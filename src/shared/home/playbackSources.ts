import type { PlaybackSourceContext } from '../../types/playbackSource'
import type { HomePlaybackSourceSummary } from '../../types/home'
import { normalizeIdentityKey } from '../library/artistCredits'

export function normalizePlaybackSourceContext(value: unknown): PlaybackSourceContext | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const label = (key: string): string | undefined => {
    const text = source[key]
    return typeof text === 'string' && text.trim() ? text.trim() : undefined
  }
  switch (source.type) {
    case 'playlist':
      return Number.isSafeInteger(source.playlistId) && (Number(source.playlistId) > 0 || source.playlistId === -1)
        ? { type: 'playlist', playlistId: Number(source.playlistId) } : null
    case 'track':
      return label('trackPath') ? { type: 'track', trackPath: label('trackPath')! } : null
    case 'album':
      return label('album') ? {
        type: 'album', album: label('album')!, albumArtist: label('albumArtist'), identityKey: label('identityKey')
      } : null
    case 'artist':
      return label('artist') ? { type: 'artist', artist: label('artist')! } : null
    case 'genre':
      return label('genre') ? { type: 'genre', genre: label('genre')! } : null
    case 'year':
      return source.year === 'unknown' || Number.isSafeInteger(source.year)
        ? { type: 'year', year: source.year as number | 'unknown' } : null
    default:
      return null
  }
}

export function playbackSourceKey(source: PlaybackSourceContext): string {
  switch (source.type) {
    case 'playlist': return `playlist:${source.playlistId}`
    case 'track': return `track:${source.trackPath}`
    case 'album': return `album:${source.identityKey ?? `${normalizeIdentityKey(source.albumArtist)}\0${normalizeIdentityKey(source.album)}`}`
    case 'artist': return `artist:${normalizeIdentityKey(source.artist)}`
    case 'genre': return `genre:${normalizeIdentityKey(source.genre)}`
    case 'year': return `year:${source.year}`
  }
}

/** Resolve from the actual item, never from the queue's original collection. */
export function resolveCurrentPlaybackSource(state: {
  currentTrack: { path: string; origin?: string; albumIdentityKey?: string } | null
  currentQueueItemId: string | null
  queueItems: readonly { queueId: string; entry: { path: string }; sourceContext: PlaybackSourceContext | null; sourcePlaylistId: number | null }[]
}): PlaybackSourceContext | null {
  const track = state.currentTrack
  if (!track || track.origin === 'associated-external') return null
  if (!state.currentQueueItemId) return { type: 'track', trackPath: track.path }
  const item = state.queueItems.find((entry) => entry.queueId === state.currentQueueItemId)
  if (!item || item.entry.path !== track.path) return null
  const source = item.sourceContext ?? (item.sourcePlaylistId !== null
    ? normalizePlaybackSourceContext({ type: 'playlist', playlistId: item.sourcePlaylistId }) : null)
  if (source?.type === 'track') return { type: 'track', trackPath: track.path }
  if (source?.type === 'album' && !source.identityKey && track.albumIdentityKey) {
    return { ...source, identityKey: track.albumIdentityKey }
  }
  return source
}

export function buildHomeSourceCards(
  recent: readonly HomePlaybackSourceSummary[],
  activeSource: PlaybackSourceContext | null,
  activeSummary: HomePlaybackSourceSummary | null,
  limit: number
): Array<HomePlaybackSourceSummary & { active: boolean }> {
  const activeKey = activeSource ? playbackSourceKey(activeSource) : null
  const candidates = activeSummary?.key === activeKey ? [activeSummary, ...recent] : [...recent]
  const seen = new Set<string>()
  return candidates.filter((entry) => {
    if (seen.has(entry.key)) return false
    seen.add(entry.key)
    return true
  }).map((entry) => ({ ...entry, active: entry.key === activeKey }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.last_played_at - a.last_played_at || a.key.localeCompare(b.key))
    .slice(0, limit)
}
