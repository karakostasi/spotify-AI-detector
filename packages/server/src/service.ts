import type { DatabaseSync } from "node:sqlite";
import {
  scoreArtist, normalizeName, profileFromIsrc, profileFromArtistId, lookupWebPresence, needsYouTube, YouTube, Wikipedia, Deezer, MusicBrainz, Wikidata, normalizeName as foldName,
  type ArtistProfile, type MusicBrainzInfo, type ScoreReport, type WebPresence, type WikidataInfo, type WikipediaInfo, type YouTubeVideo,
} from "@aid/core";
import { Crowd } from "./crowd.js";
import { cacheEntry, cacheGet, cacheSet } from "./db.js";
import { resolveArtist, type ArtistChoice, type LlmHints, type ResolverDeps } from "./artistResolver.js";
import { createInterpreter } from "./ai.js";
import { fetchPlaylist, type PlaylistInfo } from "./playlist.js";
import {
  CONFIDENT, PLAUSIBLE, findMatches, hintFromSpotify, hintFromText, hintFromYouTube, parseInput,
  type Hint, type Match, type Source,
} from "./resolve.js";

const PROFILE_TTL = 24 * 3600 * 1000;
/** Bump when the shape of the cached extra data changes, so old entries are ignored instead of crashing the new code. */
const EXTRA_SCHEMA = 3;
const EXTRA_TTL = 7 * 24 * 3600 * 1000;
/** A lookup where a source failed is retried soon, not trusted for a week. */
const PARTIAL_TTL = 5 * 60 * 1000;
const PLAYLIST_TTL = 10 * 60 * 1000;
/** Playlist tracks must match a Deezer track at least this well before we score the artist */
const PLAYLIST_MATCH = 0.7;
const NO_MATCH: PlaylistScore = { matched: false, score: null, verdict: "unknown", confidence: 0, reasons: [] };
const AI_TTL = 30 * 24 * 3600 * 1000;
/** A failed or empty AI answer is retried soon rather than remembered */
const AI_MISS_TTL = 10 * 60 * 1000;
const RETRY_DELAY_MS = 2000;

export interface ServerReport extends ScoreReport {
  /** MusicBrainz data is still being fetched; score will sharpen on a later request */
  pending: boolean;
  /** Artist photo, when one exists */
  artistImage?: string;
}

export interface CheckResult {
  input?: { source: Source; title?: string; artist: string };
  /** The track we matched on Deezer (absent for artist-only checks) */
  track?: { title: string; artist: string; album: string; isrc?: string };
  /** True when the match is a near-exact title+artist hit */
  confident: boolean;
  alternatives: Match[];
  report: ServerReport | null;
  error?: string;
  /** Other artists that could be meant, when a name is shared or the pick is uncertain */
  artistChoices?: ArtistChoice[];
  /** What was actually searched, e.g. "Justin Johnston · guitarist" */
  searchedAs?: string;
  /** The AI layer helped interpret the query */
  usedAi?: boolean;
  /** The query carried clues (instrument, nationality...) that no source could confirm */
  unverifiedClues?: boolean;
}

/** One playlist track's verdict, from the fast scoring mode. */
export interface PlaylistScore {
  /** The track matched a Deezer artist we could score */
  matched: boolean;
  artist?: { id: number; name: string };
  score: number | null;
  verdict: "likely-ai" | "suspicious" | "likely-human" | "unknown";
  confidence: number;
  /** The strongest reasons pointing at AI, for flagged tracks */
  reasons: string[];
}

export interface PlaylistItem {
  id: string;
  title: string;
  artists: string;
}

type FetchText = (url: string) => Promise<{ ok: boolean; text: () => Promise<string>; json: () => Promise<any> }>;

