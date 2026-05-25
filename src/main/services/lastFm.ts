import { createHash } from 'crypto'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  LASTFM_OFFICIAL_API_BASE_URL,
  LASTFM_OFFICIAL_PROFILE_ID,
  getLastFmProtocolLabel,
  isLastFmCustomEndpoint,
  lastFmProfileRequiresApiCredentials,
  normalizeLastFmScrobbleProtocol,
  normalizeLastFmApiBaseUrl,
  parseListenBrainzApiBaseUrl,
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
import {
  formatArtistNames,
  normalizeArtistNames
} from '../../shared/library/artistCredits'

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
const AUDIOSCROBBLER_PROTOCOL_VERSION = '1.2.1'
const AUDIOSCROBBLER_CLIENT_ID = 'ast'
const AUDIOSCROBBLER_CLIENT_VERSION = '0.6.0'
const LISTENBRAINZ_SUBMIT_PATH = '/1/submit-listens'

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

interface AudioScrobblerSession {
  sessionId: string
  nowPlayingUrl: string
  submissionUrl: string
}

type AudioScrobblerSessionResult =
  | { ok: true; session: AudioScrobblerSession }
  | LastFmApiFailure

interface PlaybackProfileState {
  nowPlayingSent: boolean
  nowPlayingRetryCount: number
  nextNowPlayingAttemptAt: number
}

