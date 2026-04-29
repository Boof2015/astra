import {
  buildAlbumIdentityKeyFromTrack as buildSharedAlbumIdentityKeyFromTrack,
  getPrimaryArtistFromTrackArtist,
  normalizeAlbumName,
  normalizeDisplay,
  normalizeKey,
  splitCollaborators
} from '../../shared/library/albumGrouping.ts'
import { formatArtistNames, normalizeArtistNames } from '../../shared/library/artistCredits.ts'

export type {
  AlbumIdentityArtistTrackLike,
  AlbumIdentityTrackLike
} from '../../shared/library/albumGrouping.ts'

const UNKNOWN_ARTIST_NAME = 'Unknown Artist'

export { normalizeDisplay, normalizeKey, splitCollaborators }

export function getAlbumIdentityArtist(track: {
  artist: string
  artist_names?: readonly string[] | null
  album_artist?: string | null
  album_artist_names?: readonly string[] | null
}): string {
  const albumArtist = normalizeDisplay(track.album_artist ?? '')
  if (albumArtist) return albumArtist
  const albumArtistNames = normalizeArtistNames(track.album_artist_names)
  if (albumArtistNames.length > 0) return formatArtistNames(albumArtistNames)
  const artistNames = normalizeArtistNames(track.artist_names)
  if (artistNames.length > 0) return artistNames[0]
  return normalizeDisplay(getPrimaryArtistFromTrackArtist(track.artist)) || UNKNOWN_ARTIST_NAME
}

export function buildAlbumKey(album: string, artist: string): string {
  const normalizedArtist = normalizeDisplay(artist) || UNKNOWN_ARTIST_NAME
  return `${normalizeKey(normalizeAlbumName(album))}::${normalizeKey(normalizedArtist)}`
}

export function buildAlbumIdentityKeyFromTrack(track: {
  artist: string
  artist_names?: readonly string[] | null
  album: string
  album_artist?: string | null
  album_artist_names?: readonly string[] | null
  artwork_hash?: string | null
  base_artwork_hash?: string | null
}): string {
  return buildSharedAlbumIdentityKeyFromTrack(track)
}
