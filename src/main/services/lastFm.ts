import { createHash } from 'crypto'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  LASTFM_OFFICIAL_API_BASE_URL,
  LASTFM_OFFICIAL_PROFILE_ID,
  isLastFmCustomEndpoint,
  normalizeLastFmApiBaseUrl,
  parseLastFmApiBaseUrl,
  type LastFmAuthFinishResult,
  type LastFmAuthStartResult,
  type LastFmCustomProfileInput,
  type LastFmPendingScrobble,
  type LastFmProfileConfig,
  type LastFmProfileStatus,
  type LastFmServiceConfig,
  type LastFmStatus
} from '../../types/lastFm'

const LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/'
const LASTFM_USER_AGENT = 'Astra-LastFM/0.1.0 (https://github.com/Boof2015/astra)'
const LASTFM_REQUEST_TIMEOUT_MS = 12_000
const LASTFM_MAX_SCROBBLES_PER_BATCH = 50
const LASTFM_MAX_PENDING_SCROBBLES = 1000
const LASTFM_SCROBBLE_MIN_DURATION_SECONDS = 30
const LASTFM_SCROBBLE_MAX_HALF_TRACK_SECONDS = 240
const LASTFM_MAX_PLAYBACK_DELTA_MS = 15_000
const LASTFM_BASE_RETRY_MS = 5_000
const LASTFM_NOW_PLAYING_RETRY_MS = 4_000
const LASTFM_MAX_RETRY_MS = 10 * 60 * 1000
const LASTFM_TRANSIENT_ERROR_CODES = new Set([8, 11, 16, 29])
const LASTFM_SESSION_INVALID_CODES = new Set([9])
const LASTFM_AUTH_NOT_COMPLETED_CODE = 14

interface LastFmServiceOptions {
  config: LastFmServiceConfig
  apiKey: string
  sharedSecret: string
  openExternal: (url: string) => Promise<void>
  onConfigChange?: (config: LastFmServiceConfig) => Promise<void> | void
  onStatusChange?: (status: LastFmStatus) => void
}

interface LastFmApiSuccess {
  ok: true
  payload: Record<string, unknown>
}

interface LastFmApiFailure {
  ok: false
  kind: 'transient' | 'permanent' | 'session-invalid'
  code?: number
  message: string
}

type LastFmApiResult = LastFmApiSuccess | LastFmApiFailure

interface PlaybackSession {
  trackKey: string
  trackPath: string | null
  track: string
  artist: string
  album: string | null
  albumArtist: string | null
  durationSeconds: number | null
  startedAtUnix: number
  playedSeconds: number
  nowPlayingSent: boolean
  nowPlayingRetryCount: number
  nextNowPlayingAttemptAt: number
  scrobbleQueued: boolean
  lastObservedAtMs: number
  lastObservedPlaybackState: MiniPlayerSnapshot['playbackState']
}

function normalizeDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeDisplay(value)
  return normalized.length > 0 ? normalized : null
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return 0
  return Math.trunc(value)
}

function normalizeNullablePositiveInteger(value: unknown): number | null {
  const normalized = normalizeNonNegativeInteger(value)
  if (normalized === null || normalized <= 0) return null
  return normalized
}

function buildScrobbleId(trackPath: string | null, track: string, artist: string, timestamp: number): string {
  if (trackPath) return `${trackPath}::${timestamp}`
  const hash = createHash('md5')
  hash.update(`${artist}\u0000${track}\u0000${timestamp}`)
  return hash.digest('hex')
}

function splitCollaborators(rawArtist: string): string[] {
  const normalized = normalizeDisplay(rawArtist)
  if (!normalized) return []

  const unified = normalized
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const unique = new Set<string>()
  const contributors: string[] = []

  for (const part of unified.split(',')) {
    const display = normalizeDisplay(part)
    if (!display) continue
    const key = display.toLocaleLowerCase()
    if (!key || unique.has(key)) continue
    unique.add(key)
    contributors.push(display)
  }

  return contributors
}

function getPrimaryArtist(rawArtist: string): string {
  const contributors = splitCollaborators(rawArtist)
  return contributors[0] ?? rawArtist
}

function computeRetryDelayMs(retryCount: number, baseMs: number): number {
  const normalizedRetryCount = Math.max(1, retryCount)
  const exponential = baseMs * (2 ** Math.min(8, normalizedRetryCount - 1))
  return Math.min(LASTFM_MAX_RETRY_MS, exponential)
}

function isTransientErrorCode(code: number | undefined): boolean {
  if (code == null) return false
  return LASTFM_TRANSIENT_ERROR_CODES.has(code)
}

function isSessionInvalidCode(code: number | undefined): boolean {
  if (code == null) return false
  return LASTFM_SESSION_INVALID_CODES.has(code)
}

function toApiErrorCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed)
    }
  }
  return undefined
}

function formatApiErrorMessage(code: number | undefined, fallback: string): string {
  if (code == null) return fallback
  return `Last.fm error ${code}: ${fallback}`
}

