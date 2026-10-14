import { normalizeName } from "../util.js";
import { greekToLatin, hasGreek } from "./greek.js";

/**
 * Words people add to a name to say *which* artist they mean. `says` are the query words, `matches` the words
 * that appear in Wikidata/MusicBrainz descriptions ("Australian classical guitarist").
 */
interface Clue { says: string[]; matches: string[] }

const clue = (says: string, matches = says): Clue => ({ says: says.split(" "), matches: matches.split(" ") });
const CLUES: Clue[] = [
  // instruments and roles
  clue("guitar guitarist guitars", "guitarist guitar"), clue("piano pianist keyboard keyboardist", "pianist piano keyboardist"),
  clue("drums drummer drum percussion", "drummer percussionist drums"), clue("bass bassist", "bassist bass"),
  clue("violin violinist fiddle", "violinist violin fiddler"), clue("cello cellist", "cellist cello"),
  clue("sax saxophone saxophonist", "saxophonist saxophone"), clue("trumpet trumpeter", "trumpeter trumpet"),
  clue("flute flautist flutist", "flautist flutist flute"), clue("singer vocalist vocals", "singer vocalist"),
  clue("rapper rap mc", "rapper rap"), clue("dj", "dj disc"), clue("producer beatmaker", "producer"),
  clue("composer", "composer"), clue("songwriter", "songwriter"), clue("band group duo trio", "band group duo trio ensemble"),
  // genres
  clue("jazz"), clue("rock"), clue("metal"), clue("classical"), clue("pop"), clue("country"), clue("folk"), clue("blues"),
  clue("electronic"), clue("techno"), clue("house"), clue("reggae"), clue("punk"), clue("indie"), clue("hiphop hip-hop", "hip hop"),
  // nationalities
  ...["greek", "american", "british", "english", "french", "german", "italian", "spanish", "canadian", "australian", "swedish",
    "norwegian", "finnish", "irish", "scottish", "japanese", "korean", "brazilian", "mexican", "russian", "polish", "dutch"].map((n) => clue(n)),
];
/** Filler that carries no meaning for identifying an artist. */
const NOISE = new Set(["artist", "musician", "music", "official", "songs", "song"]);

const clueFor = (token: string) => CLUES.find((c) => c.says.includes(token));

export interface Interpretation {
  /** The query as written */
  original: string;
  /** Possible artist names to search, most specific first: the whole query, then the query minus clue words */
  names: string[];
  /** Clues peeled off the ends of the query, as the description words to look for ("guitarist", "guitar") */
  clues: string[][];
  /** Greek script detected: Greek spellings are transliterated and Wikidata is searched in Greek too */
  greek: boolean;
}

/** Description words to look for, for free-form clue words (from the AI layer): known ones expand to their synonyms. */
export function cluesFromWords(words: string[]): string[][] {
  return words
    .map((w) => normalizeName(w))
    .filter((w) => w && !NOISE.has(w))
    .map((w) => clueFor(w)?.matches ?? [w]);
}

/**
 * "justin johnston guitar" -> names ["justin johnston guitar", "justin johnston"], clues [["guitarist","guitar"]].
 * Clue words are only peeled off the ends, and the whole query stays a candidate name too, so
 * "Kid Rock" is still found as itself.
 */
export function interpretText(text: string): Interpretation {
  const original = text.trim().replace(/\s+/g, " ");
  const tokens = original.split(" ");
  const clues: string[][] = [];
  let lo = 0;
  let hi = tokens.length;
  // Every state along the way is a candidate name: "kid rock guitar" -> "kid rock guitar", "kid rock", "kid".
  const variants = [original];
  const peel = (token: string) => {
    const t = normalizeName(token);
    if (NOISE.has(t)) return true;
    const c = clueFor(t);
    if (!c) return false;
    clues.push(c.matches);
    return true;
  };
  while (hi - lo > 1 && peel(tokens[hi - 1]!)) variants.push(tokens.slice(lo, --hi).join(" "));
  while (hi - lo > 1 && peel(tokens[lo]!)) variants.push(tokens.slice(++lo, hi).join(" "));

  // "greek jazz pianist" leaves "greek jazz": text made only of clue words is not a name
  const onlyClues = (v: string) => v.split(" ").every((t) => clueFor(normalizeName(t)) || NOISE.has(normalizeName(t)));
  const names = [...new Set(variants.filter((v) => !onlyClues(v)))];
  if (!names.length) names.push(original);
  const greek = hasGreek(original);
  return { original, names: greek ? [...names, ...names.map(greekToLatin)] : names, clues, greek };
}

// ---- fuzzy name comparison (Latin spellings of the same name differ: Xaroulis / Haroulis / Charoulis)

const fold = (s: string) => normalizeName(greekToLatin(s)).replace(/ /g, "");

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** 0..1 how alike two names are, ignoring case, accents, spacing and Greek vs Latin script. */
export function nameSimilarity(a: string, b: string): number {
  const x = fold(a), y = fold(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}
