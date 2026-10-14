import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

/** A label/distributor where many artists are flagged is itself a warning. */
export const labelClustering: Signal = (p) => {
  const s = p.labelStats;
  if (!s || s.artists < 5) {
    return { id: "labelClustering", score: null, weight: 0, reason: "Not enough label data" };
  }
  const ratio = s.flaggedArtists / s.artists;
  return {
    id: "labelClustering",
    score: piecewise(ratio, [[0.05, 0.1], [0.3, 0.5], [0.6, 0.85]]),
    weight: 0.9,
    reason: `${s.flaggedArtists} of ${s.artists} artists on this label are flagged as AI`,
  };
};
