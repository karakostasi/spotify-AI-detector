const AUTH = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const SCOPES = "playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-library-read";

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The only permission the main page needs: creating the cleaned copy. It cannot read your library. */
export const CREATE_PLAYLIST_SCOPE = "playlist-modify-private";

export const redirectUri = () => location.origin + location.pathname;

export async function startLogin(clientId: string, scope: string = SCOPES): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, state, clientId }));
  const q = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri(),
    scope, code_challenge_method: "S256", code_challenge: challenge, state,
  });
  location.href = `${AUTH}/authorize?${q}`;
}

/** Call on page load; returns an access token if we're mid-redirect or already logged in. */
export async function completeLogin(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (code) {
    const saved = JSON.parse(sessionStorage.getItem("pkce") ?? "null");
    history.replaceState({}, "", redirectUri());
    if (!saved || saved.state !== params.get("state")) throw new Error("Login state mismatch");
    const res = await fetch(`${AUTH}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: saved.clientId, grant_type: "authorization_code", code,
        redirect_uri: redirectUri(), code_verifier: saved.verifier,
      }),
    });
    if (!res.ok) throw new Error("Spotify login failed");
    const t = await res.json();
    sessionStorage.setItem("token", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 - 60000 }));
  }
  const stored = JSON.parse(sessionStorage.getItem("token") ?? "null");
  return stored && stored.exp > Date.now() ? stored.token : null;
}

export interface SpTrack {
  uri: string;
  name: string;
  isrc?: string;
  artistId?: string;
  artistName: string;
  isLocal: boolean;
}

export interface Source { id: string; name: string }

export class Spotify {
  constructor(private token: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2) * 1000));
      return this.req(path, init);
    }
    if (!res.ok) throw new Error(`Spotify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? (undefined as T) : res.json();
  }

  private async pages<T>(first: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = first;
    while (next) {
      const page: { items: T[]; next: string | null } = await this.req(next);
      out.push(...page.items);
      next = page.next;
    }
    return out;
  }

  async playlists(): Promise<Source[]> {
    const items = await this.pages<{ id: string; name: string }>("/me/playlists?limit=50");
    return items.map((p) => ({ id: p.id, name: p.name }));
  }

  private toTrack(t: any): SpTrack | null {
    if (!t || t.type === "episode") return null;
    return {
      uri: t.uri, name: t.name, isrc: t.external_ids?.isrc,
      artistId: t.artists?.[0]?.id, artistName: t.artists?.map((a: any) => a.name).join(", ") ?? "",
      isLocal: Boolean(t.is_local),
    };
  }

  async likedSongs(): Promise<SpTrack[]> {
    const items = await this.pages<{ track: unknown }>("/me/tracks?limit=50");
    return items.map((i) => this.toTrack(i.track)).filter((t): t is SpTrack => !!t);
  }

  /** Feb 2026 API renamed playlist `tracks` to `items` (and entry.track to entry.item); accept both. */
  async playlistTracks(id: string): Promise<SpTrack[]> {
    const items = await this.pages<{ item?: unknown; track?: unknown }>(`/playlists/${id}/items?limit=50`);
    return items.map((i) => this.toTrack(i.item ?? i.track)).filter((t): t is SpTrack => !!t);
  }

  async createPlaylistWith(name: string, description: string, uris: string[]): Promise<string> {
    const pl = await this.req<{ id: string; external_urls: { spotify: string } }>("/me/playlists", {
      method: "POST",
      body: JSON.stringify({ name, description, public: false }),
    });
    for (let i = 0; i < uris.length; i += 100) {
      await this.req(`/playlists/${pl.id}/items`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
    }
    return pl.external_urls.spotify;
  }
}
