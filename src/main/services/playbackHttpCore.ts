import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { MiniPlayerCommand, MiniPlayerQueueSnapshot, MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  type LocalApiControlCommand,
  type LocalApiNowPlayingSnapshot,
  type LocalApiQueueSnapshot,
  type LocalApiRepeatMode
} from '../../types/localApi'
import {
  formatArtistNames,
  normalizeArtistNames
} from '../../shared/library/artistCredits'

const AUTH_PREFIX = 'Bearer '
const MAX_SSE_CLIENTS = 8
const MAX_QUEUE_ITEMS = 5_000
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
const SSE_HEARTBEAT_INTERVAL_MS = 20_000
const CONTROL_RATE_LIMIT_WINDOW_MS = 60_000
const CONTROL_RATE_LIMIT_MAX_REQUESTS = 120
export const CONTROL_MAX_BODY_BYTES = 1_024
const ARTWORK_MAX_BYTES = 8 * 1024 * 1024

type PlaybackControlBody =
  | { command: Exclude<LocalApiControlCommand, 'seek' | 'play-queue-item'> }
  | { command: 'seek'; time: number }
  | { command: 'play-queue-item'; queueId: string }

interface ControlRateLimitState {
  count: number
  windowStartedAt: number
}

interface ParsedArtworkData {
  mimeType: string
  bytes: Buffer
}

interface PlaybackArtworkState {
  currentTrackId: string | null
  dataUrl: string | null
  mimeType: string | null
  bytes: Buffer | null
}

interface PlaybackSseClient<TAuthContext> {
  response: ServerResponse<IncomingMessage>
  authorization: TAuthContext
}

interface PlaybackHttpCoreOptions<TAuthContext> {
  getSnapshot: () => MiniPlayerSnapshot | null
  dispatchCommand: (command: MiniPlayerCommand) => void
  authorizeRequest: (req: IncomingMessage) => TAuthContext | null
  buildArtworkUrl: (trackId: string) => string
  getControlsEnabled: () => boolean
  resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  onConnectedClientsChange?: () => void
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

export function toSafeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function resolveArtistNames(names: unknown, fallback: unknown): string[] {
  const normalized = Array.isArray(names) ? normalizeArtistNames(names) : []
  if (normalized.length > 0) return normalized

  const fallbackText = toSafeOptionalString(fallback)
  return fallbackText ? [fallbackText] : []
}

function resolveDisplayArtist(fallback: unknown, names: unknown): string {
  const normalized = Array.isArray(names) ? normalizeArtistNames(names) : []
  if (normalized.length > 1) return formatArtistNames(normalized)

  const fallbackText = toSafeOptionalString(fallback)
  return fallbackText ?? normalized[0] ?? ''
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

function sanitizeRepeatMode(value: unknown): LocalApiRepeatMode {
  return value === 'one' || value === 'all' ? value : 'none'
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
      shuffle: false,
      repeat: 'none',
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
    shuffle: Boolean(snapshot.shuffle),
    repeat: sanitizeRepeatMode(snapshot.repeat),
    outputDeviceLabel: toSafeOptionalString(snapshot.outputDeviceLabel),
    visualizerLineColor: toSafeOptionalString(snapshot.visualizerLineColor) ?? '#38bdf8',
    currentTrack: snapshot.currentTrack
      ? {
          id: String(snapshot.currentTrack.id),
          title: String(snapshot.currentTrack.title),
          artist: resolveDisplayArtist(snapshot.currentTrack.artist, snapshot.currentTrack.artistNames),
          artists: resolveArtistNames(snapshot.currentTrack.artistNames, snapshot.currentTrack.artist),
          album: String(snapshot.currentTrack.album),
          albumArtists: resolveArtistNames(snapshot.currentTrack.albumArtistNames, snapshot.currentTrack.albumArtist),
          isFavorite: Boolean(snapshot.currentTrack.isFavorite),
          artworkUrl,
          artworkDataUrl
        }
      : null,
    updatedAt
  }
}

export function secureTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createOpaqueSecret(byteLength: number = 24): string {
  return randomBytes(byteLength).toString('base64url')
}

export function normalizeDeviceLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return fallback
  return normalized.slice(0, 80)
}

function mapControlCommand(command: PlaybackControlBody): MiniPlayerCommand {
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
    case 'toggle-shuffle':
      return { type: 'toggleShuffle' }
    case 'toggle-repeat':
      return { type: 'toggleRepeat' }
    case 'play-queue-item':
      return { type: 'playQueueItem', queueId: command.queueId }
    case 'seek':
      return { type: 'seek', time: command.time }
  }
}

function sanitizeQueueSnapshot(snapshot: MiniPlayerQueueSnapshot | null): LocalApiQueueSnapshot {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return { items: [], updatedAt: Date.now() }
  }
  const items: LocalApiQueueSnapshot['items'] = []
  for (const item of snapshot.items) {
    if (items.length >= MAX_QUEUE_ITEMS) break
    if (!item || typeof item !== 'object') continue
    const queueId = toSafeOptionalString(item.queueId)
    if (!queueId) continue
    const durationSeconds = Number(item.durationSeconds)
    items.push({
      queueId,
      title: typeof item.title === 'string' ? item.title.slice(0, 512) : '',
      artist: typeof item.artist === 'string' ? item.artist.slice(0, 512) : '',
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      isCurrent: Boolean(item.isCurrent)
    })
  }
  return { items, updatedAt: Date.now() }
}

export function hasBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string') return null
  if (!authHeader.startsWith(AUTH_PREFIX)) return null
  const suppliedToken = authHeader.slice(AUTH_PREFIX.length).trim()
  return suppliedToken || null
}

