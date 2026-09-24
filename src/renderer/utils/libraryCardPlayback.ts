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

export interface LibraryCardPlaybackFilters {
  sourceFilters: ReadonlySet<string>
  hiddenFolderPrefixes: readonly string[]
  platform: string
  albumIdentityKeys?: ReadonlySet<string>
}

type LibraryCardTrack = Pick<DbTrack, 'path' | 'source_type' | 'source_id' | 'is_available'> & Partial<Pick<DbTrack, 'album_identity_key'>>

export interface LibraryCardPlaybackSnapshot extends HomePlaybackContext {
  playbackState: string
  pendingKey: string | null
}

export type LibraryCardSource = Extract<PlaybackSourceContext, { type: 'album' | 'artist' | 'genre' | 'year' }>
export interface LibraryCardTarget {
  source: LibraryCardSource
  title: string
}

export function albumCardPlaybackSource(album: AlbumPlaybackTarget): Extract<LibraryCardSource, { type: 'album' }> {
  return { type: 'album', album: album.album, albumArtist: album.artist, identityKey: album.identity_key }
}

export function getAlbumCardPlaybackState(album: AlbumPlaybackTarget, snapshot: LibraryCardPlaybackSnapshot): HomePlaybackControlState {
  return getLibraryCardPlaybackState(albumCardPlaybackSource(album), snapshot)
}

export function getLibraryCardPlaybackState(source: PlaybackSourceContext, snapshot: LibraryCardPlaybackSnapshot): HomePlaybackControlState {
  const active = isHomePlaybackTargetActive(source, snapshot)
  return {
    active,
    playing: active && snapshot.playbackState === 'playing',
    pending: snapshot.pendingKey === playbackSourceKey(source) || (active && snapshot.playbackState === 'loading'),
    disabled: snapshot.pendingKey !== null || snapshot.playbackState === 'loading'
  }
}

function isPlayableLibraryTrack(track: LibraryCardTrack, filters: LibraryCardPlaybackFilters): boolean {
  if (track.is_available === 0) return false
  if (filters.albumIdentityKeys && !filters.albumIdentityKeys.has(track.album_identity_key ?? '')) return false
  if (filters.hiddenFolderPrefixes.some((prefix) => isSameOrDescendantFsPath(track.path, prefix, filters.platform))) return false
  if (filters.sourceFilters.size === 0) return true
  const source = track.source_type === 'local' ? 'local'
    : track.source_id === null ? null : `${track.source_type}:${track.source_id}`
  return source !== null && filters.sourceFilters.has(source)
}

/** One request lock across library cards, including the time before React renders. */
export function createLibraryCardPlaybackActions(actions: {
  getContext: () => HomePlaybackContext & { loading: boolean }
  getTracks: (source: LibraryCardSource) => Promise<readonly LibraryCardTrack[]>
  toggle: () => Promise<void>
  start: (paths: string[], startIndex: number, options: PlaybackContextOptions) => Promise<void>
  onPendingChange: (key: string | null) => void
  onError: (message: string | null) => void
}) {
  let pendingKey: string | null = null

  return {
    async play({ source, title }: LibraryCardTarget, filters: LibraryCardPlaybackFilters): Promise<void> {
      const context = actions.getContext()
      if (pendingKey !== null || context.loading) return
      pendingKey = playbackSourceKey(source)
      actions.onPendingChange(pendingKey)
      actions.onError(null)
      try {
        await activateHomePlayback(source, context, {
          toggle: actions.toggle,
          start: async () => {
            // Fetch the collection independently of search results. Album queries
            // already return canonical disc/track order; year filters honor Singles.
            const tracks = await actions.getTracks(source)
            const paths = tracks.filter((track) => isPlayableLibraryTrack(track, filters)).map((track) => track.path)
            if (paths.length === 0) throw new Error(`No available tracks in ${title}.`)
            await actions.start(paths, 0, {
              sourceContext: source, contextLabel: title,
              ...(source.type === 'album' ? { shuffle: false } : { startShuffled: true })
            })
          }
        })
      } catch (error) {
        actions.onError(error instanceof Error ? error.message : `Could not play ${title}.`)
      } finally {
        pendingKey = null
        actions.onPendingChange(null)
      }
    }
  }
}
