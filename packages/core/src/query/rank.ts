import { nameSimilarity } from "./interpret.js";

export interface Candidate {
  label: string;
  description?: string;
  deezerArtistId?: number;
}

export interface Ranked<T extends Candidate> {
  candidate: T;
  /** Best similarity of the candidate's label to any searched name (0..1) */
  nameScore: number;
  /** Share of the clue groups the description satisfies (0..1) */
  clueScore: number;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter(Boolean));

/**
 * Orders candidates by how well the label matches a searched name, then by how well the description fits the clues
 * ("guitarist" for "john williams guitar"). Only candidates that actually carry a clue-matching description are
 * placed ahead of the others, and ties go to the one we can already link to a Deezer artist.
 */
export function rankCandidates<T extends Candidate>(candidates: T[], names: string[], clues: string[][]): Ranked<T>[] {
  return candidates
    .map((candidate) => {
      const nameScore = Math.max(0, ...names.map((n) => nameSimilarity(candidate.label, n)));
      const d = words(candidate.description ?? "");
      const clueScore = clues.length ? clues.filter((group) => group.some((w) => d.has(w))).length / clues.length : 0;
      return { candidate, nameScore, clueScore };
    })
    .sort(
      (a, b) =>
        Number(b.nameScore >= 0.85) - Number(a.nameScore >= 0.85) ||
        b.clueScore - a.clueScore ||
        b.nameScore - a.nameScore ||
        Number(b.candidate.deezerArtistId !== undefined) - Number(a.candidate.deezerArtistId !== undefined),
    );
}
