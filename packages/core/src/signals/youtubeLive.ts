import type { Signal, YouTubeVideo } from "../types.js";
import { normalizeName, piecewise } from "../util.js";

const squash = (s: string) => normalizeName(s).replace(/ /g, "");

/** Channels that are the artist's own (including "NinaLaneVEVO" and auto-generated "- Topic" channels) are not independent evidence. */
const isOwnChannel = (v: YouTubeVideo, artist: string) => {
  const c = squash(v.channelTitle);
  return c.includes(squash(artist)) || /\btopic$/.test(normalizeName(v.channelTitle)) || c.endsWith("vevo");
};

const DAY = 24 * 3600 * 1000;

/**
 * Independent channels showing the act live, and above all videos from before the act's streaming catalog began:
 * a generated act's footage always comes after its releases, so earlier footage is very hard to fake.
 */
export const youtubeLive: Signal = (p) => {
  if (p.web?.youtubeSkipped) {
    return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube check skipped: the other evidence was already clear" };
  }
  const y = p.web?.youtube;
  if (!y || !Array.isArray(y.videos)) return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube live videos not checked" };

  const independent = y.videos.filter((v) => !isOwnChannel(v, p.name));
  const channels = new Set(independent.map((v) => v.channelId)).size;
  if (channels === 0) {
    // Matching YouTube titles to a name is unreliable (non-Latin scripts, spelling), so finding nothing proves nothing.
    return { id: "youtubeLive", score: null, weight: 0, reason: "No independent live-performance videos found (title matching on YouTube is unreliable for some artists)" };
  }

  const firstRelease = p.albums.map((a) => Date.parse(a.releaseDate)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const earliest = independent.map((v) => Date.parse(v.publishedAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const predates = firstRelease !== undefined && earliest !== undefined && earliest < firstRelease - 60 * DAY;

  const base = piecewise(channels, [[1, 0.3], [3, 0.15], [6, 0.06], [10, 0.03]]);
  const what = `${channels} independent channel${channels === 1 ? "" : "s"} with live-performance videos`;
  if (predates) {
    return {
      id: "youtubeLive",
      score: Math.min(base, 0.04),
      weight: 2,
      reason: `${what}; footage from ${new Date(earliest!).getFullYear()} predates the first release (${new Date(firstRelease!).getFullYear()})`,
    };
  }
  return { id: "youtubeLive", score: base, weight: 1.2, reason: what };
};
