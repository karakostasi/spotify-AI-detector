import type { WebPresence } from "../types.js";
import { Wikipedia } from "./wikipedia.js";
import { SetlistFm } from "./setlistfm.js";
import { YouTube } from "./youtube.js";
import { MusicBrainz } from "./musicbrainz.js";
import type { Fetch } from "./http.js";

export interface WebLookupOptions {
  mbid?: string;
  /** Optional: enables the concert-history check */
  setlistFmKey?: string;
  /** Optional: enables the live-video check */
  youtubeKey?: string;
  /** Share the caller's MusicBrainz client so its 1 request/second limit is respected across lookups */
  musicBrainz?: MusicBrainz;
  fetch?: Fetch;
}

/** Each source is independent and optional; one failing or missing never blocks the others. */
export async function lookupWebPresence(name: string, o: WebLookupOptions = {}): Promise<WebPresence> {
  const f = o.fetch ?? fetch;
  const mb = o.musicBrainz ?? new MusicBrainz(f);
  const [wikipedia, setlists, mbLive, youtube] = await Promise.all([
    new Wikipedia(f).lookup(name).catch(() => undefined),
    o.setlistFmKey && o.mbid ? new SetlistFm(o.setlistFmKey, f).setlistCount(o.mbid).catch(() => undefined) : undefined,
    o.mbid ? mb.liveEvidence(o.mbid).catch(() => undefined) : undefined,
    o.youtubeKey ? new YouTube(o.youtubeKey, f).liveVideos(name).then((liveVideos) => ({ liveVideos })).catch(() => undefined) : undefined,
  ]);
  const live = setlists === undefined && !mbLive ? undefined : { setlists, mbEvents: mbLive?.events, liveReleases: mbLive?.liveReleases };
  return { wikipedia, live, youtube };
}
