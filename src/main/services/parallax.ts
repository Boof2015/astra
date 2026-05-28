import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { performance } from 'perf_hooks'
import type {
  ParallaxAudioChunk,
  ParallaxClockSample,
  ParallaxHostConfig,
  ParallaxHostStreamStartOptions,
  ParallaxJoinResponse,
  ParallaxPairedSink,
  ParallaxPairResponse,
  ParallaxPairingPin,
  ParallaxSinkConnectionConfig,
  ParallaxSinkTelemetry,
  ParallaxStatus,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../../types/parallax'
import {
  PARALLAX_AUDIO_CHUNK_FRAMES,
  PARALLAX_CLOCK_SAMPLE_LIMIT,
  PARALLAX_DEFAULT_GROUP_LATENCY_MS,
  PARALLAX_LAN_HOST,
  buildParallaxClockSample,
  decodeParallaxAudioPacket,
  encodeParallaxAudioPacket,
  selectBestParallaxClockSample
} from '../../types/parallax'
import {
  createOpaqueSecret,
  hashToken,
  hasBearerToken,
  normalizeDeviceLabel,
  secureTokenEquals,
  toSafeOptionalString
} from './playbackHttpCore'

const TOKEN_PREFIX_LENGTH = 8
const PAIRING_PIN_TTL_MS = 2 * 60_000
const CLOCK_SYNC_INTERVAL_MS = 2_000
// On connect/reconnect, fire a quick burst of clock probes so the host<->sink offset
// converges (best-of-N lowest RTT) before first playback instead of after ~16s of the
// slow 2s cadence. Without this, first play aligns from a single high-RTT sample.
const CLOCK_PRIMING_PROBES = 8
const CLOCK_PRIMING_INTERVAL_MS = 120
const STATUS_RETRY_DELAY_MS = 1_000
const SINK_AUTO_RECONNECT_DELAY_MS = 2_000
const SINK_AUTO_RECONNECT_ATTEMPTS = 3
const MAX_BODY_BYTES = 8 * 1024
const MAX_AUDIO_CHUNKS = 12_000

export interface PersistedParallaxPairedSink extends ParallaxPairedSink {
  tokenHash: string
}

interface ActiveParallaxStream {
  info: ParallaxStreamInfo
  timeline: ParallaxTimelineState
  packets: Array<{
    startFrame: number
    endFrame: number
    bytes: Uint8Array
  }>
}

interface ParallaxSseClient {
  response: ServerResponse<IncomingMessage>
  sinkId: string
}

interface ParallaxAudioClient {
  response: ServerResponse<IncomingMessage>
  sinkId: string
  streamId: string
  fromFrame: number
}

interface ParallaxSinkConnectionState {
  baseUrl: string
  sinkId: string
  token: string
  abortController: AbortController
  eventReader: ReadableStreamDefaultReader<Uint8Array> | null
  audioReader: ReadableStreamDefaultReader<Uint8Array> | null
  activeAudioStreamId: string | null
  eventGeneration: number
  audioGeneration: number
}

interface ParallaxServiceOptions {
  config: ParallaxHostConfig
  pairedSinks?: PersistedParallaxPairedSink[]
  onPairedSinksChange?: (sinks: PersistedParallaxPairedSink[]) => void
  onStatusChange?: (status: ParallaxStatus) => void
  onSinkEvent?: (event: ParallaxTimelineEvent) => void
  onSinkAudioChunk?: (chunk: ParallaxAudioChunk) => void
}

function parallaxNowMs(): number {
  return performance.timeOrigin + performance.now()
}

function getParallaxLanUrls(port: number): string[] {
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

function sanitizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'http:') {
    throw new Error('Parallax v1 only supports HTTP LAN hosts.')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function sanitizePort(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return fallback
  return parsed
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const message = 'message' in error ? String(error.message) : ''
  return name === 'AbortError' || /aborted/i.test(message)
}

function toJsonResponse(res: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readRequestBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBody = await readRequestBody(req)
  if (rawBody === null) {
    throw new Error('Request body too large.')
  }
  if (!rawBody.trim()) return null
  return JSON.parse(rawBody)
}

function writeSseEvent(res: ServerResponse<IncomingMessage>, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function mergeBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  if (left.byteLength === 0) {
    const copy = new Uint8Array(right.byteLength)
    copy.set(right)
    return copy
  }
  if (right.byteLength === 0) {
    const copy = new Uint8Array(left.byteLength)
    copy.set(left)
    return copy
  }
  const merged = new Uint8Array(left.byteLength + right.byteLength)
  merged.set(left, 0)
  merged.set(right, left.byteLength)
  return merged
}

function byteViewFromArrayBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer.slice(0))
}

