export const LOCAL_API_LOOPBACK_HOST = '127.0.0.1'
export const LOCAL_API_DEFAULT_PORT = 38401
export const LOCAL_API_MIN_PORT = 1024
export const LOCAL_API_MAX_PORT = 65535

export type LocalApiPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type LocalApiRepeatMode = 'none' | 'one' | 'all'
export type LocalApiMode = 'off' | 'api' | 'api-control'
export type LocalApiControlCommand =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'toggle-favorite'
  | 'toggle-shuffle'
  | 'toggle-repeat'
  | 'play-queue-item'
  | 'seek'

export interface LocalApiTrackSnapshot {
  id: string
  title: string
  artist: string
  artists: string[]
  album: string
  albumArtists: string[]
  isFavorite: boolean
  artworkUrl: string | null
  artworkDataUrl: string | null
}

export interface LocalApiNowPlayingSnapshot {
  playbackState: LocalApiPlaybackState
  currentTime: number
  duration: number
  queueLength: number
  shuffle: boolean
  repeat: LocalApiRepeatMode
  outputDeviceLabel: string | null
  visualizerLineColor: string
  currentTrack: LocalApiTrackSnapshot | null
  updatedAt: number
}

export interface LocalApiQueueItemSnapshot {
  queueId: string
  title: string
  artist: string
  durationSeconds: number | null
  isCurrent: boolean
}

export interface LocalApiQueueSnapshot {
  items: LocalApiQueueItemSnapshot[]
  updatedAt: number
}

export interface LocalApiServiceConfig {
  enabled: boolean
  controlsEnabled: boolean
  librarySearchEnabled: boolean
  libraryWriteEnabled: boolean
  port: number
  token: string
}

export interface LocalApiStatus {
  enabled: boolean
  controlsEnabled: boolean
  librarySearchEnabled: boolean
  libraryWriteEnabled: boolean
  bindHost: string
  port: number
  baseUrl: string
  token: string
  active: boolean
  mode: LocalApiMode
  connectedClients: number
  lastError: string | null
}
