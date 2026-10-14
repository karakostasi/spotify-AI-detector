import type { DatabaseSync } from "node:sqlite";
import {
  scoreArtist, normalizeName, profileFromIsrc, profileFromArtistId, lookupWebPresence, needsYouTube, YouTube, Deezer, MusicBrainz, Wikidata, normalizeName as foldName,
  type ArtistProfile, type MusicBrainzInfo, type ScoreReport, type WebPresence, type WikidataInfo, type YouTubeResult,
} from "@aid/core";
import { Crowd } from "./crowd.js";
import { cacheEntry, cacheGet, cacheSet } from "./db.js";
import { resolveArtist, type ArtistChoice, type LlmHints, type ResolverDeps } from "./artistResolver.js";
import { createInterpreter } from "./ai.js";
import {
  CONFIDENT, PLAUSIBLE, findMatches, hintFromSpotify, hintFromText, hintFromYouTube, parseInput,
  type Hint, type Match, type Source,
} from "./resolve.js";

const PROFILE_TTL = 24 * 3600 * 1000;
/** Bump when the shape of the cached extra data changes, so old entries are ignored instead of crashing the new code. */
const EXTRA_SCHEMA = 5;
const EXTRA_TTL = 7 * 24 * 3600 * 1000;
/** A lookup where a source failed is retried soon, not trusted for a week. */
const PARTIAL_TTL = 5 * 60 * 1000;
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
  /** The exact song wasn't found on Deezer, so the detected artist was checked instead */
  fallback?: "artist";
  /** The query carried clues (instrument, nationality...) that no source could confirm */
  unverifiedClues?: boolean;
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
  /** AI layer: untangles a query the plain search could not resolve. Absent when no ANTHROPIC_API_KEY is set. */
  interpretQuery?: (text: string) => Promise<LlmHints | undefined>;
  lookupMb: (artistName: string, isrc?: string, mbidHint?: string) => Promise<MusicBrainzInfo | undefined>;
  /** Wikipedia / setlist.fm / YouTube evidence that the act is real; optional sources need API keys */
  lookupWeb: (artistName: string, mbid?: string) => Promise<WebPresence | undefined>;
  /** YouTube live videos and the artist's channel. Absent when no key is configured. */
  lookupYouTube?: (artistName: string, channelId?: string) => Promise<YouTubeResult | undefined>;
  /** Save YouTube quota by skipping the search when the other evidence is already clear (default: always search) */
  youtubeOnlyWhenUncertain?: boolean;
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
    lookupMb: (name, isrc, hint) => mb.lookup(name, isrc, hint).catch(() => undefined),
    lookupWeb: (name, mbid) =>
      lookupWebPresence(name, { mbid, musicBrainz: mb, setlistFmKey: process.env.SETLISTFM_API_KEY }).catch(() => undefined),
    lookupYouTube: process.env.YOUTUBE_API_KEY ? (name, channelId) => new YouTube(process.env.YOUTUBE_API_KEY!).collect(name, { channelId }).catch(() => undefined) : undefined,
    youtubeOnlyWhenUncertain: process.env.YOUTUBE_ONLY_WHEN_UNCERTAIN === "1",
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

        // YouTube runs every time by default. In the quota-saving mode it is skipped when the other evidence is already clear.
        let youtubeFailed = false;
        if (this.deps.lookupYouTube) {
          const interim = { ...profile, musicBrainz: info, web: combined ?? undefined };
          if (!this.deps.youtubeOnlyWhenUncertain || needsYouTube(scoreArtist(interim))) {
            const youtube = await this.deps.lookupYouTube(name, wikidata?.youtubeChannelId);
            if (youtube) combined = { ...combined, youtube };
            youtubeFailed = !youtube || !!youtube.error;
          } else {
            combined = { ...combined, youtubeSkipped: true };
          }
        }
        // A failed source (MusicBrainz or YouTube) is retried in minutes, not trusted for a week
        cacheSet(this.db, extraKey, { info: info ?? null, web: combined, partial: !info || youtubeFailed });
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

    let matches = await findMatches(this.deps.deezer as Deezer, hint);
    let best = matches[0];

    // "Song - Artist" is as common on YouTube as "Artist - Song", so unless the first reading is a sure thing, also try it
    // the other way round. A swapped match must be convincing and better, since it is a guess about which half is which.
    if (!best || best.similarity < CONFIDENT) {
      const swapped = await findMatches(this.deps.deezer as Deezer, { ...hint, artist: hint.title, title: hint.artist });
      if (swapped[0] && swapped[0].similarity >= CONFIDENT && swapped[0].similarity > (best?.similarity ?? 0)) [matches, best] = [swapped, swapped[0]];
    }

    // The exact song isn't on Deezer, but the artist we detected may well be: check them by name instead of giving up.
    if (!best || best.similarity < PLAUSIBLE) {
      const r = await resolveArtist(hint.artist, this.resolverDeps());
      if (r.artist) {
        return {
          input, confident: false, alternatives: matches, fallback: "artist",
          report: await this.scoreArtistId(r.artist.deezerArtistId, r.artist.name),
          artistChoices: r.choices, searchedAs: r.searchedAs, usedAi: r.usedAi, unverifiedClues: r.unverifiedClues,
        };
      }
      return { ...fail("Couldn't match that to a track or an artist on Deezer, so there's nothing to score. Pick a suggestion or search by artist name."), input, alternatives: matches };
    }
    const scored = await this.scoreTrack(best.deezerTrackId);
    return { input, ...scored, confident: best.similarity >= CONFIDENT, alternatives: matches.slice(1), error: scored.report ? undefined : "Track not found" };
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
