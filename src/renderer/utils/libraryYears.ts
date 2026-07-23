export type LibraryYearKey = number | 'unknown'

export interface LibraryYearAlbum {
  identity_key: string
  year: number | null
  artwork_hash: string | null
  track_count: number
}

export interface LibraryYearTrack {
  album_identity_key: string
}

export interface LibraryYearGroup {
  key: LibraryYearKey
  label: string
  album_count: number
  track_count: number
  artwork_hash: string | null
}

export function formatLibraryYearKey(key: LibraryYearKey): string {
  return key === 'unknown' ? 'Unknown Year' : String(key)
}

export function albumMatchesLibraryYear(
  album: Pick<LibraryYearAlbum, 'year'>,
  key: LibraryYearKey
): boolean {
  return key === 'unknown' ? album.year === null : album.year === key
}

export function filterTracksByLibraryYearAlbums<T extends LibraryYearTrack>(
  tracks: readonly T[],
  albums: readonly Pick<LibraryYearAlbum, 'identity_key' | 'year'>[],
  key: LibraryYearKey
): T[] {
  const matchingAlbumIdentityKeys = new Set(
    albums
      .filter((album) => albumMatchesLibraryYear(album, key))
      .map((album) => album.identity_key)
  )
  return tracks.filter((track) => matchingAlbumIdentityKeys.has(track.album_identity_key))
}

export function buildLibraryYearGroups(albums: readonly LibraryYearAlbum[]): LibraryYearGroup[] {
  const groups = new Map<LibraryYearKey, LibraryYearGroup>()
  const albumsInStableArtworkOrder = [...albums].sort((a, b) => (
    a.identity_key.localeCompare(b.identity_key, undefined, { sensitivity: 'base' })
  ))

  for (const album of albumsInStableArtworkOrder) {
    const key: LibraryYearKey = album.year ?? 'unknown'
    const existing = groups.get(key)
    if (existing) {
      existing.album_count += 1
      existing.track_count += album.track_count
      if (!existing.artwork_hash && album.artwork_hash) {
        existing.artwork_hash = album.artwork_hash
      }
      continue
    }

    groups.set(key, {
      key,
      label: formatLibraryYearKey(key),
      album_count: 1,
      track_count: album.track_count,
      artwork_hash: album.artwork_hash
    })
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === 'unknown') return b.key === 'unknown' ? 0 : 1
    if (b.key === 'unknown') return -1
    return b.key - a.key
  })
}
