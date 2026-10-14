import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

/** Near-identical track lengths across a catalog is a generator tell. */
export const uniformity: Signal = (p) => {
  const d = p.topTracks.map((t) => t.durationSec).filter((n) => n > 0);
  if (d.length < 8) {
    return { id: "uniformity", score: null, weight: 0, reason: "Too few tracks to compare lengths" };
  }
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  const cv = sd / mean;
  // Human catalogs typically sit at CV >= 0.2; generator output often < 0.1.
  const score = piecewise(cv, [[0.05, 0.9], [0.08, 0.65], [0.12, 0.3], [0.2, 0.03]]);
  return {
    id: "uniformity",
    score,
    weight: 0.6,
    reason: `Track length variation ${(cv * 100).toFixed(0)}% across ${d.length} tracks`,
  };
};
