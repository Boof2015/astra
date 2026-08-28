import { matchesFuzzyFields } from './fuzzySearch'
import { buildPlayableOccurrenceIndexes } from './playlistOccurrences'

export interface PlaylistSearchTrack {
  title: string
  artist: string
  album: string
}

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

  return matchesFuzzyFields(normalizedQuery, [
    { value: track.title, weight: 1.5 },
    { value: track.artist, weight: 1.2 },
    { value: track.album, weight: 1 }
  ])
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
