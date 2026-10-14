import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ArtistProfile } from "@aid/core";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { fetchPlaylist, parsePlaylistEmbed, EMBED_CAP } from "../src/playlist.js";
import { ScoreService } from "../src/service.js";

const PL = "37i9dQZF1DXcBWIGoYBM5M";
const T1 = "3zOYmiNOuyDL0ClxJcEJ0T";
const T2 = "70cHKK8bHAfJrOGVnfRG9J";
const T3 = "4EoJ151oQ5jY48z4RhSE96";

const embedHtml = (name: string, trackList: unknown[]) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { name, trackList } } } } } })}</script></html>`;

const track = (id: string, title: string, subtitle: string) => ({ uri: `spotify:track:${id}`, title, subtitle });

test("parsePlaylistEmbed reads tracks, skips episodes and local files, and tidies artist names", () => {
  const html = embedHtml("  Road Trip ", [
    track(T1, "Neon Dreams", "Gen Bot, Someone"),
    { uri: "spotify:episode:abcdefghijklmnopqrstuv", title: "A podcast", subtitle: "Host" },
    { uri: "spotify:local:Artist:Album:Title:120", title: "My file", subtitle: "Me" },
    { uri: `spotify:track:${T2}`, title: 42, subtitle: "bad title" }, // malformed entry
    track(T3, "Real Song", "Real Band"),
  ]);
  const p = parsePlaylistEmbed(html, PL)!;
  assert.equal(p.name, "Road Trip");
  assert.deepEqual(p.tracks, [
    { uri: `spotify:track:${T1}`, title: "Neon Dreams", artists: "Gen Bot, Someone" },
    { uri: `spotify:track:${T3}`, title: "Real Song", artists: "Real Band" },
  ]);
  assert.equal(p.capped, false);
});

test("a full embed (100 entries) is flagged as possibly truncated", () => {
  const list = Array.from({ length: EMBED_CAP }, (_, i) => track(T1.slice(0, 20) + String(i).padStart(2, "0"), `t${i}`, "A"));
  assert.equal(parsePlaylistEmbed(embedHtml("Big", list), PL)!.capped, true);
});

test("parsePlaylistEmbed returns null for pages that are not in the expected shape", () => {
  assert.equal(parsePlaylistEmbed("<html>no data</html>", PL), null);
  assert.equal(parsePlaylistEmbed('<script id="__NEXT_DATA__" type="application/json">{not json</script>', PL), null);
  assert.equal(parsePlaylistEmbed('<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>', PL), null);
  assert.equal(parsePlaylistEmbed(embedHtml("X", [] as unknown[]).replace('"trackList":[]', '"trackList":"nope"'), PL), null);
});

test("fetchPlaylist only requests well-formed ids from the fixed Spotify embed URL", async () => {
  const urls: string[] = [];
  const f = async (u: string) => (urls.push(u), { ok: true, text: async () => embedHtml("P", [track(T1, "a", "b")]) });
  assert.equal(await fetchPlaylist(f, "../../etc/passwd"), null);
  assert.equal(await fetchPlaylist(f, "short"), null);
  assert.deepEqual(urls, [], "a bad id never reaches the network");
  assert.equal((await fetchPlaylist(f, PL))!.tracks.length, 1);
  assert.deepEqual(urls, [`https://open.spotify.com/embed/playlist/${PL}`]);
  assert.equal(await fetchPlaylist(async () => ({ ok: false, text: async () => "" }), PL), null);
});

// ---- endpoints ----

const aiLike: ArtistProfile = {
  key: "deezer:1",
  name: "Gen Bot",
  albums: Array.from({ length: 50 }, (_, i) => ({
    id: String(i), title: `A${i}`, trackCount: 10, recordType: "album",
    releaseDate: new Date(Date.now() - i * 5 * 86400000).toISOString().slice(0, 10),
  })),
  topTracks: Array.from({ length: 10 }, () => ({ title: "x", durationSec: 120 })),
};
const humanLike: ArtistProfile = {
  key: "deezer:2",
  name: "Real Band",
  albums: [{ id: "1", title: "Debut", trackCount: 10, recordType: "album", releaseDate: "2019-03-01" }],
  topTracks: [150, 210, 260, 180, 330, 200, 240, 190, 300].map((d) => ({ title: "x", durationSec: d })),
};

