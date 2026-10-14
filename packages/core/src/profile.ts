import type { ArtistProfile } from "./types.js";
import { Deezer, usableImage } from "./providers/deezer.js";
import { MusicBrainz } from "./providers/musicbrainz.js";

export interface ProfileOptions {
  deezer?: Deezer;
  musicBrainz?: MusicBrainz | null;
  /** How many of the newest albums to fetch details (label, track count) for */
  detailAlbums?: number;
}

async function enrich(artistId: number, name: string, isrc: string | undefined, o: Required<Pick<ProfileOptions, "detailAlbums">> & ProfileOptions): Promise<ArtistProfile> {
  const dz = o.deezer ?? new Deezer();
  const [albums, topTracks, artist] = await Promise.all([dz.albums(artistId), dz.topTracks(artistId), dz.artist(artistId)]);

  // Track counts and labels need one call per album; only do the newest few.
  const newest = [...albums].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  const detail = await Promise.all(newest.slice(0, o.detailAlbums).map((a) => dz.albumDetail(a.id)));
  const detailed = new Set<string>();
  newest.slice(0, o.detailAlbums).forEach((a, i) => {
    const d = detail[i];
    if (d) {
      a.trackCount = d.trackCount;
      a.label = d.label;
      detailed.add(a.id);
    }
  });
  // Estimate for the rest, using record_type (single ~1, ep ~4, album ~10) so velocity isn't understated.
  for (const a of albums) {
    if (!detailed.has(a.id)) a.trackCount = a.recordType === "single" ? 1 : a.recordType === "ep" ? 4 : 10;
  }

  const musicBrainz = o.musicBrainz === null ? undefined : await (o.musicBrainz ?? new MusicBrainz()).lookup(name, isrc).catch(() => undefined);

  return {
    key: `deezer:${artistId}`,
    name,
    albums,
    topTracks,
    fans: artist?.nb_fan,
    imageUrl: usableImage(artist?.picture_big),
    musicBrainz,
  };
}

export async function profileFromIsrc(isrc: string, opts: ProfileOptions = {}): Promise<ArtistProfile | null> {
  const dz = opts.deezer ?? new Deezer();
  const track = await dz.trackByIsrc(isrc);
  if (!track) return null;
  return enrich(track.artist.id, track.artist.name, isrc, { detailAlbums: 5, ...opts, deezer: dz });
}

export async function profileFromArtistName(name: string, opts: ProfileOptions = {}): Promise<ArtistProfile | null> {
  const dz = opts.deezer ?? new Deezer();
  const a = await dz.searchArtist(name);
  if (!a) return null;
  return enrich(a.id, a.name, undefined, { detailAlbums: 5, ...opts, deezer: dz });
}

export async function profileFromArtistId(id: number, name: string, isrc?: string, opts: ProfileOptions = {}): Promise<ArtistProfile> {
  return enrich(id, name, isrc, { detailAlbums: 5, ...opts, deezer: opts.deezer ?? new Deezer() });
}
