import type { AlbumInfo, TrackSummary } from "../types.js";
import { getJson, Throttle, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";

const BASE = "https://api.deezer.com";

interface DzError { error?: { type: string; message: string; code: number } }

export interface DeezerTrack {
  id: number;
  title: string;
  isrc: string;
  duration: number;
  artist: { id: number; name: string };
  album: { id: number; title: string };
}

export interface TrackHit {
  id: number;
  title: string;
  duration: number;
  artist: { id: number; name: string };
  album: { id: number; title: string };
}

/**
 * Deezer's artist photo, or undefined when the artist has none. Artists without a photo get a placeholder URL with an
 * empty hash (".../artist//500x500..."), and we only trust Deezer's own image CDN.
 */
/** Deezer's generic silhouette, which it serves for artists with no photo, and the MD5 of an empty file. */
const PLACEHOLDER_HASHES = ["9285442897dbcc4a8eb9cf52d6d4073d", "d41d8cd98f00b204e9800998ecf8427e"];

export function usableImage(url: string | undefined): string | undefined {
  if (!url || url.includes("/artist//") || PLACEHOLDER_HASHES.some((h) => url.includes(`/${h}/`))) return undefined;
  return /^https:\/\/[a-z0-9-]+\.dzcdn\.net\//i.test(url) ? url : undefined;
}

/** Deezer allows about 50 requests per 5 seconds; going over returns error code 4 instead of data. */
const QUOTA_ERROR = 4;

export class Deezer {
  private throttle?: Throttle;

  /**
   * @param minGapMs minimum pause between requests across everything sharing this instance (0 = none). A busy server
   *   should set about 120 so a burst of lookups, like scanning a playlist, stays under Deezer's rate limit.
   * @param retryDelayMs wait before retrying a request that hit the rate limit
   */
  constructor(private f: Fetch = fetch, minGapMs = 0, private retryDelayMs = 1100) {
    if (minGapMs > 0) this.throttle = new Throttle(minGapMs);
  }

  private async get<T>(path: string, retries = 2): Promise<T | null> {
    const call = () => getJson<T & DzError>(this.f, `${BASE}${path}`);
    const data = await (this.throttle ? this.throttle.run(call) : call());
    // A rate-limit answer must not be mistaken for "no data", or an empty result gets cached as the truth.
    if (data?.error?.code === QUOTA_ERROR && retries > 0) {
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      return this.get<T>(path, retries - 1);
    }
    if (!data || data.error) return null;
    return data;
  }

  trackByIsrc(isrc: string): Promise<DeezerTrack | null> {
    return this.get<DeezerTrack>(`/track/isrc:${encodeURIComponent(isrc)}`);
  }

  async track(id: number): Promise<DeezerTrack | null> {
    return this.get<DeezerTrack>(`/track/${id}`);
  }

  /** Search results omit ISRC; fetch the full track with `track()` once chosen. */
  async searchTracks(query: string, limit = 10): Promise<TrackHit[]> {
    const r = await this.get<{ data: TrackHit[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return r?.data ?? [];
  }

  /** Artists matching a name, for choosing between people who share it. */
  async searchArtists(name: string, limit = 10): Promise<{ id: number; name: string; nb_fan: number; nb_album: number }[]> {
    const r = await this.get<{ data: { id: number; name: string; nb_fan: number; nb_album: number }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=${limit}`);
    return r?.data ?? [];
  }

  /** Best exact-name match by fan count; Deezer has many empty duplicate artist pages. */
  async searchArtist(name: string): Promise<{ id: number; name: string } | null> {
    const r = await this.get<{ data: { id: number; name: string; nb_fan: number }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=10`);
    const hits = r?.data ?? [];
    const target = normalizeName(name);
    const exact = hits.filter((h) => normalizeName(h.name) === target);
    return [...(exact.length ? exact : hits)].sort((a, b) => b.nb_fan - a.nb_fan)[0] ?? null;
  }

  async artist(id: number): Promise<{ id: number; name: string; nb_fan: number; picture_big?: string } | null> {
    return this.get(`/artist/${id}`);
  }

  async albums(artistId: number, max = 300): Promise<AlbumInfo[]> {
    const out: AlbumInfo[] = [];
    let index = 0;
    while (out.length < max) {
      const page = await this.get<{ data: { id: number; title: string; release_date: string; record_type: string }[]; total: number }>(
        `/artist/${artistId}/albums?limit=100&index=${index}`,
      );
      if (!page || page.data.length === 0) break;
      for (const a of page.data) {
        out.push({ id: String(a.id), title: a.title, releaseDate: a.release_date, trackCount: 0, recordType: a.record_type });
      }
      index += page.data.length;
      if (index >= page.total) break;
    }
    return out;
  }

  /** Fills trackCount and label for one album. */
  async albumDetail(id: string): Promise<{ trackCount: number; label?: string } | null> {
    const a = await this.get<{ nb_tracks: number; label?: string }>(`/album/${id}`);
    return a ? { trackCount: a.nb_tracks, label: a.label } : null;
  }

  async topTracks(artistId: number, limit = 50): Promise<TrackSummary[]> {
    const r = await this.get<{ data: { title: string; duration: number }[] }>(`/artist/${artistId}/top?limit=${limit}`);
    return (r?.data ?? []).map((t) => ({ title: t.title, durationSec: t.duration }));
  }
}
