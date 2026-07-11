import { readFile } from 'fs/promises'
import { randomInt } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { extname, join, normalize } from 'path'
import { fileURLToPath } from 'url'
import type { MiniPlayerCommand, MiniPlayerQueueSnapshot, MiniPlayerSnapshot } from '../../types/miniPlayer'
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

const TOKEN_PREFIX_LENGTH = 8
// Sync payloads carry whole favorites/playlists sets — far larger than control
// bodies (CONTROL_MAX_BODY_BYTES is 1 KB).
const SYNC_MAX_BODY_BYTES = 8 * 1024 * 1024
const PAIRING_TICKET_TTL_MS = 2 * 60_000
const PAIRING_REQUEST_TTL_MS = 2 * 60_000
const PIN_PAIRING_MAX_FAILURES = 3
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
  tokenHash: string
}

interface PairingTicketState {
  ticket: string
  baseUrl: string
  createdAt: number
  expiresAt: number
  claimedAt: number | null
}

interface PairingRequestState {
  id: string
  ticket: string | null
  pollToken: string
  deviceName: string
  clientLabel: string
  requestedAt: number
  expiresAt: number
  baseUrl: string
  pairingMode: PhoneRemotePairingMode
  pin: string | null
  failedPinAttempts: number
  state: PhoneRemotePairingState
  issuedDeviceId: string | null
  issuedToken: string | null
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
}

type PhoneRemoteAuthorizationContext = { kind: 'device'; deviceId: string }

function getPhoneRemoteLanUrls(port: number): string[] {
  const urls = new Set<string>()
  const interfaces = networkInterfaces()

  for (const addresses of Object.values(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.internal) continue
      if (addressInfo.family !== 'IPv4') continue
      const address = addressInfo.address.trim()
      if (!address) continue
      urls.add(`http://${address}:${port}`)
    }
  }

  const allUrls = Array.from(urls).sort((left, right) => left.localeCompare(right))
  const preferred192Urls = allUrls.filter((url) => /^http:\/\/192\.168\./.test(url))
  return preferred192Urls.length > 0 ? preferred192Urls : allUrls
}

function createPairingPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

