import { compareBaseLocaleText } from './localeSort'

export type AlbumSortKey = 'title' | 'artist' | 'year'
export type AlbumSortDirection = 'asc' | 'desc'

export interface AlbumSortState {
  key: AlbumSortKey
  direction: AlbumSortDirection
}

export interface AlbumSortRecord {
  identity_key: string
  album: string
  artist: string
  year?: number | null
}

export const DEFAULT_ALBUM_SORT_STATE: AlbumSortState = { key: 'title', direction: 'asc' }

export function getDefaultAlbumSortDirection(key: AlbumSortKey): AlbumSortDirection {
  return key === 'year' ? 'desc' : 'asc'
}

export function normalizeAlbumSortState(value: unknown): AlbumSortState {
  if (typeof value === 'string') {
    if (value === 'artist') return { key: 'artist', direction: 'asc' }
    if (value === 'year') return { key: 'year', direction: 'desc' }
    return { ...DEFAULT_ALBUM_SORT_STATE }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_ALBUM_SORT_STATE }
  }

  const record = value as Record<string, unknown>
  const key: AlbumSortKey = record.key === 'artist' || record.key === 'year'
    ? record.key
    : 'title'
  return {
    key,
    direction: record.direction === 'desc' ? 'desc' : 'asc'
  }
}

function compareText(left: string | null | undefined, right: string | null | undefined): number {
  return compareBaseLocaleText((left ?? '').trim(), (right ?? '').trim())
}

function compareDirected(value: number, direction: AlbumSortDirection): number {
  return direction === 'asc' ? value : -value
}

function compareYearMissingLast(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: AlbumSortDirection
): number {
  const leftYear = typeof left === 'number' && Number.isFinite(left) ? left : null
  const rightYear = typeof right === 'number' && Number.isFinite(right) ? right : null
  if (leftYear === null && rightYear === null) return 0
  if (leftYear === null) return 1
  if (rightYear === null) return -1
  return compareDirected(leftYear - rightYear, direction)
}

export function compareAlbumsBySortState(
  left: AlbumSortRecord,
  right: AlbumSortRecord,
  state: AlbumSortState
): number {
  let comparison = 0

  if (state.key === 'title') {
    comparison = compareDirected(compareText(left.album, right.album), state.direction)
    if (comparison === 0) comparison = compareText(left.artist, right.artist)
  } else if (state.key === 'artist') {
    comparison = compareDirected(compareText(left.artist, right.artist), state.direction)
    if (comparison === 0) comparison = compareText(left.album, right.album)
  } else {
    comparison = compareYearMissingLast(left.year, right.year, state.direction)
    if (comparison === 0) comparison = compareText(left.album, right.album)
    if (comparison === 0) comparison = compareText(left.artist, right.artist)
  }

  if (comparison !== 0) return comparison
  return compareBaseLocaleText(left.identity_key, right.identity_key)
}
