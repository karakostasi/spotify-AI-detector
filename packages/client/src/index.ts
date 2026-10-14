import type { CrowdInfo, ScoreReport } from "@aid/core";

export type { ScoreReport, Verdict, SignalResult } from "@aid/core";
export type Report = ScoreReport & { pending: boolean; artistImage?: string };
export type Vote = "ai" | "human";

export interface Match {
  deezerTrackId: number;
  title: string;
  artist: string;
  album: string;
  similarity: number;
}

export interface ArtistChoice {
  deezerArtistId: number;
  name: string;
  description?: string;
  fans?: number;
  albums?: number;
}

export interface CheckResponse {
  input?: { source: "spotify" | "youtube" | "text"; title?: string; artist: string };
  track?: { title: string; artist: string; album: string; isrc?: string };
  confident: boolean;
  alternatives: Match[];
  report: Report | null;
  error?: string;
  artistChoices?: ArtistChoice[];
  searchedAs?: string;
  usedAi?: boolean;
  unverifiedClues?: boolean;
  /** The exact song wasn't found, so the detected artist was checked instead */
  fallback?: "artist";
}

export interface TrackRef {
  isrc: string;
}

/** Same origin by default: the server serves the web app, and Vite proxies /api in dev. */
export const DEFAULT_SERVER = "";
const BATCH = 25;

/** Stable anonymous id so the server can weigh a voter's track record. */
export function getUserId(storage: Pick<Storage, "getItem" | "setItem">): string {
  let id = storage.getItem("aid.userId");
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem("aid.userId", id);
  }
  return id;
}

export class DetectorClient {
  constructor(private baseUrl: string, private userId: string) {}

  async score(tracks: TrackRef[], onProgress?: (done: number, total: number) => void): Promise<Record<string, Report | null>> {
    const out: Record<string, Report | null> = {};
    for (let i = 0; i < tracks.length; i += BATCH) {
      const res = await fetch(`${this.baseUrl}/api/score/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tracks: tracks.slice(i, i + BATCH) }),
      });
      if (!res.ok) throw new Error(`Detector server error ${res.status}`);
      Object.assign(out, ((await res.json()) as { results: Record<string, Report | null> }).results);
      onProgress?.(Math.min(i + BATCH, tracks.length), tracks.length);
    }
    return out;
  }

  async vote(artistKey: string, vote: Vote): Promise<CrowdInfo | null> {
    const res = await fetch(`${this.baseUrl}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": this.userId },
      body: JSON.stringify({ artistKey, vote }),
    });
    if (!res.ok) throw new Error(`Vote failed (${res.status})`);
    return ((await res.json()) as { crowd: CrowdInfo | null }).crowd;
  }

  async check(q: string): Promise<CheckResponse> {
    const res = await fetch(`${this.baseUrl}/api/check?q=${encodeURIComponent(q)}`);
    return this.checkResult(res);
  }

  async checkTrack(deezerTrackId: number): Promise<CheckResponse> {
    return this.checkResult(await fetch(`${this.baseUrl}/api/check?deezerTrack=${deezerTrackId}`));
  }

  async checkArtist(deezerArtistId: number): Promise<CheckResponse> {
    return this.checkResult(await fetch(`${this.baseUrl}/api/check?deezerArtist=${deezerArtistId}`));
  }

  private async checkResult(res: Response): Promise<CheckResponse> {
    const body = (await res.json().catch(() => null)) as (Partial<CheckResponse> & { error?: string }) | null;
    if (res.status === 429) throw new Error("Too many requests, wait a minute and try again.");
    // An error body ({ error }) has no result fields, so it must never reach the renderer.
    if (!res.ok || !body || !Array.isArray(body.alternatives)) {
      throw new Error(res.status >= 500 ? "Something went wrong on our side. Please try again in a moment." : body?.error ?? `Request failed (${res.status})`);
    }
    return body as CheckResponse;
  }

  async blocklist(): Promise<{ key: string; name: string }[]> {
    const res = await fetch(`${this.baseUrl}/api/blocklist`);
    if (!res.ok) throw new Error(`Blocklist failed (${res.status})`);
    return ((await res.json()) as { artists: { key: string; name: string }[] }).artists;
  }
}
