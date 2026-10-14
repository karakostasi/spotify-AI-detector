import { DEFAULT_SERVER, loadConfig, loadPlaylist, scorePlaylist, type PlaylistInfo, type PlaylistScore } from "@aid/client";
import { CREATE_PLAYLIST_SCOPE, Spotify, completeLogin, redirectUri, startLogin } from "./spotify.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PENDING = "aid.pendingClean";

export const PLAYLIST_LINK = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/i;

/** What the playlist scanner needs from the page around it. */
export interface Host {
  result: HTMLElement;
  /** False once the user starts something else, so a slow scan never overwrites newer results */
  isCurrent: () => boolean;
  busy: (b: boolean) => void;
  /** A fixed 0..100 progress, or null for the page's default estimate */
  progress: (pct: number | null) => void;
}

interface Row {
  uri: string;
  title: string;
  artists: string;
  score: PlaylistScore;
}

interface Pending {
  url: string;
  /** Tracks the user chose to keep even though they were flagged */
  keep: string[];
  includeSuspicious: boolean;
}

const base = () => localStorage.getItem("aid.server") || DEFAULT_SERVER;

/** Scan a playlist link and render the results into host.result. Pass `resume` to finish a clean after logging in. */
export async function scanPlaylist(id: string, url: string, host: Host, resume?: Pending): Promise<void> {
  host.busy(true);
  host.progress(2);
  host.result.innerHTML = `<section><p class="muted" id="plStatus">Reading the playlist…</p>${bar()}</section>`;
  let playlist: PlaylistInfo;
  let rows: Row[];
  try {
    playlist = await loadPlaylist(base(), id);
    const status = () => document.getElementById("plStatus");
    if (status()) status()!.textContent = `Scanning ${playlist.tracks.length} tracks…`;
    // Many tracks share an artist and the server caches by artist, but sending each once keeps requests small.
    const items = playlist.tracks.map((t) => ({ id: t.uri, title: t.title, artists: t.artists }));
    const scores = await scorePlaylist(base(), items, (done, total) => {
      host.progress(5 + Math.round((95 * done) / total));
      const el = status();
      if (el) el.textContent = `Scanned ${done} of ${total} tracks…`;
    });
    rows = playlist.tracks.map((t) => ({ ...t, score: scores[t.uri]! }));
  } catch (e) {
    if (host.isCurrent()) {
      host.busy(false);
      host.result.innerHTML = `<section class="err">${esc((e as Error).message)}</section>`;
    }
    return;
  }
  if (!host.isCurrent()) return;
  host.progress(null);
  host.busy(false);
  new Results(playlist, rows, url, host, resume).render();
}

const bar = () => `<div class="progress" role="progressbar" aria-label="Scanning playlist" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="width:0%"></i></div>`;

class Results {
  private includeSuspicious: boolean;
  /** Flagged tracks the user wants to keep */
  private keep: Set<string>;

  constructor(private pl: PlaylistInfo, private rows: Row[], private url: string, private host: Host, resume?: Pending) {
    this.includeSuspicious = resume?.includeSuspicious ?? false;
    this.keep = new Set(resume?.keep ?? []);
    if (resume) void this.clean(); // came back from logging in: finish what was asked
  }

  private flagged = () =>
    this.rows.filter((r) => r.score.matched && (r.score.verdict === "likely-ai" || (this.includeSuspicious && r.score.verdict === "suspicious")));
  private toRemove = () => this.flagged().filter((r) => !this.keep.has(r.uri));

