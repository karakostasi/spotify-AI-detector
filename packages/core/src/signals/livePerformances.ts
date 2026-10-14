import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

/** Recorded concerts on setlist.fm are about the strongest sign real people perform this music. */
export const livePerformances: Signal = (p) => {
  const l = p.web?.live;
  if (!l) return { id: "livePerformances", score: null, weight: 0, reason: "Concert history not checked" };
  if (l.setlists === 0) {
    return { id: "livePerformances", score: 0.55, weight: 0.8, reason: "No concerts recorded on setlist.fm" };
  }
  return {
    id: "livePerformances",
    score: piecewise(l.setlists, [[1, 0.25], [5, 0.08], [20, 0.02]]),
    weight: 2.5,
    reason: `${l.setlists} concert${l.setlists === 1 ? "" : "s"} recorded on setlist.fm`,
  };
};
