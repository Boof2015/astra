import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { readFile } from 'fs/promises'
import { networkInterfaces } from 'os'
import { extname, join, normalize } from 'path'
import { fileURLToPath } from 'url'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  LOCAL_API_LAN_HOST,
  LOCAL_API_LOOPBACK_HOST,
  type LocalApiControlCommand,
  type LocalApiNowPlayingSnapshot,
  type LocalApiPairingState,
  type LocalApiPairedDevice,
  type LocalApiPairingTicket,
  type LocalApiPendingPairingRequest,
  type LocalApiServiceConfig,
  type LocalApiStatus
} from '../../types/localApi'

const AUTH_PREFIX = 'Bearer '
const MAX_SSE_CLIENTS = 8
const SSE_HEARTBEAT_INTERVAL_MS = 20_000
const CONTROL_RATE_LIMIT_WINDOW_MS = 60_000
const CONTROL_RATE_LIMIT_MAX_REQUESTS = 120
const CONTROL_MAX_BODY_BYTES = 1_024
const ARTWORK_MAX_BYTES = 8 * 1024 * 1024
const TOKEN_PREFIX_LENGTH = 8
const PAIRING_TICKET_TTL_MS = 2 * 60_000
const PAIRING_REQUEST_TTL_MS = 2 * 60_000
const PAIRED_DEVICE_LAST_SEEN_PERSIST_INTERVAL_MS = 60_000
const LOCAL_API_MODULE_DIR = typeof __dirname === 'string'
  ? __dirname
  : fileURLToPath(new URL('.', import.meta.url))
const REMOTE_STATIC_ROOT_CANDIDATES = [
  join(process.cwd(), 'src/renderer/public/remote'),
  join(process.cwd(), 'out/renderer/remote'),
  join(LOCAL_API_MODULE_DIR, '../../renderer/remote'),
  join(LOCAL_API_MODULE_DIR, '../renderer/remote')
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

interface LocalApiServiceOptions {
  config: LocalApiServiceConfig
  getSnapshot: () => MiniPlayerSnapshot | null
  dispatchCommand: (command: MiniPlayerCommand) => void
  resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  pairedDevices?: PersistedPairedDevice[]
  onPairedDevicesChange?: (devices: PersistedPairedDevice[]) => void
  onStatusChange?: (status: LocalApiStatus) => void
}

type LocalApiControlBody =
  | { command: Exclude<LocalApiControlCommand, 'seek'> }
  | { command: 'seek'; time: number }

interface ControlRateLimitState {
  count: number
  windowStartedAt: number
}

interface ParsedArtworkData {
  mimeType: string
  bytes: Buffer
}

interface LocalApiArtworkState {
  currentTrackId: string | null
  dataUrl: string | null
  mimeType: string | null
  bytes: Buffer | null
}

interface PersistedPairedDevice extends LocalApiPairedDevice {
  tokenHash: string
}

interface LocalApiSseClient {
  response: ServerResponse<IncomingMessage>
  authorization: LocalApiAuthorizationContext
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
  ticket: string
  pollToken: string
  deviceName: string
  clientLabel: string
  requestedAt: number
  expiresAt: number
  baseUrl: string
  state: LocalApiPairingState
  issuedDeviceId: string | null
  issuedToken: string | null
}

type LocalApiAuthorizationContext =
  | { kind: 'primary' }
  | { kind: 'device'; deviceId: string }

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function toSafeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function parseArtworkDataUrl(artworkData: string | null | undefined): ParsedArtworkData | null {
  if (typeof artworkData !== 'string') return null
  const normalized = artworkData.trim()
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    normalized
  )
  if (!match) return null

  const mimeType = match[1].toLowerCase()
  const base64Payload = match[2].replace(/\s+/g, '')

  if (base64Payload.length === 0 || base64Payload.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) return null

  const bytes = Buffer.from(base64Payload, 'base64')
  if (bytes.length === 0 || bytes.length > ARTWORK_MAX_BYTES) return null
  if (bytes.toString('base64') !== base64Payload) return null

  return { mimeType, bytes }
}

