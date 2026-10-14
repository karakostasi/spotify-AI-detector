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
  const [wikipedia, setlists, mbLive] = await Promise.all([
    new Wikipedia(f).lookup(name).catch(() => undefined),
    o.setlistFmKey && o.mbid ? new SetlistFm(o.setlistFmKey, f).setlistCount(o.mbid).catch(() => undefined) : undefined,
    o.mbid ? mb.liveEvidence(o.mbid).catch(() => undefined) : undefined,
  ]);
  const live = setlists === undefined && !mbLive ? undefined : { setlists, mbEvents: mbLive?.events, liveReleases: mbLive?.liveReleases };
  return { wikipedia, live };
}

/**
 * Adds the YouTube evidence only when it can change the answer. A YouTube search costs 100 of the 10,000 daily quota
 * units, so when everything else already says clearly human or clearly AI it is skipped.
 * `profile` must already carry the other evidence (MusicBrainz, Wikidata, Wikipedia, live).
 */
export async function withYouTubeIfUncertain(profile: ArtistProfile, youtubeKey: string | undefined, f: Fetch = fetch): Promise<WebPresence> {
  const web = profile.web ?? {};
  if (!youtubeKey) return web;
  if (!needsYouTube(scoreArtist(profile))) return { ...web, youtubeSkipped: true };
  const videos = await new YouTube(youtubeKey, f).liveVideos(profile.name).catch(() => undefined);
  return videos ? { ...web, youtube: { videos } } : web;
}
