# spotify-AI-detector

Detects likely AI-generated music on Spotify by combining several independent signals, spam-filter style. No single signal is trusted on its own.

Paste a Spotify or YouTube link (or type an artist name) and get a score with the reasons behind it.

> **Status:** early but working end to end. See [Limitations](#limitations).

## How it scores

Each signal returns a 0–1 AI-likelihood (or "no opinion") plus a human-readable reason. The engine takes a weighted average and reports a confidence based on how much evidence it had.

| Signal | What it looks at | Source |
| --- | --- | --- |
| Spotify AI Persona badge | Decisive when present | Spotify (not wired up yet, see Limitations) |
| Crowd votes | Weighted community votes; voters who agree with consensus gain weight | This server |
| Release velocity | Distinct release dates and tracks in the last 12 months (reissues collapsed, label EP dumps on one day count once) | Deezer |
| External presence | MusicBrainz entry, external links, background info | MusicBrainz |
| Credits | Producer/writer credits on the recording | MusicBrainz |
| Uniformity | Near-identical track lengths across a catalog | Deezer |
| Label clustering | Share of a label's artists the crowd flagged | This server |

Tracks are matched across services by ISRC. Deezer's public API does **not** expose Deezer's own AI tag, so it is not used.

## How a link becomes a score

1. **Spotify link:** the public page's metadata gives track and artist (no Spotify login or API key needed).
2. **YouTube link:** oEmbed gives title and channel; "Artist - Topic" channels and "Artist - Title (Official Video)" titles are cleaned.
3. The track is matched to Deezer by title and artist. Near-exact matches are shown as confident; anything weaker is labelled "best guess" and alternatives are offered. If nothing plausible matches, nothing is scored.
4. The Deezer track's ISRC is used to look up credits on MusicBrainz, and the artist's catalog is scored.

Votes are keyed on the Deezer artist, so Spotify and YouTube checks of the same artist share one community tally.

## Layout

```
packages/
  core/     scoring engine, signals, Deezer + MusicBrainz providers
  server/   HTTP API + link resolver + votes/blocklist (SQLite), also serves the web app
  client/   small typed client for the server API
  cli/      `aid` command line tool
  web/      checker page (/) and playlist cleaner (/cleaner.html)
```

## Getting started

Needs Node 22.13+ (uses the built-in `node:sqlite`) and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev                # server + web app with auto-reload; opens http://127.0.0.1:5173/
```

Paste a link on the page. Results are shareable: `/?q=<link>`.

Other commands:

```sh
pnpm test               # unit tests
pnpm typecheck
pnpm start              # production-style: build the web app, then serve everything from http://127.0.0.1:8787/
```

`pnpm dev` runs the API on port 8787 and Vite on 5173, which proxies `/api` to it. The database is `aid.sqlite` in the repo root; delete it to reset votes and cached lookups.

### CLI

```sh
pnpm cli artist "Breaking Rust"
pnpm cli isrc USRC17607839
pnpm cli artist "Some Artist" --no-mb --json
```

### Playlist cleaner

At `/cleaner.html`. It logs in with Spotify and writes a cleaned copy of a playlist or Liked Songs.

1. Create an app at the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and add `http://127.0.0.1:5173/` (dev) or your site's `/cleaner.html` URL as a redirect URI.
2. Open the page, paste your Client ID, log in, pick a source, scan, adjust the threshold, and create the cleaned playlist.

Spotify's Development Mode limits apply here: the app owner needs Premium and new apps are capped at 5 users. The checker page has no such limit because it doesn't use the Spotify API.

### Shared blocklist

`GET /api/blocklist` returns artists the crowd agrees are AI (JSON, or `?format=txt` for `key<TAB>name` lines).

### Hosting

Environment variables: `PORT`, `HOST` (default `127.0.0.1`), `DB_PATH`, `STATIC_DIR`, `TRUST_PROXY=1` (only behind a reverse proxy you control, so rate limiting sees real client IPs). Expensive endpoints are limited to 40 requests/minute per client. Put HTTPS in front of it.

## Server API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/check?q=<link or text>` | Resolve a Spotify/YouTube link or `Artist - Song` and score it |
| `GET /api/check?deezerTrack=<id>` | Score a specific Deezer track (used to pick an alternative) |
| `GET /api/score?isrc=` | Score one track's artist |
| `POST /api/score/batch` `{tracks:[{isrc}]}` | Up to 50 at once |
| `POST /api/vote` `{artistKey, vote}` + `X-User-Id` | Vote `ai` or `human` |
| `GET /api/blocklist` | Crowd-flagged artists |

MusicBrainz allows ~1 request/second, so those lookups run in the background. The first response for a new artist has `pending: true` and a lower-confidence score; ask again a few seconds later.

## Limitations

- **Metadata alone misses some AI acts.** The Velvet Sundown, for example, scores as human (3 releases, documented on MusicBrainz). Catching cases like that is the job of crowd votes, Spotify's badge and, later, audio analysis. Treat the result as an estimate, not proof; the page says so.
- **Human false positives are possible.** Labels that repackage back catalogs, or prolific real artists, can look like AI release patterns. Release velocity is only one weighted signal and reissues are collapsed, but expect some misses in both directions.
- **YouTube matching is fuzzy.** Covers, remixes, fan uploads and live videos may match the wrong track or nothing. The page flags low-confidence matches and offers alternatives.
- **Only tracks on Deezer can be scored.**
- **Spotify AI Persona badge:** the signal exists but nothing feeds it yet. It is unclear whether Spotify exposes the label through any API.
- **No audio analysis yet.** Planned as a tie-breaker for uncertain tracks.
- **Votes are not sybil-resistant.** Reputation weighting helps, but anonymous IDs are cheap. Treat the crowd signal as advisory until there is real abuse protection.
- **MusicBrainz is slow** (~1 request/second), so a new artist's first result is preliminary and refines itself after a few seconds.
- **Scraping:** Spotify link resolution reads public page metadata, which Spotify can change at any time.
