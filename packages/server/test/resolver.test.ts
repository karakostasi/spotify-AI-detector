import { test } from "node:test";
import assert from "node:assert/strict";
import type { WikidataCandidate } from "@aid/core";
import { resolveArtist, type LlmHints, type ResolverDeps } from "../src/artistResolver.js";

type DzArtist = { id: number; name: string; nb_fan: number; nb_album: number };

/** A tiny fake Deezer and Wikidata, enough to exercise every branch of the resolver. */
function world(opts: { deezer: DzArtist[]; wikidata?: WikidataCandidate[] | ((names: string[]) => WikidataCandidate[]); mb?: Record<string, number>; interpret?: ResolverDeps["interpret"] }) {
  const calls = { wikidata: [] as { names: string[]; languages: string[] }[], deezerSearches: [] as string[], interpret: 0 };
  const deps: ResolverDeps = {
    deezer: {
      searchArtists: async (name) => {
        calls.deezerSearches.push(name);
        const q = name.toLowerCase();
        return opts.deezer.filter((a) => a.name.toLowerCase().includes(q.split(" ")[0]!) ).slice(0, 10);
      },
      artist: async (id) => {
        const a = opts.deezer.find((x) => x.id === id);
        return a ? { id: a.id, name: a.name, nb_fan: a.nb_fan } : null;
      },
    },
    wikidataCandidates: async (names, languages) => {
      calls.wikidata.push({ names, languages });
      return typeof opts.wikidata === "function" ? opts.wikidata(names) : opts.wikidata ?? [];
    },
    mbDeezerId: async (mbid) => opts.mb?.[mbid],
    interpret: opts.interpret ? async (t) => { calls.interpret++; return opts.interpret!(t); } : undefined,
  };
  return { deps, calls };
}

const cand = (over: Partial<WikidataCandidate>): WikidataCandidate => ({ id: "Q1", label: "X", aiDescribed: false, ...over });

const johnWilliams = {
  deezer: [
    { id: 805, name: "John Williams", nb_fan: 20000, nb_album: 80 }, // the film composer
    { id: 5604436, name: "John Williams", nb_fan: 3000, nb_album: 40 }, // the guitarist
  ],
  wikidata: [
    cand({ id: "Q131285", label: "John Williams", description: "American composer and conductor (born 1932)", deezerArtistId: 805 }),
    cand({ id: "Q370293", label: "John Williams", description: "Australian classical guitarist (born 1941)", musicBrainzId: "mb-guitarist" }),
  ],
  mb: { "mb-guitarist": 5604436 },
};

test("a clue picks the described person, found through MusicBrainz's Deezer link", async () => {
  const { deps } = world(johnWilliams);
  const r = await resolveArtist("john williams guitar", deps);
  assert.equal(r.artist?.deezerArtistId, 5604436);
  assert.match(r.artist!.description!, /guitarist/);
  assert.equal(r.verified, true);
  assert.deepEqual(r.choices.map((c) => c.deezerArtistId), [805], "the other John Williams is offered");
  assert.equal(r.usedAi, false);
  assert.equal(r.searchedAs, "John Williams · guitarist");
});

test("without a clue, two well-known people sharing a name are not silently picked between by Wikidata", async () => {
  const { deps } = world(johnWilliams);
  const r = await resolveArtist("john williams", deps);
  assert.equal(r.verified, undefined, "ambiguous: not claimed as identified");
  assert.equal(r.artist?.deezerArtistId, 805, "the more popular page");
  assert.deepEqual(r.choices.map((c) => c.deezerArtistId), [5604436], "and the other one is a click away");
});

test("Greek script is searched in Greek too, and resolves to the Latin-spelled artist", async () => {
  const { deps, calls } = world({
    deezer: [
      { id: 5886, name: "Giannis Haroulis", nb_fan: 5886, nb_album: 60 },
      { id: 16, name: "Giannis Xaroulis", nb_fan: 16, nb_album: 3 },
    ],
    wikidata: [cand({ id: "Q12875270", label: "Giannis Haroulis", description: "Greek singer, songwriter and musician" })],
  });
  const r = await resolveArtist("Γιάννης Χαρούλης", deps);
  assert.deepEqual(calls.wikidata[0]!.languages, ["en", "el"]);
  assert.ok(calls.wikidata[0]!.names.includes("giannis charoulis"), "a transliteration is searched as well");
  assert.equal(r.artist?.deezerArtistId, 5886);
  assert.equal(r.verified, true);
});

test("Latin queries do not search Wikidata in Greek", async () => {
  const { deps, calls } = world({ deezer: [{ id: 1, name: "Daft Punk", nb_fan: 1e6, nb_album: 30 }] });
  await resolveArtist("Daft Punk", deps);
  assert.deepEqual(calls.wikidata[0]!.languages, ["en"]);
});

test("a typed name is not swapped for a lookalike with more fans; the lookalike is offered instead", async () => {
  const { deps } = world({
    deezer: [
      { id: 996514, name: "Justin Johnson", nb_fan: 21575, nb_album: 10 },
      { id: 4888876, name: "Justin Johnston", nb_fan: 33, nb_album: 4 },
    ],
  });
  const r = await resolveArtist("justin johnston guitar", deps);
  assert.equal(r.artist?.name, "Justin Johnston");
  assert.deepEqual(r.choices.map((c) => c.name), ["Justin Johnson"]);
  assert.equal(r.unverifiedClues, true, "nobody could confirm 'guitarist', and the page says so");
  assert.equal(r.verified, undefined);
});

