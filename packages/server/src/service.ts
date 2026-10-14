import type { DatabaseSync } from "node:sqlite";
import {
  scoreArtist, normalizeName, profileFromIsrc, profileFromArtistId, lookupWebPresence, Deezer, MusicBrainz,
  type ArtistProfile, type MusicBrainzInfo, type ScoreReport, type WebPresence,
} from "@aid/core";
import { Crowd } from "./crowd.js";
import { cacheGet, cacheSet } from "./db.js";
import {
  CONFIDENT, PLAUSIBLE, findMatches, hintFromSpotify, hintFromText, hintFromYouTube, parseInput,
  type Hint, type Match, type Source,
} from "./resolve.js";

const PROFILE_TTL = 24 * 3600 * 1000;
const EXTRA_TTL = 7 * 24 * 3600 * 1000;

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
}

type FetchText = (url: string) => Promise<{ ok: boolean; text: () => Promise<string>; json: () => Promise<any> }>;

export interface ServiceDeps {
  deezer: Pick<Deezer, "track" | "searchTracks" | "searchArtist">;
  fetchText: FetchText;
  /** Deezer-backed profile without MusicBrainz data */
  loadProfile: (isrc: string) => Promise<ArtistProfile | null>;
  loadArtistProfile: (artistId: number, name: string) => Promise<ArtistProfile>;
  lookupMb: (artistName: string, isrc?: string) => Promise<MusicBrainzInfo | undefined>;
  /** Wikipedia / setlist.fm / YouTube evidence that the act is real; optional sources need API keys */
  lookupWeb: (artistName: string, mbid?: string) => Promise<WebPresence | undefined>;
  /**
   * Which optional API keys are configured, e.g. "sy". It is part of the cache key, so adding or removing a key
   * re-runs the lookups instead of serving week-old results that were gathered without it.
   */
  webKeyTag?: string;
}

export function defaultDeps(): ServiceDeps {
  const mb = new MusicBrainz();
  const deezer = new Deezer();
  return {
    deezer,
    fetchText: (url) => fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; spotify-ai-detector)" }, signal: AbortSignal.timeout(8000) }),
    loadProfile: (isrc) => profileFromIsrc(isrc, { musicBrainz: null, deezer }),
    loadArtistProfile: (id, name) => profileFromArtistId(id, name, undefined, { musicBrainz: null, deezer }),
    webKeyTag: `${process.env.SETLISTFM_API_KEY ? "s" : ""}${process.env.YOUTUBE_API_KEY ? "y" : ""}`,
    lookupMb: (name, isrc) => mb.lookup(name, isrc).catch(() => undefined),
    lookupWeb: (name, mbid) =>
      lookupWebPresence(name, { mbid, musicBrainz: mb, setlistFmKey: process.env.SETLISTFM_API_KEY, youtubeKey: process.env.YOUTUBE_API_KEY }).catch(() => undefined),
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
    const extraKey = `extra:${this.deps.webKeyTag ?? ""}:${normalizeName(profile.name)}:${isrc ?? ""}`;
    const cached = cacheGet<{ info: MusicBrainzInfo | null; web: WebPresence | null }>(this.db, extraKey, EXTRA_TTL);
    let pending = false;
    if (cached) {
      if (cached.info) profile.musicBrainz = cached.info;
      if (cached.web) profile.web = cached.web;
    } else {
      pending = true;
      const name = profile.name;
      void this.once(extraKey, async () => {
        const info = await this.deps.lookupMb(name, isrc);
        const web = await this.deps.lookupWeb(name, info?.artistId);
        cacheSet(this.db, extraKey, { info: info ?? null, web: web ?? null });
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
      const a = await this.deps.deezer.searchArtist(hint.artist);
      if (!a) return { ...fail(`No artist named "${hint.artist}" found.`), input };
      return { input, confident: true, alternatives: [], report: await this.scoreArtistId(a.id, a.name) };
    }

    const matches = await findMatches(this.deps.deezer as Deezer, hint);
    const best = matches[0];
    if (!best || best.similarity < PLAUSIBLE) {
      return { ...fail("Couldn't match that to a track on Deezer, so there's nothing to score. Pick a suggestion or search by artist name."), input, alternatives: matches };
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
