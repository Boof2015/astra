export type MiniPlayerPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type MiniPlayerTimeDisplayMode = 'remaining' | 'duration'
export type MiniPlayerVisualizerMode = 'off' | 'oscilloscope' | 'spectrum'

export const DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE: MiniPlayerTimeDisplayMode = 'remaining'

export function normalizeMiniPlayerTimeDisplayMode(value: unknown): MiniPlayerTimeDisplayMode {
  return value === 'duration' || value === 'remaining'
    ? value
    : DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE
}

export function getNextMiniPlayerTimeDisplayMode(value: unknown): MiniPlayerTimeDisplayMode {
  const current = normalizeMiniPlayerTimeDisplayMode(value)
  return current === 'remaining' ? 'duration' : 'remaining'
}

export interface MiniPlayerTrackSnapshot {
  id: string
  path: string
  title: string
  artist: string
  artistNames?: string[]
  album: string
  albumArtist?: string | null
  albumArtistNames?: string[]
  artworkHash?: string | null
  artworkData?: string | null
  isFavorite: boolean
}

export interface MiniPlayerSnapshot {
  playbackState: MiniPlayerPlaybackState
  currentTime: number
  duration: number
  queueLength: number
  outputDeviceLabel: string | null
  currentTrack: MiniPlayerTrackSnapshot | null
  timeDisplayMode: MiniPlayerTimeDisplayMode
  visualizerLineColor: string
}

export interface MiniPlayerResolvedArtwork {
  trackPath: string
  dataUrl: string | null
}

export function selectMiniPlayerTrackArtworkData(
  currentTrack: Pick<MiniPlayerTrackSnapshot, 'path' | 'artworkData'> | null | undefined,
  resolvedArtwork: MiniPlayerResolvedArtwork | null | undefined
): string | null {
  if (!currentTrack) return null
  if (typeof currentTrack.artworkData === 'string') return currentTrack.artworkData
  if (resolvedArtwork?.trackPath === currentTrack.path) {
    return resolvedArtwork.dataUrl
  }
  return null
}

export function mergeMiniPlayerSnapshots(
  previous: MiniPlayerSnapshot | null | undefined,
  next: MiniPlayerSnapshot
): MiniPlayerSnapshot {
  const previousTrack = previous?.currentTrack ?? null
  const nextTrack = next.currentTrack

  if (!nextTrack) {
    return {
      ...next,
      currentTrack: null
    }
  }

  const shouldPreserveArtwork = previousTrack
    && previousTrack.path === nextTrack.path
    && nextTrack.artworkData === undefined

  return {
    ...next,
    currentTrack: shouldPreserveArtwork
      ? {
          ...nextTrack,
          artworkData: previousTrack.artworkData ?? null
        }
      : nextTrack
  }
}

export interface MiniPlayerVisualizerStreamChunk {
  capturedAt: number
  sampleRate: number
  leftChunks: Float32Array[]
  monoChunks: Float32Array[]
  fftSize: number
  pitchLock: boolean
  oscilloscopeUnderfillEnabled: boolean
  lineColor: string
  reset: boolean
}

export type MiniPlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePlay' }
  | { type: 'playNext' }
  | { type: 'playPrevious' }
  | { type: 'toggleTimeDisplayMode' }
  | { type: 'toggleFavoriteCurrent' }
  | { type: 'seek'; time: number }
  | { type: 'toggleFavorite'; trackPath: string }

export interface MiniPlayerWindowState {
  isOpen: boolean
  alwaysOnTop: boolean
  visualizerMode: MiniPlayerVisualizerMode
}

export interface MiniPlayerWindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  alwaysOnTop: boolean
  visualizerMode: MiniPlayerVisualizerMode
}
