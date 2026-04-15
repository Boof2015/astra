export const LOCAL_API_LOOPBACK_HOST = '127.0.0.1'
export const LOCAL_API_LAN_HOST = '0.0.0.0'
export const LOCAL_API_DEFAULT_PORT = 38401
export const LOCAL_API_MIN_PORT = 1024
export const LOCAL_API_MAX_PORT = 65535

export type LocalApiPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type LocalApiMode = 'off' | 'api' | 'api-control'
export type LocalApiControlCommand = 'play' | 'pause' | 'next' | 'previous' | 'toggle-favorite' | 'seek'
export type LocalApiPairingState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'

export interface LocalApiTrackSnapshot {
  id: string
  title: string
  artist: string
  album: string
  isFavorite: boolean
  artworkUrl: string | null
  artworkDataUrl: string | null
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
  remoteWebEnabled: boolean
  port: number
  token: string
}

export interface LocalApiPairedDevice {
  id: string
  name: string
  clientLabel: string
  tokenPrefix: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface LocalApiPendingPairingRequest {
  id: string
  deviceName: string
  clientLabel: string
  requestedAt: number
  expiresAt: number
  baseUrl: string
}

export interface LocalApiPairingTicket {
  ticket: string
  baseUrl: string
  controllerUrl: string
  pairingUrl: string
  createdAt: number
  expiresAt: number
}

export interface LocalApiStatus {
  enabled: boolean
  controlsEnabled: boolean
  remoteWebEnabled: boolean
  bindHost: string
  port: number
  baseUrl: string
  lanUrls: string[]
  controllerUrl: string | null
  token: string
  active: boolean
  mode: LocalApiMode
  connectedClients: number
  pairedDeviceCount: number
  pendingPairingCount: number
  lastError: string | null
}
