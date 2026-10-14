import type { YouTubeChannel, YouTubeError, YouTubeVideo } from "../types.js";
import type { Fetch } from "./http.js";
import { isOwnChannel, normalizeName, parseIsoDuration } from "../util.js";
import { looksAiMade } from "./wikipedia.js";

const LIVE = /\b(live|concert|festival|tour|unplugged|acoustic|session|on stage|in concert|performance|performs)\b/i;
const BASE = "https://www.googleapis.com/youtube/v3";

export interface YouTubeResult {
  videos: YouTubeVideo[];
  channel?: YouTubeChannel;
  /** Set when the search itself failed, so the page can say why nothing was found */
  error?: YouTubeError;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: YouTubeError };

/**
 * Evidence from the YouTube Data API (https://console.cloud.google.com, YouTube Data API v3, free key):
 *  - live-performance videos about the artist, with views, length and recording venue
 *  - the artist's own channel: how old it is and how big
 * One check costs about 102 of the free 10,000 daily quota units (the search is 100, the rest 1 each).
 */
export class YouTube {
  constructor(private key: string, private f: Fetch = fetch) {}

  private async call<T>(path: string): Promise<Reply<T>> {
    let res: Response;
    try {
      res = await this.f(`${BASE}/${path}&key=${encodeURIComponent(this.key)}`);
    } catch {
      return { ok: false, error: "failed" };
    }
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    // Name the reason without ever putting the URL (which holds the key) in an error.
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
    const reason = `${body?.error?.errors?.[0]?.reason ?? ""} ${body?.error?.message ?? ""}`;
    if (/quota|rateLimit|dailyLimit/i.test(reason)) return { ok: false, error: "quota" };
    if (/key|accessNotConfigured|forbidden|not been used|disabled/i.test(reason) || res.status === 400) return { ok: false, error: "key" };
    return { ok: false, error: "failed" };
  }

  /**
   * Live videos that name the artist (AI-labelled uploads don't count), enriched with views, length and venue,
   * plus the artist's channel: the one Wikidata lists, otherwise the artist's own channel among the results.
   */
  async collect(artist: string, hints: { channelId?: string } = {}): Promise<YouTubeResult> {
    const q = encodeURIComponent(`"${artist}" live concert`);
    const found = await this.call<{ items?: { id?: { videoId?: string }; snippet: { title: string; channelId: string; channelTitle?: string; publishedAt?: string } }[] }>(
      `search?part=snippet&type=video&maxResults=15&q=${q}`,
    );
    if (!found.ok) return { videos: [], error: found.error };

    const name = normalizeName(artist);
    const videos: YouTubeVideo[] = (found.data.items ?? [])
      .filter((it) => normalizeName(it.snippet.title).includes(name) && LIVE.test(it.snippet.title) && !looksAiMade(it.snippet.title))
      .map((it) => ({
        title: it.snippet.title,
        channelId: it.snippet.channelId,
        channelTitle: it.snippet.channelTitle ?? "",
        publishedAt: it.snippet.publishedAt ?? "",
        videoId: it.id?.videoId,
      }));

    const [details, channel] = await Promise.all([this.details(videos), this.channel(artist, videos, hints.channelId)]);
    for (const v of videos) Object.assign(v, details.get(v.videoId ?? ""));
    return { videos, channel };
  }

  /** Views, length and recording location for the found videos (one quota unit). Failure just leaves them out. */
  private async details(videos: YouTubeVideo[]): Promise<Map<string, Partial<YouTubeVideo>>> {
    const ids = videos.map((v) => v.videoId).filter((x): x is string => !!x);
    const out = new Map<string, Partial<YouTubeVideo>>();
    if (!ids.length) return out;
    const r = await this.call<{
      items?: { id: string; contentDetails?: { duration?: string }; statistics?: { viewCount?: string }; recordingDetails?: { locationDescription?: string; recordingDate?: string } }[];
    }>(`videos?part=contentDetails,statistics,recordingDetails&id=${ids.join(",")}`);
    if (!r.ok) return out;
    for (const it of r.data.items ?? []) {
      const rd = it.recordingDetails;
      out.set(it.id, {
        views: it.statistics?.viewCount !== undefined ? Number(it.statistics.viewCount) : undefined,
        durationSec: parseIsoDuration(it.contentDetails?.duration),
        venue: rd?.locationDescription || rd?.recordingDate || undefined,
      });
    }
    return out;
  }

  private async channel(artist: string, videos: YouTubeVideo[], listed?: string): Promise<YouTubeChannel | undefined> {
    const own = [...new Set(videos.filter((v) => isOwnChannel(v.channelTitle, artist)).map((v) => v.channelId))];
    const ids = [...new Set([listed, ...own].filter((x): x is string => !!x))].slice(0, 2);
    if (!ids.length) return undefined;
    const r = await this.call<{
      items?: { id: string; snippet?: { title?: string; publishedAt?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string; viewCount?: string } }[];
    }>(`channels?part=snippet,statistics&id=${ids.join(",")}`);
    if (!r.ok) return undefined;
    // Prefer the channel Wikidata names, otherwise the biggest of the candidates
    const channels: YouTubeChannel[] = (r.data.items ?? []).map((c) => ({
      id: c.id,
      title: c.snippet?.title ?? "",
      createdAt: c.snippet?.publishedAt ?? "",
      subscribers: c.statistics?.hiddenSubscriberCount || c.statistics?.subscriberCount === undefined ? undefined : Number(c.statistics.subscriberCount),
      videos: Number(c.statistics?.videoCount ?? 0),
      views: Number(c.statistics?.viewCount ?? 0),
    }));
    return channels.find((c) => c.id === listed) ?? channels.sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0))[0];
  }
}
