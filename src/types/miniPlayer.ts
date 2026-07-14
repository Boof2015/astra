export type MiniPlayerPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type MiniPlayerRepeatMode = 'none' | 'one' | 'all'
export type MiniPlayerTimeDisplayMode = 'remaining' | 'duration'
export type MiniPlayerVisualizerMode = 'off' | 'oscilloscope' | 'spectrum'
export type MiniPlayerLayoutMode = 'strip' | 'card' | 'cover'

export const DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE: MiniPlayerTimeDisplayMode = 'remaining'

// BrowserWindow's 300px minimum includes the miniplayer's 1px border on each side,
// so its observed content width is 298px. Keep the cover threshold below that box.
const MINI_PLAYER_COVER_MIN_WIDTH = 280
const MINI_PLAYER_COVER_MIN_HEIGHT = 300
const MINI_PLAYER_COVER_MAX_ASPECT_RATIO = 1.35
const MINI_PLAYER_STRIP_MAX_HEIGHT = 179
const MINI_PLAYER_STRIP_MAX_WIDTH = 399

export function resolveMiniPlayerLayout(width: number, height: number): MiniPlayerLayoutMode {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0
  const aspectRatio = safeHeight > 0 ? safeWidth / safeHeight : Number.POSITIVE_INFINITY

  if (
    safeWidth >= MINI_PLAYER_COVER_MIN_WIDTH
    && safeHeight >= MINI_PLAYER_COVER_MIN_HEIGHT
    && aspectRatio <= MINI_PLAYER_COVER_MAX_ASPECT_RATIO
  ) {
    return 'cover'
  }

  if (safeHeight <= MINI_PLAYER_STRIP_MAX_HEIGHT || safeWidth <= MINI_PLAYER_STRIP_MAX_WIDTH) {
    return 'strip'
  }

  return 'card'
}

export function formatMiniPlayerTrackContext(
  track: Pick<MiniPlayerTrackSnapshot, 'artist' | 'album'>
): string {
  const artist = track.artist.trim()
  const album = track.album.trim()
  if (artist && album) return `${artist} • ${album}`
  return artist || album || 'Unknown artist'
}

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
  duration?: number
  year?: number | null
  genres?: string[]
  format?: string | null
  sampleRate?: number | null
  bitDepth?: number | null
  channels?: number | null
}

export interface MiniPlayerSnapshot {
  playbackState: MiniPlayerPlaybackState
  currentTime: number
  duration: number
  queueLength: number
  shuffle: boolean
  repeat: MiniPlayerRepeatMode
  volume?: number
  isMuted?: boolean
  outputDeviceLabel: string | null
  currentTrack: MiniPlayerTrackSnapshot | null
  timeDisplayMode: MiniPlayerTimeDisplayMode
  visualizerLineColor: string
}

export interface MiniPlayerQueueItemSnapshot {
  queueId: string
  title: string
  artist: string
  durationSeconds: number | null
  isCurrent: boolean
  trackPath?: string
}

export interface MiniPlayerQueueSnapshot {
  items: MiniPlayerQueueItemSnapshot[]
  updatedAt: number
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
  | { type: 'toggleShuffle' }
  | { type: 'toggleRepeat' }
  | { type: 'playQueueItem'; queueId: string }
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
