export interface AlbumInfo {
  id: string;
  title: string;
  /** ISO date (YYYY-MM-DD) */
  releaseDate: string;
  trackCount: number;
  recordType?: string;
  label?: string;
}

export interface TrackSummary {
  title: string;
  durationSec: number;
}

export interface MusicBrainzInfo {
  /** Artist found on MusicBrainz */
  artistFound: boolean;
  /** Number of external URL relations (official site, socials, Discogs, ...) */
  urlCount: number;
  /** Whether the artist has a life-span/begin date or area filled in */
  hasBackground: boolean;
  /** Recording matched by ISRC exists on MusicBrainz */
  recordingFound: boolean;
  /** Count of credit relations (producer, composer, ...) on the recording */
  creditCount: number;
}

export interface CrowdInfo {
  /** Sum of user weights voting "ai" */
  aiWeight: number;
  /** Sum of user weights voting "human" */
  humanWeight: number;
}

export interface LabelStats {
  /** Distinct artists seen on this label */
  artists: number;
  /** Of those, how many the crowd flagged as AI */
  flaggedArtists: number;
}

export interface ArtistProfile {
  /** Stable key, e.g. "spotify:<id>" or "deezer:<id>" */
  key: string;
  name: string;
  albums: AlbumInfo[];
  topTracks: TrackSummary[];
  fans?: number;
  /** Spotify "AI Persona" badge, when known */
  spotifyAiPersona?: boolean;
  musicBrainz?: MusicBrainzInfo;
  crowd?: CrowdInfo;
  labelStats?: LabelStats;
}

export interface SignalResult {
  id: string;
  /** 0 = human-like, 1 = AI-like. null = no opinion (not enough data) */
  score: number | null;
  /** Relative importance when combining */
  weight: number;
  reason: string;
  /** If true and score is extreme, the engine uses this signal alone */
  decisive?: boolean;
}

export type Verdict = "likely-ai" | "suspicious" | "likely-human" | "unknown";

export interface ScoreReport {
  artistKey: string;
  artistName: string;
  /** 0..1 AI likelihood, null when verdict is unknown */
  score: number | null;
  /** 0..1 how much evidence backs the score */
  confidence: number;
  verdict: Verdict;
  signals: SignalResult[];
}

export type Signal = (profile: ArtistProfile, now: Date) => SignalResult;
