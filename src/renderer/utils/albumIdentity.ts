export interface AlbumIdentityArtistTrackLike {
  artist: string
  album_artist?: string | null
}

export interface AlbumIdentityTrackLike extends AlbumIdentityArtistTrackLike {
  album: string
  artwork_hash?: string | null
  base_artwork_hash?: string | null
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ARTIST_NAME = 'Unknown Artist'

function normalizeAlbumName(album: string): string {
  const normalized = normalizeDisplay(album)
  return normalized || UNKNOWN_ALBUM_NAME
}

function normalizeArtworkHash(hash: string | null | undefined): string | null {
  const normalized = normalizeDisplay(hash ?? '')
  return normalized ? normalized.toLocaleLowerCase() : null
}

function getPrimaryArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? UNKNOWN_ARTIST_NAME
}

function buildCanonicalAlbumIdentityKey(album: string, discriminator: string): string {
  return `album:${normalizeKey(normalizeAlbumName(album))}::${discriminator}`
}

export function normalizeDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeKey(value: string): string {
  return normalizeDisplay(value).toLocaleLowerCase()
}

export function splitCollaborators(rawArtist: string): string[] {
  const normalized = normalizeDisplay(rawArtist)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x\u00D7]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const unique = new Map<string, string>()
  for (const part of unified.split(',')) {
    const display = normalizeDisplay(part)
    if (!display) continue
    const key = normalizeKey(display)
    if (!key || unique.has(key)) continue
    unique.set(key, display)
  }

  return Array.from(unique.values())
}

export function getAlbumIdentityArtist(track: AlbumIdentityArtistTrackLike): string {
  const albumArtist = normalizeDisplay(track.album_artist ?? '')
  if (albumArtist) return albumArtist
  return getPrimaryArtist(track.artist)
}

export function buildAlbumKey(album: string, artist: string): string {
  const normalizedArtist = normalizeDisplay(artist) || UNKNOWN_ARTIST_NAME
  return `${normalizeKey(normalizeAlbumName(album))}::${normalizeKey(normalizedArtist)}`
}

export function buildAlbumIdentityKeyFromTrack(track: AlbumIdentityTrackLike): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) {
    return buildCanonicalAlbumIdentityKey(track.album, `aa:${normalizeKey(normalizedAlbumArtist)}`)
  }

  const artworkHash = normalizeArtworkHash(track.base_artwork_hash ?? track.artwork_hash)
  if (artworkHash) {
    return buildCanonicalAlbumIdentityKey(track.album, `ah:${artworkHash}`)
  }

  return buildCanonicalAlbumIdentityKey(track.album, `ta:${normalizeKey(getPrimaryArtist(track.artist))}`)
}
