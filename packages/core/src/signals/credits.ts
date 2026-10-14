import type { Signal } from "../types.js";

/** Tracks with no songwriter/producer credits anywhere are suspicious. */
export const credits: Signal = (p) => {
  const mb = p.musicBrainz;
  if (!mb || !mb.recordingFound) {
    return { id: "credits", score: null, weight: 0, reason: "No credit data for this recording" };
  }
  if (mb.creditCount === 0) {
    return { id: "credits", score: 0.55, weight: 0.8, reason: "Recording has no producer/writer credits" };
  }
  return { id: "credits", score: 0.1, weight: 0.8, reason: `${mb.creditCount} credits on the recording` };
};
