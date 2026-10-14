import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

export const wikidata: Signal = (p) => {
  const w = p.web?.wikidata;
  if (!w) return { id: "wikidata", score: null, weight: 0, reason: "Wikidata not checked yet" };
  if (!w.found) return { id: "wikidata", score: null, weight: 0, reason: "No Wikidata entry found for this artist" };

  if (w.aiDescribed) {
    return { id: "wikidata", score: 0.95, weight: 4, decisive: true, reason: `Wikidata describes this act as AI-generated: "${w.description}"` };
  }
  if (w.isHuman && w.birthYear) {
    // A listed person with a birth date and a trail of official profiles is hard to fake.
    return {
      id: "wikidata",
      score: piecewise(w.linkCount, [[0, 0.1], [2, 0.06], [5, 0.03]]),
      weight: 1.5,
      reason: `Wikidata lists a real person (born ${w.birthYear}) with ${w.linkCount} linked official profile${w.linkCount === 1 ? "" : "s"}`,
    };
  }
  // A band or unlabelled entry proves little: fake acts have websites and social accounts too.
  return {
    id: "wikidata",
    score: piecewise(w.linkCount, [[0, 0.3], [3, 0.2], [6, 0.15]]),
    weight: 0.5,
    reason: `Wikidata entry${w.description ? ` ("${w.description}")` : ""} with ${w.linkCount} linked profile${w.linkCount === 1 ? "" : "s"}`,
  };
};