export class ParallaxService {
  private config: ParallaxHostConfig
  private pairedSinks: PersistedParallaxPairedSink[]
  private readonly onPairedSinksChange?: (sinks: PersistedParallaxPairedSink[]) => void
  private readonly onStatusChange?: (status: ParallaxStatus) => void
  private readonly onSinkEvent?: (event: ParallaxTimelineEvent) => void
  private readonly onSinkAudioChunk?: (chunk: ParallaxAudioChunk) => void

  private server: Server | null = null
  private active = false
  private lastError: string | null = null
  private activePairingPin: ParallaxPairingPin | null = null
  private activeStream: ActiveParallaxStream | null = null
  private readonly sseClients = new Set<ParallaxSseClient>()
  private readonly audioClients = new Set<ParallaxAudioClient>()
  private sinkConnection: ParallaxSinkConnectionState | null = null
  private sinkClockSamples: ParallaxClockSample[] = []
  private sinkClockTimer: ReturnType<typeof setInterval> | null = null
  private sinkReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sinkReconnectAttempts = 0
  private sinkActiveStream: ParallaxStreamInfo | null = null
  private sinkLastError: string | null = null

  constructor(options: ParallaxServiceOptions) {
    this.config = { ...options.config }
    this.pairedSinks = [...(options.pairedSinks ?? [])]
    this.onPairedSinksChange = options.onPairedSinksChange
    this.onStatusChange = options.onStatusChange
    this.onSinkEvent = options.onSinkEvent
    this.onSinkAudioChunk = options.onSinkAudioChunk
  }

  getStatus(): ParallaxStatus {
    this.cleanupExpiredPairingPin()
    const lanUrls = this.active ? getParallaxLanUrls(this.config.port) : []
    const bestClock = selectBestParallaxClockSample(this.sinkClockSamples)
    const sinkConnected = this.sinkConnection !== null
    return {
      role: sinkConnected ? 'sink' : this.config.enabled ? 'host' : 'idle',
      host: {
        enabled: this.config.enabled,
        active: this.active,
        bindHost: PARALLAX_LAN_HOST,
        port: this.config.port,
        lanUrls,
        activePairingPin: this.activePairingPin,
        pairedSinkCount: this.pairedSinks.filter((sink) => sink.revokedAt === null).length,
        connectedSinkCount: new Set(Array.from(this.sseClients, (client) => client.sinkId)).size,
        activeStream: this.activeStream?.info ?? null,
        lastError: this.lastError
      },
      sink: {
        connected: sinkConnected,
        baseUrl: this.sinkConnection?.baseUrl ?? null,
        sinkId: this.sinkConnection?.sinkId ?? null,
        activeStream: this.sinkActiveStream,
        clockOffsetMs: bestClock?.offsetMs ?? null,
        rttMs: bestClock?.rttMs ?? null,
        lastError: this.sinkLastError
      }
    }
  }

  listPairedSinks(): ParallaxPairedSink[] {
    return this.pairedSinks
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((sink) => ({
        id: sink.id,
        name: sink.name,
        tokenPrefix: sink.tokenPrefix,
        createdAt: sink.createdAt,
        lastSeenAt: sink.lastSeenAt,
        revokedAt: sink.revokedAt
      }))
  }

  replacePairedSinks(sinks: PersistedParallaxPairedSink[]): void {
    this.pairedSinks = sinks.map((sink) => ({ ...sink }))
    this.emitStatus()
  }

  async applyHostConfig(config: ParallaxHostConfig): Promise<ParallaxStatus> {
    const previous = this.config
    const nextPort = sanitizePort(config.port, previous.port)
    const nextConfig = {
      enabled: Boolean(config.enabled),
      port: nextPort
    }
    const restartNeeded = previous.port !== nextConfig.port || previous.enabled !== nextConfig.enabled
    this.config = nextConfig

    if (!this.config.enabled) {
      await this.stopHostServer()
      this.activePairingPin = null
      this.lastError = null
      this.emitStatus()
      return this.getStatus()
    }

    if (restartNeeded || !this.server || !this.active) {
      await this.startHostServer()
    } else {
      this.lastError = null
      this.emitStatus()
    }

    return this.getStatus()
  }

  createPairingPin(): ParallaxPairingPin {
    this.cleanupExpiredPairingPin()
    if (!this.config.enabled || !this.active) {
      throw new Error('Parallax host pairing is only available while the host service is active.')
    }

    const createdAt = Date.now()
    this.activePairingPin = {
      pin: String(Math.floor(100000 + Math.random() * 900000)),
      createdAt,
      expiresAt: createdAt + PAIRING_PIN_TTL_MS
    }
    this.emitStatus()
    return this.activePairingPin
  }

