import { DEFAULT_SERVER, DetectorClient, getUserId, type Report } from "@aid/client";
import { completeLogin, redirectUri, Spotify, startLogin, type SpTrack } from "./spotify.js";

const app = document.getElementById("app")!;
const ls = localStorage;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let spotify: Spotify | null = null;
let tracks: SpTrack[] = [];
let reports: Record<string, Report | null> = {};
let sourceName = "";

const client = () => new DetectorClient(ls.getItem("aid.server") || DEFAULT_SERVER, getUserId(ls));
const threshold = () => Number((document.getElementById("threshold") as HTMLInputElement | null)?.value ?? 70) / 100;
const flagged = (t: SpTrack) => {
  const r = t.isrc ? reports[t.isrc] : null;
  return !!r && r.score !== null && r.score >= threshold();
};

function renderLogin(error?: string) {
  app.innerHTML = `
    <p><a href="/">← Check a single track</a></p><a href="/"><img class="banner small" src="/logo.png" alt="AI Music Detector" width="900" height="600" /></a><h1>Playlist Cleaner</h1>
    <section>
      <label>Spotify app Client ID <input type="text" id="cid" value="${esc(ls.getItem("aid.clientId") ?? "")}" /></label>
      <label>Detector server URL (leave empty for this site) <input type="text" id="srv" value="${esc(ls.getItem("aid.server") ?? DEFAULT_SERVER)}" /></label>
      <p class="muted">Redirect URI to register in your Spotify app: <code>${esc(redirectUri())}</code></p>
      <button id="login">Log in with Spotify</button>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
    </section>`;
  document.getElementById("login")!.onclick = () => {
    const cid = (document.getElementById("cid") as HTMLInputElement).value.trim();
    ls.setItem("aid.clientId", cid);
    ls.setItem("aid.server", (document.getElementById("srv") as HTMLInputElement).value.trim());
    if (cid) void startLogin(cid);
  };
}

async function renderHome() {
  app.innerHTML = `<p><a href="/">← Check a single track</a></p><a href="/"><img class="banner small" src="/logo.png" alt="AI Music Detector" width="900" height="600" /></a><h1>Playlist Cleaner</h1><section id="pick">Loading playlists…</section><section id="out"></section>`;
  const playlists = await spotify!.playlists();
  document.getElementById("pick")!.innerHTML = `
    <label>Source <select id="src"><option value="liked">Liked Songs</option>${playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
    <button id="scan">Scan</button> <span id="status" class="muted"></span>`;
  document.getElementById("scan")!.onclick = () => {
    const sel = document.getElementById("src") as HTMLSelectElement;
    sourceName = sel.selectedOptions[0]!.text;
    void scan(sel.value).catch((e) => (document.getElementById("status")!.innerHTML = `<span class="err">${esc(String(e.message ?? e))}</span>`));
  };
}

async function scan(source: string) {
  const status = document.getElementById("status")!;
  status.textContent = "Reading tracks…";
  tracks = source === "liked" ? await spotify!.likedSongs() : await spotify!.playlistTracks(source);
  const seen = new Map<string, { isrc: string }>();
  for (const t of tracks) if (t.isrc && !seen.has(t.isrc)) seen.set(t.isrc, { isrc: t.isrc });
  reports = await client().score([...seen.values()], (d, n) => (status.textContent = `Scored ${d}/${n} unique tracks…`));
  status.textContent = `${tracks.length} tracks scanned.`;
  renderResults();
}

function renderResults() {
  const rows = tracks
    .map((t) => ({ t, r: t.isrc ? reports[t.isrc] ?? null : null }))
    .sort((a, b) => (b.r?.score ?? -1) - (a.r?.score ?? -1));
  const n = rows.filter((x) => flagged(x.t)).length;
  document.getElementById("out")!.innerHTML = `
    <label>Flag tracks scoring at or above <b id="tv">${Math.round(threshold() * 100)}%</b>
      <input type="range" id="threshold" min="30" max="95" value="${Math.round(threshold() * 100)}" /></label>
    <p><b>${n}</b> of ${tracks.length} flagged. <button id="clean" ${n ? "" : "disabled"}>Create cleaned playlist</button> <span id="cleanStatus" class="muted"></span></p>
    <table><tr><th>Track</th><th>Verdict</th><th>Vote</th></tr>
    ${rows
      .map(({ t, r }, i) => `<tr><td>${esc(t.name)}<br><span class="muted">${esc(t.artistName)}</span>
        ${r ? `<ul class="reasons">${r.signals.filter((s) => s.score !== null).map((s) => `<li>${esc(s.reason)} (${Math.round(s.score! * 100)}%)</li>`).join("")}</ul>` : ""}</td>
        <td>${r ? `<span class="badge ${r.verdict}">${r.verdict === "unknown" ? "unknown" : Math.round(r.score! * 100) + "% " + r.verdict.replace("likely-", "")}</span>${r.pending ? '<br><span class="muted">refining…</span>' : ""}` : `<span class="muted">${t.isrc ? "not found" : "no ISRC"}</span>`}</td>
        <td>${r ? `<button class="secondary" data-v="ai" data-i="${i}">AI</button> <button class="secondary" data-v="human" data-i="${i}">Human</button>` : ""}</td></tr>`)
      .join("")}
    </table>`;
  const slider = document.getElementById("threshold") as HTMLInputElement;
  slider.onchange = () => renderResults();
  document.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
    b.onclick = async () => {
      const r = rows[Number(b.dataset.i)]!.r!;
      b.disabled = true;
      try {
        await client().vote(r.artistKey, b.dataset.v as "ai" | "human");
        b.textContent = "✓";
      } catch (e) {
        b.textContent = "!";
        b.title = String((e as Error).message);
      }
    };
  });
  document.getElementById("clean")!.onclick = async () => {
    const keep = tracks.filter((t) => !flagged(t));
    const st = document.getElementById("cleanStatus")!;
    st.textContent = "Creating…";
    try {
      const url = await spotify!.createPlaylistWith(`${sourceName} (AI-free)`, "Cleaned by AI Music Detector", keep.filter((t) => !t.isLocal).map((t) => t.uri));
      st.innerHTML = `Done – <a href="${esc(url)}" target="_blank" rel="noopener">open playlist</a>`;
    } catch (e) {
      st.innerHTML = `<span class="err">${esc((e as Error).message)}</span>`;
    }
  };
}

(async () => {
  try {
    const token = await completeLogin();
    if (!token) return renderLogin();
    spotify = new Spotify(token);
    await renderHome();
  } catch (e) {
    renderLogin((e as Error).message);
  }
})();
