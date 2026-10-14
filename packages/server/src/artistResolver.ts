import { cluesFromWords, hasGreek, interpretText, nameSimilarity, rankCandidates, type WikidataCandidate } from "@aid/core";

/** An artist the user might mean, as shown in the "which one?" list. */
export interface ArtistChoice {
  deezerArtistId: number;
  name: string;
  /** e.g. "Australian classical guitarist (born 1941)" when Wikidata knows who this is */
  description?: string;
  fans?: number;
  albums?: number;
}

export interface LlmHints {
  /** The artist name as it would be spelled on a streaming service */
  artist: string;
  /** Descriptive words that are not part of the name: instrument, genre, nationality, role */
  qualifiers: string[];
  /** Other plausible spellings, including native script */
  spellings: string[];
}

export interface ResolverDeps {
  deezer: {
    searchArtists(name: string, limit?: number): Promise<{ id: number; name: string; nb_fan: number; nb_album: number }[]>;
    artist(id: number): Promise<{ id: number; name: string; nb_fan: number } | null>;
  };
  wikidataCandidates(names: string[], languages: string[]): Promise<WikidataCandidate[]>;
  /** Deezer artist id linked from a MusicBrainz artist */
  mbDeezerId(mbid: string): Promise<number | undefined>;
  /** Last resort: ask the AI layer to untangle a query we couldn't resolve. Absent when no key is configured. */
  interpret?: (text: string) => Promise<LlmHints | undefined>;
}

export interface ResolveResult {
  artist?: ArtistChoice;
  /** Other plausible people when the query is ambiguous or the pick is uncertain */
  choices: ArtistChoice[];
  /** What we actually searched for, e.g. `Justin Johnston · guitarist` */
  searchedAs: string;
  usedAi: boolean;
  /** The query carried clues we could not verify against any source */
  unverifiedClues?: boolean;
  /** Identified through Wikidata (a described person), not just a name match on Deezer */
  verified?: boolean;
}

const NAME_MATCH = 0.85;
const MAX_CHOICES = 5;

/** Fan count dominates between pages of the same artist, but an empty page loses to a populated one. */
const popularity = (a: { nb_fan: number; nb_album: number }) => (a.nb_album > 0 ? 1 : 0) * 1e9 + a.nb_fan;

/** A page we found by name alone, with no sign it is the artist people mean. */
const isWeak = (r: Omit<ResolveResult, "searchedAs" | "usedAi">) =>
  !r.artist || (!r.verified && (r.artist.albums === 0 || (r.artist.fans ?? 0) < 100));

export async function resolveArtist(text: string, deps: ResolverDeps): Promise<ResolveResult> {
  const interp = interpretText(text);
  // Show the artist we matched; with no match, the most specific name we tried
  const searchedAs = (artist: ArtistChoice | undefined, names: string[], clues: string[][]) =>
    [artist?.name ?? names[Math.min(1, names.length - 1)], ...clues.map((c) => c[0])].join(" · ");

  let names = interp.names;
  let clues = interp.clues;
  let result: Omit<ResolveResult, "searchedAs" | "usedAi">;

  // Artists whose names end in a genre or role word (Daft Punk, Kid Rock) must not lose it: try the query exactly as typed
  // first, and only peel off clue words if that finds no solid artist.
  const asTyped = clues.length ? await attempt([interp.original], [], interp.greek, deps) : undefined;
  if (asTyped && !isWeak(asTyped)) {
    result = asTyped;
    names = [interp.original];
    clues = [];
  } else {
    result = await attempt(interp.names, interp.clues, interp.greek, deps);
  }
  let usedAi = false;

  // Ask the AI layer only when the plain search found nothing, or only a page that looks like a stray duplicate.
  if (isWeak(result) && deps.interpret) {
    const hints = await deps.interpret(text).catch(() => undefined);
    if (hints) {
      usedAi = true;
      const aiNames = [...new Set([hints.artist, ...hints.spellings].map((n) => n.trim()).filter(Boolean))];
      const aiClues = cluesFromWords(hints.qualifiers);
      const retry = await attempt(aiNames, aiClues.length ? aiClues : clues, aiNames.some(hasGreek), deps);
      // Take the retry only if it is clearly better than what we had
      if (retry.artist && (retry.verified || !result.artist || popularity(toPage(retry.artist)) > popularity(toPage(result.artist)))) {
        result = retry;
        names = aiNames;
        clues = aiClues.length ? aiClues : clues;
      }
    }
  }
  return { ...result, searchedAs: searchedAs(result.artist, names, clues), usedAi };
}

