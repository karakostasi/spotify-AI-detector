import { DEFAULT_SERVER, DetectorClient, getUserId, type CheckResponse, type Report } from "@aid/client";

const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const client = new DetectorClient(localStorage.getItem("aid.server") || DEFAULT_SERVER, getUserId(localStorage));

const LABEL: Record<string, string> = { "likely-ai": "Likely AI", suspicious: "Suspicious", "likely-human": "Likely human", unknown: "Not enough evidence" };
const SOURCE: Record<string, string> = { spotify: "Spotify", youtube: "YouTube", text: "your search" };
const MAX_REFRESH = 6;

app.innerHTML = `
  <a href="/"><img class="banner" src="/logo.png" alt="AI Music Detector" width="900" height="600" /></a>
  <form id="form">
    <input type="text" id="q" placeholder="Paste a Spotify or YouTube link, or type an artist name, to see how likely the music is AI-generated" aria-label="Spotify or YouTube link, or artist name" autocomplete="off" />
    <button type="submit" id="go">Check</button>
  </form>
  <div id="result"></div>
  <a class="cta" href="/cleaner.html">
    <span class="cta-title">Clean a whole playlist →</span>
    <span class="cta-sub">Scan your Spotify playlists or Liked Songs and remove likely-AI tracks</span>
  </a>
  <p class="muted small footnote">An estimate from public metadata and community votes, not proof.</p>`;

const input = document.getElementById("q") as HTMLInputElement;
const result = document.getElementById("result")!;
let run = 0; // guards against out-of-order responses
let refreshTimer: number | undefined;

// ---- busy state: the search runs until the slower sources (MusicBrainz, Wikidata, ...) have answered
const goButton = document.getElementById("go") as HTMLButtonElement;
let busy = false;
let startedAt = 0;
let progressTimer: number | undefined;

/** We don't know how long the sources take, so ease towards 95% and only finish when they're done. */
const currentProgress = () => Math.min(95, Math.round(100 * (1 - Math.exp(-(Date.now() - startedAt) / 9000))));
const progressBar = (label: string) =>
  `<div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${currentProgress()}"><i style="width:${currentProgress()}%"></i></div>`;

function tickProgress() {
  const p = currentProgress();
  document.querySelectorAll<HTMLElement>("#result .progress").forEach((bar) => {
    bar.setAttribute("aria-valuenow", String(p));
    (bar.firstElementChild as HTMLElement).style.width = `${p}%`;
  });
}

function setBusy(b: boolean) {
  busy = b;
  goButton.disabled = b;
  goButton.textContent = b ? "Checking…" : "Check";
  input.disabled = b;
  result.querySelectorAll<HTMLButtonElement>("button").forEach((x) => (x.disabled = b));
  if (b && progressTimer === undefined) progressTimer = window.setInterval(tickProgress, 250);
  if (!b) {
    clearInterval(progressTimer);
    progressTimer = undefined;
  }
}

async function check(q: string, loader: () => Promise<CheckResponse>, refresh = 0) {
  clearTimeout(refreshTimer);
  const mine = ++run;
  if (refresh === 0) {
    startedAt = Date.now();
    result.innerHTML = `<section><p class="muted">Checking…</p>${progressBar("Checking sources")}</section>`;
  }
  setBusy(true);
  let r: CheckResponse;
  try {
    r = await loader();
  } catch (e) {
    if (mine === run) {
      setBusy(false);
      result.innerHTML = `<section class="err">${esc((e as Error).message)}</section>`;
    }
    return;
  }
  if (mine !== run) return;
  // Done once the slow sources have answered, or after the last refresh (a source may never answer).
  const settled = !r.report?.pending || refresh >= MAX_REFRESH;
  if (settled) setBusy(false);
  render(r, q, settled);
  if (!settled) refreshTimer = window.setTimeout(() => void check(q, loader, refresh + 1), 4000);
}

function explain(r: Report): string {
  if (r.verdict === "unknown") return "There isn't enough public data about this artist to say either way.";
  const lowConf = r.confidence < 0.5 ? " We have little data on this artist, so treat it as a rough guess." : "";
  if (r.verdict === "likely-ai") return "Several signals point to AI-generated music." + lowConf;
  if (r.verdict === "suspicious") return "Some signals look like AI, but it isn't clear-cut." + lowConf;
  return "This looks like a real, established artist." + lowConf;
}