export class PlaybackHttpCore<TAuthContext> {
  private readonly options: PlaybackHttpCoreOptions<TAuthContext>

  private readonly sseClients = new Set<PlaybackSseClient<TAuthContext>>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private controlRateLimit: ControlRateLimitState = {
    count: 0,
    windowStartedAt: Date.now()
  }
  private latestRawSnapshot: MiniPlayerSnapshot | null
  private latestArtwork: PlaybackArtworkState = {
    currentTrackId: null,
    dataUrl: null,
    mimeType: null,
    bytes: null
  }
  private latestSnapshot: LocalApiNowPlayingSnapshot
  private latestQueueSnapshot: LocalApiQueueSnapshot = { items: [], updatedAt: 0 }
  private artworkResolveSequence = 0
  private artworkResolvingTrackId: string | null = null

  constructor(options: PlaybackHttpCoreOptions<TAuthContext>) {
    this.options = options
    this.latestRawSnapshot = options.getSnapshot()
    this.latestSnapshot = sanitizeSnapshot(this.latestRawSnapshot, null, null)
    this.refreshLatestSnapshot(this.latestRawSnapshot)
  }

  getConnectedClientCount(): number {
    return this.sseClients.size
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.refreshLatestSnapshot(snapshot)
    if (this.sseClients.size === 0) return
    this.broadcastSseEvent('now-playing', this.latestSnapshot)
  }

  publishQueueSnapshot(snapshot: MiniPlayerQueueSnapshot | null): void {
    this.latestQueueSnapshot = sanitizeQueueSnapshot(snapshot)
    if (this.sseClients.size === 0) return
    this.broadcastSseEvent('queue', this.latestQueueSnapshot)
  }

  /** One-off event to all connected SSE clients (e.g. sync-request nudges). */
  broadcastEvent(event: string, payload: unknown): void {
    if (this.sseClients.size === 0) return
    this.broadcastSseEvent(event, payload)
  }

  handleQueue(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    if (!this.options.authorizeRequest(req)) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }
    this.respondJson(res, 200, this.latestQueueSnapshot)
  }

  closeSseClients(predicate: (client: { authorization: TAuthContext }) => boolean): void {
    let removedAny = false

    for (const client of this.sseClients) {
      if (!predicate(client)) continue
      try {
        client.response.end()
      } catch {
        // Ignore shutdown errors when closing SSE streams.
      }
      removedAny = this.sseClients.delete(client) || removedAny
    }

    if (removedAny) {
      this.options.onConnectedClientsChange?.()
    }
  }

  closeAllSseClients(): void {
    this.closeSseClients(() => true)
  }

  startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.broadcastRawSse(': heartbeat\n\n')
    }, SSE_HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  handleNowPlaying(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): void {
    if (!this.options.authorizeRequest(req)) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }

    const includeInlineArtwork = requestUrl.searchParams.get('inlineArtwork') === '1'
    this.respondJson(res, 200, includeInlineArtwork ? this.buildSnapshot(true) : this.latestSnapshot)
  }

  handleSse(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const authorization = this.options.authorizeRequest(req)
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

    const client: PlaybackSseClient<TAuthContext> = { response: res, authorization }
    this.sseClients.add(client)
    this.options.onConnectedClientsChange?.()

    const cleanup = () => {
      const removed = this.sseClients.delete(client)
      if (removed) {
        this.options.onConnectedClientsChange?.()
      }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  async handleControl(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    if (!this.options.authorizeRequest(req)) {
      this.respondJson(res, 401, { error: 'Unauthorized' })
      return
    }

    if (!this.options.getControlsEnabled()) {
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

    this.options.dispatchCommand(mapControlCommand(dispatchCommand))
    this.respondJson(res, 200, { ok: true, command: dispatchCommand.command })
  }

  handleArtwork(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL
  ): void {
    if (!this.options.authorizeRequest(req)) {
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

  private buildSnapshot(includeInlineArtwork: boolean): LocalApiNowPlayingSnapshot {
    const trackId = this.latestArtwork.currentTrackId
    return sanitizeSnapshot(
      this.latestRawSnapshot,
      trackId && this.latestArtwork.bytes ? this.options.buildArtworkUrl(trackId) : null,
      includeInlineArtwork ? this.latestArtwork.dataUrl : null
    )
  }

  private async resolveArtworkForTrack(
    trackId: string,
    artworkHash: string,
    sequence: number
  ): Promise<void> {
    if (!this.options.resolveArtworkDataUrl) return

    const artworkDataUrl = await this.options.resolveArtworkDataUrl(artworkHash).catch(() => null)
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
    if (this.sseClients.size > 0) {
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

  private getCurrentSeekDuration(): number | null {
    if (!this.latestRawSnapshot?.currentTrack) return null
    const duration = toSafeNumber(this.latestRawSnapshot.duration)
    return duration > 0 ? duration : null
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
    let encoded = Buffer.from(JSON.stringify(body), 'utf8')
    if (encoded.byteLength > MAX_JSON_RESPONSE_BYTES) {
      statusCode = 507
      encoded = Buffer.from(JSON.stringify({ error: 'Response exceeds the transport limit.' }), 'utf8')
    }
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', encoded.byteLength.toString())
    res.setHeader('Cache-Control', 'no-store')
    res.end(encoded)
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

  private parseControlBody(payload: unknown): PlaybackControlBody | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as Record<string, unknown>
    const command = candidate.command
    switch (command) {
      case 'play':
      case 'pause':
      case 'next':
      case 'previous':
      case 'toggle-favorite':
      case 'toggle-shuffle':
      case 'toggle-repeat':
        return { command }
      case 'play-queue-item': {
        const queueId = toSafeOptionalString(candidate.queueId)
        if (!queueId) return null
        return { command, queueId }
      }
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
}
