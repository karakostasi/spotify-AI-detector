import type { Signal } from "../types.js";

/** Real artists leave traces off streaming: MusicBrainz entry, links, history. */
export const externalPresence: Signal = (p) => {
  const mb = p.musicBrainz;
  if (!mb) {
    return { id: "externalPresence", score: null, weight: 0, reason: "MusicBrainz lookup unavailable" };
  }
  if (!mb.artistFound) {
    return { id: "externalPresence", score: 0.65, weight: 1.2, reason: "No MusicBrainz entry for this artist" };
  }
  if (mb.urlCount === 0 && !mb.hasBackground) {
    return { id: "externalPresence", score: 0.5, weight: 1.2, reason: "MusicBrainz entry exists but has no links or background" };
  }
  const score = mb.urlCount >= 3 && mb.hasBackground ? 0.05 : 0.25;
  return {
    id: "externalPresence",
    score,
    weight: 1.2,
    reason: `MusicBrainz entry with ${mb.urlCount} external links${mb.hasBackground ? " and background info" : ""}`,
  };
};