function render(c: CheckResponse, q: string, settled: boolean) {
  const r = c.report;
  const parts: string[] = [];
  if (c.error && !r) parts.push(`<section class="err">${esc(c.error)}</section>`);
  if (c.input && !c.track && !r) parts.push(`<p class="muted small">Looked for: ${esc(c.input.artist)}${c.input.title ? " – " + esc(c.input.title) : ""} (from ${SOURCE[c.input.source]})</p>`);

  if (c.alternatives.length) {
    parts.push(`<section><p>${r ? "Not the right track?" : "Did you mean one of these?"}</p>${c.alternatives
      .map((a) => `<button class="secondary alt" data-id="${a.deezerTrackId}">${esc(a.artist)} – ${esc(a.title)}</button>`)
      .join(" ")}</section>`);
  }

  if (r) {
    const pct = r.score === null ? null : Math.round(r.score * 100);
    const what = c.track ? `<b>${esc(c.track.title)}</b> by <b>${esc(c.track.artist)}</b>` + (c.track.album ? ` <span class="muted">· ${esc(c.track.album)}</span>` : "") : `Artist <b>${esc(r.artistName)}</b>`;
    parts.unshift(`
      <section>
        <div class="who">
          ${r.artistImage ? `<img class="artist-img" src="${esc(r.artistImage)}" alt="${esc(r.artistName)}" width="96" height="96" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
          <div>
            <p class="small muted">${c.input ? `From ${SOURCE[c.input.source]}` : ""}${c.track && !c.confident ? " · <b>best guess, double-check this is the right song</b>" : ""}</p>
            <p>${what}</p>
          </div>
        </div>
        ${
          r.pending && !settled
            ? `<p><span class="badge big unknown">Gathering more data…</span></p>${progressBar("Checking more sources")}<p class="muted">Preliminary: ${pct === null ? "no score yet" : `${pct}% AI score`}. Checking more sources, this updates automatically.</p>`
            : `<p><span class="badge big ${r.verdict}">${LABEL[r.verdict]}</span> ${pct === null ? "" : `<span class="pct">${pct}% AI score</span>`}</p><p>${explain(r)}</p>${
                r.pending ? `<p class="muted small">Some sources hadn't answered yet, so this is the best estimate so far. Check again in a minute for a sharper score.</p>` : ""
              }`
        }
        <p class="small muted">Why:</p>
        <ul class="signals">${r.signals
          .map((s) => `<li class="${s.score === null ? "nodata" : ""}"><span class="bar"><i style="width:${s.score === null ? 0 : Math.round(s.score * 100)}%"></i></span>${esc(s.reason)}</li>`)
          .join("")}</ul>
      </section>
      <section id="vote">
        <p>What do you think? Votes from people with a good track record count for more.</p>
        <button class="secondary" data-v="ai">This artist is AI</button> <button class="secondary" data-v="human">This artist is human</button>
        <span id="voteMsg" class="muted small"></span>
      </section>`);
  }
  parts.push(`<p class="again-wrap"><button type="button" id="again">Check another</button></p>`);
  result.innerHTML = parts.join("");
  // buttons stay locked while the checks are still running
  result.querySelectorAll<HTMLButtonElement>("button").forEach((x) => (x.disabled = busy));
  document.getElementById("again")!.onclick = reset;

  result.querySelectorAll<HTMLButtonElement>("button.alt").forEach((b) => {
    b.onclick = () => void check(q, () => client.checkTrack(Number(b.dataset.id)));
  });
  result.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
    b.onclick = async () => {
      const msg = document.getElementById("voteMsg")!;
      try {
        await client.vote(r!.artistKey, b.dataset.v as "ai" | "human");
        msg.textContent = "Thanks, vote recorded.";
      } catch (e) {
        msg.innerHTML = `<span class="err">${esc((e as Error).message)}</span>`;
      }
    };
  });
}

/** Clear the input and result, cancel any pending refresh, and get ready for the next link. */
function reset() {
  clearTimeout(refreshTimer);
  run++;
  setBusy(false);
  input.value = "";
  result.innerHTML = "";
  history.replaceState({}, "", location.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
}

// Selecting on focus lets you paste a new link straight over the previous one.
input.addEventListener("focus", () => input.select());

function submit(q: string) {
  q = q.trim();
  if (!q) return;
  history.replaceState({}, "", `?q=${encodeURIComponent(q)}`);
  void check(q, () => client.check(q));
}

document.getElementById("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  submit(input.value);
});

const initial = new URLSearchParams(location.search).get("q");
if (initial) {
  input.value = initial;
  submit(initial);
}