  revokePairedSink(id: string): ParallaxPairedSink | null {
    const sink = this.pairedSinks.find((candidate) => candidate.id === id)
    if (!sink || sink.revokedAt !== null) return null
    sink.revokedAt = Date.now()
    this.closeSseClientsForSink(id)
    this.emitPairedSinksChange()
    this.emitStatus()
    return {
      id: sink.id,
      name: sink.name,
      tokenPrefix: sink.tokenPrefix,
      createdAt: sink.createdAt,
      lastSeenAt: sink.lastSeenAt,
      revokedAt: sink.revokedAt
    }
  }

  revokeAllPairedSinks(): number {
    const now = Date.now()
    let revokedCount = 0
    for (const sink of this.pairedSinks) {
      if (sink.revokedAt !== null) continue
      sink.revokedAt = now
      revokedCount += 1
    }
    if (revokedCount === 0) return 0
    this.closeAllHostClients()
    this.emitPairedSinksChange()
    this.emitStatus()
    return revokedCount
  }

  publishHostStreamStart(
    info: Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'>,
    options: ParallaxHostStreamStartOptions = {}
  ): ParallaxTimelineState {
    if (!this.config.enabled || !this.active) {
      throw new Error('Parallax host is not active.')
    }

    const now = parallaxNowMs()
    const stream: ParallaxStreamInfo = {
      ...info,
      sampleRate: Math.max(1, Math.round(info.sampleRate)),
      channels: Math.max(1, Math.min(8, Math.round(info.channels))),
      totalFrames: Math.max(0, Math.floor(info.totalFrames)),
      durationSeconds: Math.max(0, info.durationSeconds),
      chunkFrames: PARALLAX_AUDIO_CHUNK_FRAMES,
      groupLatencyMs: PARALLAX_DEFAULT_GROUP_LATENCY_MS,
      createdAt: Date.now()
    }
    const timeline: ParallaxTimelineState = {
      streamId: stream.streamId,
      playbackState: options.playbackState ?? 'playing',
      startFrame: Math.max(0, Math.min(stream.totalFrames, Math.floor(options.startFrame ?? 0))),
      startHostTimeMs: now + PARALLAX_DEFAULT_GROUP_LATENCY_MS,
      updatedHostTimeMs: now,
      groupLatencyMs: PARALLAX_DEFAULT_GROUP_LATENCY_MS
    }

    this.activeStream = {
      info: stream,
      timeline,
      packets: []
    }
    this.broadcastTimelineEvent({
      type: 'stream-start',
      stream,
      timeline,
      emittedAtHostTimeMs: now
    })
    this.emitStatus()
    return timeline
  }

  publishHostTimeline(timeline: ParallaxTimelineState): void {
    if (!this.activeStream || this.activeStream.info.streamId !== timeline.streamId) return
    this.activeStream.timeline = { ...timeline }
    this.broadcastTimelineEvent({
      type: 'timeline',
      timeline,
      emittedAtHostTimeMs: parallaxNowMs()
    })
  }

  publishHostAudioChunk(chunk: ParallaxAudioChunk): void {
    if (!this.activeStream || this.activeStream.info.streamId !== chunk.streamId) return
    const packet = byteViewFromArrayBuffer(encodeParallaxAudioPacket(chunk))
    const startFrame = Math.max(0, Math.floor(chunk.startFrame))
    const endFrame = startFrame + Math.max(0, Math.floor(chunk.frameCount))

    this.activeStream.packets.push({ startFrame, endFrame, bytes: packet })
    if (this.activeStream.packets.length > MAX_AUDIO_CHUNKS) {
      this.activeStream.packets.splice(0, this.activeStream.packets.length - MAX_AUDIO_CHUNKS)
    }

    for (const client of this.audioClients) {
      if (client.streamId !== chunk.streamId) continue
      if (endFrame <= client.fromFrame) continue
      try {
        client.response.write(packet)
      } catch {
        this.audioClients.delete(client)
      }
    }
  }

  private getTimelineForNewSink(now: number = parallaxNowMs()): ParallaxTimelineState | null {
    if (!this.activeStream) return null

    const { info, timeline } = this.activeStream
    if (timeline.playbackState !== 'playing') {
      return {
        ...timeline,
        groupLatencyMs: info.groupLatencyMs,
        updatedHostTimeMs: now
      }
    }

    const startHostTimeMs = now + info.groupLatencyMs
    const elapsedFrames = Math.floor(
      Math.max(0, startHostTimeMs - timeline.startHostTimeMs) * info.sampleRate / 1000
    )
    return {
      ...timeline,
      startFrame: Math.max(0, Math.min(info.totalFrames, timeline.startFrame + elapsedFrames)),
      startHostTimeMs,
      updatedHostTimeMs: now,
      groupLatencyMs: info.groupLatencyMs
    }
  }

  stopHostStream(): void {
    const streamId = this.activeStream?.info.streamId ?? null
    this.activeStream = null
    this.broadcastTimelineEvent({
      type: 'stop',
      streamId,
      emittedAtHostTimeMs: parallaxNowMs()
    })
    for (const client of this.audioClients) {
      try { client.response.end() } catch { /* ignore */ }
    }
    this.audioClients.clear()
    this.emitStatus()
  }

