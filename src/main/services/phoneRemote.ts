import { readFile } from 'fs/promises'
import { createServer, type Server } from 'https'
import type { IncomingMessage, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { extname, join, normalize } from 'path'
import { fileURLToPath } from 'url'
import type { MiniPlayerCommand, MiniPlayerQueueSnapshot, MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  COMPANION_API_SCOPES,
  type CompanionApiLibraryEvent,
  type CompanionApiScope
} from '../../types/companionApi'
import type {
  PhoneSyncApplyResult,
  PhoneSyncConflictResolution,
  PhoneSyncPendingResolution,
  PhoneSyncReportedConflict,
  PhoneSyncState,
  SyncPlaylistEntry,
  SyncPlaylistSnapshot
} from '../../types/phoneSync'
import { PHONE_SYNC_FORMAT } from '../../types/phoneSync'
import type {
  PhoneRemoteIdentity,
  PhoneRemoteClientKind,
  PhoneRemoteCredentialScope,
  PhoneRemotePairedDevice,
  PhoneRemotePairingMode,
  PhoneRemotePairingState,
  PhoneRemotePairingTicket,
  PhoneRemotePendingPairingRequest,
  PhoneRemoteServiceConfig,
  PhoneRemoteStatus
} from '../../types/phoneRemote'
import { PHONE_REMOTE_LAN_HOST, PHONE_REMOTE_PROTOCOL_VERSION } from '../../types/phoneRemote'
import {
  CONTROL_MAX_BODY_BYTES,
  PlaybackHttpCore,
  createOpaqueSecret,
  hashToken,
  hasBearerToken,
  normalizeDeviceLabel,
  secureTokenEquals,
  toSafeOptionalString
} from './playbackHttpCore'
import { CompanionApiV2, type CompanionApiV2Options } from './companionApiV2'
import {
  PHONE_REMOTE_DEVICE_INACTIVITY_MS,
  PHONE_REMOTE_PREVIOUS_TOKEN_GRACE_MS,
  PHONE_REMOTE_TOKEN_ROTATE_AFTER_MS,
  PHONE_REMOTE_TOKEN_ROTATE_REQUIRED_MS,
  createPhoneRemoteEphemeralKeyPair,
  derivePhoneRemotePairingCode,
  derivePhoneRemotePairingKey,
  normalizePhoneRemoteFingerprint,
  sealPhoneRemotePairingPayload,
  verifyPhoneRemotePairingProof,
  type PhoneRemotePairingTranscript,
  type PhoneRemoteTlsIdentity
} from './phoneRemoteSecurity'

const TOKEN_PREFIX_LENGTH = 8
// Sync payloads carry whole favorites/playlists sets — far larger than control
// bodies (CONTROL_MAX_BODY_BYTES is 1 KB).
const SYNC_MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_REMOTE_ASSET_BYTES = 2 * 1024 * 1024
const PAIRING_TICKET_TTL_MS = 2 * 60_000
const PAIRING_REQUEST_TTL_MS = 2 * 60_000
const PIN_PAIRING_MAX_FAILURES = 3
const PIN_PAIRING_RATE_LIMIT_MS = 5_000
const PIN_PAIRING_LOCKOUT_MS = 5 * 60_000
const PAIRED_DEVICE_LAST_SEEN_PERSIST_INTERVAL_MS = 60_000
const PHONE_REMOTE_MODULE_DIR = typeof __dirname === 'string'
  ? __dirname
  : fileURLToPath(new URL('.', import.meta.url))
const REMOTE_STATIC_ROOT_CANDIDATES = [
  join(process.cwd(), 'src/renderer/public/remote'),
  join(process.cwd(), 'out/renderer/remote'),
  join(PHONE_REMOTE_MODULE_DIR, '../../renderer/remote'),
  join(PHONE_REMOTE_MODULE_DIR, '../renderer/remote')
]
const REMOTE_STATIC_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
}

interface PersistedPairedDevice extends PhoneRemotePairedDevice {
  controlTokenHash: string
  syncTokenHash: string | null
  previousControlTokenHash: string | null
  previousSyncTokenHash: string | null
  previousTokensValidUntil: number | null
}

interface PairingTicketState {
  ticket: string
  baseUrl: string
  createdAt: number
  expiresAt: number
  claimedAt: number | null
  clientKind: PhoneRemoteClientKind
}

interface PairingRequestState {
  id: string
  ticket: string | null
  pollToken: string
  deviceName: string
  clientLabel: string
  clientKind: PhoneRemoteClientKind
  requestedAt: number
  expiresAt: number
  baseUrl: string
  pairingMode: PhoneRemotePairingMode
  pin: string | null
  failedPinAttempts: number
  state: PhoneRemotePairingState
  issuedDeviceId: string | null
  issuedControlToken: string | null
  issuedSyncToken: string | null
  pairingKey: Buffer | null
  transcript: PhoneRemotePairingTranscript | null
  remoteAddress: string
  requestedScopes: CompanionApiScope[]
}

interface PhoneRemoteServiceOptions {
  config: PhoneRemoteServiceConfig
  getSnapshot: () => MiniPlayerSnapshot | null
  dispatchCommand: (command: MiniPlayerCommand) => void
  getIdentity?: () => PhoneRemoteIdentity
  resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  pairedDevices?: PersistedPairedDevice[]
  onPairedDevicesChange?: (devices: PersistedPairedDevice[]) => void
  onStatusChange?: (status: PhoneRemoteStatus) => void
  // Favorites/playlists LAN sync (phoneSync.ts), injected so this service stays
  // decoupled from the library module. applySyncChanges returns null when the
  // payload fails validation.
  getSyncState?: () => PhoneSyncState
  applySyncChanges?: (payload: unknown) => PhoneSyncApplyResult | null
  tlsIdentity?: PhoneRemoteTlsIdentity
  companionApi?: Omit<CompanionApiV2Options, 'transport' | 'authenticateRequest' | 'onConnectedClientsChange'>
}

type PhoneRemoteAuthorizationContext = {
  kind: 'device'
  deviceId: string
  scope: PhoneRemoteCredentialScope
  rotationRequired: boolean
  usingPreviousCredential: boolean
}

function getPhoneRemoteLanUrls(port: number): string[] {
  const urls = new Set<string>()
  const interfaces = networkInterfaces()

  for (const addresses of Object.values(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.internal) continue
      if (addressInfo.family !== 'IPv4') continue
      const address = addressInfo.address.trim()
      if (!address) continue
      urls.add(`https://${address}:${port}`)
    }
  }

  const allUrls = Array.from(urls).sort((left, right) => left.localeCompare(right))
  const preferred192Urls = allUrls.filter((url) => /^https:\/\/192\.168\./.test(url))
  return preferred192Urls.length > 0 ? preferred192Urls : allUrls
}

const SYNC_CONFLICT_REPORT_MAX_ITEMS = 200

function normalizeRequestedCompanionScopes(value: unknown): CompanionApiScope[] {
  if (!Array.isArray(value)) return ['observe', 'playback-control']
  const requested = new Set<CompanionApiScope>()
  for (const scope of value) {
    if (typeof scope === 'string' && COMPANION_API_SCOPES.includes(scope as CompanionApiScope)) {
      requested.add(scope as CompanionApiScope)
    }
  }
  requested.add('observe')
  return Array.from(requested)
}