  render(message = "") {
    const flagged = this.flagged();
    const unmatched = this.rows.filter((r) => !r.score.matched).length;
    const suspiciousCount = this.rows.filter((r) => r.score.verdict === "suspicious").length;
    const remove = this.toRemove();
    const li = (r: Row) => {
      const pct = r.score.score === null ? "" : `${Math.round(r.score.score * 100)}%`;
      return `<li class="plrow">
        <label><input type="checkbox" data-uri="${esc(r.uri)}" ${this.keep.has(r.uri) ? "" : "checked"} /> <span><b>${esc(r.title)}</b> <span class="muted">${esc(r.artists)}</span>
          <br><span class="badge ${r.score.verdict}">${pct} ${r.score.verdict === "likely-ai" ? "likely AI" : "suspicious"}</span>
          <span class="muted small">${esc(r.score.reasons[0] ?? "")}</span></span></label>
      </li>`;
    };

    this.host.result.innerHTML = `
      <section>
        <p class="small muted">Playlist</p>
        <p><b>${esc(this.pl.name)}</b> <span class="muted">· ${this.rows.length} tracks scanned</span></p>
        ${flagged.length
          ? `<p><span class="badge big likely-ai">${flagged.length} of ${this.rows.length} tracks look AI-generated</span></p>`
          : `<p><span class="badge big likely-human">No AI tracks found</span></p><p class="muted">Nothing in this playlist scored as likely AI-generated.</p>`}
        ${this.pl.capped ? `<p class="muted small">Spotify only shows the first 100 tracks of a playlist, so anything after that was not scanned.</p>` : ""}
        ${unmatched ? `<p class="muted small">${unmatched} track${unmatched === 1 ? "" : "s"} couldn't be matched to an artist (not on Deezer, or an unusual title) and ${unmatched === 1 ? "was" : "were"} not scored.</p>` : ""}
        ${suspiciousCount || this.includeSuspicious
          ? `<label class="small muted"><input type="checkbox" id="plSusp" ${this.includeSuspicious ? "checked" : ""} /> Also flag borderline tracks (${suspiciousCount})</label>`
          : ""}
      </section>
      ${flagged.length ? `<section>
        <p>Tick the tracks to remove. Untick any you want to keep.</p>
        <ul class="pllist">${flagged.map(li).join("")}</ul>
        ${this.cleanArea(remove.length)}
        ${message}
      </section>` : ""}
      <p class="again-wrap"><button type="button" id="again">Check another</button></p>`;
    this.bind();
  }

  private cleanArea(n: number) {
    const loggedIn = sessionStorage.getItem("token") !== null && JSON.parse(sessionStorage.getItem("token")!).exp > Date.now();
    if (!n) return `<p class="muted small">Nothing selected to remove.</p>`;
    return `<div id="cleanArea">
      <button type="button" id="clean">${loggedIn ? `Create a clean copy without these ${n}` : `Log in with Spotify to create a clean copy (${n} removed)`}</button>
      <p class="muted small">Your original playlist is never changed. We create a new private playlist named “${esc(this.pl.name)} (AI-free)”.${loggedIn ? "" : " Logging in lets us create it for you, and asks only for permission to create playlists."}</p>
    </div>`;
  }

  private bind() {
    const root = this.host.result;
    root.querySelectorAll<HTMLInputElement>("input[data-uri]").forEach((box) => {
      box.onchange = () => {
        if (box.checked) this.keep.delete(box.dataset.uri!);
        else this.keep.add(box.dataset.uri!);
        this.render();
      };
    });
    const susp = document.getElementById("plSusp") as HTMLInputElement | null;
    if (susp) susp.onchange = () => ((this.includeSuspicious = susp.checked), this.render());
    const clean = document.getElementById("clean");
    if (clean) clean.onclick = () => void this.clean();
  }

  /** Create the clean copy, logging in first if needed. */
  private async clean() {
    const token = await completeLogin().catch(() => null);
    if (!token) return this.login();

    const button = document.getElementById("clean") as HTMLButtonElement | null;
    if (button) {
      button.disabled = true;
      button.textContent = "Creating your playlist…";
    }
    const remove = new Set(this.toRemove().map((r) => r.uri));
    const uris = this.rows.map((r) => r.uri).filter((u) => !remove.has(u));
    try {
      const link = await new Spotify(token).createPlaylistWith(`${this.pl.name} (AI-free)`, "Cleaned by AI Music Detector", uris);
      this.render(`<p class="ok">Done: removed ${remove.size} track${remove.size === 1 ? "" : "s"}, kept ${uris.length}. <a href="${esc(link)}" target="_blank" rel="noopener">Open your new playlist ↗</a></p>`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      this.render(`<p class="err">${esc(
        msg.includes("403")
          ? "Spotify said no. While this app is in development mode, only people the owner has added to it can log in. Ask them to add your Spotify email."
          : msg.includes("401")
            ? "Your Spotify login expired. Please log in again."
            : `Couldn't create the playlist: ${msg}`,
      )}</p>`);
    }
  }

  private async login() {
    const configured = (await loadConfig(base())).spotifyClientId;
    const clientId = configured ?? localStorage.getItem("aid.clientId");
    if (!clientId) {
      const area = document.getElementById("cleanArea")!;
      area.insertAdjacentHTML(
        "beforeend",
        `<p class="small">This site has no Spotify app set up yet. Paste a Client ID from your own app at the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify dashboard</a> (add <code>${esc(redirectUri())}</code> as a redirect URI):</p>
         <form id="cidForm"><input type="text" id="cid" placeholder="Client ID" /><button type="submit">Save and log in</button></form>`,
      );
      (document.getElementById("cidForm") as HTMLFormElement).onsubmit = (e) => {
        e.preventDefault();
        const v = (document.getElementById("cid") as HTMLInputElement).value.trim();
        if (v) {
          localStorage.setItem("aid.clientId", v);
          void this.login();
        }
      };
      return;
    }
    const pending: Pending = { url: this.url, keep: [...this.keep], includeSuspicious: this.includeSuspicious };
    sessionStorage.setItem(PENDING, JSON.stringify(pending));
    await startLogin(clientId, CREATE_PLAYLIST_SCOPE);
  }
}

/** After Spotify redirects back, pick up where the user left off. Returns the playlist link to rescan, if any. */
export async function pendingAfterLogin(): Promise<Pending | null> {
  const raw = sessionStorage.getItem(PENDING);
  if (!raw) return null;
  const token = await completeLogin().catch(() => null);
  if (!token) return null;
  sessionStorage.removeItem(PENDING);
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}
