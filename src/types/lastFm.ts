export const LASTFM_OFFICIAL_API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/'
export const LASTFM_OFFICIAL_PROFILE_ID = 'official-lastfm'

export type LastFmProfileKind = 'official' | 'custom'

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

export interface LastFmProfileConfig {
  id: string
  kind: LastFmProfileKind
  name: string
  apiBaseUrl: string
  sessionKey: string | null
  username: string | null
  pendingScrobbles: LastFmPendingScrobble[]
}

export interface LastFmProfileStatus {
  id: string
  kind: LastFmProfileKind
  name: string
  apiBaseUrl: string
  username: string | null
  connected: boolean
  active: boolean
  pendingScrobbles: number
  canDelete: boolean
}

export interface LastFmServiceConfig {
  enabled: boolean
  activeProfileId: string
  profiles: LastFmProfileConfig[]
}

export interface LastFmStatus {
  enabled: boolean
  connected: boolean
  username: string | null
  apiBaseUrl: string
  usingCustomEndpoint: boolean
  activeProfileId: string
  activeProfile: LastFmProfileStatus
  profiles: LastFmProfileStatus[]
  authPending: boolean
  authPendingProfileId: string | null
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

export interface LastFmCustomProfileInput {
  name: string
  apiBaseUrl: string
  username?: string | null
  sessionKey?: string | null
}

export function parseLastFmApiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

    parsed.search = ''
    parsed.hash = ''

    const normalized = parsed.toString()
    if (normalized === 'https://ws.audioscrobbler.com/2.0') {
      return LASTFM_OFFICIAL_API_BASE_URL
    }
    return normalized
  } catch {
    return null
  }
}

export function normalizeLastFmApiBaseUrl(value: unknown): string {
  return parseLastFmApiBaseUrl(value) ?? LASTFM_OFFICIAL_API_BASE_URL
}

export function isLastFmCustomEndpoint(apiBaseUrl: string): boolean {
  return normalizeLastFmApiBaseUrl(apiBaseUrl) !== LASTFM_OFFICIAL_API_BASE_URL
}
