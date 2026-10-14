import { test } from "node:test";
import assert from "node:assert/strict";
import { baseTitle, uniqueReleases, scoreArtist, type ArtistProfile, type AlbumInfo } from "../src/index.js";

const now = new Date("2026-10-01");

function albums(n: number, tracksEach: number, daysApart = 5): AlbumInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i),
    title: `Album ${i}`,
    releaseDate: new Date(now.getTime() - i * daysApart * 86400000).toISOString().slice(0, 10),
    trackCount: tracksEach,
  }));
}

const base = (over: Partial<ArtistProfile>): ArtistProfile => ({ key: "t:1", name: "T", albums: [], topTracks: [], ...over });

test("prolific, uniform, unlinked artist scores as likely AI", () => {
  const r = scoreArtist(
    base({
      albums: albums(60, 10, 5),
      topTracks: Array.from({ length: 20 }, () => ({ title: "x", durationSec: 150 })),
      musicBrainz: { artistFound: false, urlCount: 0, hasBackground: false, recordingFound: true, creditCount: 0 },
    }),
    { now },
  );
  assert.equal(r.verdict, "likely-ai");
});

test("established artist with links scores as likely human", () => {
  const r = scoreArtist(
    base({
      albums: albums(2, 10, 200),
      topTracks: [150, 210, 260, 180, 330, 200, 240, 190, 300].map((d) => ({ title: "x", durationSec: d })),
      musicBrainz: { artistFound: true, urlCount: 8, hasBackground: true, recordingFound: true, creditCount: 5 },
    }),
    { now },
  );
  assert.equal(r.verdict, "likely-human");
});

test("Spotify AI Persona badge is decisive", () => {
  const r = scoreArtist(base({ spotifyAiPersona: true, albums: albums(1, 10, 400) }), { now });
  assert.equal(r.verdict, "likely-ai");
  assert.equal(r.confidence, 1);
});

test("no data yields unknown", () => {
  assert.equal(scoreArtist(base({}), { now }).verdict, "unknown");
});

test("crowd votes below minimum are ignored, above are used", () => {
  const few = scoreArtist(base({ crowd: { aiWeight: 2, humanWeight: 0 } }), { now });
  assert.equal(few.verdict, "unknown");
  const many = scoreArtist(base({ crowd: { aiWeight: 12, humanWeight: 1 } }), { now });
  assert.equal(many.verdict, "likely-ai");
});

test("label clustering needs enough artists", () => {
  const small = scoreArtist(base({ labelStats: { artists: 3, flaggedArtists: 3 } }), { now });
  assert.equal(small.verdict, "unknown");
  const big = scoreArtist(base({ labelStats: { artists: 20, flaggedArtists: 15 } }), { now });
  assert.ok(big.score! > 0.7);
});

test("reissues collapse and compilations are ignored when counting releases", () => {
  const mk = (title: string, recordType = "album"): AlbumInfo => ({ id: title, title, releaseDate: "2026-05-01", trackCount: 10, recordType });
  const list = [
    mk("Whenever You Need Somebody"),
    mk("Whenever You Need Somebody (Deluxe Edition)"),
    mk("Whenever You Need Somebody (2022 Remaster)"),
    mk("Whenever You Need Somebody - 2022 Remaster"),
    mk("Greatest Hits", "compile"),
    mk("Other Album"),
  ];
  assert.equal(baseTitle("Whenever You Need Somebody (Deluxe Edition)"), "whenever you need somebody");
  assert.equal(uniqueReleases(list).length, 2);
});

test("a label dropping many EPs on one day is not a high release velocity", () => {
  const sameDay = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), title: `Themed EP ${i}`, releaseDate: "2026-05-01", trackCount: 3, recordType: "ep",
  }));
  const r = scoreArtist(base({ albums: sameDay }), { now });
  const v = r.signals.find((x) => x.id === "releaseVelocity")!;
  assert.ok(v.score! < 0.3, `expected low, got ${v.score}`);
});
