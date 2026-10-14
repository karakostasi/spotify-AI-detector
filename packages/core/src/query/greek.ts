/** Greek letters to Latin, loosely following ELOT 743 (how most Greek artists are spelled on streaming services). */
const DIGRAPHS: [RegExp, string][] = [
  [/γγ/g, "ng"], [/γκ/g, "g"], [/γχ/g, "nch"], [/μπ/g, "b"], [/ντ/g, "d"],
  [/αυ(?=[θκξπστφχψ]|$)/g, "af"], [/αυ/g, "av"], [/ευ(?=[θκξπστφχψ]|$)/g, "ef"], [/ευ/g, "ev"],
  [/ου/g, "ou"], [/αι/g, "ai"], [/ει/g, "ei"], [/οι/g, "oi"], [/υι/g, "yi"],
];
const LETTERS: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x",
  ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

export const hasGreek = (s: string) => /[Ͱ-Ͽἀ-῿]/.test(s);

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** "Νεφέλη Φασούλη" -> "nefeli fasouli". Non-Greek text passes through unchanged (lower-cased). */
export function greekToLatin(s: string): string {
  let out = stripAccents(s.toLowerCase());
  for (const [re, to] of DIGRAPHS) out = out.replace(re, to);
  return out.replace(/[Ͱ-Ͽ]/g, (c) => LETTERS[c] ?? c);
}
