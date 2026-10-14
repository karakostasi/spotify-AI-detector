import type { Signal } from "../types.js";
import { isOwnChannel, piecewise } from "../util.js";

const DAY = 24 * 3600 * 1000;
const FULL_CONCERT_SEC = 20 * 60;

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

/**
 * Live footage from independent channels. Strongest evidence, since it is hard to fake:
 *  - footage published before the act's streaming catalog began (a generated act's footage always comes after)
 *  - full-length concerts (20+ minutes)
 *  - videos tagged with a recording venue or date
 */
export const youtubeLive: Signal = (p) => {
  if (p.web?.youtubeSkipped) {
    return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube check skipped: the other evidence was already clear" };
  }
  const y = p.web?.youtube;
  if (!y) return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube live videos not checked" };
  if (y.error) {
    const why = y.error === "quota" ? "today's YouTube quota is used up" : y.error === "key" ? "the YouTube API key was rejected" : "YouTube did not respond";
    return { id: "youtubeLive", score: null, weight: 0, reason: `YouTube check unavailable: ${why}` };
  }
  if (!Array.isArray(y.videos)) return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube live videos not checked" };

  const independent = y.videos.filter((v) => !isOwnChannel(v.channelTitle, p.name));
  const channels = new Set(independent.map((v) => v.channelId)).size;
  if (channels === 0) {
    // Matching YouTube titles to a name is unreliable (non-Latin scripts, spelling), so finding nothing proves nothing.
    return { id: "youtubeLive", score: null, weight: 0, reason: "No independent live-performance videos found (title matching on YouTube is unreliable for some artists)" };
  }

  const firstRelease = p.albums.map((a) => Date.parse(a.releaseDate)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const earliest = independent.map((v) => Date.parse(v.publishedAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const predates = firstRelease !== undefined && earliest !== undefined && earliest < firstRelease - 60 * DAY;
  const fullConcerts = independent.filter((v) => (v.durationSec ?? 0) >= FULL_CONCERT_SEC).length;
  const venues = independent.filter((v) => v.venue).length;
  const views = independent.reduce((n, v) => n + (v.views ?? 0), 0);

  const parts = [`${channels} independent channel${channels === 1 ? "" : "s"} with live-performance videos`];
  if (fullConcerts) parts.push(`${fullConcerts} full-length concert${fullConcerts === 1 ? "" : "s"}`);
  if (venues) parts.push(`${venues} with a recorded venue or date`);
  if (views) parts.push(`${compact(views)} views`);
  if (predates) parts.push(`footage from ${new Date(earliest!).getFullYear()} predates the first release (${new Date(firstRelease!).getFullYear()})`);

  const base = piecewise(channels, [[1, 0.12], [3, 0.08], [6, 0.05], [10, 0.03]]);
  const strong = predates || fullConcerts > 0 || venues > 0;
  const score = Math.min(base, predates ? 0.04 : 1, fullConcerts ? 0.06 : 1, venues ? 0.08 : 1);
  return { id: "youtubeLive", score, weight: strong ? 2 : 1.2, reason: parts.join("; ") };
};

/**
 * The artist's own YouTube channel: a channel older than the catalog is real history; a brand-new channel with
 * hundreds of uploads and almost no audience is the pattern of mass-produced music.
 */
export const youtubeChannel: Signal = (p, now) => {
  const c = p.web?.youtube?.channel;
  if (!p.web?.youtube) return { id: "youtubeChannel", score: null, weight: 0, reason: "YouTube channel not checked" };
  if (!c) return { id: "youtubeChannel", score: null, weight: 0, reason: "No official YouTube channel found for this artist" };

  const created = Date.parse(c.createdAt);
  const firstRelease = p.albums.map((a) => Date.parse(a.releaseDate)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const subs = c.subscribers === undefined ? "a hidden number of" : compact(c.subscribers);

  if (!Number.isNaN(created) && now.getTime() - created < 365 * DAY && c.videos >= 100 && (c.subscribers ?? Infinity) < 100) {
    return { id: "youtubeChannel", score: 0.8, weight: 1.5, reason: `Channel "${c.title}" is under a year old with ${c.videos} videos but only ${compact(c.subscribers!)} subscribers` };
  }
  if (!Number.isNaN(created) && firstRelease !== undefined && created < firstRelease - 60 * DAY) {
    return { id: "youtubeChannel", score: 0.04, weight: 1.5, reason: `Official channel "${c.title}" was created in ${new Date(created).getFullYear()}, before the first release (${new Date(firstRelease).getFullYear()})` };
  }
  if ((c.subscribers ?? 0) >= 10000) {
    return { id: "youtubeChannel", score: 0.05, weight: 1, reason: `Official channel "${c.title}" has ${compact(c.subscribers!)} subscribers` };
  }
  return { id: "youtubeChannel", score: null, weight: 0, reason: `Official channel "${c.title}": ${subs} subscribers, ${c.videos} videos` };
};
