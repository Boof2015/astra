import { normalizeSearchValue } from './fuzzySearch'

export interface HomeRecentTrack {
  path: string
  title: string
  artist: string
  album: string
  artwork_hash: string | null
}

/** Search preserves recency order and the original track identities for playback. */
export function filterHomeRecentTracks<T extends HomeRecentTrack>(tracks: readonly T[], query: string): readonly T[] {
  const words = normalizeSearchValue(query).split(' ').filter(Boolean)
  if (!words.length) return tracks
  return tracks.filter((track) => {
    const text = normalizeSearchValue(`${track.title} ${track.artist} ${track.album}`)
    return words.every((word) => text.includes(word))
  })
}