const SYNC_CONFLICT_REPORT_MAX_ITEMS = 200

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

  constructor(options: PhoneRemoteServiceOptions) {
    this.config = { ...options.config }
    this.onPairedDevicesChange = options.onPairedDevicesChange
    this.onStatusChange = options.onStatusChange
    this.getSyncState = options.getSyncState
    this.applySyncChanges = options.applySyncChanges
    this.pairedDevices = [...(options.pairedDevices ?? [])]
    this.core = new PlaybackHttpCore({
      getSnapshot: options.getSnapshot,
      dispatchCommand: options.dispatchCommand,
      resolveArtworkDataUrl: options.resolveArtworkDataUrl,
      authorizeRequest: (req) => this.authorizeRequest(req),
      buildArtworkUrl: (trackId) => `/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`,
      getControlsEnabled: () => this.config.controlsEnabled,
      onConnectedClientsChange: () => this.emitStatus()
    })
    this.getIdentitySnapshot = () => this.normalizeIdentity(options.getIdentity?.())
  }

  getIdentity(): PhoneRemoteIdentity {
    return this.getIdentitySnapshot()
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
      connectedClients: this.core.getConnectedClientCount(),
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

  createPairingTicket(baseUrl?: string): PhoneRemotePairingTicket {
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
    const samePortExplicitUrl = selectedUrl.protocol === 'http:' && selectedUrl.port === String(this.config.port)
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
      claimedAt: null
    })
    this.emitStatus()
    return {
      ticket,
      baseUrl: selectedBaseUrl,
      controllerUrl: `${selectedBaseUrl}/remote/`,
      pairingUrl: `${selectedBaseUrl}/remote/#pair=${encodeURIComponent(ticket)}`,
      createdAt,
      expiresAt,
      identity: this.getIdentity()
    }
  }

  approvePairingRequest(id: string): PhoneRemotePendingPairingRequest | null {
    this.cleanupExpiredPairingState(true)
    const request = this.pairingRequestsById.get(id)
    if (!request || request.state !== 'pending') return null

    this.issuePairingDeviceToken(request)
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
    this.emitPairedDevicesChange()
    this.emitStatus()
    return {
      id: device.id,
      name: device.name,
      clientLabel: device.clientLabel,
      tokenPrefix: device.tokenPrefix,
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
  }

  publishQueueSnapshot(snapshot: MiniPlayerQueueSnapshot | null): void {
    this.core.publishQueueSnapshot(snapshot)
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

  private issuePairingDeviceToken(request: PairingRequestState): { token: string; deviceId: string } {
    const now = Date.now()
    const rawToken = createOpaqueSecret(32)
    const deviceId = createOpaqueSecret(16)
    const device: PersistedPairedDevice = {
      id: deviceId,
      name: request.deviceName,
      clientLabel: request.clientLabel,
      tokenHash: hashToken(rawToken),
      tokenPrefix: rawToken.slice(0, TOKEN_PREFIX_LENGTH),
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null
    }
    this.pairedDevices = [device, ...this.pairedDevices]
    request.state = 'approved'
    request.issuedDeviceId = deviceId
    request.issuedToken = rawToken
    this.emitPairedDevicesChange()
    this.emitStatus()
    return { token: rawToken, deviceId }
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
      pin: request.pairingMode === 'pin' ? request.pin : null
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

  private authorizeRequest(req: IncomingMessage): PhoneRemoteAuthorizationContext | null {
    const suppliedToken = hasBearerToken(req)
    if (!suppliedToken) return null
    const suppliedHash = hashToken(suppliedToken)
    for (const device of this.pairedDevices) {
      if (device.revokedAt !== null) continue
      if (!secureTokenEquals(suppliedHash, device.tokenHash)) continue
      this.touchPairedDevice(device.id)
      return { kind: 'device', deviceId: device.id }
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
    this.emitPairedDevicesChange()
  }

  private async startServer(): Promise<void> {
    await this.stopServer()

    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

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
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
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
      clientLabel
    }
  }

  private parsePinPairingRequestBody(payload: unknown): {
    deviceName: string
    clientLabel: string
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    const clientLabel = normalizeDeviceLabel(candidate.clientLabel, 'Remote Controller')
    const fallbackName = clientLabel === 'Remote Controller' ? 'Remote Device' : clientLabel
    return {
      deviceName: normalizeDeviceLabel(candidate.deviceName, fallbackName),
      clientLabel
    }
  }

  private parsePinPairingConfirmBody(payload: unknown): {
    requestId: string
    pin: string
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    if (typeof candidate.requestId !== 'string' || !candidate.requestId.trim()) return null
    if (typeof candidate.pin !== 'string') return null
    const pin = candidate.pin.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(pin)) return null
    return {
      requestId: candidate.requestId.trim(),
      pin
    }
  }

  private getRequestBaseUrl(req: IncomingMessage): string {
    const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
    return host ? `http://${host}` : `http://127.0.0.1:${this.config.port}`
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
      requestedAt: Date.now(),
      expiresAt: Date.now() + PAIRING_REQUEST_TTL_MS,
      baseUrl: ticketState.baseUrl,
      pairingMode: 'approval',
      pin: null,
      failedPinAttempts: 0,
      state: 'pending',
      issuedDeviceId: null,
      issuedToken: null
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

    const now = Date.now()
    const request: PairingRequestState = {
      id: createOpaqueSecret(16),
      ticket: null,
      pollToken: createOpaqueSecret(24),
      deviceName: requestBody.deviceName,
      clientLabel: requestBody.clientLabel,
      requestedAt: now,
      expiresAt: now + PAIRING_REQUEST_TTL_MS,
      baseUrl: this.getRequestBaseUrl(req),
      pairingMode: 'pin',
      pin: createPairingPin(),
      failedPinAttempts: 0,
      state: 'pending',
      issuedDeviceId: null,
      issuedToken: null
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
    if (request.state !== 'pending' || !request.pin) {
      this.respondJson(res, 410, { state: request.state })
      return
    }
    if (request.pin !== confirmBody.pin) {
      request.failedPinAttempts += 1
      if (request.failedPinAttempts >= PIN_PAIRING_MAX_FAILURES) {
        request.state = 'rejected'
        this.emitStatus()
        this.respondJson(res, 403, { state: 'rejected', error: 'PIN attempts exceeded.' })
        return
      }
      this.respondJson(res, 401, { state: 'pending', error: 'Incorrect PIN.' })
      return
    }

    const { token, deviceId } = this.issuePairingDeviceToken(request)
    const responseBody = {
      state: 'approved' as const,
      expiresAt: request.expiresAt,
      token,
      deviceId,
      identity: this.getIdentity()
    }
    request.state = 'consumed'
    request.issuedToken = null
    request.pin = null
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

    if (request.state === 'approved' && request.issuedToken) {
      const responseBody = {
        state: 'approved' as const,
        expiresAt: request.expiresAt,
        token: request.issuedToken,
        deviceId: request.issuedDeviceId,
        identity: this.getIdentity()
      }
      request.state = 'consumed'
      request.issuedToken = null
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

  private async readRemoteAsset(relativePath: string): Promise<{ filePath: string; bytes: Buffer } | null> {
    for (const rootPath of REMOTE_STATIC_ROOT_CANDIDATES) {
      const resolvedPath = join(rootPath, relativePath)
      try {
        const bytes = await readFile(resolvedPath)
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

    if (requestPath === '/remote') {
      res.statusCode = 302
      res.setHeader('Location', '/remote/')
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return true
    }

    const assetPath = getRemoteAssetPathname(requestPath)
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

    if (method === 'GET' && path.startsWith('/remote')) {
      const handled = await this.handleRemoteAsset(res, path)
      if (handled) return
    }

    if (method === 'GET' && path === '/v1/identity') {
      // syncRequestedAt lets the phone's periodic foreground probe pick up a
      // desktop-initiated sync without holding a connection open.
      this.respondJson(res, 200, {
        ...this.getIdentity(),
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
    if (!this.authorizeRequest(req)) {
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
    if (!this.authorizeRequest(req)) {
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
    if (!this.authorizeRequest(req)) {
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
