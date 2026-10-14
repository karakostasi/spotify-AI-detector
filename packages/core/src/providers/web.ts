import type { ArtistProfile, WebPresence } from "../types.js";
import { needsYouTube, scoreArtist } from "../engine.js";
import { Wikipedia } from "./wikipedia.js";
import { SetlistFm } from "./setlistfm.js";
import { YouTube } from "./youtube.js";
import { MusicBrainz } from "./musicbrainz.js";
import type { Fetch } from "./http.js";

export interface WebLookupOptions {
  mbid?: string;
  /** Optional: enables the concert-history check */
  setlistFmKey?: string;
  /** Share the caller's MusicBrainz client so its 1 request/second limit is respected across lookups */
  musicBrainz?: MusicBrainz;
  fetch?: Fetch;
}

/** Each source is independent and optional; one failing or missing never blocks the others. */
export async function lookupWebPresence(name: string, o: WebLookupOptions = {}): Promise<WebPresence> {
  const f = o.fetch ?? fetch;
  const mb = o.musicBrainz ?? new MusicBrainz(f);
  const setlist = o.setlistFmKey ? new SetlistFm(o.setlistFmKey, f) : undefined;
  // An act MusicBrainz doesn't know can still be on setlist.fm, whose id then unlocks the concert checks.
  const mbid = o.mbid ?? (await setlist?.findMbid(name).catch(() => undefined));
  const [wikipedia, setlists, mbLive] = await Promise.all([
    new Wikipedia(f).lookup(name).catch(() => undefined),
    setlist && mbid ? setlist.setlistCount(mbid).catch(() => undefined) : undefined,
    mbid ? mb.liveEvidence(mbid).catch(() => undefined) : undefined,
  ]);
  const live =
    setlists === undefined && !mbLive
      ? setlist && !mbid ? { unlisted: true } : undefined // we did look: the act isn't listed, which is not the same as "not checked"
      : { setlists, mbEvents: mbLive?.events, liveReleases: mbLive?.liveReleases };
  return { wikipedia, live };
}

/**
 * Adds the YouTube evidence: live videos and the artist's channel. It runs every time by default. A search costs about
 * 102 of the 10,000 free daily quota units, so `onlyWhenUncertain` skips it when everything else already says clearly
 * human or clearly AI.
 * `profile` must already carry the other evidence (MusicBrainz, Wikidata, Wikipedia, live).
 */
export async function withYouTube(
  profile: ArtistProfile,
  youtubeKey: string | undefined,
  opts: { onlyWhenUncertain?: boolean; fetch?: Fetch } = {},
): Promise<WebPresence> {
  const web = profile.web ?? {};
  if (!youtubeKey) return web;
  if (opts.onlyWhenUncertain && !needsYouTube(scoreArtist(profile))) return { ...web, youtubeSkipped: true };
  const result = await new YouTube(youtubeKey, opts.fetch ?? fetch).collect(profile.name, { channelId: web.wikidata?.youtubeChannelId }).catch(() => undefined);
  return result ? { ...web, youtube: result } : web;
}
