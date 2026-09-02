import { buildPlayableOccurrenceIndexes } from './playlistOccurrences'
import { matchesTrackIdentityQuery, type TrackIdentitySearchRecord } from './trackSearch'

export interface PlaylistSearchTrack extends TrackIdentitySearchRecord {}

export interface PlaylistSearchRow<TTrack extends PlaylistSearchTrack = PlaylistSearchTrack> {
  track: TTrack
}

export interface VisiblePlaylistSearchRow<TRow> {
  row: TRow
  queueSeedIndex: number | null
}

export function matchesPlaylistTrackQuery(
  track: PlaylistSearchTrack,
  query: string
): boolean {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return true

  return matchesTrackIdentityQuery(track, normalizedQuery, 'context')
}

export function buildVisiblePlaylistSearchRows<TRow extends PlaylistSearchRow>(
  rows: readonly TRow[],
  query: string,
  isPlayable: (row: TRow) => boolean
): Array<VisiblePlaylistSearchRow<TRow>> {
  const queueSeedIndexes = buildPlayableOccurrenceIndexes(rows, isPlayable)

  return rows.flatMap((row, index) => (
    matchesPlaylistTrackQuery(row.track, query)
      ? [{ row, queueSeedIndex: queueSeedIndexes[index] ?? null }]
      : []
  ))
}
