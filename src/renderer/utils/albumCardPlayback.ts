import type { PlaybackSourceContext } from '../../types/playbackSource'
import type { DbTrack } from '../stores/libraryStore'
import type { PlaybackContextOptions } from '../stores/playerStore'
import type { HomePlaybackControlState } from '../components/home/HomePlaybackControl'
import { playbackSourceKey } from '../../shared/home/playbackSources'
import { activateHomePlayback, isHomePlaybackTargetActive, type HomePlaybackContext } from './homePlayback'
import { isSameOrDescendantFsPath } from './folderTree'

export interface AlbumPlaybackTarget {
  identity_key: string
  album: string
  artist: string
}

export interface AlbumPlaybackFilters {
  sourceFilters: ReadonlySet<string>
  hiddenFolderPrefixes: readonly string[]
  platform: string
}

type AlbumPlaybackTrack = Pick<DbTrack, 'path' | 'source_type' | 'source_id' | 'is_available'>

export interface AlbumCardPlaybackSnapshot extends HomePlaybackContext {
  playbackState: string
  pendingKey: string | null
}

export function albumCardPlaybackSource(album: AlbumPlaybackTarget): PlaybackSourceContext {
  return { type: 'album', album: album.album, albumArtist: album.artist, identityKey: album.identity_key }
}

export function getAlbumCardPlaybackState(album: AlbumPlaybackTarget, snapshot: AlbumCardPlaybackSnapshot): HomePlaybackControlState {
  const source = albumCardPlaybackSource(album)
  const active = isHomePlaybackTargetActive(source, snapshot)
  return {
    active,
    playing: active && snapshot.playbackState === 'playing',
    pending: snapshot.pendingKey === playbackSourceKey(source) || (active && snapshot.playbackState === 'loading'),
    disabled: snapshot.pendingKey !== null || snapshot.playbackState === 'loading'
  }
}

function isPlayableAlbumTrack(track: AlbumPlaybackTrack, filters: AlbumPlaybackFilters): boolean {
  if (track.is_available === 0) return false
  if (filters.hiddenFolderPrefixes.some((prefix) => isSameOrDescendantFsPath(track.path, prefix, filters.platform))) return false
  if (filters.sourceFilters.size === 0) return true
  const source = track.source_type === 'local' ? 'local'
    : track.source_id === null ? null : `${track.source_type}:${track.source_id}`
  return source !== null && filters.sourceFilters.has(source)
}

/** One request lock for both album surfaces, including the time before React renders. */
export function createAlbumCardPlaybackActions(actions: {
  getContext: () => HomePlaybackContext & { loading: boolean }
  getTracks: (album: AlbumPlaybackTarget) => Promise<readonly AlbumPlaybackTrack[]>
  toggle: () => Promise<void>
  start: (paths: string[], startIndex: number, options: PlaybackContextOptions) => Promise<void>
  onPendingChange: (key: string | null) => void
  onError: (message: string | null) => void
}) {
  let pendingKey: string | null = null

  return {
    async play(album: AlbumPlaybackTarget, filters: AlbumPlaybackFilters): Promise<void> {
      const context = actions.getContext()
      if (pendingKey !== null || context.loading) return
      const source = albumCardPlaybackSource(album)
      pendingKey = playbackSourceKey(source)
      actions.onPendingChange(pendingKey)
      actions.onError(null)
      try {
        await activateHomePlayback(source, context, {
          toggle: actions.toggle,
          start: async () => {
            // Fetch the whole release, not the artist's appearances or search results.
            // getTracksByAlbum already returns canonical disc/track order.
            const tracks = await actions.getTracks(album)
            const paths = tracks.filter((track) => isPlayableAlbumTrack(track, filters)).map((track) => track.path)
            if (paths.length === 0) throw new Error(`No available tracks in ${album.album}.`)
            await actions.start(paths, 0, { sourceContext: source, contextLabel: album.album, shuffle: false })
          }
        })
      } catch (error) {
        actions.onError(error instanceof Error ? error.message : `Could not play ${album.album}.`)
      } finally {
        pendingKey = null
        actions.onPendingChange(null)
      }
    }
  }
}
