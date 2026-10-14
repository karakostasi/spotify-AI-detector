import { getJson, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";

const LIVE = /\b(live|concert|festival|tour|unplugged|acoustic|session|on stage|in concert|performance|performs)\b/i;

/**
 * Looks for live-performance videos about the artist via the YouTube Data API.
 * Needs a key (https://console.cloud.google.com, YouTube Data API v3). A search costs 100 quota units
 * of the free 10,000/day, so results are cached by the server.
 */
export class YouTube {
  constructor(private key: string, private f: Fetch = fetch) {}

  /** Videos whose title names the artist and looks like a live performance, from distinct channels. */
  async liveVideos(artist: string): Promise<number> {
    const q = encodeURIComponent(`"${artist}" live concert`);
    const r = await getJson<{ items?: { snippet: { title: string; channelId: string } }[] }>(
      this.f,
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${q}&key=${encodeURIComponent(this.key)}`,
    );
    const name = normalizeName(artist);
    const channels = new Set<string>();
    for (const it of r?.items ?? []) {
      if (normalizeName(it.snippet.title).includes(name) && LIVE.test(it.snippet.title)) channels.add(it.snippet.channelId);
    }
    return channels.size;
  }
}
