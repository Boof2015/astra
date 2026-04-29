import { deserializeArtistNames, formatArtistNames, normalizeArtistNames } from './artistCredits.ts'

export interface AlbumIdentityArtistTrackLike {
  artist: string
  artist_names?: readonly string[] | null
  artist_names_json?: string | null
  album_artist?: string | null
  album_artist_names?: readonly string[] | null
  album_artist_names_json?: string | null
}

export interface AlbumIdentityTrackLike extends AlbumIdentityArtistTrackLike {
  album: string
  artwork_hash?: string | null
  base_artwork_hash?: string | null
}

export type AlbumGroupingMode = 'explicit-album-artist' | 'shared-artwork-compilation' | 'track-artist'

export interface AlbumIdentityGroup<T> {
  identityKey: string
  albumKey: string
  groupingMode: AlbumGroupingMode
  displayArtist: string
  tracks: T[]
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
const VARIOUS_ARTISTS_NAME = 'Various Artists'

interface PreparedTrack<T> {
  track: T
  trackId: string
  albumKey: string
  normalizedAlbumArtist: string
  primaryArtist: string
  primaryArtistKey: string
  artworkIdentityHash: string | null
}

export function normalizeDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeKey(value: string): string {
  return normalizeDisplay(value).toLocaleLowerCase()
}

export function normalizeAlbumName(album: string): string {
  const normalized = normalizeDisplay(album)
  return normalized || UNKNOWN_ALBUM_NAME
}

export function normalizeArtworkHash(hash: string | null | undefined): string | null {
  const normalized = normalizeDisplay(hash ?? '')
  return normalized ? normalized.toLocaleLowerCase() : null
}

export function splitCollaborators(rawArtist: string): string[] {
  const normalized = normalizeDisplay(rawArtist)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
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

export function getPrimaryArtistFromTrackArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? UNKNOWN_ARTIST_NAME
}

function getPrimaryArtistFromTrack<T extends AlbumIdentityArtistTrackLike>(track: T): string {
  const parsedArtists = normalizeArtistNames(track.artist_names)
  if (parsedArtists.length > 0) return parsedArtists[0]
  const parsedArtistsJson = deserializeArtistNames(track.artist_names_json)
  if (parsedArtistsJson.length > 0) return parsedArtistsJson[0]
  return getPrimaryArtistFromTrackArtist(track.artist)
}

function getNormalizedAlbumArtist<T extends AlbumIdentityArtistTrackLike>(track: T): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) return normalizedAlbumArtist

  const parsedAlbumArtists = normalizeArtistNames(track.album_artist_names)
  if (parsedAlbumArtists.length > 0) return formatArtistNames(parsedAlbumArtists)
  const parsedAlbumArtistsJson = deserializeArtistNames(track.album_artist_names_json)
  if (parsedAlbumArtistsJson.length > 0) return formatArtistNames(parsedAlbumArtistsJson)
  return ''
}

export function buildCanonicalAlbumIdentityKey(albumKey: string, discriminator: string): string {
  return `album:${albumKey}::${discriminator}`
}

export function buildAlbumIdentityKeyFromTrack(track: AlbumIdentityTrackLike): string {
  const albumKey = normalizeKey(normalizeAlbumName(track.album))
  const normalizedAlbumArtist = getNormalizedAlbumArtist(track)
  if (normalizedAlbumArtist) {
    const albumArtistKey = normalizeKey(normalizedAlbumArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
    return buildCanonicalAlbumIdentityKey(albumKey, `aa:${albumArtistKey}`)
  }

  const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track)) || UNKNOWN_ARTIST_NAME
  const primaryArtistKey = normalizeKey(primaryArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
  return buildCanonicalAlbumIdentityKey(albumKey, `ta:${primaryArtistKey}`)
}

function createAlbumIdentityGroup<T>(
  identityKey: string,
  albumKey: string,
  groupingMode: AlbumGroupingMode,
  displayArtist: string
): AlbumIdentityGroup<T> {
  return {
    identityKey,
    albumKey,
    groupingMode,
    displayArtist,
    tracks: []
  }
}

