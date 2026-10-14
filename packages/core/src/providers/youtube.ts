import type { YouTubeVideo } from "../types.js";
import { getJson, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";
import { looksAiMade } from "./wikipedia.js";

const LIVE = /\b(live|concert|festival|tour|unplugged|acoustic|session|on stage|in concert|performance|performs)\b/i;

/**
 * Looks for live-performance videos about the artist via the YouTube Data API.
 * Needs a key (https://console.cloud.google.com, YouTube Data API v3). A search costs 100 quota units
 * of the free 10,000/day, so the server only asks when the other evidence is uncertain, and caches results.
 */
export class YouTube {
  constructor(private key: string, private f: Fetch = fetch) {}

  /** Videos whose title names the artist and looks like a live performance. AI-labelled uploads don't count. */
  async liveVideos(artist: string): Promise<YouTubeVideo[]> {
    const q = encodeURIComponent(`"${artist}" live concert`);
    const r = await getJson<{ items?: { snippet: { title: string; channelId: string; channelTitle?: string; publishedAt?: string } }[] }>(
      this.f,
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${q}&key=${encodeURIComponent(this.key)}`,
    );
    const name = normalizeName(artist);
    return (r?.items ?? [])
      .filter((it) => normalizeName(it.snippet.title).includes(name) && LIVE.test(it.snippet.title) && !looksAiMade(it.snippet.title))
      .map((it) => ({
        title: it.snippet.title,
        channelId: it.snippet.channelId,
        channelTitle: it.snippet.channelTitle ?? "",
        publishedAt: it.snippet.publishedAt ?? "",
      }));
  }
}
