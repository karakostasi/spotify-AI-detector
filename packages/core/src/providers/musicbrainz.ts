import type { MusicBrainzInfo } from "../types.js";
import { getJson, Throttle, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";

const BASE = "https://musicbrainz.org/ws/2";
const CREDIT_REL_TYPES = new Set([
  "producer", "composer", "lyricist", "writer", "arranger", "mix", "engineer",
  "recording", "mastering", "performer", "instrument", "vocal", "conductor",
]);

export class MusicBrainz {
  // MusicBrainz asks for max 1 request/second and a descriptive User-Agent.
  private throttle: Throttle;
  constructor(
    private f: Fetch = fetch,
    private userAgent = "spotify-ai-detector/0.1 (https://github.com/karakostasi/spotify-AI-detector)",
    minGapMs = 1100,
  ) {
    this.throttle = new Throttle(minGapMs);
  }

  private get<T>(path: string): Promise<T | null> {
    return this.throttle.run(() => getJson<T>(this.f, `${BASE}${path}`, { "user-agent": this.userAgent }));
  }

  /** Recorded concerts and live albums for an artist. MusicBrainz coverage of events is patchy, so zero is weak evidence. */
  async liveEvidence(mbid: string): Promise<{ events: number; liveReleases: number }> {
    const id = encodeURIComponent(mbid);
    const ev = await this.get<{ "event-count"?: number }>(`/event?artist=${id}&limit=1&fmt=json`);
    const live = await this.get<{ "release-group-count"?: number }>(`/release-group?artist=${id}&type=live&limit=1&fmt=json`);
    return { events: ev?.["event-count"] ?? 0, liveReleases: live?.["release-group-count"] ?? 0 };
  }

  async lookup(artistName: string, isrc?: string): Promise<MusicBrainzInfo> {
    const info: MusicBrainzInfo = { artistFound: false, urlCount: 0, hasBackground: false, recordingFound: false, creditCount: 0 };

    if (isrc) {
      const r = await this.get<{ recordings?: { id: string }[] }>(`/isrc/${encodeURIComponent(isrc)}?fmt=json`);
      const rec = r?.recordings?.[0];
      if (rec) {
        info.recordingFound = true;
        const full = await this.get<{ relations?: { type: string }[] }>(`/recording/${rec.id}?inc=artist-rels+work-rels&fmt=json`);
        info.creditCount = (full?.relations ?? []).filter((x) => CREDIT_REL_TYPES.has(x.type)).length;
      }
    }

    const s = await this.get<{ artists?: { id: string; name: string; score: number }[] }>(
      `/artist?query=${encodeURIComponent(`artist:"${artistName}"`)}&limit=3&fmt=json`,
    );
    const target = normalizeName(artistName);
    const hit = s?.artists?.find((a) => a.score >= 90 && normalizeName(a.name) === target);
    if (hit) {
      info.artistFound = true;
      info.artistId = hit.id;
      const full = await this.get<{ relations?: unknown[]; "life-span"?: { begin?: string | null }; area?: unknown; "begin-area"?: unknown }>(
        `/artist/${hit.id}?inc=url-rels&fmt=json`,
      );
      info.urlCount = full?.relations?.length ?? 0;
      info.hasBackground = Boolean(full?.["life-span"]?.begin || full?.area || full?.["begin-area"]);
    }
    return info;
  }
}