function sanitizeSnapshot(
  snapshot: MiniPlayerSnapshot | null,
  artworkUrl: string | null,
  artworkDataUrl: string | null
): LocalApiNowPlayingSnapshot {
  const updatedAt = Date.now()

  if (!snapshot) {
    return {
      playbackState: 'stopped',
      currentTime: 0,
      duration: 0,
      queueLength: 0,
      outputDeviceLabel: null,
      visualizerLineColor: '#38bdf8',
      currentTrack: null,
      updatedAt
    }
  }

  return {
    playbackState: snapshot.playbackState,
    currentTime: toSafeNumber(snapshot.currentTime),
    duration: toSafeNumber(snapshot.duration),
    queueLength: Math.max(0, Math.floor(toSafeNumber(snapshot.queueLength))),
    outputDeviceLabel: toSafeOptionalString(snapshot.outputDeviceLabel),
    visualizerLineColor: toSafeOptionalString(snapshot.visualizerLineColor) ?? '#38bdf8',
    currentTrack: snapshot.currentTrack
      ? {
          id: String(snapshot.currentTrack.id),
          title: String(snapshot.currentTrack.title),
          artist: String(snapshot.currentTrack.artist),
          album: String(snapshot.currentTrack.album),
          isFavorite: Boolean(snapshot.currentTrack.isFavorite),
          artworkUrl,
          artworkDataUrl
        }
      : null,
    updatedAt
  }
}

function secureTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function createOpaqueSecret(byteLength: number = 24): string {
  return randomBytes(byteLength).toString('base64url')
}

function normalizeDeviceLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return fallback
  return normalized.slice(0, 80)
}

function mapControlCommand(command: LocalApiControlBody): MiniPlayerCommand {
  switch (command.command) {
    case 'play':
      return { type: 'play' }
    case 'pause':
      return { type: 'pause' }
    case 'next':
      return { type: 'playNext' }
    case 'previous':
      return { type: 'playPrevious' }
    case 'toggle-favorite':
      return { type: 'toggleFavoriteCurrent' }
    case 'seek':
      return { type: 'seek', time: command.time }
  }
}

function toLocalApiMode(config: LocalApiServiceConfig): LocalApiStatus['mode'] {
  if (!config.enabled) return 'off'
  return config.controlsEnabled ? 'api-control' : 'api'
}

function getLocalApiBindHost(config: Pick<LocalApiServiceConfig, 'remoteWebEnabled'>): string {
  return config.remoteWebEnabled ? LOCAL_API_LAN_HOST : LOCAL_API_LOOPBACK_HOST
}

