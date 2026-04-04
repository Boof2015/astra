import {
  buildAlbumIdentityKeyFromTrack as buildSharedAlbumIdentityKeyFromTrack,
  getPrimaryArtistFromTrackArtist,
  normalizeAlbumName,
  normalizeDisplay,
  normalizeKey,
  splitCollaborators
} from '../../shared/library/albumGrouping'

export type {
  AlbumIdentityArtistTrackLike,
  AlbumIdentityTrackLike
} from '../../shared/library/albumGrouping'

const UNKNOWN_ARTIST_NAME = 'Unknown Artist'

export { normalizeDisplay, normalizeKey, splitCollaborators }

export function getAlbumIdentityArtist(track: { artist: string; album_artist?: string | null }): string {
  const albumArtist = normalizeDisplay(track.album_artist ?? '')
  if (albumArtist) return albumArtist
  return normalizeDisplay(getPrimaryArtistFromTrackArtist(track.artist)) || UNKNOWN_ARTIST_NAME
}

export function buildAlbumKey(album: string, artist: string): string {
  const normalizedArtist = normalizeDisplay(artist) || UNKNOWN_ARTIST_NAME
  return `${normalizeKey(normalizeAlbumName(album))}::${normalizeKey(normalizedArtist)}`
}

export function buildAlbumIdentityKeyFromTrack(track: {
  artist: string
  album: string
  album_artist?: string | null
  artwork_hash?: string | null
  base_artwork_hash?: string | null
}): string {
  return buildSharedAlbumIdentityKeyFromTrack(track)
}
