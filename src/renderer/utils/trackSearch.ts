import {
  matchesFuzzyFields,
  multiFieldScore,
  type FieldDef,
  type SearchProfile
} from './fuzzySearch'

export interface TrackIdentitySearchRecord {
  title: string
  artist: string
  artist_names?: readonly string[] | null
  album: string
  album_artist?: string | null
  album_artist_names?: readonly string[] | null
}

function pushUniqueField(fields: FieldDef[], seen: Set<string>, value: string | null | undefined, weight: number): void {
  const trimmed = value?.trim()
  if (!trimmed) return
  const key = trimmed.toLocaleLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  fields.push({ value: trimmed, weight })
}

export function getTrackIdentitySearchFields(track: TrackIdentitySearchRecord): FieldDef[] {
  const fields: FieldDef[] = []
  const seen = new Set<string>()

  pushUniqueField(fields, seen, track.title, 1.5)
  pushUniqueField(fields, seen, track.artist, 1.2)
  for (const artist of track.artist_names ?? []) pushUniqueField(fields, seen, artist, 1.2)
  pushUniqueField(fields, seen, track.album_artist, 1.05)
  for (const artist of track.album_artist_names ?? []) pushUniqueField(fields, seen, artist, 1.05)
  pushUniqueField(fields, seen, track.album, 1)

  return fields
}

export function scoreTrackIdentityQuery(
  track: TrackIdentitySearchRecord,
  query: string,
  profile: SearchProfile = 'context'
): number | null {
  return multiFieldScore(query, getTrackIdentitySearchFields(track), profile)
}

export function matchesTrackIdentityQuery(
  track: TrackIdentitySearchRecord,
  query: string,
  profile: SearchProfile = 'context'
): boolean {
  return matchesFuzzyFields(query, getTrackIdentitySearchFields(track), profile)
}
