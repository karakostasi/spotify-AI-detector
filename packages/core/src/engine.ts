import type { ArtistProfile, ScoreReport, Signal, SignalResult, Verdict } from "./types.js";
import { defaultSignals } from "./signals/index.js";
import { clamp01 } from "./util.js";

export const THRESHOLDS = { likelyAi: 0.7, suspicious: 0.45 };

/** Sum of weights at which we consider the evidence "complete". */
const FULL_EVIDENCE_WEIGHT = 5;

export function verdictFor(score: number | null): Verdict {
  if (score === null) return "unknown";
  if (score >= THRESHOLDS.likelyAi) return "likely-ai";
  if (score >= THRESHOLDS.suspicious) return "suspicious";
  return "likely-human";
}

export function scoreArtist(
  profile: ArtistProfile,
  opts: { now?: Date; signals?: Signal[] } = {},
): ScoreReport {
  const now = opts.now ?? new Date();
  const results: SignalResult[] = (opts.signals ?? defaultSignals).map((s) => {
    try {
      return s(profile, now);
    } catch {
      // Malformed or outdated data for one check should leave that check out, not take the whole result down.
      return { id: s.name || "unknown", score: null, weight: 0, reason: "This check hit an error and was skipped" };
    }
  });
  const base = { artistKey: profile.key, artistName: profile.name, signals: results };

  const decisive = results.find((r) => r.decisive && r.score !== null && r.score >= 0.95);
  if (decisive) {
    return { ...base, score: decisive.score, confidence: 1, verdict: verdictFor(decisive.score) };
  }

  const active = results.filter((r) => r.score !== null && r.weight > 0);
  const totalWeight = active.reduce((n, r) => n + r.weight, 0);
  if (totalWeight === 0) {
    return { ...base, score: null, confidence: 0, verdict: "unknown" };
  }
  const score = clamp01(active.reduce((n, r) => n + r.score! * r.weight, 0) / totalWeight);
  const confidence = clamp01(totalWeight / FULL_EVIDENCE_WEIGHT);
  return { ...base, score, confidence, verdict: verdictFor(score) };
}

/** Below this the score is already clearly human, above the upper bound clearly AI: no need to spend YouTube quota. */
export const YOUTUBE_UNCERTAIN_BAND = { low: 0.12, high: 0.75 };

/** Is the evidence so far uncertain enough to be worth a YouTube search? */
export function needsYouTube(report: ScoreReport): boolean {
  if (report.signals.some((s) => s.decisive && s.score !== null && s.score >= 0.95)) return false;
  return report.score === null || (report.score >= YOUTUBE_UNCERTAIN_BAND.low && report.score <= YOUTUBE_UNCERTAIN_BAND.high);
}
