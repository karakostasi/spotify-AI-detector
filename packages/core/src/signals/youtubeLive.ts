import type { Signal } from "../types.js";
import { piecewise } from "../util.js";

export const youtubeLive: Signal = (p) => {
  const y = p.web?.youtube;
  if (!y) return { id: "youtubeLive", score: null, weight: 0, reason: "YouTube live videos not checked" };
  if (y.liveVideos === 0) {
    return { id: "youtubeLive", score: 0.5, weight: 0.5, reason: "No live-performance videos found on YouTube" };
  }
  return {
    id: "youtubeLive",
    score: piecewise(y.liveVideos, [[1, 0.25], [4, 0.1], [8, 0.04]]),
    weight: 1.2,
    reason: `${y.liveVideos} live-performance video${y.liveVideos === 1 ? "" : "s"} from different channels on YouTube`,
  };
};
