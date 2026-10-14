import { getJson, type Fetch } from "./http.js";

const BASE = "https://api.setlist.fm/rest/1.0";

/** Concert history from setlist.fm. Needs a free API key (https://www.setlist.fm/settings/api). */
export class SetlistFm {
  constructor(private key: string, private f: Fetch = fetch) {}

  /** Number of recorded setlists for a MusicBrainz artist id (0 if none). */
  async setlistCount(mbid: string): Promise<number> {
    const r = await getJson<{ total?: number }>(this.f, `${BASE}/artist/${encodeURIComponent(mbid)}/setlists?p=1`, { "x-api-key": this.key });
    return r?.total ?? 0;
  }
}
