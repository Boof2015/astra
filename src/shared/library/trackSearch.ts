import { matchesFuzzyFields } from '../../renderer/utils/fuzzySearch'

export function matchesTrackSearchQuery(
  track: { title: string; artist: string; album: string },
  query: string
): boolean {
  return matchesFuzzyFields(query, [
    { value: track.title, weight: 1.5 },
    { value: track.album, weight: 1.4 },
    { value: track.artist, weight: 1.1 }
  ])
}