function toSortedSignaturePayload(params: Record<string, string>): string {
  // Last.fm signature ordering is strict alphabetical by parameter name.
  // Use default code-unit sort instead of locale-aware collation.
  return Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('')
}

function createApiSignature(params: Record<string, string>, sharedSecret: string): string {
  const hash = createHash('md5')
  hash.update(toSortedSignaturePayload(params) + sharedSecret, 'utf8')
  return hash.digest('hex')
}

function normalizeProfileName(value: unknown, fallback: string): string {
  return (normalizeText(value) ?? fallback).slice(0, 80)
}

function isConnectedProfile(profile: LastFmProfileConfig): boolean {
  return Boolean(profile.sessionKey && profile.username)
}

function buildCustomProfileId(name: string, existingIds: Set<string>): string {
  const base = normalizeDisplay(name)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'endpoint'

  let candidate = `custom-${base}`
  let suffix = 2
  while (existingIds.has(candidate) || candidate === LASTFM_OFFICIAL_PROFILE_ID) {
    candidate = `custom-${base}-${suffix}`
    suffix += 1
  }
  existingIds.add(candidate)
  return candidate
}

function createOfficialProfile(raw?: unknown): LastFmProfileConfig {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}

  return {
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
    sessionKey: normalizeText(record.sessionKey),
    username: normalizeText(record.username),
    pendingScrobbles: sanitizePendingScrobbles(record.pendingScrobbles)
  }
}

function normalizeCustomProfile(raw: unknown, existingIds: Set<string>): LastFmProfileConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const apiBaseUrl = parseLastFmApiBaseUrl(record.apiBaseUrl)
  if (!apiBaseUrl || apiBaseUrl === LASTFM_OFFICIAL_API_BASE_URL) return null

  const name = normalizeProfileName(record.name, 'Custom endpoint')
  const rawId = normalizeText(record.id)
  const id = rawId && rawId !== LASTFM_OFFICIAL_PROFILE_ID && !existingIds.has(rawId)
    ? rawId
    : buildCustomProfileId(name, existingIds)
  existingIds.add(id)

  return {
    id,
    kind: 'custom',
    name,
    apiBaseUrl,
    sessionKey: normalizeText(record.sessionKey),
    username: normalizeText(record.username),
    pendingScrobbles: sanitizePendingScrobbles(record.pendingScrobbles)
  }
}

function createLegacyConfig(record: Record<string, unknown>, hasApiCredentials: boolean): LastFmServiceConfig {
  const apiBaseUrl = normalizeLastFmApiBaseUrl(record.apiBaseUrl)
  const sessionKey = normalizeText(record.sessionKey)
  const username = normalizeText(record.username)
  const pendingScrobbles = sanitizePendingScrobbles(record.pendingScrobbles)
  const connected = Boolean(sessionKey && username)
  const enabled = Boolean(record.enabled) && connected && hasApiCredentials

  if (isLastFmCustomEndpoint(apiBaseUrl)) {
    const customProfile: LastFmProfileConfig = {
      id: 'custom-lastfm-endpoint',
      kind: 'custom',
      name: 'Custom Last.fm endpoint',
      apiBaseUrl,
      sessionKey,
      username,
      pendingScrobbles
    }

    return {
      enabled,
      activeProfileId: customProfile.id,
      profiles: [createOfficialProfile(), customProfile]
    }
  }

  return {
    enabled,
    activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
    profiles: [
      {
        ...createOfficialProfile(),
        sessionKey,
        username,
        pendingScrobbles
      }
    ]
  }
}

function normalizeConfig(config: LastFmServiceConfig, hasApiCredentials: boolean): LastFmServiceConfig {
  const record = config as unknown as Record<string, unknown>
  if (!Array.isArray(record.profiles)) {
    return createLegacyConfig(record, hasApiCredentials)
  }

  const rawProfiles = record.profiles
  const existingIds = new Set<string>([LASTFM_OFFICIAL_PROFILE_ID])
  const officialRaw = rawProfiles.find((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const profile = item as Record<string, unknown>
    return profile.id === LASTFM_OFFICIAL_PROFILE_ID || profile.kind === 'official'
  })

  const profiles: LastFmProfileConfig[] = [createOfficialProfile(officialRaw)]
  for (const rawProfile of rawProfiles) {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue
    const recordProfile = rawProfile as Record<string, unknown>
    if (recordProfile.id === LASTFM_OFFICIAL_PROFILE_ID || recordProfile.kind === 'official') continue
    const customProfile = normalizeCustomProfile(rawProfile, existingIds)
    if (customProfile) {
      profiles.push(customProfile)
    }
  }

  const requestedActiveProfileId = normalizeText(record.activeProfileId)
  const activeProfile = profiles.find((profile) => profile.id === requestedActiveProfileId) ?? profiles[0]
  const activeConnected = isConnectedProfile(activeProfile)

  return {
    enabled: Boolean(record.enabled) && activeConnected && hasApiCredentials,
    activeProfileId: activeProfile.id,
    profiles
  }
}

