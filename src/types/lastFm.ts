export const LASTFM_OFFICIAL_API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/'
export const LASTFM_OFFICIAL_PROFILE_ID = 'official-lastfm'

export type LastFmProfileKind = 'official' | 'custom'
export type LastFmScrobbleProtocol = 'lastfm2' | 'audioscrobbler' | 'listenbrainz'

export interface LastFmPendingScrobble {
  id: string
  trackPath: string | null
  track: string
  artist: string
  artistNames?: string[]
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
  protocol: LastFmScrobbleProtocol
  name: string
  apiBaseUrl: string
  enabled: boolean
  sessionKey: string | null
  username: string | null
  pendingScrobbles: LastFmPendingScrobble[]
}

export interface LastFmProfileStatus {
  id: string
  kind: LastFmProfileKind
  protocol: LastFmScrobbleProtocol
  protocolLabel: string
  name: string
  apiBaseUrl: string
  enabled: boolean
  username: string | null
  connected: boolean
  active: boolean
  pendingScrobbles: number
  canDelete: boolean
  requiresApiCredentials: boolean
  lastError: string | null
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
  activeProfileRequiresApiCredentials: boolean
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
  protocol?: LastFmScrobbleProtocol
  name: string
  apiBaseUrl: string
  username?: string | null
  sessionKey?: string | null
}

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.search = ''
    parsed.hash = ''
    return parsed
  } catch {
    return null
  }
}

export function normalizeLastFmScrobbleProtocol(value: unknown): LastFmScrobbleProtocol {
  return value === 'audioscrobbler' || value === 'listenbrainz' ? value : 'lastfm2'
}

export function getLastFmProtocolLabel(protocol: LastFmScrobbleProtocol, kind: LastFmProfileKind): string {
  if (kind === 'official') return 'Official Last.fm'
  if (protocol === 'audioscrobbler') return 'AudioScrobbler'
  if (protocol === 'listenbrainz') return 'ListenBrainz'
  return 'Last.fm 2.0'
}

export function lastFmProfileRequiresApiCredentials(
  profile: Pick<LastFmProfileConfig, 'kind' | 'protocol'>
): boolean {
  return profile.kind === 'official' && profile.protocol === 'lastfm2'
}

export function parseLastFmApiBaseUrl(value: unknown): string | null {
  const parsed = parseHttpUrl(value)
  if (!parsed) return null

  const normalized = parsed.toString()
  if (normalized === 'https://ws.audioscrobbler.com/2.0') {
    return LASTFM_OFFICIAL_API_BASE_URL
  }
  return normalized
}

export function normalizeLastFmApiBaseUrl(value: unknown): string {
  return parseLastFmApiBaseUrl(value) ?? LASTFM_OFFICIAL_API_BASE_URL
}

export function isLastFmCustomEndpoint(apiBaseUrl: string): boolean {
  return normalizeLastFmApiBaseUrl(apiBaseUrl) !== LASTFM_OFFICIAL_API_BASE_URL
}

export function parseListenBrainzApiBaseUrl(value: unknown): string | null {
  const parsed = parseHttpUrl(value)
  if (!parsed) return null

  const submitSuffix = '/1/submit-listens'
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith(submitSuffix)) {
    const basePath = normalizedPath.slice(0, -submitSuffix.length)
    parsed.pathname = basePath.length > 0 ? basePath : '/'
  }

  return parsed.toString()
}

export function normalizeListenBrainzApiBaseUrl(value: unknown): string | null {
  return parseListenBrainzApiBaseUrl(value)
}
