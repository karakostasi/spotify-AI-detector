import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ArtistProfile } from "@aid/core";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { ScoreService } from "../src/service.js";

const prolific: ArtistProfile = {
  key: "deezer:1",
  name: "Gen Bot",
  albums: Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    title: `A${i}`,
    releaseDate: new Date(Date.now() - i * 5 * 86400000).toISOString().slice(0, 10),
    trackCount: 10,
    label: "ShadyLabel",
  })),
  topTracks: Array.from({ length: 10 }, () => ({ title: "x", durationSec: 120 })),
};

const fakeTrack = { id: 7, title: "Neon Dreams", isrc: "USXXX2400001", duration: 120, artist: { id: 1, name: "Gen Bot" }, album: { id: 1, title: "A0" } };
const fakeDeezer = {
  track: async (id: number) => (id === 7 ? fakeTrack : null),
  searchTracks: async () => [fakeTrack, { ...fakeTrack, id: 8, title: "Other Song", isrc: "" }],
  searchArtist: async (n: string) => (n === "Gen Bot" ? { id: 1, name: "Gen Bot" } : null),
};
const pages: Record<string, { ok: boolean; body: string }> = {
  "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC": {
    ok: true,
    body: '<meta property="og:title" content="Neon Dreams"><meta name="music:musician_description" content="Gen Bot">',
  },
  "https://open.spotify.com/artist/0000000000000000000000": { ok: true, body: '<meta property="og:title" content="Gen Bot">' },
  [`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}&format=json`]: {
    ok: true,
    body: JSON.stringify({ title: "Gen Bot - Neon Dreams (Official Video)", author_name: "Gen Bot" }),
  },
};
const fakeFetch = async (url: string) => {
  const p = pages[url] ?? { ok: false, body: "" };
  return { ok: p.ok, text: async () => p.body, json: async () => JSON.parse(p.body) };
};

async function setup(app: { rateLimitPerMin?: number } = {}) {
  let mbCalls = 0;
  const webCalls: (string | undefined)[] = [];
  const svc = new ScoreService(openDb(), {
    deezer: fakeDeezer as any,
    fetchText: fakeFetch,
    loadProfile: async (isrc) => (isrc === "USXXX2400001" ? structuredClone(prolific) : null),
    loadArtistProfile: async () => structuredClone(prolific),
    lookupMb: async () => {
      mbCalls++;
      return { artistId: "mbid-1", artistFound: false, urlCount: 0, hasBackground: false, recordingFound: false, creditCount: 0 };
    },
    lookupWeb: async (_name, mbid) => {
      webCalls.push(mbid);
      return { wikipedia: { found: true, title: "Gen Bot", description: "AI-generated pop project", ownArticle: true, aiMentioned: true, aiDescribed: true } };
    },
  });
  const server = createApp(svc, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { svc, base, mbCalls: () => mbCalls, webCalls, close: () => server.close() };
}

const json = (r: Response) => r.json() as Promise<any>;

test("score: validates isrc, 404s unknown, scores known, fills MusicBrainz in the background", async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/api/score?isrc=nope`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/score?isrc=USXXX2400099`)).status, 404);

    const first = await json(await fetch(`${s.base}/api/score?isrc=USXXX2400001`));
    assert.equal(first.artistKey, "deezer:1");
    assert.equal(first.pending, true);
    assert.ok(["likely-ai", "suspicious"].includes(first.verdict));

    await s.svc.idle();
    const second = await json(await fetch(`${s.base}/api/score?isrc=USXXX2400001`));
    assert.equal(second.pending, false);
    assert.ok(second.signals.some((x: any) => x.id === "externalPresence" && x.score !== null));
    assert.equal(s.mbCalls(), 1);
    // web lookup runs after MusicBrainz and receives its artist id, and its evidence reaches the score
    assert.deepEqual(s.webCalls, ["mbid-1"]);
    const wiki = second.signals.find((x: any) => x.id === "wikipedia");
    assert.ok(wiki && wiki.score >= 0.9, "wikipedia AI mention should score high");
  } finally {
    s.close();
  }
});

