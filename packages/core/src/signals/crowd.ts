import type { Signal } from "../types.js";

const MIN_WEIGHT = 3;

export const crowd: Signal = (p) => {
  const c = p.crowd;
  const total = c ? c.aiWeight + c.humanWeight : 0;
  if (!c || total < MIN_WEIGHT) {
    return { id: "crowd", score: null, weight: 0, reason: "Not enough community votes" };
  }
  return {
    id: "crowd",
    score: c.aiWeight / total,
    // more votes => more say, capped
    weight: Math.min(4, 1 + total / 5),
    reason: `Community: ${c.aiWeight.toFixed(1)} AI vs ${c.humanWeight.toFixed(1)} human (weighted)`,
  };
};
