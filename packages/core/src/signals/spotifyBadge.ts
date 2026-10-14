import type { Signal } from "../types.js";

export const spotifyBadge: Signal = (p) => {
  if (p.spotifyAiPersona === true) {
    return { id: "spotifyBadge", score: 1, weight: 5, decisive: true, reason: "Spotify labels this artist an AI Persona" };
  }
  return { id: "spotifyBadge", score: null, weight: 0, reason: "No Spotify AI Persona label" };
};
