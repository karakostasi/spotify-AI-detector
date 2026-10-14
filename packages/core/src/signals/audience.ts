import type { Signal } from "../types.js";
import { uniqueReleases } from "./releaseVelocity.js";

const YEAR_MS = 365 * 24 * 3600 * 1000;

/** An audience is hard to fake: a catalogue of dozens of releases with almost no fans is the mass-production pattern. */
export const audience: Signal = (p, now) => {
  if (p.fans === undefined) return { id: "audience", score: null, weight: 0, reason: "Fan count not available" };
  const recent = uniqueReleases(p.albums).filter((a) => {
    const t = Date.parse(a.releaseDate);
    return !Number.isNaN(t) && now.getTime() - t <= YEAR_MS && t <= now.getTime();
  });
  const releaseDates = new Set(recent.map((a) => a.releaseDate)).size;

  if (releaseDates >= 12 && p.fans < 300) {
    return { id: "audience", score: 0.75, weight: 0.8, reason: `${releaseDates} release dates in a year but only ${p.fans.toLocaleString()} fans on Deezer` };
  }
  if (p.fans >= 5000) {
    return { id: "audience", score: 0.05, weight: 0.8, reason: `${p.fans.toLocaleString()} fans on Deezer` };
  }
  return { id: "audience", score: null, weight: 0, reason: `${p.fans.toLocaleString()} fans on Deezer` };
};