function resolveSharedArtworkHash<T>(tracks: readonly PreparedTrack<T>[]): string | null {
  const firstHash = tracks[0]?.artworkIdentityHash ?? null
  if (!firstHash) return null

  for (const track of tracks) {
    if (track.artworkIdentityHash !== firstHash) {
      return null
    }
  }

  return firstHash
}

export function groupTracksByAlbumIdentity<T extends AlbumIdentityTrackLike>(
  tracks: readonly T[],
  getTrackId: (track: T) => string
): Map<string, AlbumIdentityGroup<T>> {
  const groups = new Map<string, AlbumIdentityGroup<T>>()
  const missingAlbumArtistBuckets = new Map<string, PreparedTrack<T>[]>()

  for (const track of tracks) {
    const trackId = getTrackId(track)
    const albumKey = normalizeKey(normalizeAlbumName(track.album))
    const normalizedAlbumArtist = getNormalizedAlbumArtist(track)
    const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track)) || UNKNOWN_ARTIST_NAME
    const primaryArtistKey = normalizeKey(primaryArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
    const artworkIdentityHash = normalizeArtworkHash(track.base_artwork_hash)

    if (normalizedAlbumArtist) {
      const albumArtistKey = normalizeKey(normalizedAlbumArtist) || normalizeKey(UNKNOWN_ARTIST_NAME)
      const identityKey = buildCanonicalAlbumIdentityKey(albumKey, `aa:${albumArtistKey}`)
      let group = groups.get(identityKey)
      if (!group) {
        group = createAlbumIdentityGroup(identityKey, albumKey, 'explicit-album-artist', normalizedAlbumArtist)
        groups.set(identityKey, group)
      }
      group.tracks.push(track)
      continue
    }

    const bucket = missingAlbumArtistBuckets.get(albumKey)
    const preparedTrack: PreparedTrack<T> = {
      track,
      trackId,
      albumKey,
      normalizedAlbumArtist,
      primaryArtist,
      primaryArtistKey,
      artworkIdentityHash
    }

    if (bucket) {
      bucket.push(preparedTrack)
    } else {
      missingAlbumArtistBuckets.set(albumKey, [preparedTrack])
    }
  }

  for (const bucket of missingAlbumArtistBuckets.values()) {
    const primaryArtistKeys = new Set(bucket.map((track) => track.primaryArtistKey))
    const sharedArtworkHash = primaryArtistKeys.size > 1 ? resolveSharedArtworkHash(bucket) : null

    if (sharedArtworkHash) {
      const identityKey = buildCanonicalAlbumIdentityKey(bucket[0].albumKey, `ah:${sharedArtworkHash}`)
      let group = groups.get(identityKey)
      if (!group) {
        group = createAlbumIdentityGroup(identityKey, bucket[0].albumKey, 'shared-artwork-compilation', VARIOUS_ARTISTS_NAME)
        groups.set(identityKey, group)
      }
      for (const track of bucket) {
        group.tracks.push(track.track)
      }
      continue
    }

    for (const track of bucket) {
      const identityKey = buildCanonicalAlbumIdentityKey(track.albumKey, `ta:${track.primaryArtistKey}`)
      let group = groups.get(identityKey)
      if (!group) {
        group = createAlbumIdentityGroup(identityKey, track.albumKey, 'track-artist', track.primaryArtist)
        groups.set(identityKey, group)
      }
      group.tracks.push(track.track)
    }
  }

  return groups
}

export function buildAlbumIdentityKeyByTrackId<T extends AlbumIdentityTrackLike>(
  tracks: readonly T[],
  getTrackId: (track: T) => string
): Map<string, string> {
  const keysByTrackId = new Map<string, string>()
  const groups = groupTracksByAlbumIdentity(tracks, getTrackId)

  for (const [identityKey, group] of groups.entries()) {
    for (const track of group.tracks) {
      keysByTrackId.set(getTrackId(track), identityKey)
    }
  }

  return keysByTrackId
}
