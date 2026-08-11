import { compareBaseLocaleText } from './localeSort'
import { compareTrackPlayCounts } from './trackPlayCountSort'
import type { TrackSortDirection, TrackSortRule } from './rootTrackTable'

export interface TrackSortRecord {
  path: string
  title: string
  artist: string
  album: string
  year?: number | null
  genre?: string | null
  bpm?: number | null
  musical_key?: string | null
  format?: string | null
  duration?: number | null
  source_type: 'local' | 'subsonic' | 'jellyfin'
  file_created_at: number | null
  added_at: number
  play_count: number
}

export type TrackRatingResolver = (trackPath: string) => number | null | undefined

function compareDirected(value: number, direction: TrackSortDirection): number {
  return direction === 'asc' ? value : -value
}

function compareText(left: string | null | undefined, right: string | null | undefined): number {
  return compareBaseLocaleText((left ?? '').trim(), (right ?? '').trim())
}

function compareNullableText(
  left: string | null | undefined,
  right: string | null | undefined,
  direction: TrackSortDirection
): number {
  const leftValue = (left ?? '').trim()
  const rightValue = (right ?? '').trim()
  if (!leftValue && !rightValue) return 0
  if (!leftValue) return 1
  if (!rightValue) return -1
  return compareDirected(compareBaseLocaleText(leftValue, rightValue), direction)
}

function compareNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: TrackSortDirection,
  positiveOnly = false
): number {
  const leftValue = typeof left === 'number' && Number.isFinite(left) && (!positiveOnly || left > 0) ? left : null
  const rightValue = typeof right === 'number' && Number.isFinite(right) && (!positiveOnly || right > 0) ? right : null
  if (leftValue === null && rightValue === null) return 0
  if (leftValue === null) return 1
  if (rightValue === null) return -1
  return compareDirected(leftValue - rightValue, direction)
}

function effectiveAddedAt(track: TrackSortRecord): number {
  if (track.source_type === 'local' && typeof track.file_created_at === 'number' && Number.isFinite(track.file_created_at) && track.file_created_at > 0) {
    return track.file_created_at
  }
  return track.added_at
}

export function compareTracksBySortRules(
  left: TrackSortRecord,
  right: TrackSortRecord,
  rules: readonly TrackSortRule[],
  resolveRating: TrackRatingResolver = () => null
): number {
  for (const rule of rules) {
    let comparison = 0
    if (rule.key === 'title') {
      comparison = compareDirected(compareText(left.title, right.title), rule.direction)
    } else if (rule.key === 'artist') {
      comparison = compareNullableText(left.artist, right.artist, rule.direction)
    } else if (rule.key === 'album') {
      comparison = compareNullableText(left.album, right.album, rule.direction)
    } else if (rule.key === 'year') {
      comparison = compareNullableNumber(left.year, right.year, rule.direction)
    } else if (rule.key === 'genre') {
      comparison = compareNullableText(left.genre, right.genre, rule.direction)
    } else if (rule.key === 'bpm') {
      comparison = compareNullableNumber(left.bpm, right.bpm, rule.direction, true)
    } else if (rule.key === 'musical_key') {
      comparison = compareNullableText(left.musical_key, right.musical_key, rule.direction)
    } else if (rule.key === 'rating') {
      comparison = compareNullableNumber(resolveRating(left.path), resolveRating(right.path), rule.direction, true)
    } else if (rule.key === 'codec') {
      comparison = compareNullableText(left.format, right.format, rule.direction)
    } else if (rule.key === 'added') {
      comparison = compareDirected(effectiveAddedAt(left) - effectiveAddedAt(right), rule.direction)
    } else if (rule.key === 'play_count') {
      comparison = compareTrackPlayCounts(left.play_count, right.play_count, rule.direction)
    } else {
      comparison = compareNullableNumber(left.duration, right.duration, rule.direction, true)
    }

    if (comparison !== 0) return comparison
  }

  return compareBaseLocaleText(left.path, right.path)
}
