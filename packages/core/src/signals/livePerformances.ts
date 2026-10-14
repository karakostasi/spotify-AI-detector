import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

/**
 * Recorded concerts and live albums are about the strongest sign real people perform this music.
 * setlist.fm counts when its key is configured; MusicBrainz events and live albums work without a key.
 */
export const livePerformances: Signal = (p) => {
  const l = p.web?.live;
  if (!l) return { id: "livePerformances", score: null, weight: 0, reason: "Concert history not checked" };

  const evidence = (l.setlists ?? 0) + (l.mbEvents ?? 0) + 2 * (l.liveReleases ?? 0);
  if (evidence === 0) {
    // Nothing on setlist.fm is a faint lean at most: regional and smaller acts are poorly covered. MusicBrainz alone is too patchy to hold against anyone.
    if (l.setlists === 0) return { id: "livePerformances", score: 0.5, weight: 0.5, reason: "No concerts recorded on setlist.fm" };
    return { id: "livePerformances", score: null, weight: 0, reason: "No concert or live-album records found (MusicBrainz coverage is patchy)" };
  }

  const parts = [
    l.setlists ? `${l.setlists} setlist.fm concert${l.setlists === 1 ? "" : "s"}` : "",
    l.mbEvents ? `${l.mbEvents} MusicBrainz event${l.mbEvents === 1 ? "" : "s"}` : "",
    l.liveReleases ? `${l.liveReleases} live album${l.liveReleases === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return {
    id: "livePerformances",
    score: piecewise(evidence, [[1, 0.25], [5, 0.08], [15, 0.02]]),
    weight: 2.5,
    reason: `Performs live: ${parts.join(", ")}`,
  };
};
