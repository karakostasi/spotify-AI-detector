import type { AlbumInfo, TrackSummary } from "../types.js";
import { getJson, type Fetch } from "./http.js";
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

export class Deezer {
  constructor(private f: Fetch = fetch) {}

  private async get<T>(path: string): Promise<T | null> {
    const data = await getJson<T & DzError>(this.f, `${BASE}${path}`);
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

  /** Best exact-name match by fan count; Deezer has many empty duplicate artist pages. */
  async searchArtist(name: string): Promise<{ id: number; name: string } | null> {
    const r = await this.get<{ data: { id: number; name: string; nb_fan: number }[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=10`);
    const hits = r?.data ?? [];
    const target = normalizeName(name);
    const exact = hits.filter((h) => normalizeName(h.name) === target);
    return [...(exact.length ? exact : hits)].sort((a, b) => b.nb_fan - a.nb_fan)[0] ?? null;
  }

  async artist(id: number): Promise<{ id: number; name: string; nb_fan: number } | null> {
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
