import { getJson, type Fetch } from "./http.js";
import { nameSimilarity } from "../query/interpret.js";

const BASE = "https://api.setlist.fm/rest/1.0";

/** Concert history from setlist.fm. Needs a free API key (https://www.setlist.fm/settings/api). */
export class SetlistFm {
  constructor(private key: string, private f: Fetch = fetch) {}

  /** The MusicBrainz id of the artist whose name matches, for acts we could not find on MusicBrainz ourselves. */
  async findMbid(name: string): Promise<string | undefined> {
    const r = await getJson<{ artist?: { mbid?: string; name?: string }[] }>(this.f, `${BASE}/search/artists?artistName=${encodeURIComponent(name)}&sort=relevance`, { "x-api-key": this.key });
    return r?.artist?.find((a) => a.mbid && a.name && nameSimilarity(a.name, name) >= 0.95)?.mbid;
  }

  /** Number of recorded setlists for a MusicBrainz artist id (0 if none). */
  async setlistCount(mbid: string): Promise<number> {
    const r = await getJson<{ total?: number }>(this.f, `${BASE}/artist/${encodeURIComponent(mbid)}/setlists?p=1`, { "x-api-key": this.key });
    return r?.total ?? 0;
  }
}