function sanitizeSyncPlaylistEntry(raw: unknown): SyncPlaylistEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const durationSeconds = Number(item.durationSeconds)
  const position = Number(item.position)
  const addedAt = Number(item.addedAt)
  return {
    title: typeof item.title === 'string' ? item.title : '',
    artist: typeof item.artist === 'string' ? item.artist : '',
    album: typeof item.album === 'string' ? item.album : '',
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    position: Number.isFinite(position) ? position : 0,
    addedAt: Number.isFinite(addedAt) && addedAt > 0 ? Math.floor(addedAt) : 0,
    sourcePath: typeof item.sourcePath === 'string' && item.sourcePath.trim().length > 0 ? item.sourcePath : null
  }
}

function sanitizeSyncPlaylistSnapshot(raw: unknown): SyncPlaylistSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kind = item.kind === 'dynamic' ? 'dynamic' : 'normal'
  const updatedAt = Number(item.updatedAt)
  const trackCount = Number(item.trackCount)
  let entries: SyncPlaylistEntry[] | null = null
  if (kind === 'normal' && Array.isArray(item.entries)) {
    entries = item.entries
      .map(sanitizeSyncPlaylistEntry)
      .filter((entry): entry is SyncPlaylistEntry => entry !== null)
  }
  return {
    name: typeof item.name === 'string' ? item.name : '',
    kind,
    dynamicRules: kind === 'dynamic' && typeof item.dynamicRules === 'string' ? item.dynamicRules : null,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0,
    trackCount: entries !== null
      ? entries.length
      : Number.isFinite(trackCount) && trackCount >= 0
        ? Math.floor(trackCount)
        : 0,
    entries
  }
}

function sanitizeReportedConflicts(raw: unknown): PhoneSyncReportedConflict[] {
  if (!Array.isArray(raw)) return []
  const conflicts: PhoneSyncReportedConflict[] = []
  for (const item of raw) {
    if (conflicts.length >= SYNC_CONFLICT_REPORT_MAX_ITEMS) break
    if (!item || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    const syncUid = typeof candidate.syncUid === 'string' ? candidate.syncUid : ''
    if (!syncUid) continue
    const toCount = (value: unknown): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
    }
    const toTimestamp = (value: unknown): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
    }
    const phoneSnapshot = sanitizeSyncPlaylistSnapshot(candidate.phoneSnapshot)
    const desktopSnapshot = sanitizeSyncPlaylistSnapshot(candidate.desktopSnapshot)
    conflicts.push({
      kind: candidate.kind === 'first-pairing' ? 'first-pairing' : 'concurrent-edit',
      syncUid,
      name: typeof candidate.name === 'string' ? candidate.name : '',
      playlistKind: candidate.playlistKind === 'dynamic' ? 'dynamic' : 'normal',
      phoneName: typeof candidate.phoneName === 'string' ? candidate.phoneName : '',
      desktopName: typeof candidate.desktopName === 'string' ? candidate.desktopName : '',
      phoneUpdatedAt: toTimestamp(candidate.phoneUpdatedAt),
      desktopUpdatedAt: toTimestamp(candidate.desktopUpdatedAt),
      phoneTrackCount: toCount(candidate.phoneTrackCount),
      desktopTrackCount: toCount(candidate.desktopTrackCount),
      ...(phoneSnapshot ? { phoneSnapshot } : {}),
      ...(desktopSnapshot ? { desktopSnapshot } : {})
    })
  }
  return conflicts
}

function getRemoteAssetPathname(requestPath: string): string | null {
  if (requestPath === '/remote') return ''
  if (requestPath === '/remote/' || requestPath === '/remote/index.html') return 'index.html'
  if (!requestPath.startsWith('/remote/')) return null

  const rawRelativePath = requestPath.slice('/remote/'.length)
  if (!rawRelativePath) return 'index.html'

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawRelativePath)
  } catch {
    return null
  }

  const normalizedPath = normalize(decodedPath).replace(/\\/g, '/')
  if (
    normalizedPath.startsWith('../')
    || normalizedPath.includes('/../')
    || normalizedPath === '..'
    || normalizedPath.startsWith('/')
  ) {
    return null
  }

  return normalizedPath
}

export class PhoneRemoteService {
  private config: PhoneRemoteServiceConfig
  private readonly onPairedDevicesChange?: (devices: PersistedPairedDevice[]) => void
  private readonly onStatusChange?: (status: PhoneRemoteStatus) => void

  private server: Server | null = null
  private pairedDevices: PersistedPairedDevice[]
  private readonly pairingTickets = new Map<string, PairingTicketState>()
  private readonly pairingRequestsById = new Map<string, PairingRequestState>()
  private readonly pairingRequestIdByPollToken = new Map<string, string>()
  private active = false
  private lastError: string | null = null
  private readonly core: PlaybackHttpCore<PhoneRemoteAuthorizationContext>
  private readonly companionApi: CompanionApiV2 | null
  private readonly getIdentitySnapshot: () => PhoneRemoteIdentity
  private readonly getSyncState?: () => PhoneSyncState
  private readonly applySyncChanges?: (payload: unknown) => PhoneSyncApplyResult | null
  private syncApplyInFlight = false
  // Sync session state: the phone is the merge authority, so the desktop only
  // signals (sync requests, chosen resolutions) and mirrors what the phone
  // reports (conflicts, last-synced time).
  private syncRequestedAt: number | null = null
  private syncLastSyncedAt: number | null = null
  private syncConflicts: PhoneSyncReportedConflict[] = []
  private readonly syncPendingResolutions = new Map<string, PhoneSyncPendingResolution>()
  private tlsIdentity: PhoneRemoteTlsIdentity | null
  private readonly pinPairingLastRequestAt = new Map<string, number>()
  private readonly pinPairingLockoutUntil = new Map<string, number>()

  constructor(options: PhoneRemoteServiceOptions) {
    this.config = { ...options.config }
    this.onPairedDevicesChange = options.onPairedDevicesChange
    this.onStatusChange = options.onStatusChange
    this.getSyncState = options.getSyncState
    this.applySyncChanges = options.applySyncChanges
    this.tlsIdentity = options.tlsIdentity ? { ...options.tlsIdentity } : null
    this.pairedDevices = [...(options.pairedDevices ?? [])]
    this.core = new PlaybackHttpCore({
      getSnapshot: options.getSnapshot,
      dispatchCommand: options.dispatchCommand,
      resolveArtworkDataUrl: options.resolveArtworkDataUrl,
      authorizeRequest: (req) => this.authorizeRequest(req, 'control'),
      buildArtworkUrl: (trackId) => `/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`,
      getControlsEnabled: () => this.config.controlsEnabled,
      onConnectedClientsChange: () => this.emitStatus()
    })
    this.companionApi = options.companionApi
      ? new CompanionApiV2({
          ...options.companionApi,
          transport: 'paired-lan',
          authenticateRequest: (req) => this.authenticateCompanionRequest(req),
          onConnectedClientsChange: () => this.emitStatus()
        })
      : null
    this.getIdentitySnapshot = () => this.normalizeIdentity(options.getIdentity?.())
  }

  getIdentity(): PhoneRemoteIdentity {
    return this.getIdentitySnapshot()
  }