interface PlaybackSession {
  trackKey: string
  trackPath: string | null
  track: string
  artist: string
  artistNames?: string[]
  album: string | null
  albumArtist: string | null
  durationSeconds: number | null
  startedAtUnix: number
  playedSeconds: number
  nowPlayingByProfileId: Map<string, PlaybackProfileState>
  scrobbleQueuedProfileIds: Set<string>
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

function normalizeOptionalArtistNames(value: unknown): string[] | undefined {
  const names = Array.isArray(value) ? normalizeArtistNames(value) : []
  return names.length > 0 ? names : undefined
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

function createMd5Hex(value: string): string {
  const hash = createHash('md5')
  hash.update(value, 'utf8')
  return hash.digest('hex')
}

function normalizeProfileName(value: unknown, fallback: string): string {
  return (normalizeText(value) ?? fallback).slice(0, 80)
}

function normalizeProfileEnabled(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isConnectedProfile(profile: LastFmProfileConfig): boolean {
  if (profile.protocol === 'listenbrainz') {
    return Boolean(profile.sessionKey)
  }
  return Boolean(profile.sessionKey && profile.username)
}

function isProfileSubmittable(profile: LastFmProfileConfig, hasApiCredentials: boolean): boolean {
  return isConnectedProfile(profile) && (!lastFmProfileRequiresApiCredentials(profile) || hasApiCredentials)
}

function getSecretLabelForProtocol(protocol: LastFmProfileConfig['protocol']): string {
  if (protocol === 'audioscrobbler') return 'password/API key'
  if (protocol === 'listenbrainz') return 'auth token'
  return 'session key/token'
}

function parseProfileApiBaseUrl(protocol: LastFmProfileConfig['protocol'], value: unknown): string | null {
  if (protocol === 'listenbrainz') {
    return parseListenBrainzApiBaseUrl(value)
  }
  return parseLastFmApiBaseUrl(value)
}

function buildListenBrainzSubmitUrl(apiBaseUrl: string): string {
  const parsed = new URL(apiBaseUrl)
  const basePath = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `${basePath}${LISTENBRAINZ_SUBMIT_PATH}`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
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

function createOfficialProfile(raw?: unknown, defaultEnabled = false): LastFmProfileConfig {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}

  return {
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    protocol: 'lastfm2',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
    enabled: normalizeProfileEnabled(record.enabled, defaultEnabled),
    sessionKey: normalizeText(record.sessionKey),
    username: normalizeText(record.username),
    pendingScrobbles: sanitizePendingScrobbles(record.pendingScrobbles)
  }
}

function normalizeCustomProfile(raw: unknown, existingIds: Set<string>, defaultEnabled = false): LastFmProfileConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const protocol = normalizeLastFmScrobbleProtocol(record.protocol)
  const apiBaseUrl = parseProfileApiBaseUrl(protocol, record.apiBaseUrl)
  if (!apiBaseUrl) return null
  if (protocol === 'lastfm2' && apiBaseUrl === LASTFM_OFFICIAL_API_BASE_URL) return null

  const name = normalizeProfileName(record.name, 'Custom endpoint')
  const rawId = normalizeText(record.id)
  const id = rawId && rawId !== LASTFM_OFFICIAL_PROFILE_ID && !existingIds.has(rawId)
    ? rawId
    : buildCustomProfileId(name, existingIds)
  existingIds.add(id)

  return {
    id,
    kind: 'custom',
    protocol,
    name,
    apiBaseUrl,
    enabled: normalizeProfileEnabled(record.enabled, defaultEnabled),
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
  const enabled = Boolean(record.enabled)
  const profileEnabled = connected && hasApiCredentials

  if (isLastFmCustomEndpoint(apiBaseUrl)) {
    const customProfile: LastFmProfileConfig = {
      id: 'custom-lastfm-endpoint',
      kind: 'custom',
      protocol: 'lastfm2',
      name: 'Custom Last.fm endpoint',
      apiBaseUrl,
      enabled: profileEnabled,
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
        enabled: profileEnabled,
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
  const requestedActiveProfileId = normalizeText(record.activeProfileId)
  const existingIds = new Set<string>([LASTFM_OFFICIAL_PROFILE_ID])
  const officialRaw = rawProfiles.find((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const profile = item as Record<string, unknown>
    return profile.id === LASTFM_OFFICIAL_PROFILE_ID || profile.kind === 'official'
  })
  const officialDefaultEnabled = requestedActiveProfileId === LASTFM_OFFICIAL_PROFILE_ID

  const profiles: LastFmProfileConfig[] = [createOfficialProfile(officialRaw, officialDefaultEnabled)]
  for (const rawProfile of rawProfiles) {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue
    const recordProfile = rawProfile as Record<string, unknown>
    if (recordProfile.id === LASTFM_OFFICIAL_PROFILE_ID || recordProfile.kind === 'official') continue
    const rawProfileId = normalizeText(recordProfile.id)
    const customProfile = normalizeCustomProfile(rawProfile, existingIds, rawProfileId === requestedActiveProfileId)
    if (customProfile) {
      profiles.push(customProfile)
    }
  }

  const activeProfile = profiles.find((profile) => profile.id === requestedActiveProfileId) ?? profiles[0]
  for (const profile of profiles) {
    profile.enabled = profile.enabled && isProfileSubmittable(profile, hasApiCredentials)
  }

  return {
    enabled: Boolean(record.enabled),
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
    const artistNames = normalizeOptionalArtistNames(record.artistNames)

    normalized.push({
      id,
      trackPath,
      track,
      artist,
      artistNames,
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
  private audioScrobblerSessions = new Map<string, AudioScrobblerSession>()
  private currentPlayback: PlaybackSession | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushInFlight = false
  private lastError: string | null = null
  private profileErrors = new Map<string, string>()

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
    const profileStatuses = this.config.profiles.map((profile) => this.toProfileStatus(profile))
    const enabledProfiles = this.getEnabledSubmittableProfiles()
    const connectedProfiles = this.config.profiles.filter((profile) => isConnectedProfile(profile))
    const blockedEnabledProfiles = this.config.profiles.filter((profile) => {
      return profile.enabled && !isProfileSubmittable(profile, this.hasApiCredentials)
    })
    const pendingCount = this.config.profiles.reduce((count, profile) => count + profile.pendingScrobbles.length, 0)
    const enabledPendingCount = enabledProfiles.reduce((count, profile) => count + profile.pendingScrobbles.length, 0)
    const activeProfile = this.getPrimaryStatusProfile()
    const apiBaseUrl = activeProfile.apiBaseUrl
    const usingCustomEndpoint = enabledProfiles.some((profile) => profile.kind === 'custom')
    const activeRequiresApiCredentials = lastFmProfileRequiresApiCredentials(activeProfile)
    const activeProfileStatus = profileStatuses.find((profile) => profile.id === activeProfile.id) ?? profileStatuses[0]
    const errorCount = profileStatuses.filter((profile) => profile.lastError).length

    let statusMessage = 'No scrobble destinations connected.'
    if (this.pendingAuthToken) {
      statusMessage = 'Last.fm authorization pending. Approve Astra in your browser; Astra will complete connection automatically.'
    } else if (connectedProfiles.length > 0 && !this.config.enabled) {
      statusMessage = 'Scrobbling is disabled.'
    } else if (connectedProfiles.length > 0 && enabledProfiles.length === 0) {
      statusMessage = blockedEnabledProfiles.length > 0
        ? 'Enabled destinations need valid credentials before scrobbling can start.'
        : 'Enable a connected destination to start scrobbling.'
    } else if (this.config.enabled && enabledProfiles.length > 0 && enabledPendingCount > 0) {
      const destinationLabel = enabledProfiles.length === 1 ? 'destination' : 'destinations'
      statusMessage = `${enabledPendingCount} scrobble${enabledPendingCount === 1 ? '' : 's'} pending retry across ${enabledProfiles.length} ${destinationLabel}.`
    } else if (this.config.enabled && enabledProfiles.length > 0 && errorCount > 0) {
      statusMessage = `${enabledProfiles.length} scrobble destination${enabledProfiles.length === 1 ? '' : 's'} active. ${errorCount} destination${errorCount === 1 ? '' : 's'} reporting errors.`
    } else if (this.config.enabled && enabledProfiles.length === 1) {
      statusMessage = `${enabledProfiles[0].name} scrobbling is active.`
    } else if (this.config.enabled && enabledProfiles.length > 1) {
      statusMessage = `${enabledProfiles.length} scrobble destinations active.`
    }

    return {
      enabled: this.config.enabled,
      connected: connectedProfiles.length > 0,
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
      activeProfileRequiresApiCredentials: activeRequiresApiCredentials,
      statusMessage,
      lastError: this.lastError
    }
  }

  async applyConfig(config: LastFmServiceConfig): Promise<LastFmStatus> {
    this.config = normalizeConfig(config, this.hasApiCredentials)
    this.audioScrobblerSessions.clear()
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
      protocol: normalized.protocol,
      name: normalized.name,
      apiBaseUrl: normalized.apiBaseUrl,
      enabled: false,
      sessionKey: normalized.sessionKey,
      username: normalized.username,
      pendingScrobbles: []
    }
    profile.enabled = isProfileSubmittable(profile, this.hasApiCredentials)

    this.config.profiles.push(profile)
    this.config.activeProfileId = profile.id
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.lastError = null
    this.profileErrors.delete(profile.id)
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

    const protocolChanged = profile.protocol !== normalized.protocol
    const endpointChanged = profile.apiBaseUrl !== normalized.apiBaseUrl
    const sessionChanged = normalized.sessionKey !== null && normalized.sessionKey !== profile.sessionKey

    profile.protocol = normalized.protocol
    profile.name = normalized.name
    profile.apiBaseUrl = normalized.apiBaseUrl

    if (normalized.sessionKey) {
      profile.sessionKey = normalized.sessionKey
      profile.username = normalized.username
    } else if (protocolChanged || endpointChanged) {
      profile.sessionKey = null
      profile.username = null
    } else {
      profile.username = normalized.username ?? profile.username
    }

    if (protocolChanged || endpointChanged || sessionChanged) {
      this.audioScrobblerSessions.delete(profile.id)
      profile.pendingScrobbles = []
      this.pendingAuthToken = this.pendingAuthProfileId === profile.id ? null : this.pendingAuthToken
      this.pendingAuthProfileId = this.pendingAuthProfileId === profile.id ? null : this.pendingAuthProfileId
    }

    if (!isProfileSubmittable(profile, this.hasApiCredentials)) {
      profile.enabled = false
    }

    this.lastError = null
    this.profileErrors.delete(profile.id)
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
    this.audioScrobblerSessions.delete(profile.id)
    this.profileErrors.delete(profile.id)
    if (this.pendingAuthProfileId === profile.id) {
      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
    }
    if (this.config.activeProfileId === profile.id) {
      this.config.activeProfileId = this.getPrimaryStatusProfile().id
    }

    this.lastError = null
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async setProfileEnabled(profileId: string, enabled: boolean): Promise<LastFmStatus> {
    const profile = this.findProfile(profileId)
    if (!profile) {
      return this.failWithStatus('Scrobble destination not found.')
    }

    const nextEnabled = Boolean(enabled)
    if (nextEnabled && !isProfileSubmittable(profile, this.hasApiCredentials)) {
      return this.failWithStatus('Connect this destination before enabling scrobbling.')
    }

    profile.enabled = nextEnabled
    if (nextEnabled) {
      this.config.activeProfileId = profile.id
      this.profileErrors.delete(profile.id)
    } else if (this.config.activeProfileId === profile.id) {
      this.config.activeProfileId = this.getPrimaryStatusProfile().id
    }

    this.lastError = null
    if (!this.shouldProcessPlayback()) {
      this.currentPlayback = null
      this.clearFlushTimer()
    }
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)
    return this.getStatus()
  }

  async setActiveProfile(profileId: string): Promise<LastFmStatus> {
    return this.setProfileEnabled(profileId, true)
  }

  async beginAuth(profileId: string = LASTFM_OFFICIAL_PROFILE_ID): Promise<LastFmAuthStartResult> {
    const profile = this.findProfile(profileId) ?? this.findProfile(LASTFM_OFFICIAL_PROFILE_ID) ?? this.getActiveProfile()
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
    const fallbackProfile = this.getPrimaryStatusProfile()
    if (!this.hasApiCredentials) {
      const message = 'Last.fm credentials are not configured for this build.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: fallbackProfile.username, message }
    }

    const authProfile = this.pendingAuthProfileId ? this.findProfile(this.pendingAuthProfileId) : null
    if (!this.pendingAuthToken || !authProfile) {
      return {
        ok: false,
        connected: this.isConnected(),
        username: fallbackProfile.username,
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
          username: fallbackProfile.username,
          message: 'Authorization still pending. Approve Astra in your browser.'
        }
      }

      if (sessionResponse.kind === 'transient') {
        this.lastError = sessionResponse.message
        this.emitStatus()
        return {
          ok: false,
          connected: this.isConnected(),
          username: fallbackProfile.username,
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
        username: fallbackProfile.username,
        message: sessionResponse.message
      }
    }

    const sessionValue = sessionResponse.payload.session
    if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) {
      const message = 'Last.fm returned an invalid session payload.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: fallbackProfile.username, message }
    }

    const session = sessionValue as Record<string, unknown>
    const sessionKey = normalizeText(session.key)
    const username = normalizeText(session.name)
    if (!sessionKey || !username) {
      const message = 'Last.fm returned an incomplete session payload.'
      this.lastError = message
      this.emitStatus()
      return { ok: false, connected: this.isConnected(), username: fallbackProfile.username, message }
    }

    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    authProfile.sessionKey = sessionKey
    authProfile.username = username
    authProfile.enabled = true
    this.config.activeProfileId = authProfile.id
    this.lastError = null
    this.profileErrors.delete(authProfile.id)
    await this.persistAndEmitStatus()
    this.scheduleFlush(0)

    return {
      ok: true,
      connected: true,
      username,
      message: `Connected as ${username}. Destination enabled.`
    }
  }

  async disconnectProfile(profileId: string): Promise<LastFmStatus> {
    const profile = this.findProfile(profileId)
    if (!profile) {
      return this.failWithStatus('Scrobble destination not found.')
    }

    if (this.pendingAuthProfileId === profile.id) {
      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
    }
    this.audioScrobblerSessions.delete(profile.id)
    profile.enabled = false
    profile.sessionKey = null
    profile.username = null
    profile.pendingScrobbles = []
    if (this.config.activeProfileId === profile.id) {
      this.config.activeProfileId = this.getPrimaryStatusProfile().id
    }
    this.lastError = null
    this.profileErrors.delete(profile.id)
    if (!this.shouldProcessPlayback()) {
      this.currentPlayback = null
      this.clearFlushTimer()
    }
    await this.persistAndEmitStatus()
    return this.getStatus()
  }

  async disconnect(): Promise<LastFmStatus> {
    return this.disconnectProfile(this.getPrimaryStatusProfile().id)
  }

  async resetToDefaults(): Promise<LastFmStatus> {
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.clearFlushTimer()
    this.audioScrobblerSessions.clear()
    this.config = normalizeConfig({
      enabled: false,
      activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
      profiles: [createOfficialProfile()]
    }, this.hasApiCredentials)
    this.lastError = null
    this.profileErrors.clear()
    await this.persistAndEmitStatus()
    return this.getStatus()
  }

  stop(): void {
    this.pendingAuthToken = null
    this.pendingAuthProfileId = null
    this.currentPlayback = null
    this.flushInFlight = false
    this.audioScrobblerSessions.clear()
    this.profileErrors.clear()
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
      const normalizedArtistNames = normalizeArtistNames(currentTrack.artistNames)
      const normalizedArtist = normalizedArtistNames.length > 1
        ? formatArtistNames(normalizedArtistNames)
        : normalizeDisplay(currentTrack.artist)
      const normalizedAlbum = normalizeText(currentTrack.album)

      this.currentPlayback = {
        trackKey,
        trackPath: normalizeText(currentTrack.path),
        track: normalizedTrack || currentTrack.title,
        artist: normalizedArtist || currentTrack.artist,
        artistNames: normalizedArtistNames.length > 0 ? normalizedArtistNames : undefined,
        album: normalizedAlbum,
        albumArtist: null,
        durationSeconds: normalizeNullablePositiveInteger(snapshot.duration),
        startedAtUnix: Math.max(
          0,
          Math.floor((nowMs / 1000) - Math.max(0, Number.isFinite(snapshot.currentTime) ? snapshot.currentTime : 0))
        ),
        playedSeconds: 0,
        nowPlayingByProfileId: new Map(),
        scrobbleQueuedProfileIds: new Set(),
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
    return this.config.profiles.some((profile) => isConnectedProfile(profile))
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

  private getPrimaryStatusProfile(): LastFmProfileConfig {
    const activeProfile = this.findProfile(this.config.activeProfileId)
    if (activeProfile && activeProfile.enabled && isProfileSubmittable(activeProfile, this.hasApiCredentials)) {
      return activeProfile
    }
    const enabledProfile = this.getEnabledSubmittableProfiles()[0]
    if (enabledProfile) return enabledProfile
    if (activeProfile && isConnectedProfile(activeProfile)) return activeProfile
    return this.findProfile(LASTFM_OFFICIAL_PROFILE_ID) ?? this.getActiveProfile()
  }

  private getEnabledSubmittableProfiles(): LastFmProfileConfig[] {
    return this.config.profiles.filter((profile) => {
      return profile.enabled && isProfileSubmittable(profile, this.hasApiCredentials)
    })
  }

  private toProfileStatus(profile: LastFmProfileConfig): LastFmProfileStatus {
    const enabled = profile.enabled && isProfileSubmittable(profile, this.hasApiCredentials)
    return {
      id: profile.id,
      kind: profile.kind,
      protocol: profile.protocol,
      protocolLabel: getLastFmProtocolLabel(profile.protocol, profile.kind),
      name: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      enabled,
      username: profile.username,
      connected: isConnectedProfile(profile),
      active: enabled,
      pendingScrobbles: profile.pendingScrobbles.length,
      canDelete: profile.kind === 'custom',
      requiresApiCredentials: lastFmProfileRequiresApiCredentials(profile),
      lastError: this.profileErrors.get(profile.id) ?? null
    }
  }

  private normalizeCustomProfileInput(
    input: LastFmCustomProfileInput,
    existingProfile: LastFmProfileConfig | null
  ):
    | {
        ok: true
        protocol: LastFmProfileConfig['protocol']
        name: string
        apiBaseUrl: string
        username: string | null
        sessionKey: string | null
      }
    | { ok: false; message: string } {
    const protocol = normalizeLastFmScrobbleProtocol(input.protocol ?? existingProfile?.protocol)
    const name = normalizeProfileName(input.name, existingProfile?.name ?? 'Custom endpoint')
    const apiBaseUrl = parseProfileApiBaseUrl(protocol, input.apiBaseUrl)
    if (!apiBaseUrl) {
      return { ok: false, message: 'Enter a valid http or https scrobble API URL.' }
    }
    if (protocol === 'lastfm2' && apiBaseUrl === LASTFM_OFFICIAL_API_BASE_URL) {
      return { ok: false, message: 'Custom profiles must use a non-official Last.fm-compatible API URL.' }
    }

    const username = normalizeText(input.username) ?? existingProfile?.username ?? null
    const sessionKey = normalizeText(input.sessionKey)
    if (protocol !== 'listenbrainz' && sessionKey && !username) {
      return { ok: false, message: `Username and ${getSecretLabelForProtocol(protocol)} are both required for custom profiles.` }
    }
    if (protocol !== 'listenbrainz' && !existingProfile && !sessionKey && username) {
      return { ok: false, message: `Username and ${getSecretLabelForProtocol(protocol)} are both required for custom profiles.` }
    }
    if (!existingProfile && protocol === 'listenbrainz' && !sessionKey) {
      return { ok: false, message: 'ListenBrainz profiles require an auth token.' }
    }

    return { ok: true, protocol, name, apiBaseUrl, username, sessionKey }
  }

  private failWithStatus(message: string): LastFmStatus {
    this.lastError = message
    this.emitStatus()
    return this.getStatus()
  }

  private shouldProcessPlayback(): boolean {
    return this.config.enabled && this.getEnabledSubmittableProfiles().length > 0
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
    if (!this.currentPlayback) return

    const durationSeconds = this.currentPlayback.durationSeconds
    if (durationSeconds != null && durationSeconds < LASTFM_SCROBBLE_MIN_DURATION_SECONDS) {
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

    let queued = false
    for (const profile of this.getEnabledSubmittableProfiles()) {
      if (this.currentPlayback.scrobbleQueuedProfileIds.has(profile.id)) continue

      const exists = profile.pendingScrobbles.some((item) => item.id === scrobbleId)
      this.currentPlayback.scrobbleQueuedProfileIds.add(profile.id)
      if (exists) continue

      profile.pendingScrobbles.push({
        id: scrobbleId,
        trackPath: this.currentPlayback.trackPath,
        track: this.currentPlayback.track,
        artist: this.currentPlayback.artist,
        artistNames: this.currentPlayback.artistNames,
        album: this.currentPlayback.album,
        albumArtist: this.currentPlayback.albumArtist,
        durationSeconds: this.currentPlayback.durationSeconds,
        timestamp: this.currentPlayback.startedAtUnix,
        queuedAt: nowMs,
        retryCount: 0,
        nextRetryAt: nowMs
      })

      if (profile.pendingScrobbles.length > LASTFM_MAX_PENDING_SCROBBLES) {
        const extra = profile.pendingScrobbles.length - LASTFM_MAX_PENDING_SCROBBLES
        profile.pendingScrobbles.splice(0, extra)
      }
      queued = true
    }

    if (!queued) return
    this.lastError = null
    void this.persistAndEmitStatus()
    this.scheduleFlush(0)
  }

  private async maybeSendNowPlaying(nowMs: number): Promise<void> {
    const playback = this.currentPlayback
    if (!playback) return

    for (const profile of this.getEnabledSubmittableProfiles()) {
      let profileState = playback.nowPlayingByProfileId.get(profile.id)
      if (!profileState) {
        profileState = {
          nowPlayingSent: false,
          nowPlayingRetryCount: 0,
          nextNowPlayingAttemptAt: nowMs
        }
        playback.nowPlayingByProfileId.set(profile.id, profileState)
      }

      if (profileState.nowPlayingSent) continue
      if (nowMs < profileState.nextNowPlayingAttemptAt) continue
      if (!profile.sessionKey) continue

      const response = await this.submitNowPlaying(playback, profile)
      if (response.ok) {
        profileState.nowPlayingSent = true
        profileState.nowPlayingRetryCount = 0
        profileState.nextNowPlayingAttemptAt = nowMs
        this.profileErrors.delete(profile.id)
        this.lastError = null
        this.emitStatus()
        continue
      }

      if (response.kind === 'session-invalid') {
        await this.handleSessionInvalid(response.message, profile)
        continue
      }

      this.profileErrors.set(profile.id, response.message)
      this.lastError = response.message
      if (response.kind === 'transient') {
        profileState.nowPlayingRetryCount += 1
        profileState.nextNowPlayingAttemptAt = nowMs + computeRetryDelayMs(
          profileState.nowPlayingRetryCount,
          LASTFM_NOW_PLAYING_RETRY_MS
        )
        this.emitStatus()
        continue
      }

      profileState.nowPlayingSent = true
      this.emitStatus()
    }
  }

  private async submitNowPlaying(
    playback: PlaybackSession,
    profile: LastFmProfileConfig
  ): Promise<LastFmApiResult> {
    if (!profile.sessionKey) {
      return {
        ok: false,
        kind: 'session-invalid',
        message: `${getLastFmProtocolLabel(profile.protocol, profile.kind)} credentials are not available.`
      }
    }

    if (profile.protocol === 'audioscrobbler') {
      return this.submitAudioScrobblerNowPlaying(playback, profile)
    }
    if (profile.protocol === 'listenbrainz') {
      return this.submitListenBrainz('playing_now', [playback], profile)
    }

    const params: Record<string, string | number> = {
      track: playback.track,
      artist: playback.artist
    }
    if (playback.album) params.album = playback.album
    if (playback.albumArtist) params.albumArtist = playback.albumArtist
    if (playback.durationSeconds) params.duration = playback.durationSeconds

    return this.callSignedMethod('track.updateNowPlaying', params, profile.sessionKey, profile)
  }

  private scheduleFlush(delayMs: number): void {
    this.clearFlushTimer()
    if (!this.shouldProcessPlayback()) return
    if (this.flushInFlight) return

    const nowMs = Date.now()
    const earliestRetryAt = this.getEnabledSubmittableProfiles()
      .map((profile) => profile.pendingScrobbles[0]?.nextRetryAt)
      .filter((nextRetryAt): nextRetryAt is number => typeof nextRetryAt === 'number')
      .reduce<number | null>((earliest, nextRetryAt) => {
        return earliest == null ? nextRetryAt : Math.min(earliest, nextRetryAt)
      }, null)

    if (earliestRetryAt == null) return

    const dueAt = Math.max(nowMs + Math.max(0, delayMs), earliestRetryAt)
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

    this.flushInFlight = true
    try {
      while (this.shouldProcessPlayback()) {
        const nowMs = Date.now()
        let processed = false

        for (const profile of this.getEnabledSubmittableProfiles()) {
          const first = profile.pendingScrobbles[0]
          if (!first || first.nextRetryAt > nowMs) continue

          const batch: LastFmPendingScrobble[] = []
          for (const item of profile.pendingScrobbles) {
            if (batch.length >= LASTFM_MAX_SCROBBLES_PER_BATCH) break
            if (item.nextRetryAt > nowMs) break
            batch.push(item)
          }

          if (batch.length === 0) continue
          processed = true
          const submitResult = await this.submitScrobbleBatch(batch, profile)

          if (submitResult.ok) {
            profile.pendingScrobbles.splice(0, batch.length)
            this.profileErrors.delete(profile.id)
            this.lastError = null
            await this.persistAndEmitStatus()
            continue
          }

          if (submitResult.kind === 'session-invalid') {
            await this.handleSessionInvalid(submitResult.message, profile)
            continue
          }

          this.profileErrors.set(profile.id, submitResult.message)
          this.lastError = submitResult.message
          if (submitResult.kind === 'permanent') {
            profile.pendingScrobbles.splice(0, batch.length)
            await this.persistAndEmitStatus()
            continue
          }

          const retryAt = nowMs + computeRetryDelayMs((batch[0]?.retryCount ?? 0) + 1, LASTFM_BASE_RETRY_MS)
          for (let index = 0; index < batch.length; index += 1) {
            const queued = profile.pendingScrobbles[index]
            if (!queued) break
            queued.retryCount += 1
            queued.nextRetryAt = retryAt
          }
          await this.persistAndEmitStatus()
        }

        if (!processed) break
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
        message: `${getLastFmProtocolLabel(profile.protocol, profile.kind)} credentials are not available.`
      }
    }

    if (profile.protocol === 'audioscrobbler') {
      return this.submitAudioScrobblerBatch(batch, profile)
    }
    if (profile.protocol === 'listenbrainz') {
      return this.submitListenBrainz('single', batch, profile)
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

  private async submitAudioScrobblerNowPlaying(
    playback: PlaybackSession,
    profile: LastFmProfileConfig
  ): Promise<LastFmApiResult> {
    const sessionResult = await this.getAudioScrobblerSession(profile)
    if (!sessionResult.ok) return sessionResult

    const body = new URLSearchParams({
      s: sessionResult.session.sessionId,
      a: playback.artist,
      t: playback.track,
      b: playback.album ?? '',
      l: playback.durationSeconds ? String(playback.durationSeconds) : '',
      n: '',
      m: ''
    })

    return this.callAudioScrobblerEndpoint(profile, sessionResult.session.nowPlayingUrl, body)
  }

  private async submitAudioScrobblerBatch(
    batch: LastFmPendingScrobble[],
    profile: LastFmProfileConfig
  ): Promise<LastFmApiResult> {
    const sessionResult = await this.getAudioScrobblerSession(profile)
    if (!sessionResult.ok) return sessionResult

    const body = new URLSearchParams({
      s: sessionResult.session.sessionId
    })
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]
      body.set(`a[${index}]`, item.artist)
      body.set(`t[${index}]`, item.track)
      body.set(`i[${index}]`, String(item.timestamp))
      body.set(`o[${index}]`, 'P')
      body.set(`r[${index}]`, '')
      body.set(`l[${index}]`, item.durationSeconds ? String(item.durationSeconds) : '')
      body.set(`b[${index}]`, item.album ?? '')
      body.set(`n[${index}]`, '')
      body.set(`m[${index}]`, '')
    }

    return this.callAudioScrobblerEndpoint(profile, sessionResult.session.submissionUrl, body)
  }

  private async getAudioScrobblerSession(profile: LastFmProfileConfig): Promise<AudioScrobblerSessionResult> {
    const cached = this.audioScrobblerSessions.get(profile.id)
    if (cached) return { ok: true, session: cached }

    if (!profile.username || !profile.sessionKey) {
      return {
        ok: false,
        kind: 'session-invalid',
        message: 'AudioScrobbler credentials are not available.'
      }
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const authToken = createMd5Hex(`${createMd5Hex(profile.sessionKey)}${timestamp}`)
    const handshakeUrl = new URL(profile.apiBaseUrl)
    handshakeUrl.searchParams.set('hs', 'true')
    handshakeUrl.searchParams.set('p', AUDIOSCROBBLER_PROTOCOL_VERSION)
    handshakeUrl.searchParams.set('c', AUDIOSCROBBLER_CLIENT_ID)
    handshakeUrl.searchParams.set('v', AUDIOSCROBBLER_CLIENT_VERSION)
    handshakeUrl.searchParams.set('u', profile.username)
    handshakeUrl.searchParams.set('t', String(timestamp))
    handshakeUrl.searchParams.set('a', authToken)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LASTFM_REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(handshakeUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'text/plain',
          'User-Agent': LASTFM_USER_AGENT
        },
        signal: controller.signal
      })

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          kind: 'session-invalid',
          message: `AudioScrobbler handshake failed with HTTP ${response.status}.`
        }
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message: `AudioScrobbler handshake failed with HTTP ${response.status}.`
        }
      }

      const text = await response.text().catch(() => '')
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const firstLine = lines[0] ?? ''
      if (firstLine === 'OK') {
        const sessionId = normalizeText(lines[1])
        const nowPlayingUrl = parseLastFmApiBaseUrl(lines[2])
        const submissionUrl = parseLastFmApiBaseUrl(lines[3])
        if (!sessionId || !nowPlayingUrl || !submissionUrl) {
          return {
            ok: false,
            kind: 'transient',
            message: 'AudioScrobbler handshake returned incomplete endpoint data.'
          }
        }

        const session = { sessionId, nowPlayingUrl, submissionUrl }
        this.audioScrobblerSessions.set(profile.id, session)
        return { ok: true, session }
      }

      if (firstLine === 'BADAUTH') {
        return {
          ok: false,
          kind: 'session-invalid',
          message: 'AudioScrobbler username or password/API key was rejected.'
        }
      }

      const message = firstLine.startsWith('FAILED')
        ? firstLine.replace(/^FAILED\s*/i, '').trim() || 'AudioScrobbler handshake failed.'
        : firstLine || `AudioScrobbler handshake failed with HTTP ${response.status}.`

      return {
        ok: false,
        kind: 'transient',
        message
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: 'transient',
        message: isAbort
          ? 'AudioScrobbler handshake timed out.'
          : 'AudioScrobbler handshake failed due to a network error.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async callAudioScrobblerEndpoint(
    profile: LastFmProfileConfig,
    endpointUrl: string,
    body: URLSearchParams
  ): Promise<LastFmApiResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LASTFM_REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'text/plain',
          'User-Agent': LASTFM_USER_AGENT
        },
        body: body.toString(),
        signal: controller.signal
      })

      if (response.status === 401 || response.status === 403) {
        this.audioScrobblerSessions.delete(profile.id)
        return {
          ok: false,
          kind: 'session-invalid',
          message: `AudioScrobbler request failed with HTTP ${response.status}.`
        }
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message: `AudioScrobbler request failed with HTTP ${response.status}.`
        }
      }

      const text = await response.text().catch(() => '')
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
      if (firstLine === 'OK') {
        return { ok: true, payload: {} }
      }

      if (firstLine === 'BADSESSION') {
        this.audioScrobblerSessions.delete(profile.id)
        return {
          ok: false,
          kind: 'transient',
          message: 'AudioScrobbler session expired; retrying after a new handshake.'
        }
      }

      if (firstLine.startsWith('FAILED')) {
        return {
          ok: false,
          kind: 'transient',
          message: firstLine.replace(/^FAILED\s*/i, '').trim() || 'AudioScrobbler request failed.'
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          kind: 'transient',
          message: `AudioScrobbler request failed with HTTP ${response.status}.`
        }
      }

      return {
        ok: false,
        kind: 'transient',
        message: firstLine || 'AudioScrobbler returned an invalid response.'
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: 'transient',
        message: isAbort
          ? 'AudioScrobbler request timed out.'
          : 'AudioScrobbler request failed due to a network error.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async submitListenBrainz(
    listenType: 'playing_now' | 'single',
    items: Array<PlaybackSession | LastFmPendingScrobble>,
    profile: LastFmProfileConfig
  ): Promise<LastFmApiResult> {
    if (!profile.sessionKey) {
      return {
        ok: false,
        kind: 'session-invalid',
        message: 'ListenBrainz auth token is not available.'
      }
    }

    const payload = items.map((item) => {
      const additionalInfo: Record<string, string | number | string[]> = {
        media_player: 'Astra',
        submission_client: 'Astra'
      }
      const artistNames = normalizeArtistNames(item.artistNames)
      if (artistNames.length > 0) {
        additionalInfo.artist_names = artistNames
      }
      if (item.durationSeconds) {
        additionalInfo.duration = item.durationSeconds
      }
      if ('playedSeconds' in item) {
        additionalInfo.duration_played = Math.trunc(item.playedSeconds)
      }

      const trackMetadata: Record<string, unknown> = {
        artist_name: item.artist,
        track_name: item.track,
        additional_info: additionalInfo
      }
      if (item.album) {
        trackMetadata.release_name = item.album
      }

      if ('timestamp' in item) {
        return {
          listened_at: item.timestamp,
          track_metadata: trackMetadata
        }
      }

      return {
        track_metadata: trackMetadata
      }
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LASTFM_REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(buildListenBrainzSubmitUrl(profile.apiBaseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Token ${profile.sessionKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': LASTFM_USER_AGENT
        },
        body: JSON.stringify({
          listen_type: listenType,
          payload
        }),
        signal: controller.signal
      })

      if (response.ok) {
        return { ok: true, payload: {} }
      }

      const message = await this.readJsonErrorMessage(response, 'ListenBrainz request failed.')
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          kind: 'session-invalid',
          message
        }
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return {
          ok: false,
          kind: 'transient',
          message
        }
      }
      return {
        ok: false,
        kind: 'permanent',
        message
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: 'transient',
        message: isAbort
          ? 'ListenBrainz request timed out.'
          : 'ListenBrainz request failed due to a network error.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readJsonErrorMessage(response: Response, fallback: string): Promise<string> {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>
      const message = normalizeText(record.error) ?? normalizeText(record.message) ?? normalizeText(record.detail)
      if (message) return message
    }

    return `${fallback} HTTP ${response.status}.`
  }

  private async handleSessionInvalid(message: string, profile: LastFmProfileConfig): Promise<void> {
    if (this.pendingAuthProfileId === profile.id) {
      this.pendingAuthToken = null
      this.pendingAuthProfileId = null
    }
    this.audioScrobblerSessions.delete(profile.id)
    profile.enabled = false
    profile.sessionKey = null
    profile.username = null
    if (this.config.activeProfileId === profile.id) {
      this.config.activeProfileId = this.getPrimaryStatusProfile().id
    }
    if (!this.shouldProcessPlayback()) {
      this.currentPlayback = null
      this.clearFlushTimer()
    }
    this.profileErrors.set(profile.id, message)
    this.lastError = message
    await this.persistAndEmitStatus()
  }

  private async callSignedMethod(
    method: string,
    inputParams: Record<string, string | number> = {},
    sessionKey?: string,
    profile: LastFmProfileConfig = this.getPrimaryStatusProfile()
  ): Promise<LastFmApiResult> {
    if (lastFmProfileRequiresApiCredentials(profile) && !this.hasApiCredentials) {
      return {
        ok: false,
        kind: 'permanent',
        message: 'Last.fm credentials are not configured.'
      }
    }

    const normalizedMethod = method.trim()
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