const toPage = (a: ArtistChoice) => ({ nb_fan: a.fans ?? 0, nb_album: a.albums ?? 1 });

async function attempt(names: string[], clues: string[][], wantGreek: boolean, deps: ResolverDeps): Promise<Omit<ResolveResult, "searchedAs" | "usedAi">> {
  const wd = await deps.wikidataCandidates(names, wantGreek ? ["en", "el"] : ["en"]).catch(() => []);
  const ranked = rankCandidates(wd, names, clues).filter((r) => r.nameScore >= NAME_MATCH);

  // 1. Wikidata knows who this is. With clues, the described person wins; without, only an unambiguous match does.
  const described = clues.length ? ranked.filter((r) => r.clueScore > 0) : ranked;
  const best = described[0];
  if (best && (clues.length > 0 || ranked.length === 1)) {
    const artist = await toDeezer(best.candidate, deps);
    if (artist) {
      const others = ranked.filter((r) => r !== best).slice(0, MAX_CHOICES - 1);
      return { artist, verified: true, choices: await choicesFrom(others.map((r) => r.candidate), deps, artist.deezerArtistId) };
    }
  }

  // 2. Fall back to Deezer's own search, treating spelling variants as one artist and preferring the populated page.
  const pages = new Map<number, { id: number; name: string; nb_fan: number; nb_album: number; sim: number }>();
  for (const n of names.slice(0, 4)) {
    for (const a of await deps.deezer.searchArtists(n, 10).catch(() => [])) {
      const sim = Math.max(...names.map((x) => nameSimilarity(a.name, x)));
      if (sim >= NAME_MATCH) pages.set(a.id, { ...a, sim });
    }
  }
  // What the user typed beats a lookalike: "Justin Johnston" is not "Justin Johnson", even though Deezer would rank him higher.
  // Near-matches (a different transliteration, a typo) are offered as choices instead.
  const found = [...pages.values()];
  const byPopularity = (list: typeof found) => [...list].sort((x, y) => popularity(y) - popularity(x) || y.sim - x.sim);
  const exact = byPopularity(found.filter((a) => a.sim >= 0.995));
  const near = byPopularity(found.filter((a) => a.sim < 0.995));
  const ordered = exact.length ? [...exact, ...near] : near;
  const describe = new Map(wd.map((c) => [c.deezerArtistId, c.description]));
  const toChoice = (a: (typeof found)[number]): ArtistChoice => ({
    deezerArtistId: a.id, name: a.name, fans: a.nb_fan, albums: a.nb_album, description: describe.get(a.id),
  });
  const top = ordered[0];
  if (!top) return { choices: [] };
  return { artist: toChoice(top), choices: ordered.slice(1, MAX_CHOICES).map(toChoice), unverifiedClues: clues.length > 0 || undefined };
}

/** Wikidata person -> Deezer artist: Wikidata's own link, then MusicBrainz's link, then a name search. */
async function toDeezer(c: WikidataCandidate, deps: ResolverDeps): Promise<ArtistChoice | undefined> {
  const id = c.deezerArtistId ?? (c.musicBrainzId ? await deps.mbDeezerId(c.musicBrainzId).catch(() => undefined) : undefined);
  if (id) {
    const a = await deps.deezer.artist(id).catch(() => null);
    if (a) return { deezerArtistId: a.id, name: a.name, fans: a.nb_fan, description: c.description };
  }
  const byName = (await deps.deezer.searchArtists(c.label, 10).catch(() => []))
    .filter((a) => nameSimilarity(a.name, c.label) >= NAME_MATCH)
    .sort((a, b) => popularity(b) - popularity(a))[0];
  return byName ? { deezerArtistId: byName.id, name: byName.name, fans: byName.nb_fan, albums: byName.nb_album, description: c.description } : undefined;
}

/** Choices from Wikidata candidates that already carry a Deezer id (no extra lookups). */
async function choicesFrom(cs: WikidataCandidate[], deps: ResolverDeps, exclude: number): Promise<ArtistChoice[]> {
  const out: ArtistChoice[] = [];
  for (const c of cs) {
    if (!c.deezerArtistId || c.deezerArtistId === exclude) continue;
    const a = await deps.deezer.artist(c.deezerArtistId).catch(() => null);
    if (a) out.push({ deezerArtistId: a.id, name: a.name, fans: a.nb_fan, description: c.description });
  }
  return out;
}
