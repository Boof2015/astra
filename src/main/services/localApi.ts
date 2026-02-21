import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import {
  LOCAL_API_HOST,
  type LocalApiControlCommand,
  type LocalApiNowPlayingSnapshot,
  type LocalApiServiceConfig,
  type LocalApiStatus
} from '../../types/localApi'

const AUTH_PREFIX = 'Bearer '
const MAX_SSE_CLIENTS = 8
const SSE_HEARTBEAT_INTERVAL_MS = 20_000
const CONTROL_RATE_LIMIT_WINDOW_MS = 60_000
const CONTROL_RATE_LIMIT_MAX_REQUESTS = 120
const CONTROL_MAX_BODY_BYTES = 1_024

interface LocalApiServiceOptions {
  config: LocalApiServiceConfig
  getSnapshot: () => MiniPlayerSnapshot | null
  dispatchCommand: (command: MiniPlayerCommand) => void
  onStatusChange?: (status: LocalApiStatus) => void
}

interface LocalApiControlBody {
  command: LocalApiControlCommand
}

interface ControlRateLimitState {
  count: number
  windowStartedAt: number
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function toSafeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function sanitizeSnapshot(snapshot: MiniPlayerSnapshot | null): LocalApiNowPlayingSnapshot {
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
          isFavorite: Boolean(snapshot.currentTrack.isFavorite)
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

function mapControlCommand(command: LocalApiControlCommand): MiniPlayerCommand {
  switch (command) {
    case 'play':
      return { type: 'play' }
    case 'pause':
      return { type: 'pause' }
    case 'next':
      return { type: 'playNext' }
    case 'previous':
      return { type: 'playPrevious' }
  }
}

function toLocalApiMode(config: LocalApiServiceConfig): LocalApiStatus['mode'] {
  if (!config.enabled) return 'off'
  return config.controlsEnabled ? 'api-control' : 'api'
}

export function generateLocalApiToken(): string {
  return randomBytes(24).toString('hex')
}

export class LocalApiService {
  private config: LocalApiServiceConfig
  private readonly dispatchCommand: (command: MiniPlayerCommand) => void
  private readonly onStatusChange?: (status: LocalApiStatus) => void

  private server: Server | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly sseClients = new Set<ServerResponse<IncomingMessage>>()
  private controlRateLimit: ControlRateLimitState = {
    count: 0,
    windowStartedAt: Date.now()
  }

  private active = false
  private lastError: string | null = null
  private latestSnapshot: LocalApiNowPlayingSnapshot

  constructor(options: LocalApiServiceOptions) {
    this.config = { ...options.config }
    this.dispatchCommand = options.dispatchCommand
    this.onStatusChange = options.onStatusChange
    this.latestSnapshot = sanitizeSnapshot(options.getSnapshot())
  }

  getStatus(): LocalApiStatus {
    return {
      enabled: this.config.enabled,
      controlsEnabled: this.config.controlsEnabled,
      host: LOCAL_API_HOST,
      port: this.config.port,
      baseUrl: `http://${LOCAL_API_HOST}:${this.config.port}`,
      token: this.config.token,
      active: this.active,
      mode: toLocalApiMode(this.config),
      connectedClients: this.sseClients.size,
      lastError: this.lastError
    }
  }

  async applyConfig(config: LocalApiServiceConfig): Promise<LocalApiStatus> {
    const previous = this.config
    const tokenChanged = previous.token !== config.token
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

    if (tokenChanged) {
      this.closeAllSseClients()
      this.emitStatus()
    }

    return this.getStatus()
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot | null): void {
    this.latestSnapshot = sanitizeSnapshot(snapshot)
    if (!this.active) return
    this.broadcastSseEvent('now-playing', this.latestSnapshot)
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
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
        server.listen(this.config.port, LOCAL_API_HOST)
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

  private closeAllSseClients(): void {
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // Ignore shutdown errors when closing SSE streams.
      }
    }
    this.sseClients.clear()
  }

  private broadcastRawSse(payload: string): void {
    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private broadcastSseEvent(event: string, payload: unknown): void {
    const serialized = JSON.stringify(payload)
    this.broadcastRawSse(`event: ${event}\ndata: ${serialized}\n\n`)
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string') return false
    if (!authHeader.startsWith(AUTH_PREFIX)) return false

    const suppliedToken = authHeader.slice(AUTH_PREFIX.length).trim()
    if (!suppliedToken) return false
    return secureTokenEquals(suppliedToken, this.config.token)
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
    if (command !== 'play' && command !== 'pause' && command !== 'next' && command !== 'previous') {
      return null
    }
    return { command }
  }

  private handleSse(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    if (!this.isAuthorized(req)) {
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

    this.sseClients.add(res)
    this.emitStatus()

    const cleanup = () => {
      this.sseClients.delete(res)
      this.emitStatus()
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    if (!this.isAuthorized(req)) {
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

    this.dispatchCommand(mapControlCommand(controlBody.command))
    this.respondJson(res, 200, { ok: true, command: controlBody.command })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const method = req.method ?? 'GET'
    let path = '/'
    try {
      path = new URL(req.url ?? '/', `http://${LOCAL_API_HOST}`).pathname
    } catch {
      this.respondJson(res, 400, { error: 'Invalid request URL.' })
      return
    }

    if (method === 'GET' && path === '/v1/now-playing') {
      if (!this.isAuthorized(req)) {
        this.respondJson(res, 401, { error: 'Unauthorized' })
        return
      }

      this.respondJson(res, 200, this.latestSnapshot)
      return
    }

    if (method === 'GET' && path === '/v1/events') {
      this.handleSse(req, res)
      return
    }

    if (method === 'POST' && path === '/v1/control') {
      await this.handleControl(req, res)
      return
    }

    this.respondJson(res, 404, { error: 'Not found' })
  }
}