  setTlsIdentity(identity: PhoneRemoteTlsIdentity): void {
    if (this.active) throw new Error('Stop Phone Remote before replacing its TLS identity.')
    if (
      this.tlsIdentity &&
      normalizePhoneRemoteFingerprint(this.tlsIdentity.fingerprint256) !==
        normalizePhoneRemoteFingerprint(identity.fingerprint256)
    ) {
      this.pairedDevices = []
      this.core.closeAllSseClients()
      this.companionApi?.closeAllSseClients()
      this.emitPairedDevicesChange()
    }
    this.tlsIdentity = { ...identity }
  }

  private requireTlsIdentity(): PhoneRemoteTlsIdentity {
    if (!this.tlsIdentity) throw new Error('Phone remote secure identity is unavailable.')
    return this.tlsIdentity
  }

  getStatus(): PhoneRemoteStatus {
    this.cleanupExpiredPairingState(false)
    const lanUrls = this.active ? getPhoneRemoteLanUrls(this.config.port) : []
    return {
      enabled: this.config.enabled,
      controlsEnabled: this.config.controlsEnabled,
      bindHost: PHONE_REMOTE_LAN_HOST,
      port: this.config.port,
      lanUrls,
      controllerUrl: lanUrls[0] ? `${lanUrls[0]}/remote/` : null,
      active: this.active,
      connectedClients: this.core.getConnectedClientCount() + (this.companionApi?.getConnectedClientCount() ?? 0),
      pairedDeviceCount: this.pairedDevices.filter((device) => device.revokedAt === null).length,
      pendingPairingCount: this.getPendingPairingRequestsSnapshot().length,
      lastError: this.lastError,
      identity: this.getIdentity(),
      sync: {
        enabled: this.config.syncEnabled,
        requestedAt: this.syncRequestedAt,
        lastSyncedAt: this.syncLastSyncedAt,
        conflicts: [...this.syncConflicts],
        pendingResolutions: [...this.syncPendingResolutions.values()]
      }
    }
  }

  /** Desktop-side "Sync now": nudge connected phones over SSE and leave a flag
   *  the phone's foreground poll picks up when it isn't connected. */
  requestSync(): void {
    this.syncRequestedAt = Date.now()
    this.core.broadcastEvent('sync-request', { requestedAt: this.syncRequestedAt })
    this.emitStatus()
  }

  /** Desktop-side conflict choice; delivered via /v1/sync/state and applied by
   *  the phone on its next run (which requestSync() kicks off). */
  resolveSyncConflict(syncUid: string, resolution: PhoneSyncConflictResolution): void {
    this.syncPendingResolutions.set(syncUid, {
      syncUid,
      resolution,
      decidedAt: Date.now()
    })
    this.requestSync()
  }

  listPairedDevices(): PhoneRemotePairedDevice[] {
    return this.pairedDevices
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((device) => ({
        id: device.id,
        name: device.name,
        clientLabel: device.clientLabel,
        tokenPrefix: device.tokenPrefix,
        syncTokenPrefix: device.syncTokenPrefix,
        clientKind: device.clientKind,
        scopes: [...device.scopes],
        credentialIssuedAt: device.credentialIssuedAt,
        credentialRotatedAt: device.credentialRotatedAt,
        expiresAt: this.deviceExpiresAt(device),
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt
      }))
  }

  replacePairedDevices(devices: PersistedPairedDevice[]): void {
    this.pairedDevices = devices.map((device) => ({ ...device }))
    this.emitStatus()
  }

  listPendingPairingRequests(): PhoneRemotePendingPairingRequest[] {
    this.cleanupExpiredPairingState(false)
    return this.getPendingPairingRequestsSnapshot()
  }

  createPairingTicket(baseUrl?: string, clientKind: PhoneRemoteClientKind = 'native'): PhoneRemotePairingTicket {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.active) {
      throw new Error('Phone remote pairing is only available while the phone remote is active.')
    }

    const lanUrls = getPhoneRemoteLanUrls(this.config.port)
    const normalizedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
    if (lanUrls.length === 0 && !normalizedBaseUrl) {
      throw new Error('No non-internal IPv4 LAN address is available for phone pairing.')
    }

    const selectedBaseUrl = normalizedBaseUrl || lanUrls[0]
    let selectedUrl: URL
    try {
      selectedUrl = new URL(selectedBaseUrl)
    } catch {
      throw new Error('Selected pairing URL is invalid.')
    }
    const isCleanHttpsOrigin = selectedUrl.protocol === 'https:'
      && selectedUrl.port === String(this.config.port)
      && !selectedUrl.username
      && !selectedUrl.password
      && (selectedUrl.pathname === '' || selectedUrl.pathname === '/')
      && !selectedUrl.search
      && !selectedUrl.hash
    const samePortExplicitUrl = isCleanHttpsOrigin
    if (!lanUrls.includes(selectedBaseUrl) && !samePortExplicitUrl) {
      throw new Error('Selected pairing URL is no longer available.')
    }

