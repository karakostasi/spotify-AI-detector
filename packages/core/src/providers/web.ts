import type { WebPresence } from "../types.js";
import { Wikipedia } from "./wikipedia.js";
import { SetlistFm } from "./setlistfm.js";
import { YouTube } from "./youtube.js";
import type { Fetch } from "./http.js";

export interface WebLookupOptions {
  mbid?: string;
  /** Optional: enables the concert-history check */
  setlistFmKey?: string;
  /** Optional: enables the live-video check */
  youtubeKey?: string;
  fetch?: Fetch;
}

/** Each source is independent and optional; one failing or missing never blocks the others. */
export async function lookupWebPresence(name: string, o: WebLookupOptions = {}): Promise<WebPresence> {
  const f = o.fetch ?? fetch;
  const [wikipedia, live, youtube] = await Promise.all([
    new Wikipedia(f).lookup(name).catch(() => undefined),
    o.setlistFmKey && o.mbid
      ? new SetlistFm(o.setlistFmKey, f).setlistCount(o.mbid).then((setlists) => ({ setlists })).catch(() => undefined)
      : undefined,
    o.youtubeKey ? new YouTube(o.youtubeKey, f).liveVideos(name).then((liveVideos) => ({ liveVideos })).catch(() => undefined) : undefined,
  ]);
  return { wikipedia, live, youtube };
}
