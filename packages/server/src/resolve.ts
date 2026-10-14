import { Deezer, normalizeName, type DeezerTrack, type TrackHit } from "@aid/core";

export type Source = "spotify" | "youtube" | "text";

export type ParsedInput =
  | { kind: "spotify-track"; id: string }
  | { kind: "spotify-artist"; id: string }
  | { kind: "youtube"; id: string }
  | { kind: "text"; text: string };

export interface Hint {
  source: Source;
  title?: string;
  artist: string;
}

export interface Match {
  deezerTrackId: number;
  title: string;
  artist: string;
  album: string;
  /** 0..1 how well it matches what was asked for */
  similarity: number;
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YT_ID = /^[\w-]{11}$/;

/** Only ever builds URLs for fixed hosts from validated ids, so user input can't steer our fetches. */
export function parseInput(raw: string): ParsedInput | null {
  const text = raw.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return { kind: "text", text };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "open.spotify.com") {
    const m = /^\/(?:intl-[a-z-]+\/)?(track|artist)\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (m && SPOTIFY_ID.test(m[2]!)) return { kind: `spotify-${m[1] as "track" | "artist"}`, id: m[2]! };
    return null;
  }
  let id: string | null = null;
  if (host === "youtube.com") {
    id = u.searchParams.get("v") ?? /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
  } else if (host === "youtu.be") {
    id = u.pathname.slice(1, 12);
  }
  return id && YT_ID.test(id) ? { kind: "youtube", id } : null;
}

const NOISE = /\b(official|video|audio|lyrics?|lyric video|visualizer|hd|4k|hq|remaster(?:ed)?(?: \d{4})?|mv|m\/v|music video|full album)\b/i;

/** "Artist - Title (Official Video)" and "Artist - Topic" style YouTube metadata -> artist/title. */
export function cleanYouTube(title: string, author: string): Hint {
  const strip = (s: string) =>
    s
      .replace(/[([{][^)\]}]*[)\]}]/g, (m) => (NOISE.test(m) ? "" : m))
      .replace(/\s{2,}/g, " ")
      .trim();
  const channel = author.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
  const t = strip(title).replace(/\s+(?:M\/V|MV)\s*$/i, "");
  const m = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(t);
  if (m) return { source: "youtube", artist: m[1]!.trim(), title: m[2]!.trim() };
  return { source: "youtube", artist: channel, title: t };
}

export function parseSpotifyMeta(html: string): { title?: string; artist?: string } {
  const meta = (name: string) =>
    new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`, "i").exec(html)?.[1]?.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  return { title: meta("og:title"), artist: meta("music:musician_description") };
}

const words = (s: string) => new Set(normalizeName(s).split(" ").filter(Boolean));
function jaccard(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

/** Exact-ish artist match, but "Daft Punk & Pharrell" still matches the credited "Daft Punk" (the other way round does not). */
function artistMatch(hitArtist: string, hintArtist: string): number {
  const hit = ` ${normalizeName(hitArtist)} `;
  const hint = ` ${normalizeName(hintArtist)} `;
  const contained = hit.trim() !== "" && hint.includes(hit) ? 0.9 : 0;
  return Math.max(jaccard(hitArtist, hintArtist), contained);
}

/** Strict word match (intersection over union) after dropping remaster/version suffixes, so "Walk My Walk" != "Walk My Way". */
function titleMatch(a: string, b: string): number {
  const base = (t: string) =>
    normalizeName(t.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s-\s.*(remaster|version|edit|mix|live|mono|stereo|bonus).*$/i, " ").replace(/\s-\s(from|feat|ft|with|soundtrack)\b.*$/i, " ").replace(/\s(?:ft|feat|featuring)\.?\s.*$/i, " ").replace(/\b(remaster(ed)?|\d{4})\b/gi, " "));
  const x = words(base(a)), y = words(base(b));
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

export function similarity(hit: { title: string; artist: string }, hint: Hint): number {
  const a = artistMatch(hit.artist, hint.artist);
  if (!hint.title) return a;
  return 0.5 * titleMatch(hit.title, hint.title) + 0.5 * a;
}

export const CONFIDENT = 0.9;
/** Above 0.5, which is what a perfect artist match with a completely different song scores: that is "wrong song", not a match. */
export const PLAUSIBLE = 0.6;

export async function findMatches(dz: Deezer, hint: Hint): Promise<Match[]> {
  const clean = (s: string) => s.replace(/["]/g, " ").replace(/\s+/g, " ").trim();
  const queries = new Set<string>();
  if (hint.title) {
    // Feature credits, "(with X)" and "- From the film" suffixes confuse Deezer's search, so also try without them.
    const bare = clean(hint.title.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s-\s.*$/, " "));
    const lead = clean(hint.artist.split(/,|&| feat\.? /i)[0] ?? hint.artist);
    for (const [a, t] of [[clean(hint.artist), clean(hint.title)], [lead, bare], [clean(hint.artist), bare]] as const) {
      if (!a || !t) continue;
      queries.add(`artist:"${a}" track:"${t}"`);
      queries.add(`${a} ${t}`);
    }
  } else {
    queries.add(clean(hint.artist));
  }
  const seen = new Map<number, TrackHit>();
  for (const q of queries) {
    for (const h of await dz.searchTracks(q, 10).catch(() => [])) seen.set(h.id, h);
    if ([...seen.values()].some((h) => similarity({ title: h.title, artist: h.artist.name }, hint) >= CONFIDENT)) break;
  }
  return [...seen.values()]
    .map((h) => ({
      deezerTrackId: h.id,
      title: h.title,
      artist: h.artist.name,
      album: h.album.title,
      similarity: similarity({ title: h.title, artist: h.artist.name }, hint),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
}

type FetchText = (url: string) => Promise<{ ok: boolean; text: () => Promise<string>; json: () => Promise<any> }>;

export async function hintFromSpotify(f: FetchText, kind: "track" | "artist", id: string): Promise<Hint | null> {
  const res = await f(`https://open.spotify.com/${kind}/${id}`);
  if (!res.ok) return null;
  const m = parseSpotifyMeta(await res.text());
  if (kind === "artist") return m.title ? { source: "spotify", artist: m.title } : null;
  return m.title && m.artist ? { source: "spotify", title: m.title, artist: m.artist } : null;
}

export async function hintFromYouTube(f: FetchText, id: string): Promise<Hint | null> {
  const res = await f(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
  if (!res.ok) return null;
  const j = await res.json();
  return typeof j?.title === "string" ? cleanYouTube(j.title, String(j.author_name ?? "")) : null;
}

export function hintFromText(text: string): Hint {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(text);
  return m ? { source: "text", artist: m[1]!.trim(), title: m[2]!.trim() } : { source: "text", artist: text.trim() };
}

export type { DeezerTrack };
