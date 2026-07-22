import { performance } from 'perf_hooks'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type {
  ParallaxAudioChunk,
  ParallaxClockSample,
  ParallaxJoinPhase,
  ParallaxJoinResponse,
  ParallaxJoinValidationDiagnostic,
  ParallaxSinkConnectionConfig,
  ParallaxSinkTelemetry,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../../src/types/parallax'
import {
  PARALLAX_AUDIO_PACKET_HEADER_BYTES,
  PARALLAX_CLOCK_SAMPLE_LIMIT,
  PARALLAX_PROTOCOL_VERSION,
  ParallaxAuthError,
  buildParallaxClockSample,
  buildParallaxJoinValidationDiagnostic,
  decodeParallaxAudioPacket,
  parseParallaxTimelineEvent,
  readParallaxAudioPacketHeader,
  selectFilteredParallaxClockOffsetMs,
  validateParallaxJoinResponse
} from '../../src/types/parallax'
import {
  createParallaxPinnedDispatcher,
  readBoundedBytesResponse,
  readBoundedJsonResponse,
  PARALLAX_MAX_SSE_EVENT_BYTES
} from '../../src/main/services/parallaxSecurity'

// The sink-role network client, extracted from the app's ParallaxService (src/main/services/
// parallax.ts) with the host role and Electron/IPC wiring removed. Protocol behavior — clock
// priming, SSE/audio consumption, watchdogs, reconnect-forever backoff with mDNS relocation,
// 401 → credential wipe — is a faithful port; constants match the app's.
//
// §21 gapless: the pre-announced next stream's audio is pre-fetched on a SECOND concurrent
// reader (a port of the app's consumeSinkNextAudio) and forwarded tagged by streamId — the
// session routes those chunks to its staged playout engine. The pre-fetch is short-lived
// (pre-announce → boundary) and best-effort: it does not auto-reconnect, because on the boundary
// the promote cancels it and re-establishes the stream in the primary slot from the live frame
// (re-sent backlog is idempotent — playback is by absolute frame).

const CLOCK_SYNC_INTERVAL_MS = 2_000
const CLOCK_PRIMING_PROBES = 8
const CLOCK_PRIMING_INTERVAL_MS = 120
const SINK_JSON_FETCH_TIMEOUT_MS = 3_000
// §19.18(e) — matches the app's PARALLAX_ARTWORK_MAX_BYTES bound on the same endpoint.
const SINK_ARTWORK_MAX_BYTES = 4 * 1024 * 1024
const SINK_ARTWORK_CACHE_MAX = 4
const PARALLAX_AUDIO_STALL_MS = 1_200
const PARALLAX_AUDIO_STALL_CHECK_MS = 400
const PARALLAX_AUDIO_RECONNECT_BACKFILL_MS = 1_000
const STATUS_RETRY_DELAY_MS = 1_000
const SINK_AUTO_RECONNECT_DELAY_MS = 2_000
const SINK_RECONNECT_MAX_DELAY_MS = 20_000
const PARALLAX_RELOCATE_AFTER_ATTEMPTS = 3
const PARALLAX_HOST_LOST_MS = 4_000
const PARALLAX_HOST_SILENCE_MS = 6_000
const PARALLAX_HOST_SILENCE_CHECK_MS = 1_000

export interface SinkClientStatus {
  connected: boolean
  playbackEnabled: boolean
  hostReachable: boolean
  clockOffsetMs: number | null
  rttMs: number | null
  activeStream: ParallaxStreamInfo | null
  timeline: ParallaxTimelineState | null
  lastError: string | null
}

export interface SinkClientCallbacks {
  onEvent: (event: ParallaxTimelineEvent) => void
  onAudioChunk: (chunk: ParallaxAudioChunk) => void
  onStatus: (status: SinkClientStatus) => void
  /** 401 anywhere — the host revoked this sink. Caller wipes the persisted credential. */
  onAuthRevoked: () => void
  /** Resolve the host's current baseUrl via mDNS after repeated reconnect failures. */
  onRelocate?: () => Promise<string | null>
  /** Sanitized join-validation diagnostics for the system journal. */
  onDiagnostic?: (diagnostic: ParallaxJoinValidationDiagnostic) => void
  /** Installed receiver release tag, or `dev` for source builds. */
  softwareVersion?: string
}

interface SinkConnectionState {
  baseUrl: string
  sinkId: string
  token: string
  dispatcher: ReturnType<typeof createParallaxPinnedDispatcher>
  abortController: AbortController
  eventReader: ReadableStreamDefaultReader<Uint8Array> | null
  audioReader: ReadableStreamDefaultReader<Uint8Array> | null
  activeAudioStreamId: string | null
  eventGeneration: number
  audioGeneration: number
  nextAudioReader: ReadableStreamDefaultReader<Uint8Array> | null
  nextAudioStreamId: string | null
  nextAudioGeneration: number
}

type ParallaxFetchInit = UndiciRequestInit & {
  dispatcher: ReturnType<typeof createParallaxPinnedDispatcher>
}

interface ParallaxJsonResponse<T> {
  value: T
  httpStatus: number
  contentType: string | null
}

function parallaxNowMs(): number {
  return performance.timeOrigin + performance.now()
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const message = 'message' in error ? String(error.message) : ''
  return name === 'AbortError' || /aborted/i.test(message)
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return ('name' in error ? String(error.name) : '') === 'TimeoutError'
}

function sanitizeHostBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'https:') {
    throw new Error('Parallax v2 host connections require HTTPS.')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function mergeBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right
  const merged = new Uint8Array(left.byteLength + right.byteLength)
  merged.set(left, 0)
  merged.set(right, left.byteLength)
  return merged
}

function toSafeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export class ParallaxSinkClient {
  private readonly callbacks: SinkClientCallbacks
  private connection: SinkConnectionState | null = null
  private clockSamples: ParallaxClockSample[] = []
  private activeStream: ParallaxStreamInfo | null = null
  private playbackEnabled = true
  private timeline: ParallaxTimelineState | null = null
  private pendingStream: ParallaxStreamInfo | null = null
  private pendingTimeline: ParallaxTimelineState | null = null
  // §14.1.4 Zone Display artwork, keyed by streamId. `null` = the host answered "no artwork"
  // (don't re-ask); missing key = never fetched (the next getActiveArtwork poll fetches).
  private artworkCache = new Map<string, { contentType: string; bytes: Buffer } | null>()
  private artworkFetchesInFlight = new Set<string>()
  // Phase-3 transport lane capability: null until the first command is attempted, false when
  // the host 404s it (host predates the /v1/parallax/control route — hide the buttons).
  private controlSupported: boolean | null = null
  private lastError: string | null = null
  private hostReachable = true
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private audioStallTimer: ReturnType<typeof setInterval> | null = null
  private hostLostTimer: ReturnType<typeof setTimeout> | null = null
  private lastHostContactAtMs = Date.now()
  private lastAudioChunkAtMs = Date.now()

  constructor(callbacks: SinkClientCallbacks) {
    this.callbacks = callbacks
  }

  getStatus(): SinkClientStatus {
    return {
      connected: this.connection !== null,
      playbackEnabled: this.playbackEnabled,
      hostReachable: this.hostReachable,
      clockOffsetMs: selectFilteredParallaxClockOffsetMs(this.clockSamples),
      rttMs: this.bestRttMs(),
      activeStream: this.activeStream,
      timeline: this.timeline,
      lastError: this.lastError
    }
  }

  getClockOffsetMs(): number | null {
    return selectFilteredParallaxClockOffsetMs(this.clockSamples)
  }

  private bestRttMs(): number | null {
    let best: number | null = null
    for (const sample of this.clockSamples) {
      if (!Number.isFinite(sample.rttMs)) continue
      if (best === null || sample.rttMs < best) best = sample.rttMs
    }
    return best
  }

  private emitStatus(): void {
    this.callbacks.onStatus(this.getStatus())
  }

  async connect(config: ParallaxSinkConnectionConfig): Promise<void> {
    await this.disconnect()
    if (config.protocolVersion !== PARALLAX_PROTOCOL_VERSION) {
      throw new Error('Parallax v1 credentials are no longer supported. Pair this speaker again.')
    }
    const baseUrl = sanitizeHostBaseUrl(config.baseUrl)
    const sinkId = config.sinkId.trim()
    const token = config.token.trim()
    const hostCertificatePem = config.hostCertificatePem.trim()
    const hostCertificateFingerprint = config.hostCertificateFingerprint.trim()
    if (!sinkId || !token || !hostCertificatePem || !hostCertificateFingerprint) {
      throw new Error('Parallax sink credentials and pinned host certificate are required.')
    }

    this.connection = {
      baseUrl,
      sinkId,
      token,
      dispatcher: createParallaxPinnedDispatcher(hostCertificatePem, hostCertificateFingerprint),
      abortController: new AbortController(),
      eventReader: null,
      audioReader: null,
      activeAudioStreamId: null,
      eventGeneration: 0,
      audioGeneration: 0,
      nextAudioReader: null,
      nextAudioStreamId: null,
      nextAudioGeneration: 0
    }
    this.clockSamples = []
    this.activeStream = null
    this.timeline = null
    this.pendingStream = null
    this.pendingTimeline = null
    this.lastError = null
    this.reconnectAttempts = 0
    if (this.hostLostTimer) {
      clearTimeout(this.hostLostTimer)
      this.hostLostTimer = null
    }
    this.hostReachable = true

    const connection = this.connection
    try {
      const join = await this.fetchValidatedJoin(sinkId, 'initial')
      this.reconnectAttempts = 0
      this.playbackEnabled = join.playbackEnabled
      this.activeStream = join.stream
      this.emitStatus()
      void this.primeClockSync(connection)
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        this.timeline = join.timeline
        this.callbacks.onEvent({
          type: 'stream-start',
          stream: join.stream,
          timeline: join.timeline,
          emittedAtHostTimeMs: join.hostTimeMs
        })
        void this.consumeSinkAudio(join.stream.streamId, join.timeline.startFrame, true)
      }
      if (join.nextStream && join.nextTimeline) {
        this.pendingStream = join.nextStream
        this.pendingTimeline = join.nextTimeline
        // Joining mid-handoff-window: surface the pre-announcement to the session (it stages an
        // engine for it) and start the pre-fetch, exactly as if the SSE event had arrived.
        this.callbacks.onEvent({
          type: 'next-stream-start',
          stream: join.nextStream,
          timeline: join.nextTimeline,
          emittedAtHostTimeMs: join.hostTimeMs
        })
        void this.consumeSinkNextAudio(join.nextStream.streamId, join.nextTimeline.startFrame)
      }
    } catch (error) {
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        throw error
      }
      await this.disconnect()
      this.lastError = error instanceof Error ? error.message : 'Failed to connect Parallax sink.'
      this.emitStatus()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    this.stopClockSync()
    if (this.hostLostTimer) {
      clearTimeout(this.hostLostTimer)
      this.hostLostTimer = null
    }
    this.hostReachable = true
    const connection = this.connection
    this.connection = null
    this.activeStream = null
    this.timeline = null
    this.pendingStream = null
    this.pendingTimeline = null
    this.clockSamples = []
    this.lastError = null

    if (connection) {
      const eventReader = connection.eventReader
      const audioReader = connection.audioReader
      const nextAudioReader = connection.nextAudioReader
      connection.eventReader = null
      connection.audioReader = null
      connection.activeAudioStreamId = null
      connection.nextAudioReader = null
      connection.nextAudioStreamId = null
      connection.eventGeneration += 1
      connection.audioGeneration += 1
      connection.nextAudioGeneration += 1

      // Detach and abort every fetch before waiting on reader cancellation. Some Web Streams
      // implementations can leave cancel() pending indefinitely after a broken network path; all
      // cancellation attempts still need to start, and receiver shutdown bounds this promise.
      try { connection.abortController.abort() } catch { /* ignore */ }
      this.emitStatus()

      const cleanup: Array<Promise<unknown>> = []
      const startCleanup = (operation: () => unknown): void => {
        try {
          cleanup.push(Promise.resolve(operation()))
        } catch {
          // A synchronous cleanup failure is best-effort, like a rejected cancellation.
        }
      }
      startCleanup(() => connection.dispatcher.close())
      if (eventReader) startCleanup(() => eventReader.cancel())
      if (audioReader) startCleanup(() => audioReader.cancel())
      if (nextAudioReader) startCleanup(() => nextAudioReader.cancel())
      await Promise.allSettled(cleanup)
      return
    }
    this.emitStatus()
  }

  async publishTelemetry(telemetry: ParallaxSinkTelemetry): Promise<void> {
    if (!this.connection) return
    await this.fetchSinkJson('/v1/parallax/telemetry', {
      method: 'POST',
      body: JSON.stringify(telemetry)
    }).catch((error) => {
      if (isAbortLikeError(error)) return
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return
      }
      this.lastError = error instanceof Error ? error.message : 'Failed to publish Parallax telemetry.'
      this.emitStatus()
    })
  }

  /** Sink-initiated unpair notification; best-effort, local forget succeeds regardless. */
  async forgetOnHost(): Promise<void> {
    if (!this.connection) return
    await this.fetchSinkJson('/v1/parallax/sink/forget', { method: 'POST' }).catch(() => undefined)
  }

  private handleAuthRevoked(): void {
    void this.disconnect()
    this.lastError = 'Removed by host.'
    this.emitStatus()
    this.callbacks.onAuthRevoked()
  }

  private async fetchSinkJsonResponse<T = unknown>(
    path: string,
    init: UndiciRequestInit = {}
  ): Promise<ParallaxJsonResponse<T>> {
    const connection = this.connection
    if (!connection) {
      throw new Error('Parallax sink is not connected.')
    }
    const response = await undiciFetch(`${connection.baseUrl}${path}`, {
      ...init,
      dispatcher: connection.dispatcher,
      signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS)]),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(init.headers ?? {})
      }
    } as ParallaxFetchInit)
    const payload = await readBoundedJsonResponse<unknown>(response).catch(() => null)
    if (!response.ok) {
      const message = toSafeOptionalString((payload as { error?: unknown } | null)?.error)
        ?? `Parallax host request failed (${response.status}).`
      if (response.status === 401) {
        throw new ParallaxAuthError(401, message)
      }
      throw new Error(message)
    }
    return {
      value: payload as T,
      httpStatus: response.status,
      contentType: response.headers.get('content-type')?.trim() || null
    }
  }

  private async fetchSinkJson<T = unknown>(path: string, init: UndiciRequestInit = {}): Promise<T> {
    return (await this.fetchSinkJsonResponse<T>(path, init)).value
  }

  private async fetchValidatedJoin(
    expectedSinkId: string,
    joinPhase: ParallaxJoinPhase
  ): Promise<ParallaxJoinResponse> {
    const response = await this.fetchSinkJsonResponse<unknown>('/v1/parallax/join', {
      method: 'POST',
      body: JSON.stringify({ sinkId: expectedSinkId })
    })
    const validation = validateParallaxJoinResponse(response.value, expectedSinkId)
    if (validation.ok) return validation.value

    const diagnostic = buildParallaxJoinValidationDiagnostic({
      value: response.value,
      expectedSinkId,
      joinPhase,
      reason: validation.reason,
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      softwareVersion: this.callbacks.softwareVersion ?? 'unknown'
    })
    if (this.callbacks.onDiagnostic) {
      this.callbacks.onDiagnostic(diagnostic)
    } else {
      console.error(`[astra-receiver] Parallax join validation failed: ${JSON.stringify(diagnostic)}`)
    }
    throw new Error(`Parallax host returned an invalid join response (${validation.reason}).`)
  }

  // ── Zone Display artwork (§14.1.4 / §19.18(e) port) ──────────────────────────
  // Pull-based: the status/display page polls at 1 Hz; the first poll after a stream change
  // misses the cache and kicks a background fetch, the next poll serves it. This deliberately
  // touches none of the join/promote/stream-start machinery.

  // ── Phase-3 transport lane (play/pause/skip pushed to the host) ──────────────

  getControlSupported(): boolean | null {
    return this.controlSupported
  }

  async sendControl(command: 'toggle-play' | 'next' | 'previous'): Promise<'ok' | 'unsupported' | 'failed'> {
    const connection = this.connection
    if (!connection) return 'failed'
    try {
      const response = await undiciFetch(`${connection.baseUrl}/v1/parallax/control`, {
        method: 'POST',
        dispatcher: connection.dispatcher,
        signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS)]),
        headers: {
          Authorization: `Bearer ${connection.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command })
      } as ParallaxFetchInit)
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404) {
        this.controlSupported = false
        return 'unsupported'
      }
      if (!response.ok) return 'failed'
      this.controlSupported = true
      return 'ok'
    } catch {
      return 'failed'
    }
  }

  getActiveArtwork(): { streamId: string; contentType: string; bytes: Buffer } | null {
    const stream = this.activeStream
    if (!stream || !this.connection) return null
    const cached = this.artworkCache.get(stream.streamId)
    if (cached === undefined) {
      void this.fetchArtwork(stream.streamId)
      return null
    }
    return cached ? { streamId: stream.streamId, ...cached } : null
  }

  private async fetchArtwork(streamId: string): Promise<void> {
    if (this.artworkFetchesInFlight.has(streamId)) return
    const connection = this.connection
    if (!connection) return
    this.artworkFetchesInFlight.add(streamId)
    try {
      const response = await undiciFetch(
        `${connection.baseUrl}/v1/parallax/artwork/current?streamId=${encodeURIComponent(streamId)}`,
        {
          dispatcher: connection.dispatcher,
          signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS)]),
          headers: { Authorization: `Bearer ${connection.token}` }
        } as ParallaxFetchInit
      )
      if (!response.ok) {
        // The host has no artwork for this stream — remember that so we stop asking.
        this.artworkCache.set(streamId, null)
        return
      }
      const contentType = response.headers.get('content-type')?.trim() || 'image/jpeg'
      const bytes = await readBoundedBytesResponse(response, SINK_ARTWORK_MAX_BYTES)
      this.artworkCache.set(streamId, bytes.byteLength > 0 ? { contentType, bytes } : null)
      while (this.artworkCache.size > SINK_ARTWORK_CACHE_MAX) {
        const oldest = this.artworkCache.keys().next().value
        if (oldest === undefined) break
        this.artworkCache.delete(oldest)
      }
    } catch {
      // Transient (timeout, reconnect) — stay uncached so the next poll retries.
    } finally {
      this.artworkFetchesInFlight.delete(streamId)
    }
  }

  // ── Clock sync + liveness watchdogs ──────────────────────────────────────────

  private async primeClockSync(connection: SinkConnectionState): Promise<void> {
    for (let index = 0; index < CLOCK_PRIMING_PROBES; index += 1) {
      if (this.connection !== connection) return
      const isLast = index === CLOCK_PRIMING_PROBES - 1
      const ok = await this.runClockProbe(isLast)
      if (this.connection !== connection) return
      if (!ok) break
      if (!isLast) {
        await new Promise<void>((resolve) => setTimeout(resolve, CLOCK_PRIMING_INTERVAL_MS))
      }
    }
    if (this.connection !== connection) return
    this.startClockSync()
  }

  private startClockSync(): void {
    this.stopClockSync()
    this.lastHostContactAtMs = Date.now()
    this.clockTimer = setInterval(() => {
      void this.runClockProbe()
    }, CLOCK_SYNC_INTERVAL_MS)
    this.clockTimer.unref?.()
    this.startAudioStallWatchdog()
    this.startHostSilenceWatchdog()
  }

  private stopClockSync(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer)
      this.clockTimer = null
    }
    this.stopAudioStallWatchdog()
    this.stopHostSilenceWatchdog()
  }

  private async runClockProbe(emit = true): Promise<boolean> {
    const connection = this.connection
    if (!connection) return false
    const sinkSentAtMs = parallaxNowMs()
    try {
      const response = await this.fetchSinkJson('/v1/parallax/clock', {
        method: 'POST',
        body: JSON.stringify({ sinkSentAtMs })
      })
      if (this.connection !== connection) return false
      const sample = buildParallaxClockSample(
        response as { sinkSentAtMs: number; hostReceivedAtMs: number; hostSentAtMs: number },
        parallaxNowMs()
      )
      this.clockSamples = [...this.clockSamples, sample].slice(-PARALLAX_CLOCK_SAMPLE_LIMIT)
      this.lastError = null
      this.lastHostContactAtMs = Date.now()
      if (emit) this.emitStatus()
      return true
    } catch (error) {
      if (this.connection !== connection) return false
      if (isAbortLikeError(error) || isTimeoutError(error)) return false
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return false
      }
      this.lastError = error instanceof Error ? error.message : 'Parallax clock sync failed.'
      this.emitStatus()
      return false
    }
  }

  private startHostSilenceWatchdog(): void {
    this.stopHostSilenceWatchdog()
    this.livenessTimer = setInterval(() => this.checkHostSilence(), PARALLAX_HOST_SILENCE_CHECK_MS)
    this.livenessTimer.unref?.()
  }

  private stopHostSilenceWatchdog(): void {
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private checkHostSilence(): void {
    const connection = this.connection
    if (!connection) return
    if (this.reconnectTimer !== null) return
    if (Date.now() - this.lastHostContactAtMs <= PARALLAX_HOST_SILENCE_MS) return
    this.lastHostContactAtMs = Date.now()
    void this.reconnect(connection)
  }

  private startAudioStallWatchdog(): void {
    this.stopAudioStallWatchdog()
    this.lastAudioChunkAtMs = Date.now()
    this.audioStallTimer = setInterval(() => this.checkAudioStall(), PARALLAX_AUDIO_STALL_CHECK_MS)
    this.audioStallTimer.unref?.()
  }

  private stopAudioStallWatchdog(): void {
    if (this.audioStallTimer !== null) {
      clearInterval(this.audioStallTimer)
      this.audioStallTimer = null
    }
  }

  private checkAudioStall(): void {
    const connection = this.connection
    const stream = this.activeStream
    if (!connection || !stream || !connection.activeAudioStreamId) return
    if (this.timeline?.playbackState !== 'playing') return
    if (Date.now() - this.lastAudioChunkAtMs <= PARALLAX_AUDIO_STALL_MS) return
    this.lastAudioChunkAtMs = Date.now()
    void this.consumeSinkAudio(stream.streamId, this.timeline?.startFrame ?? 0, true)
  }

  // ── Reconnect ────────────────────────────────────────────────────────────────

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private scheduleReconnect(connection: SinkConnectionState, reason: string): void {
    if (this.connection !== connection) return
    if (this.reconnectTimer !== null) return

    const normalizedReason = reason.trim().replace(/\.+$/, '') || 'Parallax connection interrupted'
    const attempt = this.reconnectAttempts + 1
    this.reconnectAttempts = attempt
    const delay = Math.min(
      SINK_AUTO_RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 5),
      SINK_RECONNECT_MAX_DELAY_MS
    )
    this.lastError = `${normalizedReason}. Reconnecting…`
    this.emitStatus()

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.connection !== connection) return
      void this.reconnect(connection)
    }, delay)
  }

  private async reconnect(connection: SinkConnectionState): Promise<void> {
    if (this.connection !== connection) return

    this.stopClockSync()
    this.clockSamples = []
    connection.eventGeneration += 1
    connection.audioGeneration += 1
    connection.nextAudioGeneration += 1
    connection.activeAudioStreamId = null
    connection.nextAudioStreamId = null

    const previousAbortController = connection.abortController
    const eventReader = connection.eventReader
    const audioReader = connection.audioReader
    const nextAudioReader = connection.nextAudioReader
    connection.eventReader = null
    connection.audioReader = null
    connection.nextAudioReader = null
    connection.abortController = new AbortController()

    try { previousAbortController.abort() } catch { /* ignore */ }
    try { await eventReader?.cancel() } catch { /* ignore */ }
    try { await audioReader?.cancel() } catch { /* ignore */ }
    try { await nextAudioReader?.cancel() } catch { /* ignore */ }
    if (this.connection !== connection) return

    this.emitStatus()

    try {
      // After repeated failures against the persisted address, the host likely moved (new DHCP
      // lease after sleep/wake). Ask the daemon to relocate it via mDNS by endpoint UUID.
      if (this.reconnectAttempts >= PARALLAX_RELOCATE_AFTER_ATTEMPTS && this.callbacks.onRelocate) {
        const relocatedBaseUrl = await this.callbacks.onRelocate()
        if (this.connection !== connection) return
        if (relocatedBaseUrl) {
          const normalized = sanitizeHostBaseUrl(relocatedBaseUrl)
          if (normalized && normalized !== connection.baseUrl) {
            connection.baseUrl = normalized
            this.reconnectAttempts = 0
          }
        }
      }
      // Reconverge the clock BEFORE rejoining so the join timeline applies with a fresh offset.
      await this.primeClockSync(connection)
      if (this.connection !== connection) return

      const join = await this.fetchValidatedJoin(connection.sinkId, 'reconnect')
      if (this.connection !== connection) return
      this.reconnectAttempts = 0
      this.playbackEnabled = join.playbackEnabled
      this.activeStream = join.stream
      this.lastError = null
      this.emitStatus()
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        this.timeline = join.timeline
        this.callbacks.onEvent({
          type: 'stream-start',
          stream: join.stream,
          timeline: join.timeline,
          emittedAtHostTimeMs: join.hostTimeMs
        })
        void this.consumeSinkAudio(join.stream.streamId, join.timeline.startFrame, true)
      }
      if (join.nextStream && join.nextTimeline) {
        this.pendingStream = join.nextStream
        this.pendingTimeline = join.nextTimeline
        this.callbacks.onEvent({
          type: 'next-stream-start',
          stream: join.nextStream,
          timeline: join.nextTimeline,
          emittedAtHostTimeMs: join.hostTimeMs
        })
        void this.consumeSinkNextAudio(join.nextStream.streamId, join.nextTimeline.startFrame)
      }
    } catch (error) {
      if (this.connection !== connection) return
      if (isAbortLikeError(error)) return
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return
      }
      const message = error instanceof Error ? error.message : 'Parallax reconnect failed.'
      this.lastError = `Parallax reconnect failed: ${message}`
      this.emitStatus()
      this.scheduleReconnect(connection, this.lastError)
    }
  }

  // ── SSE control channel ──────────────────────────────────────────────────────

  private setSseConnected(connected: boolean): void {
    if (connected) {
      if (this.hostLostTimer) {
        clearTimeout(this.hostLostTimer)
        this.hostLostTimer = null
      }
      if (!this.hostReachable) {
        this.hostReachable = true
        this.emitStatus()
      }
      return
    }
    if (this.hostLostTimer || !this.hostReachable) return
    this.hostLostTimer = setTimeout(() => {
      this.hostLostTimer = null
      if (!this.connection) return
      this.hostReachable = false
      this.emitStatus()
    }, PARALLAX_HOST_LOST_MS)
  }

  private async consumeSinkEvents(): Promise<void> {
    const connection = this.connection
    if (!connection) return
    if (connection.eventReader) return
    connection.eventGeneration += 1
    const eventGeneration = connection.eventGeneration
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const response = await undiciFetch(`${connection.baseUrl}/v1/parallax/events`, {
        method: 'GET',
        dispatcher: connection.dispatcher,
        signal: connection.abortController.signal,
        headers: { Authorization: `Bearer ${connection.token}` }
      } as ParallaxFetchInit)
      if (!response.ok || !response.body) {
        if (response.status === 401) {
          throw new ParallaxAuthError(401, 'Parallax event stream unauthorized.')
        }
        throw new Error(`Parallax event stream failed (${response.status}).`)
      }

      reader = response.body.getReader()
      if (this.connection !== connection || connection.eventGeneration !== eventGeneration) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.eventReader = reader
      this.lastError = null
      this.setSseConnected(true)
      this.emitStatus()
      const decoder = new TextDecoder()
      let buffer = ''
      while (this.connection === connection && connection.eventGeneration === eventGeneration) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary)
          if (Buffer.byteLength(rawEvent, 'utf8') > PARALLAX_MAX_SSE_EVENT_BYTES) {
            throw new Error('Parallax host sent an oversized event.')
          }
          buffer = buffer.slice(boundary + 2)
          this.handleRawSseEvent(rawEvent)
          boundary = buffer.indexOf('\n\n')
        }
        if (Buffer.byteLength(buffer, 'utf8') > PARALLAX_MAX_SSE_EVENT_BYTES) {
          throw new Error('Parallax host sent an oversized event.')
        }
      }
      if (this.connection === connection && connection.eventGeneration === eventGeneration) {
        if (connection.eventReader === reader) connection.eventReader = null
        this.setSseConnected(false)
        setTimeout(() => {
          if (
            this.connection === connection
            && connection.eventGeneration === eventGeneration
            && connection.eventReader === null
          ) {
            void this.consumeSinkEvents()
          }
        }, STATUS_RETRY_DELAY_MS).unref?.()
      }
    } catch (error) {
      if (this.connection !== connection || connection.eventGeneration !== eventGeneration) return
      if (connection.eventReader === reader) connection.eventReader = null
      if (!isAbortLikeError(error)) this.setSseConnected(false)
      if (isAbortLikeError(error)) {
        setTimeout(() => {
          if (
            this.connection === connection
            && connection.eventGeneration === eventGeneration
            && connection.eventReader === null
          ) {
            void this.consumeSinkEvents()
          }
        }, STATUS_RETRY_DELAY_MS).unref?.()
        return
      }
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return
      }
      const message = error instanceof Error ? error.message : 'Parallax event stream disconnected.'
      this.scheduleReconnect(connection, message)
    }
  }

  private handleRawSseEvent(rawEvent: string): void {
    const dataLine = rawEvent
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
    if (!dataLine) return
    let decoded: unknown
    try {
      decoded = JSON.parse(dataLine.slice('data: '.length))
    } catch {
      return
    }
    const event = parseParallaxTimelineEvent(decoded)
    if (!event) return
    this.lastHostContactAtMs = Date.now()

    if (event.type === 'stream-start') {
      this.activeStream = event.stream
      this.timeline = event.timeline
      // §21. A fresh stream supersedes any in-flight gapless handoff.
      this.pendingStream = null
      this.pendingTimeline = null
      this.cancelSinkNextAudio(null)
      this.emitStatus()
      void this.consumeSinkAudio(event.stream.streamId, event.timeline.startFrame, true)
    } else if (event.type === 'sink-playback-update') {
      if (this.connection?.sinkId !== event.sinkId) return
      this.playbackEnabled = event.playbackEnabled
      this.emitStatus()
    } else if (event.type === 'timeline') {
      this.timeline = event.timeline
      this.lastAudioChunkAtMs = Date.now()
      if (event.resetAudio && this.activeStream?.streamId === event.timeline.streamId) {
        void this.consumeSinkAudio(event.timeline.streamId, event.timeline.startFrame, true)
      }
    } else if (event.type === 'next-stream-start') {
      // §21. Pre-fetch the pre-announced next stream's audio concurrently with the current one.
      this.pendingStream = event.stream
      this.pendingTimeline = event.timeline
      void this.consumeSinkNextAudio(event.stream.streamId, event.timeline.startFrame)
    } else if (event.type === 'next-stream-cancel') {
      if (this.pendingStream?.streamId === event.streamId) {
        this.pendingStream = null
        this.pendingTimeline = null
      }
      this.cancelSinkNextAudio(event.streamId)
    } else if (event.type === 'next-stream-promote') {
      this.promotePendingStream(event.streamId)
    } else if (event.type === 'stop') {
      this.activeStream = null
      this.timeline = null
      this.pendingStream = null
      this.pendingTimeline = null
      const connection = this.connection
      if (connection) {
        connection.audioGeneration += 1
        connection.activeAudioStreamId = null
        try { void connection.audioReader?.cancel() } catch { /* ignore */ }
        connection.audioReader = null
      }
      this.cancelSinkNextAudio(null)
      this.emitStatus()
    }

    this.callbacks.onEvent(event)
  }

  // §21. Boundary crossed — the pre-announced next stream becomes primary. Cancel the pre-fetch
  // reader and re-establish the stream in the primary slot from the live frame (the host keeps
  // streaming it post-boundary). Re-sent backlog is idempotent — the playout engine plays by
  // absolute frame, so duplicate frames don't glitch. The session hears the same promote event
  // (dispatched after this) and swaps its staged engine in as the active one.
  private promotePendingStream(streamId: string): void {
    if (this.pendingStream?.streamId !== streamId) return
    this.activeStream = this.pendingStream
    this.timeline = this.pendingTimeline
    this.pendingStream = null
    this.pendingTimeline = null
    this.cancelSinkNextAudio(streamId)
    const resumeFrame = this.getSinkReconnectFrame(streamId, this.timeline?.startFrame ?? 0)
    this.lastAudioChunkAtMs = Date.now()
    this.emitStatus()
    void this.consumeSinkAudio(streamId, resumeFrame, true)
  }

  getPromotedStream(): { stream: ParallaxStreamInfo; timeline: ParallaxTimelineState | null } | null {
    return this.activeStream ? { stream: this.activeStream, timeline: this.timeline } : null
  }

  // ── Audio stream ─────────────────────────────────────────────────────────────

  private getSinkReconnectFrame(streamId: string, fallbackFrame: number): number {
    const activeStream = this.activeStream
    const timeline = this.timeline
    if (!activeStream || activeStream.streamId !== streamId || !timeline || timeline.streamId !== streamId) {
      return Math.max(0, Math.floor(fallbackFrame))
    }
    if (timeline.playbackState !== 'playing') {
      return Math.max(0, Math.min(activeStream.totalFrames, Math.floor(timeline.startFrame)))
    }
    const offsetMs = selectFilteredParallaxClockOffsetMs(this.clockSamples) ?? 0
    const hostNowMs = parallaxNowMs() + offsetMs
    const elapsedMs = Math.max(0, hostNowMs - timeline.startHostTimeMs)
    const liveFrame = timeline.startFrame + Math.floor((elapsedMs * activeStream.sampleRate) / 1000)
    const backfillFrames = Math.floor((PARALLAX_AUDIO_RECONNECT_BACKFILL_MS * activeStream.sampleRate) / 1000)
    return Math.max(0, Math.min(activeStream.totalFrames, liveFrame - backfillFrames))
  }

  private async consumeSinkAudio(streamId: string, fromFrame: number, replace = false): Promise<void> {
    const connection = this.connection
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
      const response = await undiciFetch(
        `${connection.baseUrl}/v1/parallax/audio?streamId=${encodeURIComponent(streamId)}&fromFrame=${requestFromFrame}`,
        {
          method: 'GET',
          dispatcher: connection.dispatcher,
          signal: connection.abortController.signal,
          headers: { Authorization: `Bearer ${connection.token}` }
        } as ParallaxFetchInit
      )
      if (!response.ok || !response.body) {
        if (response.status === 401) {
          throw new ParallaxAuthError(401, 'Parallax audio stream unauthorized.')
        }
        throw new Error(`Parallax audio stream failed (${response.status}).`)
      }

      const reader = response.body.getReader()
      if (this.connection !== connection || connection.activeAudioStreamId !== streamId || connection.audioGeneration !== audioGeneration) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.audioReader = reader
      this.lastError = null
      this.lastAudioChunkAtMs = Date.now()
      this.emitStatus()
      let pending: Uint8Array = new Uint8Array(0)
      while (
        this.connection === connection
        && connection.activeAudioStreamId === streamId
        && connection.audioGeneration === audioGeneration
      ) {
        const { done, value } = await reader.read()
        if (
          this.connection !== connection
          || connection.activeAudioStreamId !== streamId
          || connection.audioGeneration !== audioGeneration
        ) {
          return
        }
        if (done) break
        if (!value) continue
        this.lastAudioChunkAtMs = Date.now()
        this.lastHostContactAtMs = Date.now()
        const received = new Uint8Array(value.byteLength)
        received.set(value)
        pending = mergeBytes(pending, received)
        if (
          pending.byteLength >= PARALLAX_AUDIO_PACKET_HEADER_BYTES
          && !readParallaxAudioPacketHeader(pending)
        ) {
          throw new Error('Parallax host sent an invalid audio packet header.')
        }
        while (true) {
          const decoded = decodeParallaxAudioPacket(pending)
          if (!decoded) break
          pending = pending.slice(decoded.bytesRead)
          this.callbacks.onAudioChunk({ ...decoded.chunk, streamId })
        }
      }
      if (
        this.connection === connection
        && connection.activeAudioStreamId === streamId
        && connection.audioGeneration === audioGeneration
      ) {
        connection.audioReader = null
        connection.activeAudioStreamId = null
        setTimeout(() => {
          if (this.connection === connection && connection.activeAudioStreamId === null) {
            void this.consumeSinkAudio(streamId, fromFrame, true)
          }
        }, STATUS_RETRY_DELAY_MS).unref?.()
      }
    } catch (error) {
      if (
        this.connection !== connection
        || connection.activeAudioStreamId !== streamId
        || connection.audioGeneration !== audioGeneration
      ) return
      connection.audioReader = null
      connection.activeAudioStreamId = null
      if (isAbortLikeError(error)) {
        setTimeout(() => {
          if (this.connection === connection && connection.activeAudioStreamId === null) {
            void this.consumeSinkAudio(streamId, fromFrame, true)
          }
        }, STATUS_RETRY_DELAY_MS).unref?.()
        return
      }
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return
      }
      this.lastError = error instanceof Error ? error.message : 'Parallax audio stream disconnected.'
      this.scheduleReconnect(connection, this.lastError)
    }
  }

  // §21 Gapless sink handoff. A lean second reader that pre-fetches the pre-announced next
  // stream concurrently with the current one. Short-lived (pre-announce → boundary), so unlike
  // consumeSinkAudio it does not auto-reconnect — on the boundary, promotePendingStream cancels
  // it and re-establishes the stream in the primary slot.
  private async consumeSinkNextAudio(streamId: string, fromFrame: number): Promise<void> {
    const connection = this.connection
    if (!connection) return
    if (connection.nextAudioStreamId === streamId && connection.nextAudioReader) return

    connection.nextAudioGeneration += 1
    const audioGeneration = connection.nextAudioGeneration
    connection.nextAudioStreamId = streamId
    try {
      await connection.nextAudioReader?.cancel()
    } catch {
      // Ignore replacement races.
    }
    connection.nextAudioReader = null

    try {
      const requestFromFrame = Math.max(0, Math.floor(fromFrame))
      const response = await undiciFetch(
        `${connection.baseUrl}/v1/parallax/audio?streamId=${encodeURIComponent(streamId)}&fromFrame=${requestFromFrame}`,
        {
          method: 'GET',
          dispatcher: connection.dispatcher,
          signal: connection.abortController.signal,
          headers: { Authorization: `Bearer ${connection.token}` }
        } as ParallaxFetchInit
      )
      if (!response.ok || !response.body) {
        if (response.status === 401) {
          throw new ParallaxAuthError(401, 'Parallax next audio stream unauthorized.')
        }
        throw new Error(`Parallax next audio stream failed (${response.status}).`)
      }

      const reader = response.body.getReader()
      if (
        this.connection !== connection
        || connection.nextAudioStreamId !== streamId
        || connection.nextAudioGeneration !== audioGeneration
      ) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.nextAudioReader = reader
      this.lastHostContactAtMs = Date.now()
      let pending: Uint8Array = new Uint8Array(0)
      while (
        this.connection === connection
        && connection.nextAudioStreamId === streamId
        && connection.nextAudioGeneration === audioGeneration
      ) {
        const { done, value } = await reader.read()
        if (
          this.connection !== connection
          || connection.nextAudioStreamId !== streamId
          || connection.nextAudioGeneration !== audioGeneration
        ) {
          return
        }
        if (done) break
        if (!value) continue
        this.lastHostContactAtMs = Date.now()
        const received = new Uint8Array(value.byteLength)
        received.set(value)
        pending = mergeBytes(pending, received)
        if (
          pending.byteLength >= PARALLAX_AUDIO_PACKET_HEADER_BYTES
          && !readParallaxAudioPacketHeader(pending)
        ) {
          throw new Error('Parallax host sent an invalid next-stream audio packet header.')
        }
        while (true) {
          const decoded = decodeParallaxAudioPacket(pending)
          if (!decoded) break
          pending = pending.slice(decoded.bytesRead)
          this.callbacks.onAudioChunk({ ...decoded.chunk, streamId })
        }
      }
      if (
        this.connection === connection
        && connection.nextAudioStreamId === streamId
        && connection.nextAudioGeneration === audioGeneration
      ) {
        connection.nextAudioReader = null
      }
    } catch (error) {
      if (
        this.connection !== connection
        || connection.nextAudioStreamId !== streamId
        || connection.nextAudioGeneration !== audioGeneration
      ) return
      connection.nextAudioReader = null
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleAuthRevoked()
        return
      }
      // Non-fatal: pre-fetch is best-effort; the boundary promote re-fetches as the primary stream.
    }
  }

  // §21. Stop the pre-fetch reader (skip / seek / queue edit / fresh stream-start / stop). Pass
  // null to cancel whatever next stream is in flight; a streamId cancels only if it matches.
  private cancelSinkNextAudio(streamId: string | null): void {
    const connection = this.connection
    if (!connection) return
    if (streamId !== null && connection.nextAudioStreamId !== streamId) return
    connection.nextAudioGeneration += 1
    connection.nextAudioStreamId = null
    try { void connection.nextAudioReader?.cancel() } catch { /* ignore */ }
    connection.nextAudioReader = null
  }
}