export interface ServiceDeps {
  deezer: Pick<Deezer, "track" | "searchTracks" | "searchArtist" | "searchArtists" | "artist">;
  fetchText: FetchText;
  /** Deezer-backed profile without MusicBrainz data */
  loadProfile: (isrc: string) => Promise<ArtistProfile | null>;
  loadArtistProfile: (artistId: number, name: string) => Promise<ArtistProfile>;
  lookupWikidata: (artistName: string, deezerArtistId?: number) => Promise<WikidataInfo | undefined>;
  /** Musicians matching names on Wikidata, with their Deezer/MusicBrainz ids (used to resolve ambiguous or non-Latin queries) */
  wikidataCandidates?: ResolverDeps["wikidataCandidates"];
  /** Deezer artist id linked from a MusicBrainz artist */
  mbDeezerId?: ResolverDeps["mbDeezerId"];
  /** Deezer-only profile that skips the slow per-album detail calls (playlist scanning). Defaults to loadArtistProfile. */
  loadQuickProfile?: (artistId: number, name: string) => Promise<ArtistProfile>;
  /** Wikipedia-only lookup for fast scoring. Absent: Wikipedia is skipped in fast mode. */
  lookupWikipedia?: (artistName: string) => Promise<WikipediaInfo | undefined>;
  /** AI layer: untangles a query the plain search could not resolve. Absent when no ANTHROPIC_API_KEY is set. */
  interpretQuery?: (text: string) => Promise<LlmHints | undefined>;
  lookupMb: (artistName: string, isrc?: string, mbidHint?: string) => Promise<MusicBrainzInfo | undefined>;
  /** Wikipedia / setlist.fm / YouTube evidence that the act is real; optional sources need API keys */
  lookupWeb: (artistName: string, mbid?: string) => Promise<WebPresence | undefined>;
  /** YouTube live videos for an artist. Absent when no key is configured. Only called when the score is uncertain. */
  lookupYouTube?: (artistName: string) => Promise<YouTubeVideo[] | undefined>;
  /**
   * Which optional API keys are configured, e.g. "sy". It is part of the cache key, so adding or removing a key
   * re-runs the lookups instead of serving week-old results that were gathered without it.
   */
  webKeyTag?: string;
  /** Pause before retrying a failed MusicBrainz lookup (default 2s; tests use 0) */
  retryDelayMs?: number;
}

export function defaultDeps(): ServiceDeps {
  const mb = new MusicBrainz();
  const wikidata = new Wikidata();
  const deezer = new Deezer(fetch, 105);
  return {
    deezer,
    fetchText: (url) => fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; spotify-ai-detector)" }, signal: AbortSignal.timeout(8000) }),
    loadProfile: (isrc) => profileFromIsrc(isrc, { musicBrainz: null, deezer }),
    loadArtistProfile: (id, name) => profileFromArtistId(id, name, undefined, { musicBrainz: null, deezer }),
    webKeyTag: `${process.env.SETLISTFM_API_KEY ? "s" : ""}${process.env.YOUTUBE_API_KEY ? "y" : ""}`,
    lookupWikidata: (name, deezerId) => wikidata.lookup(name, deezerId).catch(() => undefined),
    wikidataCandidates: (names, languages) => wikidata.candidates(names, languages),
    mbDeezerId: (mbid) => mb.deezerArtistId(mbid),
    interpretQuery: process.env.ANTHROPIC_API_KEY ? createInterpreter() : undefined,
    loadQuickProfile: (id, name) => profileFromArtistId(id, name, undefined, { musicBrainz: null, detailAlbums: 0, skipArtistInfo: true, deezer }),
    lookupWikipedia: (name) => new Wikipedia().lookup(name).catch(() => undefined),
    lookupMb: (name, isrc, hint) => mb.lookup(name, isrc, hint).catch(() => undefined),
    lookupWeb: (name, mbid) =>
      lookupWebPresence(name, { mbid, musicBrainz: mb, setlistFmKey: process.env.SETLISTFM_API_KEY }).catch(() => undefined),
    lookupYouTube: process.env.YOUTUBE_API_KEY ? (name) => new YouTube(process.env.YOUTUBE_API_KEY!).liveVideos(name).catch(() => undefined) : undefined,
  };
}

