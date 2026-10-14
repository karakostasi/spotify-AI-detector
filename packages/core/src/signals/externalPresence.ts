import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

/** Real artists leave traces off streaming: MusicBrainz entry, links, history. */
export const externalPresence: Signal = (p) => {
  const mb = p.musicBrainz;
  if (!mb) {
    return { id: "externalPresence", score: null, weight: 0, reason: "MusicBrainz lookup unavailable" };
  }
  if (!mb.artistFound) {
    return { id: "externalPresence", score: 0.65, weight: 1.2, reason: "No MusicBrainz entry for this artist" };
  }
  // Scales smoothly with the number of linked sites (official site, socials, Discogs, ...) instead of a hard cutoff.
  const byLinks = piecewise(mb.urlCount, [[0, 0.5], [1, 0.3], [3, 0.12], [6, 0.04]]);
  const score = mb.hasBackground ? byLinks * 0.7 : byLinks;
  return {
    id: "externalPresence",
    score,
    weight: 1.2,
    reason: `MusicBrainz entry with ${mb.urlCount} external link${mb.urlCount === 1 ? "" : "s"}${mb.hasBackground ? " and background info" : ""}`,
  };
};
