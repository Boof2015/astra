export type MiniPlayerPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type MiniPlayerVisualizerMode = 'off' | 'oscilloscope' | 'spectrum'

export interface MiniPlayerTrackSnapshot {
  id: string
  path: string
  title: string
  artist: string
  album: string
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
  visualizerLineColor: string
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
