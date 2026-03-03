export interface LastFmPendingScrobble {
  id: string
  trackPath: string | null
  track: string
  artist: string
  album: string | null
  albumArtist: string | null
  durationSeconds: number | null
  timestamp: number
  queuedAt: number
  retryCount: number
  nextRetryAt: number
}

export interface LastFmServiceConfig {
  enabled: boolean
  sessionKey: string | null
  username: string | null
  pendingScrobbles: LastFmPendingScrobble[]
}

export interface LastFmStatus {
  enabled: boolean
  connected: boolean
  username: string | null
  authPending: boolean
  pendingScrobbles: number
  hasApiCredentials: boolean
  statusMessage: string
  lastError: string | null
}

export interface LastFmAuthStartResult {
  ok: boolean
  authPending: boolean
  message: string
  authUrl?: string
}

export interface LastFmAuthFinishResult {
  ok: boolean
  connected: boolean
  username: string | null
  message: string
}
