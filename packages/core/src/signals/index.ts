import type { Signal } from "../types.js";
import { releaseVelocity } from "./releaseVelocity.js";
import { uniformity } from "./uniformity.js";
import { externalPresence } from "./externalPresence.js";
import { credits } from "./credits.js";
import { labelClustering } from "./labelClustering.js";
import { crowd } from "./crowd.js";
import { spotifyBadge } from "./spotifyBadge.js";
import { wikipedia } from "./wikipedia.js";
import { wikidata } from "./wikidata.js";
import { livePerformances } from "./livePerformances.js";
import { youtubeLive, youtubeChannel } from "./youtubeLive.js";
import { audience } from "./audience.js";

export const defaultSignals: Signal[] = [
  spotifyBadge,
  crowd,
  releaseVelocity,
  externalPresence,
  wikipedia,
  wikidata,
  livePerformances,
  youtubeLive,
  youtubeChannel,
  credits,
  uniformity,
  audience,
  labelClustering,
];

export { baseTitle, uniqueReleases } from "./releaseVelocity.js";
export { wikipedia, wikidata, livePerformances, youtubeLive, youtubeChannel, audience };
export { releaseVelocity, uniformity, externalPresence, credits, labelClustering, crowd, spotifyBadge };