test("an exact-name page with a populated catalogue beats an empty duplicate", async () => {
  const { deps } = world({
    deezer: [
      { id: 1, name: "Nina Lane", nb_fan: 900, nb_album: 0 }, // stray duplicate
      { id: 2, name: "Nina Lane", nb_fan: 120, nb_album: 5 },
    ],
  });
  assert.equal((await resolveArtist("Nina Lane", deps)).artist?.deezerArtistId, 2);
});

test("AI layer: not called when the plain search already found a solid artist", async () => {
  const { deps, calls } = world({
    deezer: [{ id: 1, name: "Daft Punk", nb_fan: 1e6, nb_album: 30 }],
    interpret: async () => ({ artist: "Daft Punk", qualifiers: [], spellings: [] }),
  });
  const r = await resolveArtist("Daft Punk", deps);
  assert.equal(calls.interpret, 0);
  assert.equal(r.usedAi, false);
});

test("AI layer: rescues a query the plain search cannot read, using its spellings", async () => {
  const hints: LlmHints = { artist: "Giannis Haroulis", qualifiers: [], spellings: ["Γιάννης Χαρούλης", "Yiannis Haroulis"] };
  const { deps, calls } = world({
    deezer: [{ id: 5886, name: "Giannis Haroulis", nb_fan: 5886, nb_album: 60 }],
    wikidata: [cand({ id: "Q1", label: "Giannis Haroulis", description: "Greek singer" })],
    interpret: async () => hints,
  });
  // "yianis charoulis please": no Deezer artist is near this
  const r = await resolveArtist("yianis charoulis the greek singer please", deps);
  assert.equal(calls.interpret, 1);
  assert.equal(r.usedAi, true);
  assert.equal(r.artist?.deezerArtistId, 5886);
  assert.ok(calls.wikidata.at(-1)!.languages.includes("el"), "the Greek spelling from the AI is searched in Greek");
});

test("AI layer: tried when the best page looks like a stray duplicate, and only taken if clearly better", async () => {
  const stray = { id: 16, name: "Giannis Xaroulis", nb_fan: 16, nb_album: 0 };
  const real = { id: 5886, name: "Giannis Haroulis", nb_fan: 5886, nb_album: 60 };
  // Wikidata only answers to the Greek spelling that the AI layer supplies
  const better = world({
    deezer: [stray, real],
    wikidata: (names) => (names.includes("Γιάννης Χαρούλης") ? [cand({ id: "Q1", label: "Giannis Haroulis", description: "Greek singer" })] : []),
    interpret: async () => ({ artist: "Giannis Haroulis", qualifiers: [], spellings: ["Γιάννης Χαρούλης"] }),
  });
  const r = await resolveArtist("Giannis Xaroulis", better.deps);
  assert.equal(better.calls.interpret, 1, "a catalogue-less page is suspect, so the AI is asked");
  assert.equal(r.artist?.deezerArtistId, 5886);
  assert.equal(r.usedAi, true);

  // the AI offers nothing better: keep what the plain search found
  const same = world({ deezer: [stray], interpret: async () => ({ artist: "Giannis Xaroulis", qualifiers: [], spellings: [] }) });
  const r2 = await resolveArtist("Giannis Xaroulis", same.deps);
  assert.equal(r2.artist?.deezerArtistId, 16);
});

test("when Wikidata already matches a spelling variant, the AI is not needed", async () => {
  const w = world({
    deezer: [{ id: 16, name: "Giannis Xaroulis", nb_fan: 16, nb_album: 0 }, { id: 5886, name: "Giannis Haroulis", nb_fan: 5886, nb_album: 60 }],
    wikidata: [cand({ id: "Q1", label: "Giannis Haroulis", description: "Greek singer" })],
    interpret: async () => ({ artist: "x", qualifiers: [], spellings: [] }),
  });
  const r = await resolveArtist("Giannis Xaroulis", w.deps);
  assert.equal(r.artist?.deezerArtistId, 5886);
  assert.equal(w.calls.interpret, 0);
});

test("AI layer: a failure or an empty answer degrades to the plain result", async () => {
  const boom = world({ deezer: [{ id: 16, name: "Some Act", nb_fan: 5, nb_album: 0 }], interpret: async () => { throw new Error("API down"); } });
  const r = await resolveArtist("Some Act", boom.deps);
  assert.equal(r.artist?.deezerArtistId, 16);
  assert.equal(r.usedAi, false);

  const none = world({ deezer: [], interpret: async () => undefined });
  const r2 = await resolveArtist("Unfindable Person", none.deps);
  assert.equal(r2.artist, undefined);
  assert.deepEqual(r2.choices, []);
});

test("names that end in a genre or role word keep it: Daft Punk is not 'Daft' plus a punk clue", async () => {
  for (const name of ["Daft Punk", "Kid Rock", "Pop Smoke"]) {
    const { deps } = world({ deezer: [{ id: 1, name, nb_fan: 1e6, nb_album: 30 }] });
    const r = await resolveArtist(name, deps);
    assert.equal(r.artist?.name, name);
    assert.equal(r.unverifiedClues, undefined, `${name}: no bogus clue is claimed`);
    assert.equal(r.searchedAs, name);
  }
});

test("the same name still splits when the whole query finds nothing: 'kid rock guitar' keeps the guitar clue", async () => {
  const { deps } = world({ deezer: [{ id: 1, name: "Kid Rock", nb_fan: 1e6, nb_album: 30 }] });
  const r = await resolveArtist("Kid Rock guitar", deps);
  assert.equal(r.artist?.name, "Kid Rock");
  assert.match(r.searchedAs, /guitarist/);
});
