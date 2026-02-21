export const LOCAL_API_HOST = '127.0.0.1'
export const LOCAL_API_DEFAULT_PORT = 38401
export const LOCAL_API_MIN_PORT = 1024
export const LOCAL_API_MAX_PORT = 65535

export type LocalApiPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type LocalApiMode = 'off' | 'api' | 'api-control'
export type LocalApiControlCommand = 'play' | 'pause' | 'next' | 'previous'

export interface LocalApiTrackSnapshot {
  id: string
  title: string
  artist: string
  album: string
  isFavorite: boolean
}

export interface LocalApiNowPlayingSnapshot {
  playbackState: LocalApiPlaybackState
  currentTime: number
  duration: number
  queueLength: number
  outputDeviceLabel: string | null
  visualizerLineColor: string
  currentTrack: LocalApiTrackSnapshot | null
  updatedAt: number
}

export interface LocalApiServiceConfig {
  enabled: boolean
  controlsEnabled: boolean
  port: number
  token: string
}

export interface LocalApiStatus {
  enabled: boolean
  controlsEnabled: boolean
  host: string
  port: number
  baseUrl: string
  token: string
  active: boolean
  mode: LocalApiMode
  connectedClients: number
  lastError: string | null
}