async function setup(opts: { playlistLimitPerMin?: number } = {}) {
  const calls = { embed: 0, trackSearch: 0, mb: 0, quickProfile: 0 };
  const hits = (title: string) =>
    title === "Neon Dreams" ? [{ id: 101, title, duration: 120, artist: { id: 1, name: "Gen Bot" }, album: { id: 1, title: "A0" } }]
    : title === "Real Song" ? [{ id: 202, title, duration: 200, artist: { id: 2, name: "Real Band" }, album: { id: 2, title: "Debut" } }]
    : [];
  const svc = new ScoreService(openDb(), {
    deezer: {
      searchTracks: async (q: string) => (calls.trackSearch++, hits(q.includes("Neon") ? "Neon Dreams" : q.includes("Real") ? "Real Song" : "")),
      track: async (id: number) => hits("Neon Dreams").concat(hits("Real Song")).map((h) => ({ ...h, isrc: "" })).find((h) => h.id === id) ?? null,
      searchArtist: async () => null,
      searchArtists: async () => [],
      artist: async () => null,
    } as any,
    fetchText: async (u: string) => {
      if (u.includes("/embed/playlist/")) {
        calls.embed++;
        return { ok: true, text: async () => embedHtml("Road Trip", [track(T1, "Neon Dreams", "Gen Bot"), track(T3, "Real Song", "Real Band"), track(T2, "Obscure Thing", "Nobody")]), json: async () => ({}) };
      }
      return { ok: false, text: async () => "", json: async () => ({}) };
    },
    loadProfile: async () => null,
    loadArtistProfile: async () => structuredClone(aiLike),
    loadQuickProfile: async (id) => (calls.quickProfile++, structuredClone(id === 1 ? aiLike : humanLike)),
    lookupWikidata: async () => undefined,
    lookupWikipedia: async () => undefined,
    lookupMb: async () => (calls.mb++, undefined),
    lookupWeb: async () => ({}),
    retryDelayMs: 0,
  });
  const server = createApp(svc, { playlistLimitPerMin: opts.playlistLimitPerMin, spotifyClientId: "client-123" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { svc, calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const json = (r: Response) => r.json() as Promise<any>;
const post = (base: string, items: unknown) => fetch(`${base}/api/playlist/score`, { method: "POST", body: JSON.stringify({ items }) });

test("GET /api/playlist returns the tracks, caches the page, and rejects bad or unreadable ids", async () => {
  const s = await setup();
  try {
    const p = await json(await fetch(`${s.base}/api/playlist?id=${PL}`));
    assert.equal(p.name, "Road Trip");
    assert.equal(p.tracks.length, 3);
    await fetch(`${s.base}/api/playlist?id=${PL}`);
    assert.equal(s.calls.embed, 1, "the second request came from the cache");
    assert.equal((await fetch(`${s.base}/api/playlist?id=nope`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/playlist`)).status, 400);
  } finally {
    s.close();
  }
});

test("scoring flags the AI-like artist, clears the human one, leaves unmatched tracks alone, and never calls MusicBrainz", async () => {
  const s = await setup();
  try {
    const r = (await json(await post(s.base, [
      { id: "a", title: "Neon Dreams", artists: "Gen Bot" },
      { id: "b", title: "Real Song", artists: "Real Band" },
      { id: "c", title: "Obscure Thing", artists: "Nobody" },
    ]))).results;

    assert.equal(r.a.matched, true);
    assert.equal(r.a.artist.name, "Gen Bot");
    assert.ok(r.a.score >= 0.7, `expected a high AI score, got ${r.a.score}`);
    assert.equal(r.a.verdict, "likely-ai");
    assert.ok(r.a.reasons.length >= 1 && r.a.reasons.every((x: string) => typeof x === "string"));

    assert.ok(r.b.matched && r.b.score < 0.45, `a normal catalogue stays below the flag line, got ${r.b.score}`);
    assert.deepEqual(r.b.reasons, []);

    assert.deepEqual(r.c, { matched: false, score: null, verdict: "unknown", confidence: 0, reasons: [] }, "no match: never guessed at");
    assert.equal(s.calls.mb, 0, "fast mode skips the 1-request-per-second MusicBrainz lookups");
  } finally {
    s.close();
  }
});

test("matching and scoring are cached, so rescanning the same playlist costs nothing", async () => {
  const s = await setup();
  try {
    const items = [{ id: "a", title: "Neon Dreams", artists: "Gen Bot" }, { id: "b", title: "Real Song", artists: "Real Band" }];
    await post(s.base, items);
    const searches = s.calls.trackSearch, profiles = s.calls.quickProfile;
    assert.ok(searches > 0 && profiles === 2);
    await post(s.base, items);
    assert.equal(s.calls.trackSearch, searches, "track matches came from the cache");
    assert.equal(s.calls.quickProfile, profiles, "artist profiles came from the cache");
  } finally {
    s.close();
  }
});

test("scoring batches are size-limited, validated and rate limited; config exposes only the public client id", async () => {
  const s = await setup({ playlistLimitPerMin: 3 });
  try {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: String(i), title: "t", artists: "a" }));
    assert.equal((await post(s.base, many)).status, 400, "more than 12 tracks per request");
    // malformed entries are dropped, not fatal
    const mixed = await json(await post(s.base, [{ id: "ok", title: "Real Song", artists: "Real Band" }, { id: 5 }, null, { id: "x".repeat(100), title: "t", artists: "a" }]));
    assert.deepEqual(Object.keys(mixed.results), ["ok"]);
    assert.equal((await post(s.base, [])).status, 200);
    assert.equal((await post(s.base, [])).status, 429, "the fourth request in a minute is refused");

    assert.deepEqual(await json(await fetch(`${s.base}/api/config`)), { spotifyClientId: "client-123" });
  } finally {
    s.close();
  }
});
