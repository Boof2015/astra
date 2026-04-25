export interface AlbumEligibilityGroupLike {
  albumKey: string
  trackCount: number
}

export interface AlbumEligibilityOptions {
  includeSingles?: boolean
}

const UNKNOWN_ALBUM_KEY = 'unknown album'
const MIN_TRACKS_FOR_ALBUM = 2

export function isAlbumGroupEligible(
  group: AlbumEligibilityGroupLike,
  options: AlbumEligibilityOptions = {}
): boolean {
  if (group.albumKey === UNKNOWN_ALBUM_KEY) return false
  if (!options.includeSingles && group.trackCount < MIN_TRACKS_FOR_ALBUM) return false
  return true
}