test("batch scoring", async () => {
  const s = await setup();
  try {
    const r = await json(
      await fetch(`${s.base}/api/score/batch`, {
        method: "POST",
        body: JSON.stringify({ tracks: [{ isrc: "USXXX2400001" }, { isrc: "USXXX2400099" }, { isrc: "bad" }] }),
      }),
    );
    assert.ok(r.results.USXXX2400001);
    assert.equal(r.results.USXXX2400099, null);
    assert.equal("bad" in r.results, false);
  } finally {
    s.close();
  }
});

test("votes need a user id, shift the score, and feed the blocklist", async () => {
  const s = await setup();
  try {
    const vote = (user: string | null, artistKey: string, v: string) =>
      fetch(`${s.base}/api/vote`, {
        method: "POST",
        headers: user ? { "x-user-id": user } : {},
        body: JSON.stringify({ artistKey, vote: v }),
      });

    assert.equal((await vote(null, "deezer:1", "ai")).status, 401);
    assert.equal((await vote("aaaaaaaa-0000-4000-8000-000000000000", "bogus", "ai")).status, 400);
    assert.equal((await vote("aaaaaaaa-0000-4000-8000-000000000000", "deezer:1", "maybe")).status, 400);

    // artist must be known to the server to show up by name on the blocklist
    await fetch(`${s.base}/api/score?isrc=USXXX2400001`);
    for (let i = 0; i < 6; i++) assert.equal((await vote(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`, "deezer:1", "ai")).status, 200);

    const bl = await json(await fetch(`${s.base}/api/blocklist`));
    assert.equal(bl.artists[0].key, "deezer:1");
    assert.equal(bl.artists[0].name, "Gen Bot");
    const txt = await (await fetch(`${s.base}/api/blocklist?format=txt`)).text();
    assert.match(txt, /deezer:1\tGen Bot/);
  } finally {
    s.close();
  }
});

test("a user who keeps disagreeing with consensus loses weight", async () => {
  const s = await setup();
  try {
    const crowd = s.svc.crowd;
    // consensus: 5 honest users call 6 artists AI; the troll calls them all human
    for (let a = 0; a < 6; a++) {
      for (let u = 0; u < 5; u++) crowd.castVote(`bbbbbbbb-0000-4000-8000-00000000000${u}`, `deezer:${a}`, "ai");
      crowd.castVote("cccccccc-0000-4000-8000-000000000000", `deezer:${a}`, "human");
    }
    const t = crowd.tallies().get("deezer:0")!;
    assert.ok(t.humanWeight < 1, `troll weight should drop below 1, got ${t.humanWeight}`);
    assert.ok(t.aiWeight > 5, `honest users should gain weight, got ${t.aiWeight}`);
  } finally {
    s.close();
  }
});

test("check: spotify link, youtube link, artist link, free text, and failures", async () => {
  const s = await setup();
  try {
    const check = async (q: string) => json(await fetch(`${s.base}/api/check?q=${encodeURIComponent(q)}`));

    const sp = await check("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc");
    assert.equal(sp.track.title, "Neon Dreams");
    assert.equal(sp.confident, true);
    assert.equal(sp.report.artistKey, "deezer:1");

    const yt = await check("https://youtu.be/dQw4w9WgXcQ");
    assert.equal(yt.track.artist, "Gen Bot");
    assert.ok(yt.report);

    const artist = await check("https://open.spotify.com/artist/0000000000000000000000");
    assert.equal(artist.track, undefined);
    assert.ok(artist.report);

    const text = await check("Gen Bot - Neon Dreams");
    assert.equal(text.track.title, "Neon Dreams");

    assert.ok((await check("https://example.com/evil")).error);
    assert.ok((await check("https://open.spotify.com/track/0000000000000000000000")).error);
    assert.equal((await fetch(`${s.base}/api/check`)).status, 400);

    const picked = await json(await fetch(`${s.base}/api/check?deezerTrack=7`));
    assert.equal(picked.track.title, "Neon Dreams");
    assert.equal((await fetch(`${s.base}/api/check?deezerTrack=abc`)).status, 400);
  } finally {
    s.close();
  }
});

test("rate limiting kicks in", async () => {
  const s = await setup({ rateLimitPerMin: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.base}/api/check?deezerTrack=7`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    s.close();
  }
});