function getLocalApiLanUrls(port: number): string[] {
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

export function generateLocalApiToken(): string {
  return randomBytes(24).toString('hex')
}

export class LocalApiService {
  private config: LocalApiServiceConfig
  private readonly dispatchCommand: (command: MiniPlayerCommand) => void
  private readonly resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  private readonly onPairedDevicesChange?: (devices: PersistedPairedDevice[]) => void
  private readonly onStatusChange?: (status: LocalApiStatus) => void

  private server: Server | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly sseClients = new Set<LocalApiSseClient>()
  private controlRateLimit: ControlRateLimitState = {
    count: 0,
    windowStartedAt: Date.now()
  }
  private pairedDevices: PersistedPairedDevice[]
  private readonly pairingTickets = new Map<string, PairingTicketState>()
  private readonly pairingRequestsById = new Map<string, PairingRequestState>()
  private readonly pairingRequestIdByPollToken = new Map<string, string>()

  private active = false
  private lastError: string | null = null
  private latestRawSnapshot: MiniPlayerSnapshot | null
  private latestArtwork: LocalApiArtworkState = {
    currentTrackId: null,
    dataUrl: null,
    mimeType: null,
    bytes: null
  }
  private latestSnapshot: LocalApiNowPlayingSnapshot
  private artworkResolveSequence = 0
  private artworkResolvingTrackId: string | null = null

  constructor(options: LocalApiServiceOptions) {
    this.config = { ...options.config }
    this.dispatchCommand = options.dispatchCommand
    this.resolveArtworkDataUrl = options.resolveArtworkDataUrl
    this.onPairedDevicesChange = options.onPairedDevicesChange
    this.onStatusChange = options.onStatusChange
    this.pairedDevices = [...(options.pairedDevices ?? [])]
    this.latestRawSnapshot = options.getSnapshot()
    this.latestSnapshot = sanitizeSnapshot(this.latestRawSnapshot, null, null)
    this.refreshLatestSnapshot(this.latestRawSnapshot)
  }

  getStatus(): LocalApiStatus {
    this.cleanupExpiredPairingState(false)
    const bindHost = getLocalApiBindHost(this.config)
    const lanUrls = this.active && this.config.remoteWebEnabled
      ? getLocalApiLanUrls(this.config.port)
      : []
    return {
      enabled: this.config.enabled,
      controlsEnabled: this.config.controlsEnabled,
      remoteWebEnabled: this.config.remoteWebEnabled,
      bindHost,
      port: this.config.port,
      baseUrl: `http://${LOCAL_API_LOOPBACK_HOST}:${this.config.port}`,
      lanUrls,
      controllerUrl: lanUrls[0] ? `${lanUrls[0]}/remote/` : null,
      token: this.config.token,
      active: this.active,
      mode: toLocalApiMode(this.config),
      connectedClients: this.sseClients.size,
      pairedDeviceCount: this.pairedDevices.filter((device) => device.revokedAt === null).length,
      pendingPairingCount: this.getPendingPairingRequestsSnapshot().length,
      lastError: this.lastError
    }
  }

  listPairedDevices(): LocalApiPairedDevice[] {
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

  listPendingPairingRequests(): LocalApiPendingPairingRequest[] {
    this.cleanupExpiredPairingState(false)
    return this.getPendingPairingRequestsSnapshot()
  }

  createPairingTicket(baseUrl?: string): LocalApiPairingTicket {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.active || !this.config.remoteWebEnabled) {
      throw new Error('Remote pairing is only available while the remote web controller is active.')
    }

    const lanUrls = getLocalApiLanUrls(this.config.port)
    const normalizedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
    if (lanUrls.length === 0 && !normalizedBaseUrl) {
      throw new Error('No non-internal IPv4 LAN address is available for remote pairing.')
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
      expiresAt
    }
  }

  approvePairingRequest(id: string): LocalApiPendingPairingRequest | null {
    this.cleanupExpiredPairingState(true)
    const request = this.pairingRequestsById.get(id)
    if (!request || request.state !== 'pending') return null

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
    return this.toPendingPairingRequest(request)
  }

  rejectPairingRequest(id: string): LocalApiPendingPairingRequest | null {
    this.cleanupExpiredPairingState(true)
    const request = this.pairingRequestsById.get(id)
    if (!request || request.state !== 'pending') return null
    request.state = 'rejected'
    this.emitStatus()
    return this.toPendingPairingRequest(request)
  }

  revokePairedDevice(id: string): LocalApiPairedDevice | null {
    const device = this.pairedDevices.find((candidate) => candidate.id === id)
    if (!device || device.revokedAt !== null) return null
    device.revokedAt = Date.now()
    this.closeSseClients((client) => client.authorization.kind === 'device' && client.authorization.deviceId === id)
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
    this.closeSseClients((client) => client.authorization.kind === 'device')
    this.emitPairedDevicesChange()
    this.emitStatus()
    return revokedCount
  }

  async applyConfig(config: LocalApiServiceConfig): Promise<LocalApiStatus> {
    const previous = this.config
    const tokenChanged = previous.token !== config.token
    const restartNeeded =
      previous.port !== config.port
      || previous.enabled !== config.enabled
      || previous.remoteWebEnabled !== config.remoteWebEnabled

    this.config = { ...config }
    this.refreshLatestSnapshot(this.latestRawSnapshot)

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

    if (tokenChanged) {
      this.closeSseClients((client) => client.authorization.kind === 'primary')
      this.emitStatus()
    }

    return this.getStatus()
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.refreshLatestSnapshot(snapshot)
    if (!this.active) return
    this.broadcastSseEvent('now-playing', this.latestSnapshot)
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private getPendingPairingRequestsSnapshot(): LocalApiPendingPairingRequest[] {
    return Array.from(this.pairingRequestsById.values())
      .filter((request) => request.state === 'pending')
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .map((request) => this.toPendingPairingRequest(request))
  }

  private toPendingPairingRequest(request: PairingRequestState): LocalApiPendingPairingRequest {
    return {
      id: request.id,
      deviceName: request.deviceName,
      clientLabel: request.clientLabel,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      baseUrl: request.baseUrl
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private emitPairedDevicesChange(): void {
    this.onPairedDevicesChange?.(this.pairedDevices.map((device) => ({ ...device })))
  }

  private buildArtworkUrl(trackId: string): string {
    const baseUrl = `http://${LOCAL_API_LOOPBACK_HOST}:${this.config.port}`
    return `${baseUrl}/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`
  }

  private buildSnapshot(includeInlineArtwork: boolean): LocalApiNowPlayingSnapshot {
    const trackId = this.latestArtwork.currentTrackId
    return sanitizeSnapshot(
      this.latestRawSnapshot,
      trackId && this.latestArtwork.bytes ? this.buildArtworkUrl(trackId) : null,
      includeInlineArtwork ? this.latestArtwork.dataUrl : null
    )
  }

  private async resolveArtworkForTrack(trackId: string, artworkHash: string, sequence: number): Promise<void> {
    if (!this.resolveArtworkDataUrl) return

    const artworkDataUrl = await this.resolveArtworkDataUrl(artworkHash).catch(() => null)
    if (!artworkDataUrl) {
      if (this.artworkResolvingTrackId === trackId) this.artworkResolvingTrackId = null
      return
    }

    if (sequence !== this.artworkResolveSequence) return
    if (this.latestRawSnapshot?.currentTrack?.id !== trackId) {
      if (this.artworkResolvingTrackId === trackId) this.artworkResolvingTrackId = null
      return
    }

    const parsedArtwork = parseArtworkDataUrl(artworkDataUrl)
    if (!parsedArtwork) {
      if (this.artworkResolvingTrackId === trackId) this.artworkResolvingTrackId = null
      return
    }

    this.artworkResolvingTrackId = null
    this.latestArtwork = {
      currentTrackId: trackId,
      dataUrl: artworkDataUrl,
      mimeType: parsedArtwork.mimeType,
      bytes: parsedArtwork.bytes
    }
    this.latestSnapshot = this.buildSnapshot(false)
    if (this.active) {
      this.broadcastSseEvent('now-playing', this.buildSnapshot(true))
    }
  }

  private refreshLatestSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.latestRawSnapshot = snapshot
    const currentTrack = snapshot?.currentTrack
    if (!currentTrack) {
      this.artworkResolveSequence += 1
      this.artworkResolvingTrackId = null
      this.latestArtwork = {
        currentTrackId: null,
        dataUrl: null,
        mimeType: null,
        bytes: null
      }
      this.latestSnapshot = this.buildSnapshot(false)
      return
    }

    const trackId = String(currentTrack.id)
    const inlineArtworkDataUrl = toSafeOptionalString(currentTrack.artworkData)
    const parsedArtwork = parseArtworkDataUrl(inlineArtworkDataUrl)
    if (parsedArtwork) {
      this.artworkResolveSequence += 1
      this.artworkResolvingTrackId = null
      this.latestArtwork = {
        currentTrackId: trackId,
        dataUrl: inlineArtworkDataUrl,
        mimeType: parsedArtwork.mimeType,
        bytes: parsedArtwork.bytes
      }
      this.latestSnapshot = this.buildSnapshot(false)
      return
    }

    if (this.latestArtwork.currentTrackId === trackId && this.latestArtwork.bytes) {
      this.latestSnapshot = this.buildSnapshot(false)
      return
    }

    if (this.latestArtwork.currentTrackId === trackId && this.artworkResolvingTrackId === trackId) {
      this.latestSnapshot = this.buildSnapshot(false)
      return
    }

    this.artworkResolveSequence += 1
    const resolveSequence = this.artworkResolveSequence

    if (!currentTrack.artworkHash) {
      this.artworkResolvingTrackId = null
      this.latestArtwork = {
        currentTrackId: trackId,
        dataUrl: null,
        mimeType: null,
        bytes: null
      }
      this.latestSnapshot = this.buildSnapshot(false)
      return
    }

    this.latestArtwork = {
      currentTrackId: trackId,
      dataUrl: null,
      mimeType: null,
      bytes: null
    }
    this.latestSnapshot = this.buildSnapshot(false)
    this.artworkResolvingTrackId = trackId
    void this.resolveArtworkForTrack(trackId, currentTrack.artworkHash, resolveSequence)
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
        server.listen(this.config.port, getLocalApiBindHost(this.config))
      })

      server.on('error', (error) => {
        this.lastError = error.message
        this.active = false
        this.emitStatus()
      })

      this.server = server
      this.active = true
      this.lastError = null
      this.startHeartbeat()
      this.emitStatus()
    } catch (error) {
      this.server = null
      this.active = false
      this.lastError = error instanceof Error ? error.message : 'Failed to start local API.'
      this.stopHeartbeat()
      this.emitStatus()
    }
  }

  private async stopServer(): Promise<void> {
    this.stopHeartbeat()
    this.closeAllSseClients()

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

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.broadcastRawSse(': heartbeat\n\n')
    }, SSE_HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
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

  private closeSseClients(predicate: (client: LocalApiSseClient) => boolean): void {
    for (const client of this.sseClients) {
      if (!predicate(client)) continue
      try {
        client.response.end()
      } catch {
        // Ignore shutdown errors when closing SSE streams.
      }
      this.sseClients.delete(client)
    }
  }

  private closeAllSseClients(): void {
    this.closeSseClients(() => true)
  }

  private broadcastRawSse(payload: string): void {
    for (const client of this.sseClients) {
      try {
        client.response.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private broadcastSseEvent(event: string, payload: unknown): void {
    const serialized = JSON.stringify(payload)
    this.broadcastRawSse(`event: ${event}\ndata: ${serialized}\n\n`)
  }

  private authorizeRequest(req: IncomingMessage): LocalApiAuthorizationContext | null {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string') return null
    if (!authHeader.startsWith(AUTH_PREFIX)) return null

    const suppliedToken = authHeader.slice(AUTH_PREFIX.length).trim()
    if (!suppliedToken) return null
    if (secureTokenEquals(suppliedToken, this.config.token)) {
      return { kind: 'primary' }
    }

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

  private checkControlRateLimit(): boolean {
    const now = Date.now()
    if (now - this.controlRateLimit.windowStartedAt >= CONTROL_RATE_LIMIT_WINDOW_MS) {
      this.controlRateLimit = { count: 0, windowStartedAt: now }
    }
    this.controlRateLimit.count += 1
    return this.controlRateLimit.count <= CONTROL_RATE_LIMIT_MAX_REQUESTS
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

  private parseControlBody(payload: unknown): LocalApiControlBody | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    const command = candidate.command
    switch (command) {
      case 'play':
      case 'pause':
      case 'next':
      case 'previous':
      case 'toggle-favorite':
        return { command }
      case 'seek': {
        const time = candidate.time
        if (typeof time !== 'number' || !Number.isFinite(time)) {
          return null
        }
        return { command, time }
      }
      default:
        return null
    }
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

  private getCurrentSeekDuration(): number | null {
    if (!this.latestRawSnapshot?.currentTrack) return null
    const duration = toSafeNumber(this.latestRawSnapshot.duration)
    return duration > 0 ? duration : null
  }

  private async handlePairingClaim(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    this.cleanupExpiredPairingState(true)
    if (!this.config.enabled || !this.config.remoteWebEnabled || !this.active) {
      this.respondJson(res, 409, { error: 'Remote pairing is not available right now.' })
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
      clientLabel: request.clientLabel
    })
  }

  private handlePairingStatus(_req: IncomingMessage, res: ServerResponse<IncomingMessage>, requestUrl: URL): void {
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
        deviceId: request.issuedDeviceId
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

  private handleSse(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const authorization = this.authorizeRequest(req)
    if (!authorization) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }

    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      this.respondJson(res, 503, { error: 'Too many active stream clients.' })
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(': connected\n\n')
    res.write(`event: now-playing\ndata: ${JSON.stringify(this.latestSnapshot)}\n\n`)

    const client: LocalApiSseClient = { response: res, authorization }
    this.sseClients.add(client)
    this.emitStatus()

    const cleanup = () => {
      this.sseClients.delete(client)
      this.emitStatus()
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    if (!this.authorizeRequest(req)) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }

    if (!this.config.controlsEnabled) {
      this.respondJson(res, 403, { error: 'External playback controls are disabled.' })
      return
    }

    if (!this.checkControlRateLimit()) {
      this.respondJson(res, 429, { error: 'Control rate limit exceeded.' })
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

    const controlBody = this.parseControlBody(parsedBody)
    if (!controlBody) {
      this.respondJson(res, 400, { error: 'Invalid control command.' })
      return
    }

    let dispatchCommand = controlBody
    if (controlBody.command === 'seek') {
      const duration = this.getCurrentSeekDuration()
      if (duration === null) {
        this.respondJson(res, 409, { error: 'No active seekable track.' })
        return
      }

      dispatchCommand = {
        command: 'seek',
        time: Math.max(0, Math.min(duration, controlBody.time))
      }
    }

    this.dispatchCommand(mapControlCommand(dispatchCommand))
    this.respondJson(res, 200, { ok: true, command: dispatchCommand.command })
  }

  private handleArtwork(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): void {
    if (!this.authorizeRequest(req)) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }

    const requestedTrackId = toSafeOptionalString(requestUrl.searchParams.get('trackId'))
    if (requestedTrackId && requestedTrackId !== this.latestArtwork.currentTrackId) {
      this.respondJson(res, 404, { error: 'Artwork not found for requested track.' })
      return
    }

    if (!this.latestArtwork.currentTrackId || !this.latestArtwork.mimeType || !this.latestArtwork.bytes) {
      this.respondJson(res, 404, { error: 'Artwork not available.' })
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', this.latestArtwork.mimeType)
    res.setHeader('Content-Length', this.latestArtwork.bytes.length.toString())
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(this.latestArtwork.bytes)
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
    _req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestPath: string
  ): Promise<boolean> {
    if (!this.config.remoteWebEnabled) return false

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

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const method = req.method ?? 'GET'
    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', `http://${LOCAL_API_LOOPBACK_HOST}`)
    } catch {
      this.respondJson(res, 400, { error: 'Invalid request URL.' })
      return
    }
    const path = requestUrl.pathname

    if (method === 'GET' && path.startsWith('/remote')) {
      const handled = await this.handleRemoteAsset(req, res, path)
      if (handled) return
    }

    if (method === 'POST' && path === '/v1/pairing/claim') {
      await this.handlePairingClaim(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/pairing/status') {
      this.handlePairingStatus(req, res, requestUrl)
      return
    }

    if (method === 'GET' && path === '/v1/now-playing') {
      if (!this.authorizeRequest(req)) {
        this.respondJson(res, 401, { error: 'Unauthorized' })
        return
      }

      const includeInlineArtwork = requestUrl.searchParams.get('inlineArtwork') === '1'
      this.respondJson(res, 200, includeInlineArtwork ? this.buildSnapshot(true) : this.latestSnapshot)
      return
    }

    if (method === 'GET' && path === '/v1/events') {
      this.handleSse(req, res)
      return
    }

    if (method === 'GET' && path === '/v1/artwork/current') {
      this.handleArtwork(req, res, requestUrl)
      return
    }

    if (method === 'POST' && path === '/v1/control') {
      await this.handleControl(req, res)
      return
    }

    this.respondJson(res, 404, { error: 'Not found' })
  }
}
