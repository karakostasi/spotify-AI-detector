import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

export const wikidata: Signal = (p) => {
  const w = p.web?.wikidata;
  if (!w) return { id: "wikidata", score: null, weight: 0, reason: "Wikidata not checked yet" };
  if (!w.found) return { id: "wikidata", score: null, weight: 0, reason: "No Wikidata entry found for this artist" };

  if (w.aiDescribed) {
    return { id: "wikidata", score: 0.95, weight: 4, decisive: true, reason: `Wikidata describes this act as AI-generated: "${w.description}"` };
  }

  // Wikidata found *someone* with this name. Before counting a person as evidence, make sure it is this artist.
  const ourMb = p.musicBrainz?.artistId;
  if (w.musicBrainzId && ourMb && w.musicBrainzId !== ourMb) {
    return { id: "wikidata", score: null, weight: 0, reason: "Wikidata's entry for this name is a different artist (its MusicBrainz id does not match)" };
  }
  const sameAct = w.verified === true || (!!w.musicBrainzId && w.musicBrainzId === ourMb);

  if (w.isHuman && w.birthYear) {
    // A listed person with a birth date and a trail of official profiles is hard to fake, if it is the right person.
    if (sameAct || w.linkCount >= 3) {
      return {
        id: "wikidata",
        score: piecewise(w.linkCount, [[0, 0.1], [2, 0.06], [5, 0.03]]),
        weight: 1.5,
        reason: `Wikidata lists a real person (born ${w.birthYear}) with ${w.linkCount} linked official profile${w.linkCount === 1 ? "" : "s"}`,
      };
    }
    return {
      id: "wikidata",
      score: 0.2,
      weight: 0.5,
      reason: `Wikidata lists a person with this name (born ${w.birthYear}), but nothing links that entry to this artist, so it counts for little`,
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
