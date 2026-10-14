export interface PlaylistTrack {
  /** spotify:track:<id>, ready to add to another playlist */
  uri: string;
  title: string;
  /** All artists as Spotify shows them, e.g. "Ashe, FINNEAS" */
  artists: string;
}

export interface PlaylistInfo {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
  /** Spotify's public embed shows at most 100 tracks, so a full list means there may be more */
  capped: boolean;
}

export const EMBED_CAP = 100;
export const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;

interface EmbedTrack {
  uri?: unknown;
  title?: unknown;
  subtitle?: unknown;
}

/**
 * Reads the tracks from Spotify's public embed page, which needs no login. Spotify's API no longer returns the
 * contents of playlists you don't own, so this is the only way to read a playlist someone shares a link to.
 * Returns null when the page isn't in the expected shape (Spotify can change it at any time).
 */
export function parsePlaylistEmbed(html: string, id: string): PlaylistInfo | null {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let entity: { name?: unknown; trackList?: EmbedTrack[] } | undefined;
  try {
    entity = JSON.parse(m[1]!)?.props?.pageProps?.state?.data?.entity;
  } catch {
    return null;
  }
  if (!entity || typeof entity.name !== "string" || !Array.isArray(entity.trackList)) return null;

  const tracks: PlaylistTrack[] = [];
  for (const t of entity.trackList) {
    // episodes and local files have other uri shapes and can't be matched or copied
    if (typeof t.uri !== "string" || !/^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri)) continue;
    if (typeof t.title !== "string" || typeof t.subtitle !== "string") continue;
    tracks.push({ uri: t.uri, title: t.title.trim(), artists: t.subtitle.replace(/ /g, " ").trim() });
  }
  return { id, name: entity.name.trim(), tracks, capped: entity.trackList.length >= EMBED_CAP };
}

type FetchText = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export async function fetchPlaylist(f: FetchText, id: string): Promise<PlaylistInfo | null> {
  if (!PLAYLIST_ID.test(id)) return null;
  const res = await f(`https://open.spotify.com/embed/playlist/${id}`);
  return res.ok ? parsePlaylistEmbed(await res.text(), id) : null;
}
