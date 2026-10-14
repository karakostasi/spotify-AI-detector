import type { Signal } from "../types.js";
import { normalizeName, piecewise } from "../util.js";
import type { AlbumInfo } from "../types.js";

const YEAR_MS = 365 * 24 * 3600 * 1000;

const REISSUE_WORDS = /\b(deluxe|remaster(?:ed)?|expanded|anniversary|edition|version|mono|stereo|bonus|special|collector'?s?|reissue|explicit|clean|\d{4})\b/g;

/** Same album shipped as deluxe/remaster/regional editions counts once. */
export function baseTitle(title: string): string {
  return normalizeName(title.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s-\s.*$/, " ")).replace(REISSUE_WORDS, " ").replace(/\s+/g, " ").trim();
}

/** Own new releases: drop compilations and collapse reissues of the same title (earliest wins). */
export function uniqueReleases(albums: AlbumInfo[]): AlbumInfo[] {
  const byTitle = new Map<string, AlbumInfo>();
  for (const a of albums) {
    if (a.recordType === "compile") continue;
    const k = baseTitle(a.title) || a.title;
    const prev = byTitle.get(k);
    if (!prev || a.releaseDate < prev.releaseDate) byTitle.set(k, a);
  }
  return [...byTitle.values()];
}

/** Humans rarely ship dozens of releases a year; generators do. */
export const releaseVelocity: Signal = (p, now) => {
  const recent = uniqueReleases(p.albums).filter((a) => {
    const t = Date.parse(a.releaseDate);
    return !Number.isNaN(t) && now.getTime() - t <= YEAR_MS && t <= now.getTime();
  });
  if (p.albums.length === 0) {
    return { id: "releaseVelocity", score: null, weight: 0, reason: "No release history available" };
  }
  // A label can drop a dozen repackaged EPs in one day; a steady drip of new dates is the generator pattern.
  const events = new Set(recent.map((a) => a.releaseDate)).size;
  const tracks = recent.reduce((n, a) => n + a.trackCount, 0);
  const byEvents = piecewise(events, [[4, 0.05], [10, 0.35], [20, 0.7], [40, 0.95]]);
  const byTracks = piecewise(tracks, [[40, 0.05], [100, 0.4], [200, 0.8], [400, 0.95]]);
  const score = Math.max(byEvents, 0.7 * byTracks);
  return {
    id: "releaseVelocity",
    score,
    weight: 1.5,
    reason: `${events} release dates (${recent.length} releases, ${tracks} tracks) in the last 12 months`,
  };
};
