export interface AlbumYearSortRecord {
  identity_key: string
  album: string
  artist: string
  year?: number | null
}

function toSortableYear(year: number | null | undefined): number | null {
  if (typeof year !== 'number' || !Number.isFinite(year)) return null
  return year
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

export function compareAlbumsByYearDescending(a: AlbumYearSortRecord, b: AlbumYearSortRecord): number {
  const aYear = toSortableYear(a.year)
  const bYear = toSortableYear(b.year)

  if (aYear !== null && bYear !== null && aYear !== bYear) return bYear - aYear
  if (aYear === null && bYear !== null) return 1
  if (aYear !== null && bYear === null) return -1

  const albumCompare = compareText(a.album, b.album)
  if (albumCompare !== 0) return albumCompare

  const artistCompare = compareText(a.artist, b.artist)
  if (artistCompare !== 0) return artistCompare

  return a.identity_key.localeCompare(b.identity_key)
}