export function sanitizePendingScrobbles(raw: unknown): LastFmPendingScrobble[] {
  if (!Array.isArray(raw)) return []

  const nowMs = Date.now()
  const normalized: LastFmPendingScrobble[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>

    const track = normalizeText(record.track)
    const artist = normalizeText(record.artist)
    if (!track || !artist) continue

    const timestamp = normalizeNullablePositiveInteger(record.timestamp)
    if (!timestamp) continue

    const trackPath = normalizeText(record.trackPath)
    const id = normalizeText(record.id) ?? buildScrobbleId(trackPath, track, artist, timestamp)
    const queuedAt = normalizeNullablePositiveInteger(record.queuedAt) ?? nowMs
    const retryCount = normalizeNonNegativeInteger(record.retryCount) ?? 0
    const nextRetryAt = normalizeNullablePositiveInteger(record.nextRetryAt) ?? nowMs
    const durationSeconds = normalizeNullablePositiveInteger(record.durationSeconds)

    normalized.push({
      id,
      trackPath,
      track,
      artist,
      album: normalizeText(record.album),
      albumArtist: normalizeText(record.albumArtist),
      durationSeconds,
      timestamp,
      queuedAt,
      retryCount,
      nextRetryAt
    })
  }

  normalized.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
    if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt
    return left.id.localeCompare(right.id)
  })

  const deduped: LastFmPendingScrobble[] = []
  const seenIds = new Set<string>()
  for (const item of normalized) {
    if (seenIds.has(item.id)) continue
    seenIds.add(item.id)
    deduped.push(item)
  }

  if (deduped.length <= LASTFM_MAX_PENDING_SCROBBLES) return deduped
  return deduped.slice(-LASTFM_MAX_PENDING_SCROBBLES)
}

export class LastFmService {
  private config: LastFmServiceConfig
  private readonly apiKey: string
  private readonly sharedSecret: string
  private readonly hasApiCredentials: boolean
  private readonly openExternal: (url: string) => Promise<void>
  private readonly onConfigChange?: (config: LastFmServiceConfig) => Promise<void> | void
  private readonly onStatusChange?: (status: LastFmStatus) => void

  private pendingAuthToken: string | null = null
  private pendingAuthProfileId: string | null = null
  private currentPlayback: PlaybackSession | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushInFlight = false
  private lastError: string | null = null

  constructor(options: LastFmServiceOptions) {
    this.apiKey = options.apiKey.trim()
    this.sharedSecret = options.sharedSecret.trim()
    this.hasApiCredentials = this.apiKey.length > 0 && this.sharedSecret.length > 0
    this.openExternal = options.openExternal
    this.onConfigChange = options.onConfigChange
    this.onStatusChange = options.onStatusChange
    this.config = normalizeConfig(options.config, this.hasApiCredentials)
  }

  getStatus(): LastFmStatus {
    const activeProfile = this.getActiveProfile()
    const connected = isConnectedProfile(activeProfile)
    const pendingCount = activeProfile.pendingScrobbles.length
    const apiBaseUrl = activeProfile.apiBaseUrl
    const usingCustomEndpoint = activeProfile.kind === 'custom'
    const serviceLabel = usingCustomEndpoint ? activeProfile.name : 'Last.fm'
    const profileStatuses = this.config.profiles.map((profile) => this.toProfileStatus(profile))
    const activeProfileStatus = profileStatuses.find((profile) => profile.id === activeProfile.id) ?? profileStatuses[0]

    let statusMessage = `${serviceLabel} account not connected.`
    if (!this.hasApiCredentials) {
      statusMessage = `${serviceLabel} integration is unavailable: API credentials are not configured.`
    } else if (this.pendingAuthToken) {
      statusMessage = 'Last.fm authorization pending. Approve Astra in your browser; Astra will complete connection automatically.'
    } else if (usingCustomEndpoint && !connected) {
      statusMessage = 'Last.fm-compatible endpoint not connected. Enter a username and session key/token.'
    } else if (connected && !this.config.enabled) {
      statusMessage = `Connected as ${activeProfile.username}. ${serviceLabel} scrobbling is disabled.`
    } else if (connected && this.config.enabled && pendingCount > 0) {
      statusMessage = `Connected as ${activeProfile.username}. ${pendingCount} scrobble${pendingCount === 1 ? '' : 's'} pending retry.`
    } else if (connected && this.config.enabled) {
      statusMessage = `Connected as ${activeProfile.username}. ${serviceLabel} scrobbling is active.`
    }

    return {
      enabled: this.config.enabled,
      connected,
      username: activeProfile.username,
      apiBaseUrl,
      usingCustomEndpoint,
      authPending: Boolean(this.pendingAuthToken),
      authPendingProfileId: this.pendingAuthProfileId,
      activeProfileId: activeProfile.id,
      activeProfile: activeProfileStatus,
      profiles: profileStatuses,
      pendingScrobbles: pendingCount,
      hasApiCredentials: this.hasApiCredentials,
      statusMessage,
      lastError: this.lastError
    }
  }

