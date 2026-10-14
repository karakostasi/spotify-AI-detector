import type { Signal } from "../types.js";

/** Credits on the recording are evidence of real people involved. Their absence says nothing. */
export const credits: Signal = (p) => {
  const mb = p.musicBrainz;
  if (!mb || !mb.recordingFound) {
    return { id: "credits", score: null, weight: 0, reason: "No credit data for this recording" };
  }
  if (mb.creditCount === 0) {
    // Most real recordings on MusicBrainz have no credits entered either, so this is missing data, not a warning sign.
    return { id: "credits", score: null, weight: 0, reason: "No credits listed on MusicBrainz (often just missing data)" };
  }
  return {
    id: "credits",
    score: mb.creditCount >= 5 ? 0.03 : 0.1,
    weight: 0.8,
    reason: `${mb.creditCount} credit${mb.creditCount === 1 ? "" : "s"} on the recording`,
  };
};
