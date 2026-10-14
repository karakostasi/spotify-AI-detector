import { test } from "node:test";
import assert from "node:assert/strict";
import { cluesFromWords, greekToLatin, hasGreek, interpretText, MusicBrainz, nameSimilarity, rankCandidates, Wikidata } from "../src/index.js";

const fakeFetch = (routes: Record<string, unknown>) =>
  (async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return { ok: !!key, status: key ? 200 : 404, statusText: "", json: async () => (key ? routes[key] : {}) } as Response;
  }) as typeof fetch;

test("Greek is transliterated the way artists are spelled on streaming services", () => {
  assert.equal(greekToLatin("Νεφέλη Φασούλη"), "nefeli fasouli");
  assert.equal(greekToLatin("Φοίβος Δεληβοριάς"), "foivos delivorias");
  assert.equal(greekToLatin("Μάρκος Βαμβακάρης"), "markos vamvakaris");
  assert.equal(greekToLatin("Daft Punk"), "daft punk", "Latin passes through");
  assert.ok(hasGreek("Νεφέλη") && !hasGreek("Nefeli"));
});

test("interpretText peels clue words off the ends but keeps the whole query as a candidate name", () => {
  const a = interpretText("justin johnston guitar");
  assert.deepEqual(a.names, ["justin johnston guitar", "justin johnston"]);
  assert.deepEqual(a.clues, [["guitarist", "guitar"]]);

  const b = interpretText("guitarist Justin Johnston");
  assert.deepEqual(b.names, ["guitarist Justin Johnston", "Justin Johnston"]);

  const c = interpretText("John Williams classical guitarist");
  assert.ok(c.names.includes("John Williams"));
  assert.equal(c.clues.length, 2, "both the genre and the instrument are clues");

  // "Kid Rock" is also searched as itself, so a clue word inside a real name doesn't lose the artist
  assert.ok(interpretText("Kid Rock").names.includes("Kid Rock"));

  // only clue words: not a name
  assert.deepEqual(interpretText("greek jazz pianist").names, ["greek jazz pianist"]);
  // a plain name is untouched
  assert.deepEqual(interpretText("Justin Johnston"), { original: "Justin Johnston", names: ["Justin Johnston"], clues: [], greek: false });
  assert.deepEqual(interpretText("  Justin   Johnston ").names, ["Justin Johnston"], "whitespace is tidied");
  // a name ending in a genre word is split too: the resolver is what protects it, by trying the whole query first
  assert.deepEqual(interpretText("Daft Punk").names, ["Daft Punk", "Daft"]);
  // every state along the way is a candidate, so "Kid Rock" is still tried when two words are peeled
  assert.deepEqual(interpretText("Kid Rock guitar").names, ["Kid Rock guitar", "Kid Rock", "Kid"]);
});

test("Greek queries are flagged and searched with a transliteration as well", () => {
  const g = interpretText("Νεφέλη Φασούλη");
  assert.equal(g.greek, true);
  assert.deepEqual(g.names, ["Νεφέλη Φασούλη", "nefeli fasouli"]);
});

test("cluesFromWords expands known words and passes unknown ones through", () => {
  assert.deepEqual(cluesFromWords(["guitar", "Greek", "theremin", "artist"]), [["guitarist", "guitar"], ["greek"], ["theremin"]]);
});

test("nameSimilarity ignores case, accents, spacing and script, and tolerates transliteration differences", () => {
  assert.equal(nameSimilarity("Daft Punk", "daft  PUNK"), 1);
  assert.equal(nameSimilarity("Beyoncé", "Beyonce"), 1);
  assert.ok(nameSimilarity("Giannis Xaroulis", "Giannis Haroulis") > 0.9);
  assert.ok(nameSimilarity("Γιάννης Χαρούλης", "Giannis Haroulis") > 0.9);
  assert.ok(nameSimilarity("Rick Astley", "Radiohead") < 0.3);
  assert.equal(nameSimilarity("", "x"), 0);
});

test("rankCandidates puts the clue-matching person first, then those linkable to Deezer", () => {
  const cs = [
    { label: "John Williams", description: "American composer and conductor (born 1932)", deezerArtistId: 805 },
    { label: "John Williams", description: "Australian classical guitarist (born 1941)" },
    { label: "Johnny Williams", description: "English guitarist" },
  ];
  const r = rankCandidates(cs, ["John Williams"], [["guitarist", "guitar"]]);
  assert.equal(r[0]!.candidate.description, "Australian classical guitarist (born 1941)");
  assert.equal(r[0]!.clueScore, 1);
  assert.equal(r[1]!.candidate.label, "Johnny Williams", "a near-name that fits the clue beats an exact name that does not");
  assert.equal(r[2]!.candidate.deezerArtistId, 805);

  // no clues: exact-name candidates first, those with a Deezer id breaking ties
  const plain = rankCandidates(cs.slice(0, 2), ["John Williams"], []);
  assert.equal(plain[0]!.candidate.deezerArtistId, 805);
});

test("Wikidata.candidates searches each language, keeps musicians, and reads ids and English labels", async () => {
  const urls: string[] = [];
  const base = fakeFetch({
    wbsearchentities: { search: [
      { id: "Q1", description: "Greek singer, songwriter and musician" },
      { id: "Q2", description: "Greek footballer" }, // not a musician
    ] },
    wbgetentities: { entities: { Q1: {
      id: "Q1", labels: { en: { value: "Giannis Haroulis" } }, descriptions: { en: { value: "Greek singer, songwriter and musician" } },
      claims: { P434: [{ mainsnak: { datavalue: { value: "mbid-1" } } }], P2722: [{ mainsnak: { datavalue: { value: "5886" } } }] },
    } } },
  });
  const spy = ((u: string, i?: RequestInit) => (urls.push(String(u)), base(u, i))) as typeof fetch;
  const out = await new Wikidata(spy).candidates(["Γιάννης Χαρούλης"], ["en", "el"]);
  assert.deepEqual(out, [{ id: "Q1", label: "Giannis Haroulis", description: "Greek singer, songwriter and musician", deezerArtistId: 5886, musicBrainzId: "mbid-1", aiDescribed: false }]);
  assert.ok(urls.some((u) => u.includes("language=el")) && urls.some((u) => u.includes("language=en")), "searched in both languages");
  assert.ok(!urls.some((u) => u.includes("Q2")), "the footballer is never fetched");
  assert.deepEqual(await new Wikidata(fakeFetch({ wbsearchentities: { search: [] } })).candidates(["Nobody"]), []);
});

test("MusicBrainz.deezerArtistId reads the Deezer link, in any URL form", async () => {
  const link = (resource: string) => fakeFetch({ "/artist/m1": { relations: [{ url: { resource: "https://example.com" } }, { url: { resource } }] } });
  for (const u of ["https://www.deezer.com/artist/5604436", "http://deezer.com/en/artist/5604436"]) {
    assert.equal(await new MusicBrainz(link(u), "t", 0).deezerArtistId("m1"), 5604436);
  }
  assert.equal(await new MusicBrainz(link("https://spotify.com/artist/x"), "t", 0).deezerArtistId("m1"), undefined);
  assert.equal(await new MusicBrainz(fakeFetch({}), "t", 0).deezerArtistId("missing"), undefined);
});
