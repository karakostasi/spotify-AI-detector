import type { DatabaseSync } from "node:sqlite";
import type { CrowdInfo, LabelStats } from "@aid/core";

export type Vote = "ai" | "human";

/** Votes needed on an artist before it counts as "consensus" for reputation. */
const CONSENSUS_MIN_VOTES = 5;
/** Resolved votes a user needs before their weight moves off the default. */
const REPUTATION_MIN_VOTES = 5;
export const BLOCKLIST_MIN_WEIGHT = 5;
export const BLOCKLIST_MIN_RATIO = 0.8;

interface VoteRow { user_id: string; artist_key: string; vote: Vote }

export class Crowd {
  constructor(private db: DatabaseSync) {}

  castVote(userId: string, artistKey: string, vote: Vote, now = Date.now()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO votes (user_id, artist_key, vote, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, artistKey, vote, now);
  }

  /** Unweighted majority per artist, only for artists with enough votes. */
  private consensus(): Map<string, Vote> {
    const rows = this.db
      .prepare("SELECT artist_key, SUM(vote='ai') AS ai, SUM(vote='human') AS human FROM votes GROUP BY artist_key")
      .all() as { artist_key: string; ai: number; human: number }[];
    const out = new Map<string, Vote>();
    for (const r of rows) {
      if (r.ai + r.human >= CONSENSUS_MIN_VOTES && r.ai !== r.human) out.set(r.artist_key, r.ai > r.human ? "ai" : "human");
    }
    return out;
  }

  /** New users weigh 1; once enough of their votes can be checked, weight tracks how often they agree with consensus (0.5..2.5). */
  private userWeights(votes: VoteRow[], consensus: Map<string, Vote>): Map<string, number> {
    const stats = new Map<string, { agree: number; total: number }>();
    for (const v of votes) {
      const c = consensus.get(v.artist_key);
      if (!c) continue;
      const s = stats.get(v.user_id) ?? { agree: 0, total: 0 };
      s.total++;
      if (c === v.vote) s.agree++;
      stats.set(v.user_id, s);
    }
    const w = new Map<string, number>();
    for (const [u, s] of stats) w.set(u, s.total >= REPUTATION_MIN_VOTES ? 0.5 + 2 * (s.agree / s.total) : 1);
    return w;
  }

  private allVotes(): VoteRow[] {
    return this.db.prepare("SELECT user_id, artist_key, vote FROM votes").all() as unknown as VoteRow[];
  }

  private tally(votes: VoteRow[], weights: Map<string, number>): Map<string, CrowdInfo> {
    const out = new Map<string, CrowdInfo>();
    for (const v of votes) {
      const c = out.get(v.artist_key) ?? { aiWeight: 0, humanWeight: 0 };
      const w = weights.get(v.user_id) ?? 1;
      if (v.vote === "ai") c.aiWeight += w;
      else c.humanWeight += w;
      out.set(v.artist_key, c);
    }
    return out;
  }

  /** Weighted tallies for every artist with votes. */
  tallies(): Map<string, CrowdInfo> {
    const votes = this.allVotes();
    return this.tally(votes, this.userWeights(votes, this.consensus()));
  }

  forArtist(artistKey: string): CrowdInfo | undefined {
    return this.tallies().get(artistKey);
  }

  recordArtist(artistKey: string, name: string, label?: string): void {
    this.db
      .prepare("INSERT INTO artists (artist_key, name, label) VALUES (?, ?, ?) ON CONFLICT(artist_key) DO UPDATE SET name = excluded.name, label = COALESCE(excluded.label, label)")
      .run(artistKey, name, label ?? null);
  }

  private isFlagged(c: CrowdInfo | undefined): boolean {
    if (!c) return false;
    const total = c.aiWeight + c.humanWeight;
    return total >= BLOCKLIST_MIN_WEIGHT && c.aiWeight / total >= BLOCKLIST_MIN_RATIO;
  }

  labelStats(label: string): LabelStats {
    const keys = (this.db.prepare("SELECT artist_key FROM artists WHERE label = ?").all(label) as { artist_key: string }[]).map((r) => r.artist_key);
    const t = this.tallies();
    return { artists: keys.length, flaggedArtists: keys.filter((k) => this.isFlagged(t.get(k))).length };
  }

  blocklist(): { key: string; name: string; aiWeight: number; humanWeight: number }[] {
    const t = this.tallies();
    const names = new Map((this.db.prepare("SELECT artist_key, name FROM artists").all() as { artist_key: string; name: string }[]).map((r) => [r.artist_key, r.name]));
    return [...t]
      .filter(([, c]) => this.isFlagged(c))
      .map(([key, c]) => ({ key, name: names.get(key) ?? key, ...c }))
      .sort((a, b) => b.aiWeight - a.aiWeight);
  }
}
