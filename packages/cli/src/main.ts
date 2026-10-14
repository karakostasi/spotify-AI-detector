#!/usr/bin/env node
import { lookupWebPresence, profileFromArtistName, profileFromIsrc, scoreArtist, type ScoreReport } from "@aid/core";

const USAGE = `Usage:
  aid isrc <ISRC>        Score the artist behind a track (ISRC is on Spotify's track page / API)
  aid artist <name>      Score an artist by name
Options:
  --no-mb                Skip MusicBrainz (faster, fewer signals)
  --no-web               Skip Wikipedia / setlist.fm / YouTube checks

Optional env keys: SETLISTFM_API_KEY (concert history), YOUTUBE_API_KEY (live videos)
  --json                 Print the raw report`;

const COLORS: Record<string, string> = { "likely-ai": "\x1b[31m", suspicious: "\x1b[33m", "likely-human": "\x1b[32m", unknown: "\x1b[90m" };
const RESET = "\x1b[0m";

function print(r: ScoreReport) {
  const pct = r.score === null ? "n/a" : `${Math.round(r.score * 100)}%`;
  console.log(`${r.artistName}  ${COLORS[r.verdict]}${r.verdict.toUpperCase()}${RESET}  AI score ${pct}  (confidence ${Math.round(r.confidence * 100)}%)`);
  for (const s of r.signals) {
    const v = s.score === null ? "  -  " : `${String(Math.round(s.score * 100)).padStart(3)}% `;
    console.log(`  ${s.id.padEnd(18)} ${v} ${s.reason}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [cmd, ...rest] = args.filter((a) => !a.startsWith("--"));
  const value = rest.join(" ");
  if (!cmd || !value) return void console.log(USAGE);

  const opts = { musicBrainz: flags.has("--no-mb") ? null : undefined };
  const profile =
    cmd === "isrc" ? await profileFromIsrc(value.toUpperCase(), opts) : cmd === "artist" ? await profileFromArtistName(value, opts) : undefined;
  if (profile === undefined) return void console.log(USAGE);
  if (!profile) {
    console.error("Not found on Deezer.");
    process.exitCode = 1;
    return;
  }
  if (!flags.has("--no-web")) {
    profile.web = { ...profile.web, ...(await lookupWebPresence(profile.name, {
      mbid: profile.musicBrainz?.artistId,
      setlistFmKey: process.env.SETLISTFM_API_KEY,
      youtubeKey: process.env.YOUTUBE_API_KEY,
    })) };
  }
  const report = scoreArtist(profile);
  if (flags.has("--json")) console.log(JSON.stringify(report, null, 2));
  else print(report);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