  async applyConfig(config: LastFmServiceConfig): Promise<LastFmStatus> {
    this.config = normalizeConfig(config, this.hasApiCredentials)
    if (!this.config.enabled) {
      this.currentPlayback = null
      this.clearFlushTimer()
    }
    this.emitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async createCustomProfile(input: LastFmCustomProfileInput): Promise<LastFmStatus> {
    const normalized = this.normalizeCustomProfileInput(input, null)
    if (!normalized.ok) return this.failWithStatus(normalized.message)

    const existingIds = new Set(this.config.profiles.map((profile) => profile.id))
    const profile: LastFmProfileConfig = {
      id: buildCustomProfileId(normalized.name, existingIds),
      kind: 'custom',
      name: normalized.name,
      apiBaseUrl: normalized.apiBaseUrl,
      sessionKey: normalized.sessionKey,
      username: normalized.username,
      pendingScrobbles: []
    }

    this.config.profiles.push(profile)
    this.config.activeProfileId = profile.id
    this.config.enabled = isConnectedProfile(profile) && this.hasApiCredentials
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.clearFlushTimer()
    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async updateCustomProfile(profileId: string, input: LastFmCustomProfileInput): Promise<LastFmStatus> {
    const profile = this.findProfile(profileId)
    if (!profile || profile.kind !== 'custom') {
      return this.failWithStatus('Custom profile not found.')
    }

    const normalized = this.normalizeCustomProfileInput(input, profile)
    if (!normalized.ok) return this.failWithStatus(normalized.message)

    const endpointChanged = profile.apiBaseUrl !== normalized.apiBaseUrl
    const sessionChanged = normalized.sessionKey !== null && normalized.sessionKey !== profile.sessionKey

    profile.name = normalized.name
    profile.apiBaseUrl = normalized.apiBaseUrl

    if (normalized.sessionKey) {
      profile.sessionKey = normalized.sessionKey
      profile.username = normalized.username
    } else if (endpointChanged) {
      profile.sessionKey = null
      profile.username = null
    } else {
      profile.username = normalized.username ?? profile.username
    }

    if (endpointChanged || sessionChanged) {
      profile.pendingScrobbles = []
      if (this.config.activeProfileId === profile.id) {
        this.pendingAuthToken = null
        this.pendingAuthProfileId = null
        this.currentPlayback = null
        this.clearFlushTimer()
      }
    }

    if (this.config.activeProfileId === profile.id && (!isConnectedProfile(profile) || !this.hasApiCredentials)) {
      this.config.enabled = false
    }

    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async deleteCustomProfile(profileId: string): Promise<LastFmStatus> {
    const profile = this.findProfile(profileId)
    if (!profile || profile.kind !== 'custom') {
      return this.failWithStatus('Custom profile not found.')
    }

    this.config.profiles = this.config.profiles.filter((item) => item.id !== profile.id)
    if (this.pendingAuthProfileId === profile.id) {
      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
    }
    if (this.config.activeProfileId === profile.id) {
      this.config.activeProfileId = LASTFM_OFFICIAL_PROFILE_ID
      this.config.enabled = false
      this.currentPlayback = null
      this.clearFlushTimer()
    }

    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async setActiveProfile(profileId: string): Promise<LastFmStatus> {
    const profile = this.findProfile(profileId)
    if (!profile) {
      return this.failWithStatus('Scrobble profile not found.')
    }

    if (profile.id !== this.config.activeProfileId) {
      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
      this.currentPlayback = null
      this.clearFlushTimer()
    }

    this.config.activeProfileId = profile.id
    if (!isConnectedProfile(profile) || !this.hasApiCredentials) {
      this.config.enabled = false
    }

    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async beginAuth(): Promise<LastFmAuthStartResult> {
    const profile = this.getActiveProfile()
    if (!this.hasApiCredentials) {
      const message = 'Last.fm credentials are not configured for this build.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, authPending: false, message }
    }

    if (profile.kind !== 'official') {
      const message = 'Browser authorization is only available for official Last.fm. Enter custom endpoint credentials manually.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, authPending: false, message }
    }

    if (this.pendingAuthToken) {
      return {
        ok: true,
        authPending: true,
        message: 'Authorization is already pending. Approve Astra in your browser; Astra will complete connection automatically.'
      }
    }

    const tokenResponse = await this.callSignedMethod('auth.getToken', {}, undefined, profile)
    if (!tokenResponse.ok) {
      this.lastError = tokenResponse.message
      this.emitStatus()
      return { ok: false, authPending: false, message: tokenResponse.message }
    }

    const token = normalizeText(tokenResponse.payload.token)
    if (!token) {
      const message = 'Last.fm returned an invalid auth token.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, authPending: false, message }
    }

    const authUrl = `${LASTFM_AUTH_URL}?api_key=${encodeURIComponent(this.apiKey)}&token=${encodeURIComponent(token)}`
    try {
      await this.openExternal(authUrl)
    } catch {
      const message = 'Failed to open Last.fm authorization page.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, authPending: false, message }
    }

    this.pendingAuthToken = token
    this.pendingAuthProfileId = profile.id
    this.lastError = null
    this.emitStatus()

    return {
      ok: true,
      authPending: true,
      message: 'Authorization page opened. Approve Astra in Last.fm; Astra will complete connection automatically.',
      authUrl
    }
  }

  async finishAuth(): Promise<LastFmAuthFinishResult> {
    const activeProfile = this.getActiveProfile()
    if (!this.hasApiCredentials) {
      const message = 'Last.fm credentials are not configured for this build.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: activeProfile.username, message }
    }

    const authProfile = this.pendingAuthProfileId ? this.findProfile(this.pendingAuthProfileId) : null
    if (!this.pendingAuthToken || !authProfile) {
      return {
        ok: false,
        connected: this.isConnected(),
        username: activeProfile.username,
        message: 'No pending authorization. Click Connect first.'
      }
    }

    const token = this.pendingAuthToken
    const sessionResponse = await this.callSignedMethod('auth.getSession', { token }, undefined, authProfile)
    if (!sessionResponse.ok) {
      const code = sessionResponse.code
      if (code === LASTFM_AUTH_NOT_COMPLETED_CODE) {
        this.lastError = null
        this.emitStatus()
        return {
          ok: false,
          connected: this.isConnected(),
          username: activeProfile.username,
          message: 'Authorization still pending. Approve Astra in your browser.'
        }
      }

      if (sessionResponse.kind === 'transient') {
        this.lastError = sessionResponse.message
        this.emitStatus()
        return {
          ok: false,
          connected: this.isConnected(),
          username: activeProfile.username,
          message: sessionResponse.message
        }
      }

      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
      this.lastError = sessionResponse.message
      this.emitStatus()
      return {
        ok: false,
        connected: this.isConnected(),
        username: activeProfile.username,
        message: sessionResponse.message
      }
    }

    const sessionValue = sessionResponse.payload.session
    if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) {
      const message = 'Last.fm returned an invalid session payload.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: activeProfile.username, message }
    }

    const session = sessionValue as Record<string, unknown>
    const sessionKey = normalizeText(session.key)
    const username = normalizeText(session.name)
    if (!sessionKey || !username) {
      const message = 'Last.fm returned an incomplete session payload.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: activeProfile.username, message }
    }

    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    authProfile.sessionKey = sessionKey
    authProfile.username = username
    this.config.activeProfileId = authProfile.id
    this.config.enabled = true
    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)

    return {
      ok: true,
      connected: true,
      username,
      message: `Connected as ${username}. Last.fm scrobbling enabled.`
    }
  }

  async disconnect(): Promise<LastFmStatus> {
    const activeProfile = this.getActiveProfile()
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.clearFlushTimer()
    this.config.enabled = false
    activeProfile.sessionKey = null
    activeProfile.username = null
    activeProfile.pendingScrobbles = []
    this.lastError = null
    await this.persistAndEmitStatus()
    return this.getStatus()
  }

  async resetToDefaults(): Promise<LastFmStatus> {
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.clearFlushTimer()
    this.config = normalizeConfig({
      enabled: false,
      activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
      profiles: [createOfficialProfile()]
    }, this.hasApiCredentials)
    this.lastError = null
    await this.persistAndEmitStatus()
    return this.getStatus()
  }

  stop(): void {
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.flushInFlight = false
    this.clearFlushTimer()
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    if (!snapshot || !this.shouldProcessPlayback()) {
      this.currentPlayback = null
      return
    }

    const nowMs = Date.now()
    const currentTrack = snapshot.currentTrack
    if (!currentTrack || snapshot.playbackState === 'stopped') {
      this.updatePlayedSeconds(nowMs, snapshot.playbackState)
      this.maybeQueueScrobble(nowMs)
      this.currentPlayback = null
      return
    }

    const trackKey = currentTrack.path || `${currentTrack.artist}\u0000${currentTrack.title}`
    if (this.currentPlayback && this.currentPlayback.trackKey !== trackKey) {
      this.updatePlayedSeconds(nowMs, this.currentPlayback.lastObservedPlaybackState)
      this.maybeQueueScrobble(nowMs)
    }

    if (!this.currentPlayback || this.currentPlayback.trackKey !== trackKey) {
      const normalizedTrack = normalizeDisplay(currentTrack.title)
      const normalizedArtist = normalizeDisplay(getPrimaryArtist(currentTrack.artist))
      const normalizedAlbum = normalizeText(currentTrack.album)

      this.currentPlayback = {
        trackKey,
        trackPath: normalizeText(currentTrack.path),
        track: normalizedTrack || currentTrack.title,
        artist: normalizedArtist || currentTrack.artist,
        album: normalizedAlbum,
        albumArtist: null,
        durationSeconds: normalizeNullablePositiveInteger(snapshot.duration),
        startedAtUnix: Math.max(
          0,
          Math.floor((nowMs / 1000) - Math.max(0, Number.isFinite(snapshot.currentTime) ? snapshot.currentTime : 0))
        ),
        playedSeconds: 0,
        nowPlayingSent: false,
        nowPlayingRetryCount: 0,
        nextNowPlayingAttemptAt: nowMs,
        scrobbleQueued: false,
        lastObservedAtMs: nowMs,
        lastObservedPlaybackState: snapshot.playbackState
      }
    }

    this.updatePlayedSeconds(nowMs, snapshot.playbackState)
    this.maybeQueueScrobble(nowMs)
    if (snapshot.playbackState === 'playing') {
      void this.maybeSendNowPlaying(nowMs)
    }
  }

  private isConnected(): boolean {
    return isConnectedProfile(this.getActiveProfile())
  }

  private findProfile(profileId: string): LastFmProfileConfig | null {
    return this.config.profiles.find((profile) => profile.id === profileId) ?? null
  }

  private getActiveProfile(): LastFmProfileConfig {
    const activeProfile = this.findProfile(this.config.activeProfileId)
    if (activeProfile) return activeProfile

    const officialProfile = this.findProfile(LASTFM_OFFICIAL_PROFILE_ID)
    if (officialProfile) {
      this.config.activeProfileId = officialProfile.id
      return officialProfile
    }

    const official = createOfficialProfile()
    this.config.profiles.unshift(official)
    this.config.activeProfileId = official.id
    return official
  }

  private toProfileStatus(profile: LastFmProfileConfig): LastFmProfileStatus {
    return {
      id: profile.id,
      kind: profile.kind,
      name: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      username: profile.username,
      connected: isConnectedProfile(profile),
      active: profile.id === this.config.activeProfileId,
      pendingScrobbles: profile.pendingScrobbles.length,
      canDelete: profile.kind === 'custom'
    }
  }

  private normalizeCustomProfileInput(
    input: LastFmCustomProfileInput,
    existingProfile: LastFmProfileConfig | null
  ):
    | { ok: true; name: string; apiBaseUrl: string; username: string | null; sessionKey: string | null }
    | { ok: false; message: string } {
    const name = normalizeProfileName(input.name, existingProfile?.name ?? 'Custom endpoint')
    const apiBaseUrl = parseLastFmApiBaseUrl(input.apiBaseUrl)
    if (!apiBaseUrl) {
      return { ok: false, message: 'Enter a valid http or https Last.fm-compatible API URL.' }
    }
    if (apiBaseUrl === LASTFM_OFFICIAL_API_BASE_URL) {
      return { ok: false, message: 'Custom profiles must use a non-official Last.fm-compatible API URL.' }
    }

    const username = normalizeText(input.username) ?? existingProfile?.username ?? null
    const sessionKey = normalizeText(input.sessionKey)
    if (sessionKey && !username) {
      return { ok: false, message: 'Username and session key/token are both required for custom profiles.' }
    }
    if (!existingProfile && !sessionKey && username) {
      return { ok: false, message: 'Username and session key/token are both required for custom profiles.' }
    }

    return { ok: true, name, apiBaseUrl, username, sessionKey }
  }

  private failWithStatus(message: string): LastFmStatus {
    this.lastError = message
    this.emitStatus()
    return this.getStatus()
  }

  private shouldProcessPlayback(): boolean {
    return this.hasApiCredentials && this.config.enabled && this.isConnected()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private async persistConfig(): Promise<void> {
    if (!this.onConfigChange) return
    await this.onConfigChange({
      enabled: this.config.enabled,
      activeProfileId: this.config.activeProfileId,
      profiles: this.config.profiles.map((profile) => ({
        ...profile,
        pendingScrobbles: profile.pendingScrobbles.map((item) => ({ ...item }))
      }))
    })
  }

  private async persistAndEmitStatus(): Promise<void> {
    try {
      await this.persistConfig()
    } catch (error) {
      console.warn('Failed to persist Last.fm config:', error)
    }
    this.emitStatus()
  }

  private updatePlayedSeconds(nowMs: number, nextPlaybackState: MiniPlayerSnapshot['playbackState']): void {
    if (!this.currentPlayback) return

    if (this.currentPlayback.lastObservedPlaybackState === 'playing') {
      const elapsedMs = nowMs - this.currentPlayback.lastObservedAtMs
      if (elapsedMs > 0) {
        const boundedMs = Math.min(elapsedMs, LASTFM_MAX_PLAYBACK_DELTA_MS)
        this.currentPlayback.playedSeconds += boundedMs / 1000
      }
    }

    this.currentPlayback.lastObservedAtMs = nowMs
    this.currentPlayback.lastObservedPlaybackState = nextPlaybackState
  }

  private resolveScrobbleThresholdSeconds(durationSeconds: number | null): number {
    if (!durationSeconds) return LASTFM_SCROBBLE_MAX_HALF_TRACK_SECONDS
    return Math.max(
      LASTFM_SCROBBLE_MIN_DURATION_SECONDS,
      Math.min(durationSeconds / 2, LASTFM_SCROBBLE_MAX_HALF_TRACK_SECONDS)
    )
  }

  private maybeQueueScrobble(nowMs: number): void {
    if (!this.currentPlayback || this.currentPlayback.scrobbleQueued) return
    const activeProfile = this.getActiveProfile()

    const durationSeconds = this.currentPlayback.durationSeconds
    if (durationSeconds != null && durationSeconds < LASTFM_SCROBBLE_MIN_DURATION_SECONDS) {
      this.currentPlayback.scrobbleQueued = true
      return
    }

    const requiredSeconds = this.resolveScrobbleThresholdSeconds(durationSeconds)
    if (this.currentPlayback.playedSeconds < requiredSeconds) return

    const scrobbleId = buildScrobbleId(
      this.currentPlayback.trackPath,
      this.currentPlayback.track,
      this.currentPlayback.artist,
      this.currentPlayback.startedAtUnix
    )

    const exists = activeProfile.pendingScrobbles.some((item) => item.id === scrobbleId)
    if (exists) {
      this.currentPlayback.scrobbleQueued = true
      return
    }

    activeProfile.pendingScrobbles.push({
      id: scrobbleId,
      trackPath: this.currentPlayback.trackPath,
      track: this.currentPlayback.track,
      artist: this.currentPlayback.artist,
      album: this.currentPlayback.album,
      albumArtist: this.currentPlayback.albumArtist,
      durationSeconds: this.currentPlayback.durationSeconds,
      timestamp: this.currentPlayback.startedAtUnix,
      queuedAt: nowMs,
      retryCount: 0,
      nextRetryAt: nowMs
    })

    if (activeProfile.pendingScrobbles.length > LASTFM_MAX_PENDING_SCROBBLES) {
      const extra = activeProfile.pendingScrobbles.length - LASTFM_MAX_PENDING_SCROBBLES
      activeProfile.pendingScrobbles.splice(0, extra)
    }

    this.currentPlayback.scrobbleQueued = true
    this.lastError = null
    void this.persistAndEmitStatus()
    this.scheduleFlush(0)
  }

  private async maybeSendNowPlaying(nowMs: number): Promise<void> {
    const playback = this.currentPlayback
    if (!playback || playback.nowPlayingSent) return
    if (nowMs < playback.nextNowPlayingAttemptAt) return
    const activeProfile = this.getActiveProfile()
    if (!activeProfile.sessionKey) return

    const params: Record<string, string | number> = {
      track: playback.track,
      artist: playback.artist
    }
    if (playback.album) params.album = playback.album
    if (playback.albumArtist) params.albumArtist = playback.albumArtist
    if (playback.durationSeconds) params.duration = playback.durationSeconds

    const response = await this.callSignedMethod('track.updateNowPlaying', params, activeProfile.sessionKey, activeProfile)
    if (response.ok) {
      playback.nowPlayingSent = true
      playback.nowPlayingRetryCount = 0
      playback.nextNowPlayingAttemptAt = nowMs
      this.lastError = null
      this.emitStatus()
      return
    }

    if (response.kind === 'session-invalid') {
      await this.handleSessionInvalid(response.message, activeProfile)
      return
    }

    if (response.kind === 'transient') {
      playback.nowPlayingRetryCount += 1
      playback.nextNowPlayingAttemptAt = nowMs + computeRetryDelayMs(
        playback.nowPlayingRetryCount,
        LASTFM_NOW_PLAYING_RETRY_MS
      )
      this.lastError = response.message
      this.emitStatus()
      return
    }

    playback.nowPlayingSent = true
    this.lastError = response.message
    this.emitStatus()
  }

  private scheduleFlush(delayMs: number): void {
    this.clearFlushTimer()
    if (!this.shouldProcessPlayback()) return
    if (this.flushInFlight) return
    const activeProfile = this.getActiveProfile()
    if (activeProfile.pendingScrobbles.length === 0) return

    const nowMs = Date.now()
    const first = activeProfile.pendingScrobbles[0]
    const dueAt = Math.max(nowMs + Math.max(0, delayMs), first.nextRetryAt)
    const timeoutMs = Math.max(0, dueAt - nowMs)

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushQueue()
    }, timeoutMs)
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private async flushQueue(): Promise<void> {
    if (this.flushInFlight) return
    if (!this.shouldProcessPlayback()) return
    if (this.getActiveProfile().pendingScrobbles.length === 0) return

    this.flushInFlight = true
    try {
      while (this.shouldProcessPlayback() && this.getActiveProfile().pendingScrobbles.length > 0) {
        const activeProfile = this.getActiveProfile()
        const nowMs = Date.now()
        const first = activeProfile.pendingScrobbles[0]
        if (!first || first.nextRetryAt > nowMs) break

        const batch: LastFmPendingScrobble[] = []
        for (const item of activeProfile.pendingScrobbles) {
          if (batch.length >= LASTFM_MAX_SCROBBLES_PER_BATCH) break
          if (item.nextRetryAt > nowMs) break
          batch.push(item)
        }

        if (batch.length === 0) break
        const submitResult = await this.submitScrobbleBatch(batch, activeProfile)

        if (submitResult.ok) {
          activeProfile.pendingScrobbles.splice(0, batch.length)
          this.lastError = null
          await this.persistAndEmitStatus()
          continue
        }

        if (submitResult.kind === 'session-invalid') {
          await this.handleSessionInvalid(submitResult.message, activeProfile)
          break
        }

        if (submitResult.kind === 'permanent') {
          activeProfile.pendingScrobbles.splice(0, batch.length)
          this.lastError = submitResult.message
          await this.persistAndEmitStatus()
          continue
        }

        const retryAt = nowMs + computeRetryDelayMs((batch[0]?.retryCount ?? 0) + 1, LASTFM_BASE_RETRY_MS)
        for (let index = 0; index < batch.length; index += 1) {
          const queued = activeProfile.pendingScrobbles[index]
          if (!queued) break
          queued.retryCount += 1
          queued.nextRetryAt = retryAt
        }
        this.lastError = submitResult.message
        await this.persistAndEmitStatus()
        break
      }
    } finally {
      this.flushInFlight = false
      this.scheduleFlush(0)
    }
  }

  private async submitScrobbleBatch(
    batch: LastFmPendingScrobble[],
    profile: LastFmProfileConfig
  ): Promise<LastFmApiResult> {
    if (!profile.sessionKey) {
      return {
        ok: false,
        kind: 'session-invalid',
        message: 'Last.fm session is not available.'
      }
    }

    const params: Record<string, string | number> = {}
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]
      params[`track[${index}]`] = item.track
      params[`artist[${index}]`] = item.artist
      params[`timestamp[${index}]`] = item.timestamp
      if (item.album) params[`album[${index}]`] = item.album
      if (item.albumArtist) params[`albumArtist[${index}]`] = item.albumArtist
      if (item.durationSeconds) params[`duration[${index}]`] = item.durationSeconds
    }

    return this.callSignedMethod('track.scrobble', params, profile.sessionKey, profile)
  }

  private async handleSessionInvalid(message: string, profile: LastFmProfileConfig = this.getActiveProfile()): Promise<void> {
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.clearFlushTimer()
    if (this.config.activeProfileId === profile.id) {
      this.config.enabled = false
    }
    profile.sessionKey = null
    profile.username = null
    this.lastError = message
    await this.persistAndEmitStatus()
  }

  private async callSignedMethod(
    method: string,
    inputParams: Record<string, string | number> = {},
    sessionKey?: string,
    profile: LastFmProfileConfig = this.getActiveProfile()
  ): Promise<LastFmApiResult> {
    if (!this.hasApiCredentials) {
      return {
        ok: false,
        kind: 'permanent',
        message: 'Last.fm credentials are not configured.'
      }
    }

    const normalizedMethod = method.trim().toLowerCase()
    if (!normalizedMethod) {
      return {
        ok: false,
        kind: 'permanent',
        message: 'Last.fm method name is missing.'
      }
    }

    const signedParams: Record<string, string> = {
      method: normalizedMethod,
      api_key: this.apiKey
    }
    if (sessionKey) {
      signedParams.sk = sessionKey
    }

    for (const [key, value] of Object.entries(inputParams)) {
      if (value == null) continue
      const normalized = typeof value === 'number' ? String(Math.trunc(value)) : value.trim()
      if (!normalized) continue
      signedParams[key] = normalized
    }

    const apiSig = createApiSignature(signedParams, this.sharedSecret)
    const body = new URLSearchParams({
      ...signedParams,
      api_sig: apiSig,
      format: 'json'
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LASTFM_REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(profile.apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          'User-Agent': LASTFM_USER_AGENT
        },
        body: body.toString(),
        signal: controller.signal
      })

      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message: `Last.fm request failed with HTTP ${response.status}.`
        }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = null
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        if (!response.ok) {
          return {
            ok: false,
            kind: 'permanent',
            message: `Last.fm request failed with HTTP ${response.status}.`
          }
        }
        return {
          ok: false,
          kind: 'transient',
          message: 'Last.fm returned an invalid response payload.'
        }
      }

      const record = payload as Record<string, unknown>
      const errorCode = toApiErrorCode(record.error)
      const errorMessage = normalizeText(record.message)
      if (errorCode != null) {
        const resolvedMessage = formatApiErrorMessage(errorCode, errorMessage ?? 'Request failed.')
        if (isSessionInvalidCode(errorCode)) {
          return {
            ok: false,
            kind: 'session-invalid',
            code: errorCode,
            message: resolvedMessage
          }
        }
        if (isTransientErrorCode(errorCode)) {
          return {
            ok: false,
            kind: 'transient',
            code: errorCode,
            message: resolvedMessage
          }
        }
        return {
          ok: false,
          kind: 'permanent',
          code: errorCode,
          message: resolvedMessage
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          kind: 'permanent',
          message: `Last.fm request failed with HTTP ${response.status}.`
        }
      }

      return {
        ok: true,
        payload: record
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: 'transient',
        message: isAbort
          ? 'Last.fm request timed out.'
          : 'Last.fm request failed due to a network error.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