    const createdAt = Date.now()
    const expiresAt = createdAt + PAIRING_TICKET_TTL_MS
    const ticket = createOpaqueSecret()
    this.pairingTickets.set(ticket, {
      ticket,
      baseUrl: selectedBaseUrl,
      createdAt,
      expiresAt,
      claimedAt: null,
      clientKind
    })
    this.emitStatus()
    return {
      ticket,
      baseUrl: selectedBaseUrl,
      controllerUrl: `${selectedBaseUrl}/remote/`,
      pairingUrl: clientKind === 'native'
        ? `astra://desktop-remote?baseUrl=${encodeURIComponent(selectedBaseUrl)}&ticket=${encodeURIComponent(ticket)}&endpointUuid=${encodeURIComponent(this.getIdentity().endpointUuid ?? '')}&fingerprint=${encodeURIComponent(this.requireTlsIdentity().fingerprint256)}&protocolVersion=${PHONE_REMOTE_PROTOCOL_VERSION}`
        : `${selectedBaseUrl}/remote/#pair=${encodeURIComponent(ticket)}&fingerprint=${encodeURIComponent(this.requireTlsIdentity().fingerprint256)}`,
      createdAt,
      expiresAt,
      identity: this.getIdentity(),
      clientKind,
      certificateFingerprint: this.requireTlsIdentity().fingerprint256
    }
  }

  approvePairingRequest(id: string, grantedScopes?: readonly CompanionApiScope[]): PhoneRemotePendingPairingRequest | null {
    this.cleanupExpiredPairingState(true)
    const request = this.pairingRequestsById.get(id)
    if (!request || request.state !== 'pending') return null

    if (grantedScopes) {
      const requested = new Set(request.requestedScopes)
      request.requestedScopes = normalizeRequestedCompanionScopes(grantedScopes)
        .filter((scope) => requested.has(scope))
      if (!request.requestedScopes.includes('observe')) request.requestedScopes.unshift('observe')
    }
    this.issuePairingDeviceTokens(request)
    return this.toPendingPairingRequest(request)
  }

  rejectPairingRequest(id: string): PhoneRemotePendingPairingRequest | null {
    this.cleanupExpiredPairingState(true)
    const request = this.pairingRequestsById.get(id)
    if (!request || request.state !== 'pending') return null
    request.state = 'rejected'
    this.emitStatus()
    return this.toPendingPairingRequest(request)
  }

  revokePairedDevice(id: string): PhoneRemotePairedDevice | null {
    const device = this.pairedDevices.find((candidate) => candidate.id === id)
    if (!device || device.revokedAt !== null) return null
    device.revokedAt = Date.now()
    this.core.closeSseClients((client) => client.authorization.deviceId === id)
    this.companionApi?.closeAllSseClients()
    this.emitPairedDevicesChange()
    this.emitStatus()
    return {
      id: device.id,
      name: device.name,
      clientLabel: device.clientLabel,
      tokenPrefix: device.tokenPrefix,
      syncTokenPrefix: device.syncTokenPrefix,
      clientKind: device.clientKind,
      scopes: [...device.scopes],
      credentialIssuedAt: device.credentialIssuedAt,
      credentialRotatedAt: device.credentialRotatedAt,
      expiresAt: this.deviceExpiresAt(device),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt
    }
  }

  revokeAllPairedDevices(): number {
    const now = Date.now()
    let revokedCount = 0
    for (const device of this.pairedDevices) {
      if (device.revokedAt !== null) continue
      device.revokedAt = now
      revokedCount += 1
    }
    if (revokedCount === 0) return 0
    this.core.closeAllSseClients()
    this.companionApi?.closeAllSseClients()
    this.emitPairedDevicesChange()
    this.emitStatus()
    return revokedCount
  }

  async applyConfig(config: PhoneRemoteServiceConfig): Promise<PhoneRemoteStatus> {
    const previous = this.config
    const restartNeeded = previous.port !== config.port || previous.enabled !== config.enabled

    this.config = { ...config }

    if (!this.config.enabled) {
      await this.stopServer()
      this.lastError = null
      this.emitStatus()
      return this.getStatus()
    }

    if (restartNeeded || !this.server || !this.active) {
      await this.startServer()
    } else {
      this.lastError = null
      this.emitStatus()
    }

    return this.getStatus()
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.core.publishSnapshot(snapshot)
    this.companionApi?.publishCurrentPlayback()
  }

  publishQueueSnapshot(snapshot: MiniPlayerQueueSnapshot | null): void {
    this.core.publishQueueSnapshot(snapshot)
    this.companionApi?.publishCurrentQueue()
  }

  publishLibraryEvent(event: CompanionApiLibraryEvent): void {
    this.companionApi?.publishLibraryEvent(event)
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private normalizeIdentity(identity: PhoneRemoteIdentity | undefined): PhoneRemoteIdentity {
    const endpointUuid = identity?.endpointUuid?.trim() || null
    const desktopName = identity?.desktopName?.trim() || 'Astra Desktop'
    const protocolVersion = Number.isFinite(identity?.protocolVersion)
      ? Math.max(1, Math.floor(identity?.protocolVersion ?? PHONE_REMOTE_PROTOCOL_VERSION))
      : PHONE_REMOTE_PROTOCOL_VERSION
    return { endpointUuid, desktopName, protocolVersion }
  }

  private issuePairingDeviceTokens(request: PairingRequestState): {
    controlToken: string
    syncToken: string | null
    deviceId: string
    issuedAt: number
  } {
    const now = Date.now()
    const controlToken = createOpaqueSecret(32)
    const syncToken = request.clientKind === 'web' ? null : createOpaqueSecret(32)
    const deviceId = createOpaqueSecret(16)
    const clientKind = request.clientKind
    const device: PersistedPairedDevice = {
      id: deviceId,
      name: request.deviceName,
      clientLabel: request.clientLabel,
      tokenPrefix: controlToken.slice(0, TOKEN_PREFIX_LENGTH),
      syncTokenPrefix: syncToken?.slice(0, TOKEN_PREFIX_LENGTH) ?? null,
      clientKind,
      scopes: Array.from(new Set<PhoneRemoteCredentialScope>([
        'control',
        ...request.requestedScopes,
        ...(syncToken ? ['sync' as const] : [])
      ])),
      credentialIssuedAt: now,
      credentialRotatedAt: now,
      expiresAt: now + PHONE_REMOTE_DEVICE_INACTIVITY_MS,
      controlTokenHash: hashToken(controlToken),
      syncTokenHash: syncToken ? hashToken(syncToken) : null,
      previousControlTokenHash: null,
      previousSyncTokenHash: null,
      previousTokensValidUntil: null,
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null
    }
    this.pairedDevices = [device, ...this.pairedDevices]
    request.state = 'approved'
    request.issuedDeviceId = deviceId
    request.issuedControlToken = controlToken
    request.issuedSyncToken = syncToken
    this.emitPairedDevicesChange()
    this.emitStatus()
    return { controlToken, syncToken, deviceId, issuedAt: now }
  }

  private deviceExpiresAt(device: PersistedPairedDevice): number {
    return (device.lastSeenAt ?? device.createdAt) + PHONE_REMOTE_DEVICE_INACTIVITY_MS
  }

  private getPendingPairingRequestsSnapshot(): PhoneRemotePendingPairingRequest[] {
    return Array.from(this.pairingRequestsById.values())
      .filter((request) => request.state === 'pending')
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .map((request) => this.toPendingPairingRequest(request))
  }

  private toPendingPairingRequest(request: PairingRequestState): PhoneRemotePendingPairingRequest {
    return {
      id: request.id,
      deviceName: request.deviceName,
      clientLabel: request.clientLabel,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      baseUrl: request.baseUrl,
      pairingMode: request.pairingMode,
      pin: request.pairingMode === 'pin' ? request.pin : null,
      requestedScopes: [...request.requestedScopes]
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private emitPairedDevicesChange(): void {
    this.onPairedDevicesChange?.(this.pairedDevices.map((device) => ({ ...device })))
  }

  private cleanupExpiredPairingState(emitStatus: boolean): void {
    const now = Date.now()
    let changed = false

    for (const [ticket, ticketState] of this.pairingTickets) {
      if (ticketState.expiresAt > now) continue
      this.pairingTickets.delete(ticket)
      changed = true
    }

    for (const request of this.pairingRequestsById.values()) {
      if (request.expiresAt > now) continue
      if (request.state === 'pending') {
        request.state = 'expired'
        changed = true
      }
    }

    if (changed && emitStatus) {
      this.emitStatus()
    }
  }

  private authorizeRequest(
    req: IncomingMessage,
    requiredScope: PhoneRemoteCredentialScope,
    allowRotationRequired = false
  ): PhoneRemoteAuthorizationContext | null {
    const suppliedToken = hasBearerToken(req)
    if (!suppliedToken) return null
    const suppliedHash = hashToken(suppliedToken)
    const now = Date.now()
    for (const device of this.pairedDevices) {
      if (device.revokedAt !== null) continue
      if (this.deviceExpiresAt(device) <= now) {
        device.revokedAt = now
        this.emitPairedDevicesChange()
        continue
      }
      if (!device.scopes.includes(requiredScope)) continue
      const currentHash = requiredScope === 'control' ? device.controlTokenHash : device.syncTokenHash
      const previousHash = requiredScope === 'control'
        ? device.previousControlTokenHash
        : device.previousSyncTokenHash
      const matchesCurrent = Boolean(currentHash && secureTokenEquals(suppliedHash, currentHash))
      const matchesPrevious = Boolean(
        previousHash
        && device.previousTokensValidUntil
        && device.previousTokensValidUntil > now
        && secureTokenEquals(suppliedHash, previousHash)
      )
      if (!matchesCurrent && !matchesPrevious) continue
      const rotationRequired = now - device.credentialRotatedAt >= PHONE_REMOTE_TOKEN_ROTATE_REQUIRED_MS
      if (rotationRequired && !allowRotationRequired) return null
      this.touchPairedDevice(device.id)
      return {
        kind: 'device',
        deviceId: device.id,
        scope: requiredScope,
        rotationRequired,
        usingPreviousCredential: matchesPrevious
      }
    }

    return null
  }

  private authenticateCompanionRequest(req: IncomingMessage): { id: string; scopes: ReadonlySet<CompanionApiScope> } | null {
    const suppliedToken = hasBearerToken(req)
    if (!suppliedToken) return null
    const suppliedHash = hashToken(suppliedToken)
    const now = Date.now()
    for (const device of this.pairedDevices) {
      if (device.revokedAt !== null) continue
      if (this.deviceExpiresAt(device) <= now) {
        device.revokedAt = now
        this.emitPairedDevicesChange()
        continue
      }
      const matchesCurrent = secureTokenEquals(suppliedHash, device.controlTokenHash)
      const matchesPrevious = Boolean(
        device.previousControlTokenHash
        && device.previousTokensValidUntil
        && device.previousTokensValidUntil > now
        && secureTokenEquals(suppliedHash, device.previousControlTokenHash)
      )
      if (!matchesCurrent && !matchesPrevious) continue
      if (now - device.credentialRotatedAt >= PHONE_REMOTE_TOKEN_ROTATE_REQUIRED_MS) return null

      const scopes = new Set<CompanionApiScope>()
      const hasExplicitCompanionScopes = device.scopes.some((scope) => (
        COMPANION_API_SCOPES.includes(scope as CompanionApiScope)
      ))
      // Pre-v2 pairings only carried the legacy `control` scope. Preserve their
      // effective observation/control access, while respecting the exact subset
      // approved for every pairing created after companion scopes were added.
      if (device.scopes.includes('observe') || (!hasExplicitCompanionScopes && device.scopes.includes('control'))) {
        scopes.add('observe')
      }
      if (this.config.controlsEnabled && (
        device.scopes.includes('playback-control')
        || (!hasExplicitCompanionScopes && device.scopes.includes('control'))
      )) {
        scopes.add('playback-control')
      }
      if (device.scopes.includes('library-search')) scopes.add('library-search')
      if (device.scopes.includes('library-write')) scopes.add('library-write')
      this.touchPairedDevice(device.id)
      return { id: `paired:${device.id}`, scopes }
    }
    return null
  }

  private touchPairedDevice(deviceId: string): void {
    const device = this.pairedDevices.find((candidate) => candidate.id === deviceId)
    if (!device || device.revokedAt !== null) return
    const now = Date.now()
    if (device.lastSeenAt !== null && now - device.lastSeenAt < PAIRED_DEVICE_LAST_SEEN_PERSIST_INTERVAL_MS) {
      return
    }
    device.lastSeenAt = now
    device.expiresAt = now + PHONE_REMOTE_DEVICE_INACTIVITY_MS
    this.emitPairedDevicesChange()
  }

  private async startServer(): Promise<void> {
    await this.stopServer()

    if (!this.tlsIdentity) {
      this.active = false
      this.lastError = 'Phone remote secure identity is unavailable.'
      this.emitStatus()
      return
    }

    const server = createServer({
      key: this.tlsIdentity.privateKeyPem,
      cert: this.tlsIdentity.certificatePem,
      minVersion: 'TLSv1.2'
    }, (req, res) => {
      void this.handleRequest(req, res)
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 65_000
    server.timeout = 65_000
    server.keepAliveTimeout = 5_000
    server.maxConnections = 64
    server.maxRequestsPerSocket = 100

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }

        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(this.config.port, PHONE_REMOTE_LAN_HOST)
      })

      server.on('error', (error) => {
        this.lastError = error.message
        this.active = false
        this.emitStatus()
      })

      this.server = server
      this.active = true
      this.lastError = null
      this.core.startHeartbeat()
      this.companionApi?.startHeartbeat()
      this.emitStatus()
    } catch (error) {
      this.server = null
      this.active = false
      this.lastError = error instanceof Error ? error.message : 'Failed to start phone remote.'
      this.core.stopHeartbeat()
      this.emitStatus()
    }
  }

  private async stopServer(): Promise<void> {
    this.core.stopHeartbeat()
    this.core.closeAllSseClients()
    this.companionApi?.stopHeartbeat()
    this.companionApi?.closeAllSseClients()

    if (!this.server) {
      this.active = false
      this.emitStatus()
      return
    }

    const server = this.server
    this.server = null

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    this.active = false
    this.emitStatus()
  }

  private respondJson(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
    let encoded = Buffer.from(JSON.stringify(body), 'utf8')
    if (encoded.byteLength > MAX_JSON_RESPONSE_BYTES) {
      statusCode = 507
      encoded = Buffer.from(JSON.stringify({ error: 'Response exceeds the secure transport limit.' }), 'utf8')
    }
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', encoded.byteLength.toString())
    res.setHeader('Cache-Control', 'no-store')
    res.end(encoded)
  }

  private respondFile(
    res: ServerResponse<IncomingMessage>,
    statusCode: number,
    filePath: string,
    body: Buffer
  ): void {
    const extension = extname(filePath).toLowerCase()
    res.statusCode = statusCode
    res.setHeader(
      'Content-Type',
      REMOTE_STATIC_CONTENT_TYPES[extension] ?? 'application/octet-stream'
    )
    res.setHeader('Content-Length', body.length.toString())
    res.setHeader('Cache-Control', extension === '.html' ? 'no-store' : 'public, max-age=300')
    if (filePath.endsWith('/sw.js') || filePath === 'sw.js') {
      res.setHeader('Service-Worker-Allowed', '/remote/')
    }
    res.end(body)
  }

  private async readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      let tooLarge = false

      req.on('data', (chunk: Buffer | string) => {
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += normalized.length
        if (bytes > maxBytes) {
          tooLarge = true
          return
        }
        chunks.push(normalized)
      })

      req.on('end', () => {
        if (tooLarge) {
          resolve(null)
          return
        }
        resolve(Buffer.concat(chunks).toString('utf8'))
      })

      req.on('error', reject)
    })
  }

  private parsePairingClaimBody(payload: unknown): {
    ticket: string
    deviceName: string
    clientLabel: string
    requestedScopes: CompanionApiScope[]
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.ticket !== 'string' || !candidate.ticket.trim()) {
      return null
    }
    const clientLabel = normalizeDeviceLabel(candidate.clientLabel, 'Remote Controller')
    const fallbackName = clientLabel === 'Remote Controller' ? 'Remote Device' : clientLabel
    return {
      ticket: candidate.ticket.trim(),
      deviceName: normalizeDeviceLabel(candidate.deviceName, fallbackName),
      clientLabel,
      requestedScopes: normalizeRequestedCompanionScopes(candidate.requestedScopes)
    }
  }

  private parsePinPairingRequestBody(payload: unknown): {
    deviceName: string
    clientLabel: string
    phoneEphemeralPublicKey: string
    observedCertificateFingerprint: string
    requestedScopes: CompanionApiScope[]
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    const clientLabel = normalizeDeviceLabel(candidate.clientLabel, 'Remote Controller')
    const fallbackName = clientLabel === 'Remote Controller' ? 'Remote Device' : clientLabel
    const phoneEphemeralPublicKey = typeof candidate.phoneEphemeralPublicKey === 'string'
      ? candidate.phoneEphemeralPublicKey.trim()
      : ''
    const observedCertificateFingerprint = normalizePhoneRemoteFingerprint(
      typeof candidate.observedCertificateFingerprint === 'string'
        ? candidate.observedCertificateFingerprint
        : ''
    )
    if (
      phoneEphemeralPublicKey.length < 64
      || phoneEphemeralPublicKey.length > 256
      || observedCertificateFingerprint !== normalizePhoneRemoteFingerprint(this.requireTlsIdentity().fingerprint256)
    ) return null
    return {
      deviceName: normalizeDeviceLabel(candidate.deviceName, fallbackName),
      clientLabel,
      phoneEphemeralPublicKey,
      observedCertificateFingerprint,
      requestedScopes: normalizeRequestedCompanionScopes(candidate.requestedScopes)
    }
  }

  private parsePinPairingConfirmBody(payload: unknown): {
    requestId: string
    proof: string
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.requestId !== 'string' || !candidate.requestId.trim()) return null
    if (typeof candidate.proof !== 'string' || candidate.proof.length < 32 || candidate.proof.length > 128) return null
    return {
      requestId: candidate.requestId.trim(),
      proof: candidate.proof
    }
  }

  private getRequestBaseUrl(req: IncomingMessage): string {
    const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
    return host ? `https://${host}` : `https://127.0.0.1:${this.config.port}`
  }

  private async handlePairingClaim(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.active) {
      this.respondJson(res, 409, { error: 'Phone remote pairing is not available right now.' })
      return
    }

    const rawBody = await this.readRequestBody(req, CONTROL_MAX_BODY_BYTES).catch(() => null)
    if (rawBody === null) {
      this.respondJson(res, 413, { error: 'Request body too large.' })
      return
    }

    let parsedBody: unknown = null
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null
    } catch {
      this.respondJson(res, 400, { error: 'Invalid JSON payload.' })
      return
    }

    const claimBody = this.parsePairingClaimBody(parsedBody)
    if (!claimBody) {
      this.respondJson(res, 400, { error: 'Invalid pairing claim payload.' })
      return
    }

    const ticketState = this.pairingTickets.get(claimBody.ticket)
    if (!ticketState) {
      this.respondJson(res, 404, { error: 'Pairing ticket not found.' })
      return
    }
    if (ticketState.claimedAt !== null) {
      this.respondJson(res, 409, { error: 'Pairing ticket has already been used.' })
      return
    }
    if (ticketState.expiresAt <= Date.now()) {
      this.pairingTickets.delete(claimBody.ticket)
      this.respondJson(res, 410, { error: 'Pairing ticket has expired.' })
      return
    }

    ticketState.claimedAt = Date.now()
    const requestId = createOpaqueSecret(16)
    const pollToken = createOpaqueSecret(24)
    const request: PairingRequestState = {
      id: requestId,
      ticket: claimBody.ticket,
      pollToken,
      deviceName: claimBody.deviceName,
      clientLabel: claimBody.clientLabel,
      clientKind: ticketState.clientKind,
      requestedAt: Date.now(),
      expiresAt: Date.now() + PAIRING_REQUEST_TTL_MS,
      baseUrl: ticketState.baseUrl,
      pairingMode: 'approval',
      pin: null,
      failedPinAttempts: 0,
      state: 'pending',
      issuedDeviceId: null,
      issuedControlToken: null,
      issuedSyncToken: null,
      pairingKey: null,
      transcript: null,
      remoteAddress: req.socket.remoteAddress ?? '',
      requestedScopes: claimBody.requestedScopes
    }
    this.pairingRequestsById.set(request.id, request)
    this.pairingRequestIdByPollToken.set(request.pollToken, request.id)
    this.emitStatus()

    this.respondJson(res, 200, {
      requestId: request.id,
      pollToken: request.pollToken,
      expiresAt: request.expiresAt,
      deviceName: request.deviceName,
      clientLabel: request.clientLabel,
      identity: this.getIdentity()
    })
  }

  private async handlePinPairingRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.active) {
      this.respondJson(res, 409, { error: 'Phone remote pairing is not available right now.' })
      return
    }

    const remoteAddress = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
    const now = Date.now()
    if ((this.pinPairingLockoutUntil.get(remoteAddress) ?? 0) > now) {
      this.respondJson(res, 429, { error: 'Pairing is temporarily locked for this device.' })
      return
    }
    if (now - (this.pinPairingLastRequestAt.get(remoteAddress) ?? 0) < PIN_PAIRING_RATE_LIMIT_MS) {
      this.respondJson(res, 429, { error: 'Pairing requests are arriving too quickly.' })
      return
    }

    const rawBody = await this.readRequestBody(req, CONTROL_MAX_BODY_BYTES).catch(() => null)
    if (rawBody === null) {
      this.respondJson(res, 413, { error: 'Request body too large.' })
      return
    }

    let parsedBody: unknown = null
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null
    } catch {
      this.respondJson(res, 400, { error: 'Invalid JSON payload.' })
      return
    }

    const requestBody = this.parsePinPairingRequestBody(parsedBody)
    if (!requestBody) {
      this.respondJson(res, 400, { error: 'Invalid PIN pairing request payload.' })
      return
    }

    const hasPendingPinRequest = Array.from(this.pairingRequestsById.values())
      .some((request) => request.state === 'pending' && request.pairingMode === 'pin')
    if (hasPendingPinRequest) {
      this.respondJson(res, 409, { error: 'A PIN pairing request is already pending.' })
      return
    }

    const pairingId = createOpaqueSecret(16)
    const desktopEphemeral = createPhoneRemoteEphemeralKeyPair()
    const identity = this.getIdentity()
    const transcript: PhoneRemotePairingTranscript = {
      version: 3,
      pairingId,
      phoneEphemeralPublicKey: requestBody.phoneEphemeralPublicKey,
      desktopEphemeralPublicKey: desktopEphemeral.publicKey,
      desktopCertificateFingerprint: this.requireTlsIdentity().fingerprint256,
      desktopEndpointUuid: identity.endpointUuid ?? '',
      desktopPort: this.config.port
    }
    let pairingKey: Buffer
    try {
      pairingKey = derivePhoneRemotePairingKey(
        desktopEphemeral.privateKey,
        requestBody.phoneEphemeralPublicKey,
        transcript
      )
    } catch {
      this.respondJson(res, 400, { error: 'Invalid secure pairing key.' })
      return
    }
    const pin = derivePhoneRemotePairingCode(pairingKey, transcript)
    const request: PairingRequestState = {
      id: pairingId,
      ticket: null,
      pollToken: createOpaqueSecret(24),
      deviceName: requestBody.deviceName,
      clientLabel: requestBody.clientLabel,
      clientKind: 'native',
      requestedAt: now,
      expiresAt: now + PAIRING_REQUEST_TTL_MS,
      baseUrl: this.getRequestBaseUrl(req),
      pairingMode: 'pin',
      pin,
      failedPinAttempts: 0,
      state: 'pending',
      issuedDeviceId: null,
      issuedControlToken: null,
      issuedSyncToken: null,
      pairingKey,
      transcript,
      remoteAddress,
      requestedScopes: requestBody.requestedScopes
    }
    this.pinPairingLastRequestAt.set(remoteAddress, now)
    this.pairingRequestsById.set(request.id, request)
    this.pairingRequestIdByPollToken.set(request.pollToken, request.id)
    this.emitStatus()

    this.respondJson(res, 200, {
      requestId: request.id,
      pollToken: request.pollToken,
      expiresAt: request.expiresAt,
      deviceName: request.deviceName,
      clientLabel: request.clientLabel,
      identity,
      desktopEphemeralPublicKey: desktopEphemeral.publicKey,
      certificateFingerprint: this.requireTlsIdentity().fingerprint256,
      protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
    })
  }

  private async handlePinPairingConfirm(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.active) {
      this.respondJson(res, 409, { error: 'Phone remote pairing is not available right now.' })
      return
    }

    const rawBody = await this.readRequestBody(req, CONTROL_MAX_BODY_BYTES).catch(() => null)
    if (rawBody === null) {
      this.respondJson(res, 413, { error: 'Request body too large.' })
      return
    }

    let parsedBody: unknown = null
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null
    } catch {
      this.respondJson(res, 400, { error: 'Invalid JSON payload.' })
      return
    }

    const confirmBody = this.parsePinPairingConfirmBody(parsedBody)
    if (!confirmBody) {
      this.respondJson(res, 400, { error: 'Invalid PIN pairing confirm payload.' })
      return
    }

    const request = this.pairingRequestsById.get(confirmBody.requestId)
    if (!request || request.pairingMode !== 'pin') {
      this.respondJson(res, 404, { error: 'Pairing request not found.' })
      return
    }
    if (request.expiresAt <= Date.now()) {
      request.state = 'expired'
      this.emitStatus()
      this.respondJson(res, 410, { state: 'expired', error: 'Pairing request has expired.' })
      return
    }
    if (request.state === 'rejected') {
      this.respondJson(res, 403, { state: 'rejected', error: 'Pairing request was rejected.' })
      return
    }
    if (request.state !== 'pending' || !request.pin || !request.pairingKey || !request.transcript) {
      this.respondJson(res, 410, { state: request.state })
      return
    }
    if (!verifyPhoneRemotePairingProof(confirmBody.proof, request.pairingKey, request.transcript)) {
      request.failedPinAttempts += 1
      if (request.failedPinAttempts >= PIN_PAIRING_MAX_FAILURES) {
        request.state = 'rejected'
        this.pinPairingLockoutUntil.set(request.remoteAddress, Date.now() + PIN_PAIRING_LOCKOUT_MS)
        this.emitStatus()
        this.respondJson(res, 403, { state: 'rejected', error: 'PIN attempts exceeded.' })
        return
      }
      this.respondJson(res, 401, { state: 'pending', error: 'Incorrect PIN.' })
      return
    }

    const credentials = this.issuePairingDeviceTokens(request)
    const sealed = sealPhoneRemotePairingPayload({
      controlToken: credentials.controlToken,
      syncToken: credentials.syncToken,
      deviceId: credentials.deviceId,
      issuedAt: credentials.issuedAt,
      identity: this.getIdentity(),
      certificateFingerprint: this.requireTlsIdentity().fingerprint256
    }, request.pairingKey, request.transcript)
    const responseBody = {
      state: 'approved' as const,
      expiresAt: request.expiresAt,
      sealed,
      identity: this.getIdentity(),
      certificateFingerprint: this.requireTlsIdentity().fingerprint256
    }
    request.state = 'consumed'
    request.issuedControlToken = null
    request.issuedSyncToken = null
    request.pin = null
    request.pairingKey = null
    request.transcript = null
    this.pairingRequestIdByPollToken.delete(request.pollToken)
    this.emitStatus()
    this.respondJson(res, 200, responseBody)
  }

  private handlePairingStatus(
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): void {
    this.cleanupExpiredPairingState(true)
    const pollToken = toSafeOptionalString(requestUrl.searchParams.get('pollToken'))
    if (!pollToken) {
      this.respondJson(res, 400, { error: 'Missing poll token.' })
      return
    }

    const requestId = this.pairingRequestIdByPollToken.get(pollToken)
    if (!requestId) {
      this.respondJson(res, 404, { error: 'Pairing request not found.' })
      return
    }

    const request = this.pairingRequestsById.get(requestId)
    if (!request) {
      this.pairingRequestIdByPollToken.delete(pollToken)
      this.respondJson(res, 404, { error: 'Pairing request not found.' })
      return
    }

    if (request.state === 'approved' && request.issuedControlToken) {
      const device = this.pairedDevices.find((candidate) => candidate.id === request.issuedDeviceId)
      const responseBody = {
        state: 'approved' as const,
        expiresAt: request.expiresAt,
        token: request.issuedControlToken,
        controlToken: request.issuedControlToken,
        syncToken: request.issuedSyncToken,
        deviceId: request.issuedDeviceId,
        issuedAt: device?.credentialIssuedAt ?? Date.now(),
        identity: this.getIdentity(),
        certificateFingerprint: this.requireTlsIdentity().fingerprint256,
        scopes: device?.scopes ?? ['control']
      }
      request.state = 'consumed'
      request.issuedControlToken = null
      request.issuedSyncToken = null
      this.respondJson(res, 200, responseBody)
      return
    }

    if (request.state === 'consumed') {
      this.respondJson(res, 410, { state: 'consumed' })
      return
    }

    this.respondJson(res, 200, {
      state: request.state,
      expiresAt: request.expiresAt
    })
  }

  private handleSession(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const authorization = this.authorizeRequest(req, 'control')
    if (!authorization) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const device = this.pairedDevices.find((candidate) => candidate.id === authorization.deviceId)
    if (!device) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    this.respondJson(res, 200, {
      deviceId: device.id,
      scopes: device.scopes,
      issuedAt: device.credentialIssuedAt,
      rotatedAt: device.credentialRotatedAt,
      rotateAfter: device.credentialRotatedAt + PHONE_REMOTE_TOKEN_ROTATE_AFTER_MS,
      rotateRequiredAt: device.credentialRotatedAt + PHONE_REMOTE_TOKEN_ROTATE_REQUIRED_MS,
      expiresAt: this.deviceExpiresAt(device),
      rotationRequired: authorization.rotationRequired,
      usingPreviousCredential: authorization.usingPreviousCredential
    })
  }

  private handleSessionRotate(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const authorization = this.authorizeRequest(req, 'control', true)
    if (!authorization) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const device = this.pairedDevices.find((candidate) => candidate.id === authorization.deviceId)
    if (!device) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const now = Date.now()
    const controlToken = createOpaqueSecret(32)
    const syncToken = device.scopes.includes('sync') ? createOpaqueSecret(32) : null
    if (!authorization.usingPreviousCredential) {
      device.previousControlTokenHash = device.controlTokenHash
      device.previousSyncTokenHash = device.syncTokenHash
    }
    device.previousTokensValidUntil = now + PHONE_REMOTE_PREVIOUS_TOKEN_GRACE_MS
    device.controlTokenHash = hashToken(controlToken)
    device.syncTokenHash = syncToken ? hashToken(syncToken) : null
    device.tokenPrefix = controlToken.slice(0, TOKEN_PREFIX_LENGTH)
    device.syncTokenPrefix = syncToken?.slice(0, TOKEN_PREFIX_LENGTH) ?? null
    device.credentialIssuedAt = now
    device.credentialRotatedAt = now
    this.emitPairedDevicesChange()
    this.respondJson(res, 200, {
      controlToken,
      syncToken,
      issuedAt: now,
      previousValidUntil: device.previousTokensValidUntil,
      rotateAfter: now + PHONE_REMOTE_TOKEN_ROTATE_AFTER_MS
    })
  }

  private async readRemoteAsset(relativePath: string): Promise<{ filePath: string; bytes: Buffer } | null> {
    for (const rootPath of REMOTE_STATIC_ROOT_CANDIDATES) {
      const resolvedPath = join(rootPath, relativePath)
      try {
        const bytes = await readFile(resolvedPath)
        if (bytes.byteLength > MAX_REMOTE_ASSET_BYTES) return null
        return { filePath: relativePath, bytes }
      } catch {
        // Try the next candidate root.
      }
    }

    return null
  }

  private async handleRemoteAsset(
    res: ServerResponse<IncomingMessage>,
    requestPath: string
  ): Promise<boolean> {
    if (!this.config.enabled) return false

    const assetPath = getRemoteAssetPathname(requestPath === '/remote' ? '/remote/' : requestPath)
    if (assetPath === null) return false

    const asset = await this.readRemoteAsset(assetPath)
    if (!asset) {
      this.respondJson(res, 503, { error: 'Remote controller assets are unavailable.' })
      return true
    }

    this.respondFile(res, 200, asset.filePath, asset.bytes)
    return true
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    const method = req.method ?? 'GET'
    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      this.respondJson(res, 400, { error: 'Invalid request URL.' })
      return
    }
    const path = requestUrl.pathname

    if (this.companionApi && await this.companionApi.handleRequest(req, res, requestUrl)) {
      return
    }

    if (method === 'GET' && path.startsWith('/remote')) {
      const handled = await this.handleRemoteAsset(res, path)
      if (handled) return
    }

    if (method === 'GET' && path === '/v1/identity') {
      // syncRequestedAt lets the phone's periodic foreground probe pick up a
      // desktop-initiated sync without holding a connection open.
      this.respondJson(res, 200, {
        ...this.getIdentity(),
        certificateFingerprint: this.requireTlsIdentity().fingerprint256,
        syncRequestedAt: this.config.syncEnabled ? this.syncRequestedAt : null
      })
      return
    }

    if (method === 'POST' && path === '/v1/pairing/claim') {
      await this.handlePairingClaim(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/pairing/pin-request') {
      await this.handlePinPairingRequest(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/pairing/pin-confirm') {
      await this.handlePinPairingConfirm(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/pairing/status') {
      this.handlePairingStatus(res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/session') {
      this.handleSession(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/session/rotate') {
      this.handleSessionRotate(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/now-playing') {
      this.core.handleNowPlaying(req, res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/events') {
      this.core.handleSse(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/artwork/current') {
      this.core.handleArtwork(req, res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/queue') {
      this.core.handleQueue(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/control') {
      await this.core.handleControl(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/sync/state') {
      this.handleSyncState(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/sync/apply') {
      await this.handleSyncApply(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/sync/conflicts') {
      await this.handleSyncConflictsReport(req, res)
      return
    }

    this.respondJson(res, 404, { error: 'Not found' })
  }

  private handleSyncState(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    if (!this.authorizeRequest(req, 'sync')) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (!this.getSyncState) {
      this.respondJson(res, 501, { error: 'Library sync is not available on this desktop.' })
      return
    }
    if (!this.config.syncEnabled) {
      this.respondJson(res, 403, { error: 'Library sync is disabled on this desktop.' })
      return
    }
    try {
      const state: PhoneSyncState = {
        ...this.getSyncState(),
        pendingResolutions: [...this.syncPendingResolutions.values()]
      }
      // Serving state means the phone is syncing — the request is being handled.
      if (this.syncRequestedAt !== null) {
        this.syncRequestedAt = null
        this.emitStatus()
      }
      this.respondJson(res, 200, state)
    } catch (error) {
      console.error('Failed to build phone sync state:', error)
      this.respondJson(res, 500, { error: 'Failed to build sync state.' })
    }
  }

  private async handleSyncConflictsReport(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    if (!this.authorizeRequest(req, 'sync')) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (!this.config.syncEnabled) {
      this.respondJson(res, 403, { error: 'Library sync is disabled on this desktop.' })
      return
    }

    const rawBody = await this.readRequestBody(req, SYNC_MAX_BODY_BYTES).catch(() => null)
    if (rawBody === null) {
      this.respondJson(res, 413, { error: 'Request body too large.' })
      return
    }
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(rawBody || '{}')
    } catch {
      this.respondJson(res, 400, { error: 'Invalid JSON payload.' })
      return
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Number((parsedBody as Record<string, unknown>).syncFormat) !== PHONE_SYNC_FORMAT) {
      this.respondJson(res, 400, { error: 'Invalid sync payload.' })
      return
    }
    const body = parsedBody as Record<string, unknown>

    this.syncConflicts = sanitizeReportedConflicts(body.conflicts)
    const consumed = Array.isArray(body.consumedResolutions)
      ? body.consumedResolutions.filter((uid): uid is string => typeof uid === 'string')
      : []
    for (const uid of consumed) {
      this.syncPendingResolutions.delete(uid)
    }
    // Resolutions for conflicts the phone no longer reports are moot (the
    // user resolved them on the phone directly).
    const liveUids = new Set(this.syncConflicts.map((conflict) => conflict.syncUid))
    for (const uid of [...this.syncPendingResolutions.keys()]) {
      if (!liveUids.has(uid)) this.syncPendingResolutions.delete(uid)
    }
    this.syncLastSyncedAt = Date.now()
    this.emitStatus()
    this.respondJson(res, 200, { ok: true })
  }

  private async handleSyncApply(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    if (!this.authorizeRequest(req, 'sync')) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    if (!this.applySyncChanges) {
      this.respondJson(res, 501, { error: 'Library sync is not available on this desktop.' })
      return
    }
    if (!this.config.syncEnabled) {
      this.respondJson(res, 403, { error: 'Library sync is disabled on this desktop.' })
      return
    }
    if (this.syncApplyInFlight) {
      this.respondJson(res, 409, { error: 'Another sync apply is already in progress.' })
      return
    }

    const rawBody = await this.readRequestBody(req, SYNC_MAX_BODY_BYTES).catch(() => null)
    if (rawBody === null) {
      this.respondJson(res, 413, { error: 'Request body too large.' })
      return
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(rawBody || '{}')
    } catch {
      this.respondJson(res, 400, { error: 'Invalid JSON payload.' })
      return
    }

    this.syncApplyInFlight = true
    try {
      const result = this.applySyncChanges(parsedBody)
      if (!result) {
        this.respondJson(res, 400, { error: 'Invalid sync payload.' })
        return
      }
      this.respondJson(res, 200, result)
    } catch (error) {
      console.error('Failed to apply phone sync changes:', error)
      this.respondJson(res, 500, { error: 'Failed to apply sync changes.' })
    } finally {
      this.syncApplyInFlight = false
    }
  }
}