  async pairWithHost(baseUrl: string, pin: string, sinkName: string): Promise<ParallaxPairResponse> {
    const normalizedBaseUrl = sanitizeBaseUrl(baseUrl)
    const response = await fetch(`${normalizedBaseUrl}/v1/parallax/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin,
        sinkName: normalizeDeviceLabel(sinkName, 'Astra Sink')
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(toSafeOptionalString((payload as { error?: unknown } | null)?.error) ?? `Parallax pairing failed (${response.status}).`)
    }
    return payload as ParallaxPairResponse
  }

  async connectSink(config: ParallaxSinkConnectionConfig): Promise<ParallaxStatus> {
    await this.disconnectSink()
    const normalizedBaseUrl = sanitizeBaseUrl(config.baseUrl)
    const normalizedSinkId = config.sinkId.trim()
    const normalizedToken = config.token.trim()
    if (!normalizedSinkId || !normalizedToken) {
      throw new Error('Parallax sink id and token are required.')
    }

    const abortController = new AbortController()
    this.sinkConnection = {
      baseUrl: normalizedBaseUrl,
      sinkId: normalizedSinkId,
      token: normalizedToken,
      abortController,
      eventReader: null,
      audioReader: null,
      activeAudioStreamId: null,
      eventGeneration: 0,
      audioGeneration: 0
    }
    this.sinkClockSamples = []
    this.sinkActiveStream = null
    this.sinkLastError = null
    this.sinkReconnectAttempts = 0

    try {
      const join = await this.fetchSinkJson<ParallaxJoinResponse>('/v1/parallax/join', {
        method: 'POST',
        body: JSON.stringify({ sinkId: normalizedSinkId })
      })
      this.sinkReconnectAttempts = 0
      this.sinkActiveStream = join.stream
      this.emitStatus()
      void this.primeClockSync(this.sinkConnection)
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        const event: ParallaxTimelineEvent = {
          type: 'stream-start',
          stream: join.stream,
          timeline: join.timeline,
          emittedAtHostTimeMs: join.hostTimeMs
        }
        this.onSinkEvent?.(event)
        void this.consumeSinkAudio(join.stream.streamId, join.timeline.startFrame, true)
      }
      return this.getStatus()
    } catch (error) {
      await this.disconnectSink()
      this.sinkLastError = error instanceof Error ? error.message : 'Failed to connect Parallax sink.'
      this.emitStatus()
      throw error
    }
  }

  async disconnectSink(): Promise<ParallaxStatus> {
    this.clearSinkReconnectTimer()
    this.sinkReconnectAttempts = 0
    this.stopClockSync()
    const connection = this.sinkConnection
    this.sinkConnection = null
    this.sinkActiveStream = null
    this.sinkClockSamples = []
    this.sinkLastError = null

    if (connection) {
      try { connection.abortController.abort() } catch { /* ignore */ }
      try { await connection.eventReader?.cancel() } catch { /* ignore */ }
      try { await connection.audioReader?.cancel() } catch { /* ignore */ }
      connection.eventReader = null
      connection.audioReader = null
      connection.activeAudioStreamId = null
      connection.eventGeneration += 1
      connection.audioGeneration += 1
    }

    this.emitStatus()
    return this.getStatus()
  }

  async publishSinkTelemetry(telemetry: ParallaxSinkTelemetry): Promise<void> {
    if (!this.sinkConnection) return
    await this.fetchSinkJson('/v1/parallax/telemetry', {
      method: 'POST',
      body: JSON.stringify(telemetry)
    }).catch((error) => {
      if (isAbortLikeError(error)) return
      this.sinkLastError = error instanceof Error ? error.message : 'Failed to publish Parallax telemetry.'
      this.emitStatus()
    })
  }

  async stop(): Promise<void> {
    await this.disconnectSink()
    await this.stopHostServer()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  private emitPairedSinksChange(): void {
    this.onPairedSinksChange?.(this.pairedSinks.map((sink) => ({ ...sink })))
  }

  private cleanupExpiredPairingPin(): void {
    if (!this.activePairingPin) return
    if (this.activePairingPin.expiresAt > Date.now()) return
    this.activePairingPin = null
  }

  private closeSseClientsForSink(sinkId: string): void {
    for (const client of this.sseClients) {
      if (client.sinkId !== sinkId) continue
      try { client.response.end() } catch { /* ignore */ }
      this.sseClients.delete(client)
    }
    for (const client of this.audioClients) {
      if (client.sinkId !== sinkId) continue
      try { client.response.end() } catch { /* ignore */ }
      this.audioClients.delete(client)
    }
  }

  private closeAllHostClients(): void {
    for (const client of this.sseClients) {
      try { client.response.end() } catch { /* ignore */ }
    }
    for (const client of this.audioClients) {
      try { client.response.end() } catch { /* ignore */ }
    }
    this.sseClients.clear()
    this.audioClients.clear()
  }

  private async startHostServer(): Promise<void> {
    await this.stopHostServer()
    const server = createServer((req, res) => {
      void this.handleHostRequest(req, res)
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
        server.listen(this.config.port, PARALLAX_LAN_HOST)
      })

      server.on('error', (error) => {
        this.lastError = error.message
        this.active = false
        this.emitStatus()
      })

      this.server = server
      this.active = true
      this.lastError = null
      this.emitStatus()
    } catch (error) {
      this.server = null
      this.active = false
      this.lastError = error instanceof Error ? error.message : 'Failed to start Parallax host.'
      this.emitStatus()
    }
  }

  private async stopHostServer(): Promise<void> {
    this.closeAllHostClients()
    this.activeStream = null
    this.activePairingPin = null

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

  private authorizeHostRequest(req: IncomingMessage): PersistedParallaxPairedSink | null {
    const token = hasBearerToken(req)
    if (!token) return null
    const tokenHash = hashToken(token)

    for (const sink of this.pairedSinks) {
      if (sink.revokedAt !== null) continue
      if (!secureTokenEquals(tokenHash, sink.tokenHash)) continue
      sink.lastSeenAt = Date.now()
      this.emitPairedSinksChange()
      return sink
    }

    return null
  }

  private async handleHostRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    const method = req.method ?? 'GET'
    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid request URL.' })
      return
    }

    const path = requestUrl.pathname
    if (method === 'POST' && path === '/v1/parallax/pair') {
      await this.handlePairRequest(req, res)
      return
    }

    const sink = this.authorizeHostRequest(req)
    if (!sink) {
      toJsonResponse(res, 401, { error: 'Unauthorized' })
      return
    }

    if (method === 'POST' && path === '/v1/parallax/join') {
      const hostTimeMs = parallaxNowMs()
      toJsonResponse(res, 200, {
        sinkId: sink.id,
        groupLatencyMs: PARALLAX_DEFAULT_GROUP_LATENCY_MS,
        hostTimeMs,
        stream: this.activeStream?.info ?? null,
        timeline: this.getTimelineForNewSink(hostTimeMs)
      } satisfies ParallaxJoinResponse)
      return
    }

    if (method === 'GET' && path === '/v1/parallax/events') {
      this.handleEventsRequest(req, res, sink.id)
      return
    }

    if (method === 'GET' && path === '/v1/parallax/audio') {
      this.handleAudioRequest(req, res, requestUrl, sink.id)
      return
    }

    if (method === 'POST' && path === '/v1/parallax/clock') {
      const hostReceivedAtMs = parallaxNowMs()
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        toJsonResponse(res, 400, { error: 'Invalid clock payload.' })
        return
      }
      const sinkSentAtMs = Number((body as { sinkSentAtMs?: unknown } | null)?.sinkSentAtMs)
      if (!Number.isFinite(sinkSentAtMs)) {
        toJsonResponse(res, 400, { error: 'Invalid sink timestamp.' })
        return
      }
      toJsonResponse(res, 200, {
        sinkSentAtMs,
        hostReceivedAtMs,
        hostSentAtMs: parallaxNowMs()
      })
      return
    }

    if (method === 'POST' && path === '/v1/parallax/telemetry') {
      try {
        await readJsonBody(req)
      } catch {
        toJsonResponse(res, 400, { error: 'Invalid telemetry payload.' })
        return
      }
      toJsonResponse(res, 200, { ok: true })
      return
    }

    toJsonResponse(res, 404, { error: 'Not found' })
  }

  private async handlePairRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<void> {
    this.cleanupExpiredPairingPin()
    if (!this.activePairingPin) {
      toJsonResponse(res, 409, { error: 'No active Parallax pairing PIN.' })
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      toJsonResponse(res, 400, { error: 'Invalid pairing payload.' })
      return
    }

    const rawPin = toSafeOptionalString((body as { pin?: unknown } | null)?.pin)
    if (!rawPin || rawPin !== this.activePairingPin.pin) {
      toJsonResponse(res, 403, { error: 'Invalid Parallax pairing PIN.' })
      return
    }

    const now = Date.now()
    const rawToken = createOpaqueSecret(32)
    const sinkId = createOpaqueSecret(16)
    const sink: PersistedParallaxPairedSink = {
      id: sinkId,
      name: normalizeDeviceLabel((body as { sinkName?: unknown } | null)?.sinkName, 'Astra Sink'),
      tokenHash: hashToken(rawToken),
      tokenPrefix: rawToken.slice(0, TOKEN_PREFIX_LENGTH),
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null
    }
    this.pairedSinks = [sink, ...this.pairedSinks]
    this.activePairingPin = null
    this.emitPairedSinksChange()
    this.emitStatus()
    toJsonResponse(res, 200, {
      sinkId,
      token: rawToken,
      tokenPrefix: sink.tokenPrefix
    } satisfies ParallaxPairResponse)
  }

  private handleEventsRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    sinkId: string
  ): void {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(': connected\n\n')

    const client: ParallaxSseClient = { response: res, sinkId }
    this.sseClients.add(client)

    if (this.activeStream) {
      const emittedAtHostTimeMs = parallaxNowMs()
      writeSseEvent(res, 'parallax', {
        type: 'stream-start',
        stream: this.activeStream.info,
        timeline: this.getTimelineForNewSink(emittedAtHostTimeMs) ?? this.activeStream.timeline,
        emittedAtHostTimeMs
      } satisfies ParallaxTimelineEvent)
    }

    this.emitStatus()
    const cleanup = () => {
      const removed = this.sseClients.delete(client)
      if (removed) this.emitStatus()
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  private handleAudioRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    requestUrl: URL,
    sinkId: string
  ): void {
    const streamId = toSafeOptionalString(requestUrl.searchParams.get('streamId'))
    const fromFrame = Math.max(0, Math.floor(Number(requestUrl.searchParams.get('fromFrame') ?? 0) || 0))
    if (!this.activeStream || !streamId || this.activeStream.info.streamId !== streamId) {
      toJsonResponse(res, 409, { error: 'No matching Parallax stream is active.' })
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    for (const packet of this.activeStream.packets) {
      if (packet.endFrame <= fromFrame) continue
      res.write(packet.bytes)
    }

    const client: ParallaxAudioClient = { response: res, sinkId, streamId, fromFrame }
    this.audioClients.add(client)
    const cleanup = () => {
      this.audioClients.delete(client)
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  private broadcastTimelineEvent(event: ParallaxTimelineEvent): void {
    for (const client of this.sseClients) {
      try {
        writeSseEvent(client.response, 'parallax', event)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private async fetchSinkJson<T = unknown>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const connection = this.sinkConnection
    if (!connection) {
      throw new Error('Parallax sink is not connected.')
    }

    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      signal: connection.abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(init.headers ?? {})
      }
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(toSafeOptionalString((payload as { error?: unknown } | null)?.error) ?? `Parallax host request failed (${response.status}).`)
    }
    return payload as T
  }

  private startClockSync(): void {
    this.stopClockSync()
    this.sinkClockTimer = setInterval(() => {
      void this.runClockProbe()
    }, CLOCK_SYNC_INTERVAL_MS)
  }

  // Burst a series of probes back-to-back so the offset converges quickly, then hand off to
  // the slow steady-state cadence. Status is emitted only by the final probe (see runClockProbe)
  // so the renderer's first non-null clock offset already reflects the best-of-burst sample.
  private async primeClockSync(connection: ParallaxSinkConnectionState): Promise<void> {
    for (let index = 0; index < CLOCK_PRIMING_PROBES; index += 1) {
      if (this.sinkConnection !== connection) return
      const isLast = index === CLOCK_PRIMING_PROBES - 1
      await this.runClockProbe(isLast)
      if (this.sinkConnection !== connection) return
      if (!isLast) {
        await new Promise<void>((resolve) => setTimeout(resolve, CLOCK_PRIMING_INTERVAL_MS))
      }
    }
    if (this.sinkConnection !== connection) return
    this.startClockSync()
  }

  private stopClockSync(): void {
    if (this.sinkClockTimer !== null) {
      clearInterval(this.sinkClockTimer)
      this.sinkClockTimer = null
    }
  }

  private clearSinkReconnectTimer(): void {
    if (this.sinkReconnectTimer === null) return
    clearTimeout(this.sinkReconnectTimer)
    this.sinkReconnectTimer = null
  }

  private scheduleSinkReconnect(connection: ParallaxSinkConnectionState, reason: string): void {
    if (this.sinkConnection !== connection) return
    if (this.sinkReconnectTimer !== null) return

    const normalizedReason = reason.trim().replace(/\.+$/, '') || 'Parallax connection interrupted'
    if (this.sinkReconnectAttempts >= SINK_AUTO_RECONNECT_ATTEMPTS) {
      this.sinkLastError = `${normalizedReason}. Parallax sink reconnect stopped after ${SINK_AUTO_RECONNECT_ATTEMPTS} attempts.`
      this.emitStatus()
      return
    }

    const attempt = this.sinkReconnectAttempts + 1
    this.sinkReconnectAttempts = attempt
    this.sinkLastError = `${normalizedReason}. Retrying Parallax connection (${attempt}/${SINK_AUTO_RECONNECT_ATTEMPTS})...`
    this.emitStatus()

    this.sinkReconnectTimer = setTimeout(() => {
      this.sinkReconnectTimer = null
      if (this.sinkConnection !== connection) return
      void this.reconnectSink(connection)
    }, SINK_AUTO_RECONNECT_DELAY_MS)
  }

  private async reconnectSink(connection: ParallaxSinkConnectionState): Promise<void> {
    if (this.sinkConnection !== connection) return

    this.stopClockSync()
    this.sinkClockSamples = []
    connection.eventGeneration += 1
    connection.audioGeneration += 1
    connection.activeAudioStreamId = null

    const previousAbortController = connection.abortController
    const eventReader = connection.eventReader
    const audioReader = connection.audioReader
    connection.eventReader = null
    connection.audioReader = null
    connection.abortController = new AbortController()

    try { previousAbortController.abort() } catch { /* ignore */ }
    try { await eventReader?.cancel() } catch { /* ignore */ }
    try { await audioReader?.cancel() } catch { /* ignore */ }
    if (this.sinkConnection !== connection) return

    try {
      const join = await this.fetchSinkJson<ParallaxJoinResponse>('/v1/parallax/join', {
        method: 'POST',
        body: JSON.stringify({ sinkId: connection.sinkId })
      })
      if (this.sinkConnection !== connection) return
      this.sinkReconnectAttempts = 0
      this.sinkActiveStream = join.stream
      this.sinkLastError = null
      this.emitStatus()
      void this.primeClockSync(connection)
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        const event: ParallaxTimelineEvent = {
          type: 'stream-start',
          stream: join.stream,
          timeline: join.timeline,
          emittedAtHostTimeMs: join.hostTimeMs
        }
        this.onSinkEvent?.(event)
        void this.consumeSinkAudio(join.stream.streamId, join.timeline.startFrame, true)
      }
    } catch (error) {
      if (this.sinkConnection !== connection) return
      if (isAbortLikeError(error)) return
      const message = error instanceof Error ? error.message : 'Parallax reconnect failed.'
      this.sinkLastError = `Parallax reconnect failed: ${message}`
      this.emitStatus()
      this.scheduleSinkReconnect(connection, this.sinkLastError)
    }
  }

  private async runClockProbe(emit = true): Promise<void> {
    const connection = this.sinkConnection
    if (!connection) return
    const sinkSentAtMs = parallaxNowMs()
    try {
      const response = await this.fetchSinkJson('/v1/parallax/clock', {
        method: 'POST',
        body: JSON.stringify({ sinkSentAtMs })
      })
      if (this.sinkConnection !== connection) return
      const sample = buildParallaxClockSample(
        response as {
          sinkSentAtMs: number
          hostReceivedAtMs: number
          hostSentAtMs: number
        },
        parallaxNowMs()
      )
      this.sinkClockSamples = [...this.sinkClockSamples, sample].slice(-PARALLAX_CLOCK_SAMPLE_LIMIT)
      this.sinkLastError = null
      if (emit) this.emitStatus()
    } catch (error) {
      if (this.sinkConnection !== connection) return
      if (isAbortLikeError(error)) return
      this.sinkLastError = error instanceof Error ? error.message : 'Parallax clock sync failed.'
      this.emitStatus()
    }
  }

  private async consumeSinkEvents(): Promise<void> {
    const connection = this.sinkConnection
    if (!connection) return
    if (connection.eventReader) return
    connection.eventGeneration += 1
    const eventGeneration = connection.eventGeneration
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const response = await fetch(`${connection.baseUrl}/v1/parallax/events`, {
        method: 'GET',
        signal: connection.abortController.signal,
        headers: {
          Authorization: `Bearer ${connection.token}`
        }
      })
      if (!response.ok || !response.body) {
        throw new Error(`Parallax event stream failed (${response.status}).`)
      }

      reader = response.body.getReader()
      if (this.sinkConnection !== connection || connection.eventGeneration !== eventGeneration) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.eventReader = reader
      this.sinkLastError = null
      this.emitStatus()
      const decoder = new TextDecoder()
      let buffer = ''
      while (this.sinkConnection === connection && connection.eventGeneration === eventGeneration) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.handleRawSseEvent(rawEvent)
          boundary = buffer.indexOf('\n\n')
        }
      }
      if (this.sinkConnection === connection && connection.eventGeneration === eventGeneration) {
        if (connection.eventReader === reader) connection.eventReader = null
        setTimeout(() => {
          if (
            this.sinkConnection === connection
            && connection.eventGeneration === eventGeneration
            && connection.eventReader === null
          ) {
            void this.consumeSinkEvents()
          }
        }, STATUS_RETRY_DELAY_MS)
      }
    } catch (error) {
      if (this.sinkConnection !== connection || connection.eventGeneration !== eventGeneration) return
      if (connection.eventReader === reader) connection.eventReader = null
      if (isAbortLikeError(error)) {
        setTimeout(() => {
          if (
            this.sinkConnection === connection
            && connection.eventGeneration === eventGeneration
            && connection.eventReader === null
          ) {
            void this.consumeSinkEvents()
          }
        }, STATUS_RETRY_DELAY_MS)
        return
      }
      const message = error instanceof Error ? error.message : 'Parallax event stream disconnected.'
      this.scheduleSinkReconnect(connection, message)
    }
  }

  private handleRawSseEvent(rawEvent: string): void {
    const dataLine = rawEvent
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
    if (!dataLine) return
    let event: ParallaxTimelineEvent
    try {
      event = JSON.parse(dataLine.slice('data: '.length)) as ParallaxTimelineEvent
    } catch {
      return
    }

    if (event.type === 'stream-start') {
      this.sinkActiveStream = event.stream
      this.emitStatus()
      void this.consumeSinkAudio(event.stream.streamId, event.timeline.startFrame, true)
    } else if (event.type === 'stop') {
      this.sinkActiveStream = null
      const connection = this.sinkConnection
      if (connection) {
        connection.audioGeneration += 1
        connection.activeAudioStreamId = null
        try { void connection.audioReader?.cancel() } catch { /* ignore */ }
        connection.audioReader = null
      }
      this.emitStatus()
    }

    this.onSinkEvent?.(event)
  }

  private getSinkReconnectFrame(streamId: string, fallbackFrame: number): number {
    const activeStream = this.sinkActiveStream
    if (!activeStream || activeStream.streamId !== streamId) return Math.max(0, Math.floor(fallbackFrame))

    // Keep reconnect frame selection centralized; the renderer still uses chunk
    // timestamps for exact playback timing.
    return Math.max(0, Math.floor(fallbackFrame))
  }

  private async consumeSinkAudio(streamId: string, fromFrame: number, replace: boolean = false): Promise<void> {
    const connection = this.sinkConnection
    if (!connection) return
    if (!replace && connection.activeAudioStreamId === streamId && connection.audioReader) return

    connection.audioGeneration += 1
    const audioGeneration = connection.audioGeneration
    connection.activeAudioStreamId = streamId

    try {
      await connection.audioReader?.cancel()
    } catch {
      // Ignore replacement races.
    }
    connection.audioReader = null

    try {
      const requestFromFrame = this.getSinkReconnectFrame(streamId, fromFrame)
      const response = await fetch(
        `${connection.baseUrl}/v1/parallax/audio?streamId=${encodeURIComponent(streamId)}&fromFrame=${requestFromFrame}`,
        {
          method: 'GET',
          signal: connection.abortController.signal,
          headers: {
            Authorization: `Bearer ${connection.token}`
          }
        }
      )
      if (!response.ok || !response.body) {
        throw new Error(`Parallax audio stream failed (${response.status}).`)
      }

      const reader = response.body.getReader()
      if (this.sinkConnection !== connection || connection.activeAudioStreamId !== streamId || connection.audioGeneration !== audioGeneration) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.audioReader = reader
      this.sinkLastError = null
      this.emitStatus()
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
      while (
        this.sinkConnection === connection
        && connection.activeAudioStreamId === streamId
        && connection.audioGeneration === audioGeneration
      ) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const received = new Uint8Array(value.byteLength)
        received.set(value)
        pending = mergeBytes(pending, received)
        while (true) {
          const decoded = decodeParallaxAudioPacket(pending)
          if (!decoded) break
          pending = pending.slice(decoded.bytesRead)
          this.onSinkAudioChunk?.({
            ...decoded.chunk,
            streamId
          })
        }
      }
      if (
        this.sinkConnection === connection
        && connection.activeAudioStreamId === streamId
        && connection.audioGeneration === audioGeneration
      ) {
        connection.audioReader = null
        connection.activeAudioStreamId = null
        setTimeout(() => {
          if (this.sinkConnection === connection && connection.activeAudioStreamId === null) {
            void this.consumeSinkAudio(streamId, fromFrame, true)
          }
        }, STATUS_RETRY_DELAY_MS)
      }
    } catch (error) {
      if (
        this.sinkConnection !== connection
        || connection.activeAudioStreamId !== streamId
        || connection.audioGeneration !== audioGeneration
      ) return
      connection.audioReader = null
      connection.activeAudioStreamId = null
      if (isAbortLikeError(error)) {
        setTimeout(() => {
          if (this.sinkConnection === connection && connection.activeAudioStreamId === null) {
            void this.consumeSinkAudio(streamId, fromFrame, true)
          }
        }, STATUS_RETRY_DELAY_MS)
        return
      }
      this.sinkLastError = error instanceof Error ? error.message : 'Parallax audio stream disconnected.'
      this.scheduleSinkReconnect(connection, this.sinkLastError)
    }
  }
}
