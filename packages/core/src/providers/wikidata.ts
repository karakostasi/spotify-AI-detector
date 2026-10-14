import type { WikidataInfo } from "../types.js";
import { getJson, type Fetch } from "./http.js";
import { normalizeName } from "../util.js";
import { MUSICAL, looksAiMade } from "./wikipedia.js";

const API = "https://www.wikidata.org/w/api.php";
const HUMAN = "Q5";
const DEEZER_ID = "P2722";
const MUSICBRAINZ_ID = "P434";
const BIRTH_DATE = "P569";
/** Official website, YouTube, Instagram, Twitter, Facebook, Spotify, Apple Music, Deezer, Discogs, SoundCloud, MusicBrainz */
const LINK_PROPS = ["P856", "P2397", "P2003", "P2002", "P2013", "P1902", "P2850", "P2722", "P1953", "P3040", "P434"];

interface Claim {
  mainsnak?: { datavalue?: { value?: unknown } };
}
interface Entity {
  id: string;
  descriptions?: { en?: { value?: string } };
  claims?: Record<string, Claim[]>;
}

const values = (e: Entity, prop: string): unknown[] => (e.claims?.[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value);

/**
 * Wikidata knows many artists that Wikipedia and MusicBrainz name searches miss, especially regional ones, and
 * it records whether the subject is a real person with a birth date and linked official profiles.
 */
export class Wikidata {
  constructor(
    private f: Fetch = fetch,
    private userAgent = "spotify-ai-detector/0.1 (https://github.com/karakostasi/spotify-AI-detector)",
  ) {}

  private get<T>(params: string): Promise<T | null> {
    return getJson<T>(this.f, `${API}?${params}&format=json`, { "user-agent": this.userAgent }).catch(() => null);
  }

  async lookup(name: string, deezerArtistId?: number): Promise<WikidataInfo> {
    const none: WikidataInfo = { found: false, aiDescribed: false, isHuman: false, linkCount: 0 };
    const search = await this.get<{ search?: { id: string; label?: string; description?: string }[] }>(
      `action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=7`,
    );
    const target = normalizeName(name);
    const candidates = (search?.search ?? [])
      .filter((c) => c.label && normalizeName(c.label) === target)
      // Same-name footballers and films are common; only musical (or AI-music) items count.
      .filter((c) => c.description && (MUSICAL.test(c.description) || looksAiMade(c.description)))
      .slice(0, 3);
    if (!candidates.length) return none;

    const got = await this.get<{ entities?: Record<string, Entity> }>(
      `action=wbgetentities&ids=${candidates.map((c) => c.id).join("|")}&props=claims|descriptions&languages=en`,
    );
    const entities = candidates.map((c) => got?.entities?.[c.id]).filter((e): e is Entity => !!e);
    // Prefer the item that links to this exact Deezer artist; otherwise the first match.
    const e = (deezerArtistId !== undefined && entities.find((x) => values(x, DEEZER_ID).map(String).includes(String(deezerArtistId)))) || entities[0];
    if (!e) return none;

    const description = e.descriptions?.en?.value;
    const birth = /^\+?(\d{4})/.exec(String((values(e, BIRTH_DATE)[0] as { time?: string } | undefined)?.time ?? ""));
    const mbid = values(e, MUSICBRAINZ_ID)[0];
    return {
      found: true,
      id: e.id,
      description,
      aiDescribed: looksAiMade(description ?? ""),
      isHuman: values(e, "P31").some((v) => (v as { id?: string } | undefined)?.id === HUMAN),
      birthYear: birth ? Number(birth[1]) : undefined,
      linkCount: LINK_PROPS.filter((p) => values(e, p).length > 0).length,
      musicBrainzId: typeof mbid === "string" ? mbid : undefined,
    };
  }
}
