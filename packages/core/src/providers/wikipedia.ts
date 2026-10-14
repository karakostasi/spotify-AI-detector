import type { WikipediaInfo } from "../types.js";
import { getJson, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";

const REST = "https://en.wikipedia.org/api/rest_v1/page/summary";
const MUSICAL = /\b(singers?|bands?|musicians?|rappers?|duos?|groups?|composers?|producers?|djs?|songwriters?|vocalists?|guitarists?|trios?|quartets?|music(?:al)? (?:project|act|artist|group)|recording artists?)\b/i;

/**
 * The lead section calls the act AI-made. Deliberately narrow: "virtual band" (e.g. Gorillaz) is
 * not AI, and an unrelated mention of AI deep in an article shouldn't count, so only the lead is checked.
 */
const AI_MADE = new RegExp(
  [
    "\\bAI[- ]generated\\b",
    "\\bartificial(?:ly)?[- ](?:intelligence|generated)\\b",
    "\\bgenerated (?:entirely |completely )?(?:by|using|with) (?:AI|artificial intelligence|Suno|Udio)\\b",
    "\\bAI (?:band|artist|musician|singer|persona|project|music project|act)\\b",
    "\\b(?:made|created|produced) (?:entirely |completely )?(?:by|with|using) (?:AI|Suno|Udio)\\b",
  ].join("|"),
  "i",
);

export const looksAiMade = (text: string) => AI_MADE.test(text);

interface Summary {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
}

const base = (title: string) => normalizeName(title.replace(/\s*\([^)]*\)\s*$/, "")).replace(/^the /, "");

export class Wikipedia {
  constructor(
    private f: Fetch = fetch,
    private userAgent = "spotify-ai-detector/0.1 (https://github.com/karakostasi/spotify-AI-detector)",
  ) {}

  private async summary(title: string): Promise<Summary | null> {
    const url = `${REST}/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`;
    return getJson<Summary>(this.f, url, { "user-agent": this.userAgent }).catch(() => null);
  }

  async lookup(name: string): Promise<WikipediaInfo> {
    // Exact title first, then the usual disambiguators for musicians.
    for (const candidate of [name, `${name} (band)`, `${name} (musician)`, `${name} (singer)`, `${name} (rapper)`]) {
      const s = await this.summary(candidate);
      if (!s || s.type !== "standard" || !s.title) continue;
      const text = `${s.description ?? ""} ${(s.extract ?? "").slice(0, 700)}`;
      const own = base(s.title) === base(name);
      const aiMentioned = looksAiMade(text);
      const aiDescribed = looksAiMade(s.description ?? "");
      // A redirect to a different article (e.g. an act folded into a page about AI music) only counts if that page says AI.
      if (own && !MUSICAL.test(text) && !aiMentioned) continue;
      if (!own && !aiMentioned) continue;
      return { found: true, title: s.title, description: s.description, ownArticle: own, aiMentioned, aiDescribed };
    }
    return { found: false, ownArticle: false, aiMentioned: false, aiDescribed: false };
  }
}
