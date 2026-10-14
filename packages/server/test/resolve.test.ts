import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIDENT, PLAUSIBLE, cleanYouTube, parseInput, parseSpotifyMeta, similarity } from "../src/resolve.js";

const ID = "4uLU6hMCjMI75M1A2tKUQC";

test("parseInput accepts known link shapes", () => {
  assert.deepEqual(parseInput(`https://open.spotify.com/track/${ID}?si=x`), { kind: "spotify-track", id: ID });
  assert.deepEqual(parseInput(`https://open.spotify.com/intl-de/track/${ID}`), { kind: "spotify-track", id: ID });
  assert.deepEqual(parseInput(`https://open.spotify.com/artist/${ID}`), { kind: "spotify-artist", id: ID });
  assert.deepEqual(parseInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"), { kind: "youtube", id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseInput("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), { kind: "youtube", id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseInput("https://youtu.be/dQw4w9WgXcQ"), { kind: "youtube", id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseInput("https://www.youtube.com/shorts/dQw4w9WgXcQ"), { kind: "youtube", id: "dQw4w9WgXcQ" });
  assert.deepEqual(parseInput("  Rick Astley  "), { kind: "text", text: "Rick Astley" });
});

test("parseInput rejects other hosts, bad ids and lookalikes", () => {
  assert.equal(parseInput("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseInput("https://evil.com/open.spotify.com/track/" + ID), null);
  assert.equal(parseInput("https://open.spotify.com.evil.com/track/" + ID), null);
  assert.equal(parseInput("https://open.spotify.com/track/short"), null);
  assert.equal(parseInput("https://open.spotify.com/playlist/" + ID), null);
  assert.equal(parseInput("https://open.spotify.com/album/" + ID), null);
  assert.equal(parseInput("https://www.youtube.com/watch?v=../../etc"), null);
  assert.equal(parseInput(""), null);
});

test("cleanYouTube handles common title styles", () => {
  assert.deepEqual(cleanYouTube("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley"), {
    source: "youtube", artist: "Rick Astley", title: "Never Gonna Give You Up",
  });
  assert.deepEqual(cleanYouTube("Never Gonna Give You Up", "Rick Astley - Topic"), {
    source: "youtube", artist: "Rick Astley", title: "Never Gonna Give You Up",
  });
  assert.deepEqual(cleanYouTube("Artist – Song [Lyrics]", "Some Channel"), { source: "youtube", artist: "Artist", title: "Song" });
  // a meaningful bracket is kept
  assert.equal(cleanYouTube("Artist - Song (feat. Someone)", "x").title, "Song (feat. Someone)");
  assert.equal(cleanYouTube("Song", "AdeleVEVO").artist, "Adele");
});

test("parseSpotifyMeta decodes entities", () => {
  const m = parseSpotifyMeta('<meta property="og:title" content="Don&#x27;t Stop"><meta name="music:musician_description" content="Hall &amp; Oates">');
  assert.deepEqual(m, { title: "Don't Stop", artist: "Hall & Oates" });
});

test("similarity prefers real matches and tolerates feat/suffix noise", () => {
  const hint = { source: "youtube" as const, artist: "Rick Astley", title: "Never Gonna Give You Up" };
  assert.ok(similarity({ artist: "Rick Astley", title: "Never Gonna Give You Up" }, hint) > 0.95);
  assert.ok(similarity({ artist: "Rick Astley", title: "Never Gonna Give You Up - 2022 Remaster" }, hint) > 0.8);
  assert.ok(similarity({ artist: "Someone Else", title: "Totally Different" }, hint) < 0.3);
});

test("similar-but-different titles are not a confident match", () => {
  const hint = { source: "text" as const, artist: "Breaking Rust", title: "Walk My Walk" };
  assert.ok(similarity({ artist: "Breaking Rust", title: "Walk My Way" }, hint) < CONFIDENT);
  assert.ok(similarity({ artist: "Breaking Rust", title: "Walk My Walk" }, hint) > 0.95);
  assert.ok(similarity({ artist: "Breaking Rust", title: "Walk My Walk - 2024 Remaster" }, hint) > 0.95);
});

test("artist match rejects lookalike artists but accepts credited collaborations", () => {
  const hint = { source: "text" as const, artist: "The Velvet Sundown", title: "Dust On The Wind" };
  assert.ok(similarity({ artist: "The Velvet Sundown Unplugged", title: "Dust On The Wind" }, hint) < CONFIDENT);
  const collab = { source: "youtube" as const, artist: "Daft Punk & Pharrell Williams", title: "Get Lucky" };
  assert.ok(similarity({ artist: "Daft Punk", title: "Get Lucky" }, collab) >= CONFIDENT);
});

test("film and feature suffixes on a Spotify title don't stop it matching the plain Deezer title", () => {
  const spotify = { source: "text" as const, artist: "Noah Kahan, The Hunger Games", title: "Draw You Out - From The Hunger Games: Sunrise on the Reaping - The Album" };
  assert.ok(similarity({ artist: "Noah Kahan", title: "Draw You Out" }, spotify) >= CONFIDENT, "a collaborator credit and a film suffix");
  const feat = { source: "text" as const, artist: "Sam Fender, Olivia Dean", title: "Rein Me In (with Olivia Dean)" };
  assert.ok(similarity({ artist: "Sam Fender", title: "Rein Me In" }, feat) >= CONFIDENT);
  // but a genuinely different song by the same artist is still not a match
  assert.ok(similarity({ artist: "Sam Fender", title: "Seventeen Going Under" }, feat) < 0.7);
});

test("the right artist with a completely different song is not a track match", () => {
  const hint = { source: "youtube" as const, artist: "Gen Bot", title: "Unreleased Demo" };
  const wrongSong = similarity({ artist: "Gen Bot", title: "Neon Dreams" }, hint);
  assert.ok(wrongSong < PLAUSIBLE, `got ${wrongSong}`);
  // but a real match with some noise in the title still passes
  assert.ok(similarity({ artist: "Gen Bot", title: "Unreleased Demo" }, hint) >= CONFIDENT);
  assert.ok(similarity({ artist: "Gen Bot", title: "Unreleased Demo - 2024 Remaster" }, hint) >= PLAUSIBLE);
});

test("featured artists and 'M/V' do not count against a title", () => {
  const hint = { source: "youtube" as const, artist: "Luis Fonsi", title: "Despacito ft. Daddy Yankee" };
  assert.ok(similarity({ artist: "Luis Fonsi", title: "Despacito" }, hint) >= CONFIDENT);
  assert.equal(cleanYouTube("PSY - GANGNAM STYLE(강남스타일) M/V", "officialpsy").title, "GANGNAM STYLE(강남스타일)");
  assert.equal(cleanYouTube("Artist - Song MV", "x").title, "Song");
});

test("quotes around a YouTube song title are not part of the title", () => {
  assert.deepEqual(cleanYouTube('Kosta Vreto - "One Step Closer" (Official Video)', "Kosta Vreto"), { source: "youtube", artist: "Kosta Vreto", title: "One Step Closer" });
  assert.equal(cleanYouTube("Artist - “Song Name”", "x").title, "Song Name");
  assert.equal(cleanYouTube('"Just A Title"', "Some Channel").title, "Just A Title");
  assert.equal(cleanYouTube("Artist - It's Alive", "x").title, "It's Alive", "an apostrophe inside a title stays");
});