export class ScoreService {
  readonly crowd: Crowd;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private db: DatabaseSync, private deps: ServiceDeps) {
    this.crowd = new Crowd(db);
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async cachedProfile(key: string, load: () => Promise<ArtistProfile | null>): Promise<ArtistProfile | null> {
    const hit = cacheGet<ArtistProfile>(this.db, key, PROFILE_TTL);
    if (hit) return hit;
    const loaded = await this.once(key, load);
    if (loaded) cacheSet(this.db, key, loaded);
    return loaded;
  }

  async scoreIsrc(isrc: string): Promise<ServerReport | null> {
    const profile = await this.cachedProfile(`profile:v2:isrc:${isrc}`, () => this.deps.loadProfile(isrc));
    return profile ? this.finish(profile, isrc) : null;
  }

  async scoreArtistId(artistId: number, name: string): Promise<ServerReport> {
    const profile = (await this.cachedProfile(`profile:v2:artist:${artistId}`, () => this.deps.loadArtistProfile(artistId, name)))!;
    return this.finish(profile);
  }

  private finish(profile: ArtistProfile, isrc?: string): ServerReport {
    // MusicBrainz is slow (1 req/s), so serve what we have and fill the rest in behind the scenes.
    // The web lookups run after it because setlist.fm needs the MusicBrainz id.
    const extraKey = `extra:v${EXTRA_SCHEMA}:${this.deps.webKeyTag ?? ""}:${normalizeName(profile.name)}:${isrc ?? ""}`;
    const entry = cacheEntry<{ info: MusicBrainzInfo | null; web: WebPresence | null; partial?: boolean }>(this.db, extraKey);
    const cached = entry && Date.now() - entry.ts < (entry.value.partial ? PARTIAL_TTL : EXTRA_TTL) ? entry.value : undefined;
    let pending = false;
    if (cached) {
      if (cached.info) profile.musicBrainz = cached.info;
      if (cached.web) profile.web = cached.web;
    } else {
      pending = true;
      const name = profile.name;
      const deezerId = /^deezer:(\d+)$/.exec(profile.key)?.[1];
      void this.once(extraKey, async () => {
        // Wikidata first: its MusicBrainz id finds artists the name search misses.
        const wikidata = await this.deps.lookupWikidata(name, deezerId ? Number(deezerId) : undefined);
        let info = await this.deps.lookupMb(name, isrc, wikidata?.musicBrainzId);
        if (!info) {
          // MusicBrainz sometimes rejects or drops a request; one retry usually gets through.
          await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? RETRY_DELAY_MS));
          info = await this.deps.lookupMb(name, isrc, wikidata?.musicBrainzId);
        }
        const web = await this.deps.lookupWeb(name, info?.artistId);
        let combined: WebPresence | null = web || wikidata ? { ...web, ...(wikidata ? { wikidata } : {}) } : null;

        // YouTube costs quota, so only ask when the evidence so far leaves the answer open.
        if (this.deps.lookupYouTube) {
          const interim = { ...profile, musicBrainz: info, web: combined ?? undefined };
          if (needsYouTube(scoreArtist(interim))) {
            const videos = await this.deps.lookupYouTube(name);
            if (videos) combined = { ...combined, youtube: { videos } };
          } else {
            combined = { ...combined, youtubeSkipped: true };
          }
        }
        cacheSet(this.db, extraKey, { info: info ?? null, web: combined, partial: !info });
      }).catch(() => undefined);
    }

    const label = mostCommonLabel(profile);
    this.crowd.recordArtist(profile.key, profile.name, label);
    profile.crowd = this.crowd.forArtist(profile.key);
    if (label) profile.labelStats = this.crowd.labelStats(label);
    return { ...scoreArtist(profile), pending, artistImage: profile.imageUrl };
  }

  private async scoreTrack(id: number): Promise<Pick<CheckResult, "track" | "report">> {
    const t = await this.deps.deezer.track(id);
    if (!t) return { report: null };
    const track = { title: t.title, artist: t.artist.name, album: t.album.title, isrc: t.isrc || undefined };
    const report = t.isrc ? await this.scoreIsrc(t.isrc.toUpperCase()) : await this.scoreArtistId(t.artist.id, t.artist.name);
    return { track, report };
  }

  /** The user picked a specific Deezer track from the alternatives. */
  async checkDeezerTrack(id: number): Promise<CheckResult> {
    const r = await this.scoreTrack(id);
    return { ...r, confident: true, alternatives: [], error: r.report ? undefined : "Track not found" };
  }

  /** The user picked one of the "which artist?" choices. */
  async checkDeezerArtist(id: number): Promise<CheckResult> {
    const a = await this.deps.deezer.artist(id);
    if (!a) return { confident: true, alternatives: [], report: null, error: "Artist not found" };
    return { confident: true, alternatives: [], report: await this.scoreArtistId(a.id, a.name), artistChoices: [] };
  }

  private resolverDeps(): ResolverDeps {
    return {
      deezer: this.deps.deezer,
      wikidataCandidates: this.deps.wikidataCandidates ?? (async () => []),
      mbDeezerId: this.deps.mbDeezerId ?? (async () => undefined),
      interpret: this.deps.interpretQuery ? (t) => this.interpretCached(t) : undefined,
    };
  }

  /** The AI layer's answers are cached for a month, so a repeated query never costs twice. */
  private async interpretCached(text: string): Promise<LlmHints | undefined> {
    const key = `ai:v1:${foldName(text)}`;
    const entry = cacheEntry<{ hints: LlmHints | null }>(this.db, key);
    if (entry && Date.now() - entry.ts < (entry.value.hints ? AI_TTL : AI_MISS_TTL)) return entry.value.hints ?? undefined;
    const hints = await this.deps.interpretQuery!(text);
    cacheSet(this.db, key, { hints: hints ?? null });
    return hints;
  }

  /** Link or free text -> best matching track -> score. */
  async check(raw: string): Promise<CheckResult> {
    const fail = (error: string): CheckResult => ({ confident: false, alternatives: [], report: null, error });
    const parsed = parseInput(raw);
    if (parsed?.kind === "spotify-playlist") return fail("That is a playlist link. Paste it on the main page to scan the whole playlist for AI tracks.");
    if (!parsed) return fail("That doesn't look like a Spotify track/artist link, a YouTube link, or an artist name.");

    let hint: Hint | null;
    try {
      hint =
        parsed.kind === "spotify-track" ? await hintFromSpotify(this.deps.fetchText, "track", parsed.id)
        : parsed.kind === "spotify-artist" ? await hintFromSpotify(this.deps.fetchText, "artist", parsed.id)
        : parsed.kind === "youtube" ? await hintFromYouTube(this.deps.fetchText, parsed.id)
        : hintFromText(parsed.text);
    } catch {
      hint = null;
    }
    if (!hint) return fail("Couldn't read that link. It may be private or unavailable.");
    const input = { source: hint.source, title: hint.title, artist: hint.artist };

    if (!hint.title) {
      const r = await resolveArtist(hint.artist, this.resolverDeps());
      if (!r.artist) {
        return { ...fail(`No artist matching "${hint.artist}" found.`), input, searchedAs: r.searchedAs, usedAi: r.usedAi };
      }
      const report = await this.scoreArtistId(r.artist.deezerArtistId, r.artist.name);
      return {
        input, confident: true, alternatives: [], report,
        artistChoices: r.choices, searchedAs: r.searchedAs, usedAi: r.usedAi, unverifiedClues: r.unverifiedClues,
      };
    }

    const matches = await findMatches(this.deps.deezer as Deezer, hint);
    const best = matches[0];
    if (!best || best.similarity < PLAUSIBLE) {
      return { ...fail("Couldn't match that to a track on Deezer, so there's nothing to score. Pick a suggestion or search by artist name."), input, alternatives: matches };
    }
    const scored = await this.scoreTrack(best.deezerTrackId);
    return { input, ...scored, confident: best.similarity >= CONFIDENT, alternatives: matches.slice(1), error: scored.report ? undefined : "Track not found" };
  }

  /** The tracks of a public playlist, cached briefly so rescans and retries are free. */
  async getPlaylist(id: string): Promise<PlaylistInfo | null> {
    const key = `playlist:v1:${id}`;
    const hit = cacheGet<PlaylistInfo>(this.db, key, PLAYLIST_TTL);
    if (hit) return hit;
    const info = await fetchPlaylist(this.deps.fetchText, id).catch(() => null);
    if (info) cacheSet(this.db, key, info);
    return info;
  }

  /**
   * Scores playlist tracks quickly: match each to a Deezer artist, then score the artist from Deezer, Wikidata and
   * Wikipedia only. MusicBrainz is skipped because its 1 request/second limit would make a playlist take minutes.
   */
  async scorePlaylistItems(items: PlaylistItem[], concurrency = 6): Promise<Record<string, PlaylistScore>> {
    const out: Record<string, PlaylistScore> = {};
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next++]!;
          out[item.id] = await this.scorePlaylistItem(item).catch(() => NO_MATCH);
        }
      }),
    );
    return out;
  }

  private async scorePlaylistItem(item: PlaylistItem): Promise<PlaylistScore> {
    const artist = await this.matchArtist(item);
    if (!artist) return NO_MATCH;
    return { ...(await this.scoreArtistQuick(artist.id, artist.name)), artist };
  }

  /** Spotify gives names, not ids, so find the Deezer artist by title and credited artists (cached, as it never changes). */
  private async matchArtist(item: PlaylistItem): Promise<{ id: number; name: string } | null> {
    const key = `plmatch:v1:${foldName(item.artists)}:${foldName(item.title)}`;
    const hit = cacheEntry<{ artist: { id: number; name: string } | null }>(this.db, key);
    if (hit && (hit.value.artist || Date.now() - hit.ts < PARTIAL_TTL)) return hit.value.artist;

    const matches = await findMatches(this.deps.deezer as Deezer, { source: "text", artist: item.artists, title: item.title });
    const best = matches[0];
    let artist: { id: number; name: string } | null = null;
    // A wrong match would flag an innocent artist, so insist on a close one.
    if (best && best.similarity >= PLAYLIST_MATCH) artist = { id: best.artistId, name: best.artist };
    cacheSet(this.db, key, { artist });
    return artist;
  }

  private async scoreArtistQuick(artistId: number, name: string): Promise<Omit<PlaylistScore, "artist">> {
    const load = this.deps.loadQuickProfile ?? this.deps.loadArtistProfile;
    const profile = await this.cachedProfile(`profile:v2:quick:${artistId}`, () => load(artistId, name));
    if (!profile) return NO_MATCH;

    const webKey = `quickweb:v1:${artistId}`;
    let web = cacheGet<WebPresence>(this.db, webKey, EXTRA_TTL);
    if (!web) {
      const [wikidata, wikipedia] = await Promise.all([
        this.deps.lookupWikidata(name, artistId).catch(() => undefined),
        this.deps.lookupWikipedia?.(name).catch(() => undefined),
      ]);
      web = { ...(wikidata ? { wikidata } : {}), ...(wikipedia ? { wikipedia } : {}) };
      cacheSet(this.db, webKey, web);
    }
    profile.web = web;
    profile.crowd = this.crowd.forArtist(profile.key);

    const report = scoreArtist(profile);
    const reasons = report.signals
      .filter((r) => r.score !== null && r.score >= 0.5 && r.weight > 0)
      .sort((a, b) => b.score! * b.weight - a.score! * a.weight)
      .slice(0, 2)
      .map((r) => r.reason);
    return { matched: true, score: report.score, verdict: report.verdict, confidence: report.confidence, reasons };
  }

  /** Resolves when background MusicBrainz lookups started so far are done (used by tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }
}

function mostCommonLabel(p: ArtistProfile): string | undefined {
  const counts = new Map<string, number>();
  for (const a of p.albums) if (a.label) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}
