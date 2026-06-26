import { appendFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { performance } from 'perf_hooks'
import type {
  ParallaxAudioChunk,
  ParallaxClockSample,
  ParallaxConnectedSinkState,
  ParallaxHostConfig,
  ParallaxHostStreamStartOptions,
  ParallaxHostTimelinePublishOptions,
  ParallaxJoinResponse,
  ParallaxIncomingPairRequest,
  ParallaxOutputLatencyMetrics,
  ParallaxPairConfirmBody,
  ParallaxPairConfirmResponse,
  ParallaxPairRequestBody,
  ParallaxPairRequestResponse,
  ParallaxPairedSink,
  ParallaxPairResponse,
  ParallaxPairingPin,
  ParallaxSinkConnectionConfig,
  ParallaxSinkTelemetry,
  ParallaxSinkTrim,
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
  PARALLAX_PAIR_CANDIDATE_TTL_MS,
  ParallaxAuthError,
  buildParallaxClockSample,
  decodeParallaxAudioPacket,
  encodeParallaxAudioPacket,
  selectBestParallaxClockSample,
  selectFilteredParallaxClockOffsetMs
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
// Bound short JSON requests (clock probe, join, pair) so a flaky/again-dropping link can't hang
// them indefinitely. Long-lived event/audio streams are intentionally excluded. Without this, a
// reconnect that awaits clock priming could stall forever on a hung probe instead of retrying.
const SINK_JSON_FETCH_TIMEOUT_MS = 3_000
// Audio-stream stall watchdog. A WiFi blip can leave the long-lived audio stream half-open (no
// FIN/RST), so `reader.read()` hangs forever with no error. If no chunk arrives for
// PARALLAX_AUDIO_STALL_MS while playing, treat it as stalled and re-request the audio stream. Chunks
// normally arrive every ~85 ms and the sink buffers ~3 s, so a ~1.2 s threshold detects the stall
// well before the buffer drains — the buffer masks the gap and playback never cuts out.
const PARALLAX_AUDIO_STALL_MS = 1_200
const PARALLAX_AUDIO_STALL_CHECK_MS = 400
// On reconnect, resume from the live frame minus this backfill so the host replays only a short
// recent backlog (not the whole track) — keeps recovery fast enough to stay inside the buffer.
const PARALLAX_AUDIO_RECONNECT_BACKFILL_MS = 1_000
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
  // OFF-WIRE per-sink targeting (trim test tone). When set, only this sink receives the
  // stream-start event, the /join stream, and the audio chunks.
  targetSinkId?: string
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
  // §14.1.2 follow-up (Codex round 1, finding 1). Fired when an authenticated request to the
  // host returns 401 — main wires this to clearParallaxSinkConnection + cancel auto-reconnect.
  // Covers both initial-connect and in-session paths (event stream, audio stream, clock probe).
  onSinkAuthRevoked?: () => void
  // §14.1.2 follow-up (Codex round 1, finding 3). Read each getStatus() call so the status
  // payload's `sink.hasPersistedConnection` / `sink.persistedHostName` reflect the live
  // app-meta state without the service needing its own copy.
  getSinkConnectionInfo?: () => { hasPersistedConnection: boolean; persistedHostName: string | null }
  // §14.1.4 / §19.18(e) — resolve a track's artwork bytes (as a data URL string) by hash. Wired
  // in main/index.ts to the same `getArtworkThumbnailDataUrlByHash` resolver
  // `playbackHttpCore` / `phoneRemote` use. Service caches the parsed bytes by streamId and
  // serves them at `GET /v1/parallax/artwork/current?streamId=<id>` for the sink Zone Display.
  resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  // §20 / §14.1.5. Sink-role enablement gate, read per status. Service stays ignorant of the
  // meta-key storage layer (mirrors `getSinkConnectionInfo`). Defaults false if not provided.
  getSinkEnabled?: () => boolean
  // §20.19(c). Role-neutral persisted endpoint UUID. Empty string when not yet generated.
  getEndpointUuid?: () => string
  // §20 Commit 3 host-side pair flow. Wizard's pair-request carries this as `hostName` so the
  // sink can display "Studio MacBook wants to pair" on its PIN card. Falls back to a default.
  getHostDisplayName?: () => string
  // §20 Commit 3 sink side. Lets the service include the live incoming-pair state in the status
  // payload without owning the listener — main holds the listener instance, the service just
  // reads its current state every getStatus(). Mirror pattern of `getSinkConnectionInfo`.
  getIncomingPairRequest?: () => ParallaxIncomingPairRequest | null
}

function parallaxNowMs(): number {
  return performance.timeOrigin + performance.now()
}

// §20 Commit 3. Trim-and-string helper for pair-confirm/pair-request response parsing where
// fields may be undefined / non-string / whitespace.
function pickStringTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// §14.1.4 / §19.18(e). Local parser; intentionally not imported from playbackHttpCore (the helper
// there is module-private and we want zero coupling between unrelated services). Caps payload to
// keep an oversized artwork from inflating SSE/HTTP traffic.
const PARALLAX_ARTWORK_MAX_BYTES = 4 * 1024 * 1024
function parseParallaxArtworkDataUrl(
  artworkData: string | null | undefined
): { mimeType: string; bytes: Buffer } | null {
  if (typeof artworkData !== 'string') return null
  const normalized = artworkData.trim()
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(normalized)
  if (!match) return null
  const mimeType = match[1].toLowerCase()
  const base64Payload = match[2].replace(/\s+/g, '')
  if (base64Payload.length === 0 || base64Payload.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) return null
  const bytes = Buffer.from(base64Payload, 'base64')
  if (bytes.length === 0 || bytes.length > PARALLAX_ARTWORK_MAX_BYTES) return null
  if (bytes.toString('base64') !== base64Payload) return null
  return { mimeType, bytes }
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

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return ('name' in error ? String(error.name) : '') === 'TimeoutError'
}

// Phase 0 diagnostics: when PARALLAX_TELEM_LOG=<path> is set on the HOST, append each received sink
// telemetry report as a CSV row, joined with the host's own latency signals + a derived
// acoustic-drift estimate, so we can correlate the sink's internal drift/RTT/ppm/latency against an
// acoustic measurement (the chirp rig). No effect unless the env var is set.
let parallaxTelemetryLogStarted = false
function csvNum(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
// §14.1.1 CSV writer escape — output device labels can contain commas, quotes, and newlines
// ("External Headphones, MacBook Pro" is a real example). Wrap in double quotes and escape
// embedded quotes per RFC 4180 only when needed; plain alphanumeric labels stay unquoted so
// the CSV remains diff-friendly for the common case.
function csvStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (!s) return ''
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
function appendParallaxTelemetryLog(
  body: unknown,
  hostMetrics: ParallaxOutputLatencyMetrics | null,
  _sampleRate: number | null,
  // §14.1.1 follow-up. Host's persisted desired trim for the sink's currently-reported output
  // device, looked up by the caller (route handler) since this helper is module-level and the
  // pairedSinks store lives on the service instance. Null when the body has no outputDeviceId
  // yet (first telemetry from a freshly-connected sink) or no paired sink matched.
  desiredAdvanceMs: number | null = null
): void {
  const path = process.env.PARALLAX_TELEM_LOG
  if (!path || !body || typeof body !== 'object') return
  const t = body as Partial<ParallaxSinkTelemetry>
  // `acoustic_drift_frames` column was a Phase 0 prediction (write drift − output-latency difference)
  // and became misleading once Phase 1 step 5 made the loop directly target acoustic sync. Dropped
  // per share doc §8. Phase 2A columns are the new source of truth for acoustic-domain telemetry.
  try {
    if (!parallaxTelemetryLogStarted) {
      appendFileSync(
        path,
        'host_recv_ms,reported_ms,drift_frames,rtt_ms,ppm,buffered_ms,underruns,' +
          'sink_out_lat_ms,sink_base_lat_ms,sink_ts_lat_ms,' +
          'host_out_lat_ms,host_base_lat_ms,host_ts_lat_ms,' +
          'rebuffering,starved_frames,' +
          // Phase 2A — host-output-clock reference predictor diagnostics. host_ref_age_ms is how
          // stale the latest valid anchor was at the sink's report instant; host_ref_rate_ppm is
          // the Theil-Sen-filtered slope; host_ref_rate_raw_ppm is the last pairwise Δframe/Δt, for
          // validating that the filter is doing work. phase2_drift_frames is the candidate signal
          // Phase 2B will steer against; logged-only here.
          'host_ref_age_ms,host_ref_rate_ppm,host_ref_rate_raw_ppm,host_ref_frame,' +
          'sink_acoustic_frame,host_acoustic_frame,phase2_drift_frames,' +
          // Phase 2B (§13.2) — which branch produced the drift the loop steered against:
          // 'predictor' (predictor active + gates passed), 'phase1' (nominal fallback),
          // 'hold' (no usable signal: clock offset missing, stopped, or first tick).
          'loop_source,' +
          // Phase 2B §13.4 follow-up — explicit per-tick hard-sync marker, removes the need to
          // infer snap firings from ppm=0 + snap-sized drift after the handoff settle removal.
          // sync_event = 'snap' / 'rebuffer_snap' / '' ; hard_sync_count is monotonic over the
          // sink session (resets on disconnect, not on stream-start).
          'sync_event,hard_sync_count,' +
          // §14.1.1 — sink-side echo so the rig can verify "did the trim reach the sink's
          // AudioEngine?" directly, instead of inferring from drift jumps. applied_advance_ms
          // mirrors `audioEngine.getParallaxSinkAdvanceMs()`; output_device_id / _label show the
          // sink's reported device identity so a 0 -> trim -> 0 toggle is unambiguous in the CSV.
          // §14.1.1 follow-up (Codex round 3) — desired_advance_ms is the host's persisted
          // intent for the sink's current device. A divergence between desired and applied is
          // the visible footprint of the edge-trigger delivery bug we hit during the toggle
          // test (host wanted 12, sink stuck at 5) and the marker the new self-healing
          // resends should clear within a few seconds.
          'applied_advance_ms,desired_advance_ms,output_device_id,output_device_label\n'
      )
      parallaxTelemetryLogStarted = true
    }
    appendFileSync(
      path,
      `${Date.now()},${csvNum(t.reportedAtMs)},${csvNum(t.driftFrames)},${csvNum(t.rttMs)},` +
        `${csvNum(t.playbackRatePpm)},${csvNum(t.bufferedMs)},${csvNum(t.underruns)},` +
        `${csvNum(t.outputLatencyMs)},${csvNum(t.baseLatencyMs)},${csvNum(t.timestampLatencyMs)},` +
        `${csvNum(hostMetrics?.outputLatencyMs)},${csvNum(hostMetrics?.baseLatencyMs)},${csvNum(hostMetrics?.timestampLatencyMs)},` +
        `${t.rebuffering ? 1 : 0},${csvNum(t.starvedFrames)},` +
        `${csvNum(t.hostRefAgeMs)},${csvNum(t.hostRefRatePpm)},${csvNum(t.hostRefRateRawPpm)},${csvNum(t.hostRefFrame)},` +
        `${csvNum(t.sinkAcousticFrame)},${csvNum(t.hostAcousticFrame)},${csvNum(t.phase2DriftFrames)},` +
        `${t.loopSource ?? ''},${t.syncEvent ?? ''},${csvNum(t.hardSyncCount)},` +
        `${csvNum(t.appliedAdvanceMs)},${csvNum(desiredAdvanceMs)},${csvStr(t.outputDeviceId)},${csvStr(t.outputDeviceLabel)}\n`
    )
  } catch {
    /* diagnostics best-effort */
  }
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
  private readonly onSinkAuthRevoked?: () => void
  private readonly getSinkConnectionInfo?: () => { hasPersistedConnection: boolean; persistedHostName: string | null }
  // §14.1.4 / §19.18(e) — artwork-resolver callback + per-stream parsed-bytes cache. Filled on
  // publishHostStreamStart when an artworkHash is provided. Cleared on stream stop or when a new
  // streamId arrives. Served binary at `GET /v1/parallax/artwork/current?streamId=<id>`.
  private readonly resolveArtworkDataUrl?: (artworkHash: string) => Promise<string | null>
  private readonly getSinkEnabled?: () => boolean
  private readonly getEndpointUuid?: () => string
  private readonly getHostDisplayName?: () => string
  private readonly getIncomingPairRequest?: () => ParallaxIncomingPairRequest | null
  // §20 Commit 3. Host-side pre-staged candidates from `initiatePair`. Keyed by pairingId.
  // Cleared on activation, explicit cancel, or TTL expiry. Tokens here are raw — they move
  // into `pairedSinks` as tokenHash + tokenPrefix only on successful `submitPairPin`.
  private readonly pendingPairs = new Map<string, {
    sinkId: string
    token: string
    sinkBaseUrl: string
    sinkParallaxEndpointUuid: string | null
    sinkName: string
    createdAtMs: number
    expiresAtMs: number
    expiryTimer: ReturnType<typeof setTimeout>
  }>()
  private currentStreamArtwork: { streamId: string; mimeType: string; bytes: Buffer } | null = null
  // Codex finding 1 (high): the sink fetches artwork immediately when stream-start arrives, but
  // the host's hash→bytes resolve is async — a race could have the endpoint return 404 before the
  // resolve filled the cache. Store the in-flight promise per streamId so the route handler can
  // await it before answering. Bounded by PARALLAX_ARTWORK_FETCH_WAIT_TIMEOUT_MS so a slow/stuck
  // resolver can't hold an HTTP connection open indefinitely.
  private pendingStreamArtwork: { streamId: string; promise: Promise<void> } | null = null
  private readonly PARALLAX_ARTWORK_FETCH_WAIT_TIMEOUT_MS = 3_000
  // §14.1.2 follow-up. Latched true when handleSinkAuthRevoked() fires; cleared on next
  // successful connect (initial or reconnect). Surfaced via `getStatus().sink.removedByHost`
  // so the UI can show "Removed by host" instead of generic auth-error text.
  private sinkRemovedByHost = false

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
  private sinkTimeline: ParallaxTimelineState | null = null
  private sinkLastError: string | null = null
  private lastAudioChunkAtMs = 0
  private audioStallTimer: ReturnType<typeof setInterval> | null = null
  // Phase 0 diagnostics: latest output-latency signals reported by the host renderer (this machine).
  private lastHostLatencyMetrics: ParallaxOutputLatencyMetrics | null = null

  // §14.1.1 / §15 — per-connected-sink ephemeral state. Keyed by sinkId. Online state mirrors
  // sseClients presence; the rest is mirrored from `publishSinkTelemetry` POSTs. Replaced on
  // reconnect; pruned when both SSE clients for a sink disconnect.
  private readonly connectedSinkStates = new Map<string, ParallaxConnectedSinkState>()
  // §14.1.1 follow-up (Codex 2026-06-06): trim delivery is level-triggered, not edge-triggered.
  // `ingestSinkTelemetry` checks `appliedAdvanceMs` against the persisted desired value and
  // resends when they differ, so a missed SSE event or half-dead control stream self-heals on the
  // next telemetry tick. Rate-limited to once per `TRIM_RESEND_MIN_INTERVAL_MS` per (sinkId,
  // outputDeviceId) so a sink that's persistently stuck doesn't get hammered every second.
  // Storage key: `${sinkId}|${outputDeviceId}`.
  private readonly lastTrimResendAtMs = new Map<string, number>()
  private readonly TRIM_RESEND_MIN_INTERVAL_MS = 3_000
  private readonly TRIM_APPLIED_TOLERANCE_MS = 0.5

  constructor(options: ParallaxServiceOptions) {
    this.config = { ...options.config }
    this.pairedSinks = [...(options.pairedSinks ?? [])]
    this.onPairedSinksChange = options.onPairedSinksChange
    this.onStatusChange = options.onStatusChange
    this.onSinkEvent = options.onSinkEvent
    this.onSinkAudioChunk = options.onSinkAudioChunk
    this.onSinkAuthRevoked = options.onSinkAuthRevoked
    this.getSinkConnectionInfo = options.getSinkConnectionInfo
    this.resolveArtworkDataUrl = options.resolveArtworkDataUrl
    this.getSinkEnabled = options.getSinkEnabled
    this.getEndpointUuid = options.getEndpointUuid
    this.getHostDisplayName = options.getHostDisplayName
    this.getIncomingPairRequest = options.getIncomingPairRequest
  }

  getStatus(): ParallaxStatus {
    this.cleanupExpiredPairingPin()
    const lanUrls = this.active ? getParallaxLanUrls(this.config.port) : []
    const bestClock = selectBestParallaxClockSample(this.sinkClockSamples)
    const activePairedSinkIds = new Set(
      this.pairedSinks
        .filter((sink) => sink.revokedAt === null)
        .map((sink) => sink.id)
    )
    // Robust offset for everything that *acts* on it (drift formula via resolveHostNowMs, reconnect
    // frame math). bestClock still drives the rttMs display since that's a diagnostic for the best
    // single probe, not a steady-state value.
    const filteredOffsetMs = selectFilteredParallaxClockOffsetMs(this.sinkClockSamples)
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
        lastError: this.lastError,
        // §14.1.1. Snapshot copies so the renderer never mutates internal state. Revoked pairings
        // are filtered out defensively; their last connected-state row is historical noise, not
        // a current host-side presence item.
        connectedSinks: Array.from(this.connectedSinkStates.values())
          .filter((state) => activePairedSinkIds.has(state.sinkId))
          .map((state) => ({ ...state })),
        outputLatencyMs: this.lastHostLatencyMetrics?.outputLatencyMs ?? null,
        baseLatencyMs: this.lastHostLatencyMetrics?.baseLatencyMs ?? null,
        timestampLatencyMs: this.lastHostLatencyMetrics?.timestampLatencyMs ?? null
      },
      sink: {
        connected: sinkConnected,
        baseUrl: this.sinkConnection?.baseUrl ?? null,
        sinkId: this.sinkConnection?.sinkId ?? null,
        activeStream: this.sinkActiveStream,
        clockOffsetMs: filteredOffsetMs ?? bestClock?.offsetMs ?? null,
        rttMs: bestClock?.rttMs ?? null,
        lastError: this.sinkLastError,
        // §14.1.2 follow-up. Live mirror of the sink-side credential — never the token itself,
        // just enough for the UI to gate Connect/Forget visibility + display the paired host's
        // name. Pulled per-call via the constructor-supplied getter so the service stays
        // ignorant of the app-meta storage layer.
        hasPersistedConnection: this.getSinkConnectionInfo?.().hasPersistedConnection ?? false,
        persistedHostName: this.getSinkConnectionInfo?.().persistedHostName ?? null,
        removedByHost: this.sinkRemovedByHost,
        // §20 Commit 1. Surfaced to the renderer so the Settings toggle, ZoneDisplay copy, and
        // wizard host-opt-in prompt can subscribe through the existing status push.
        sinkEnabled: this.getSinkEnabled?.() ?? false,
        // §20 Commit 3. Sink listener's live pending pair-request, pushed into the renderer for
        // the PIN card (Commit 4). Null when idle.
        incomingPairRequest: this.getIncomingPairRequest?.() ?? null
      },
      identity: {
        endpointUuid: this.getEndpointUuid?.() ?? ''
      }
    }
  }

  // §14.1.2 follow-up (Codex round 1, finding 1). Single funnel for "credential is dead";
  // disconnects, latches the UI flag, fires the callback, emits status. The callers (event
  // stream, audio stream, clock probe, scheduled reconnect, initial connect) just need to
  // surface ParallaxAuthError up to their catch and call this.
  //
  // §14.1.2 follow-up (Codex round 2, finding 3). Ordering matters: `disconnectSink()` clears
  // `sinkLastError`, so set it AFTER disconnect. `sinkRemovedByHost` is its own latch and is
  // preserved across disconnect (only cleared on next successful connect), so the headline
  // status survived the bug — but the detail error string didn't.
  private handleSinkAuthRevoked(): void {
    this.sinkRemovedByHost = true
    void this.disconnectSink()
    this.sinkLastError = 'Removed by host. Re-pair to reconnect.'
    this.onSinkAuthRevoked?.()
    this.emitStatus()
  }

  listPairedSinks(): ParallaxPairedSink[] {
    return this.pairedSinks
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((sink) => this.toPublicPairedSink(sink))
  }

  private toPublicPairedSink(sink: PersistedParallaxPairedSink): ParallaxPairedSink {
    return {
      id: sink.id,
      name: sink.name,
      tokenPrefix: sink.tokenPrefix,
      createdAt: sink.createdAt,
      lastSeenAt: sink.lastSeenAt,
      revokedAt: sink.revokedAt,
      // §14.1.1. Trim list passes through so the renderer can preload existing values into the
      // stepper for any sink/device the user has already trimmed.
      trims: sink.trims ? sink.trims.map((trim) => ({ ...trim })) : [],
      // §20.19(g) / Codex round 1 finding (medium): without forwarding this, Commit 4's
      // "Already paired" badge cannot match a discovered TXT UUID against the host's paired
      // sinks even though the schema persists it.
      ...(sink.remoteParallaxEndpointUuid ? { remoteParallaxEndpointUuid: sink.remoteParallaxEndpointUuid } : {})
    }
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
    this.connectedSinkStates.delete(id)
    this.emitPairedSinksChange()
    this.emitStatus()
    return this.toPublicPairedSink(sink)
  }

  renamePairedSink(id: string, name: string): ParallaxPairedSink | null {
    const sink = this.pairedSinks.find((candidate) => candidate.id === id)
    if (!sink || sink.revokedAt !== null) return null
    sink.name = normalizeDeviceLabel(name, sink.name)
    const connected = this.connectedSinkStates.get(id)
    if (connected) connected.name = sink.name
    // §14.1.4 — tell the speaker its new name so the Zone Display heading updates live.
    this.broadcastSinkNameUpdate(id)
    this.emitPairedSinksChange()
    this.emitStatus()
    return this.toPublicPairedSink(sink)
  }

  revokeAllPairedSinks(): number {
    const now = Date.now()
    let revokedCount = 0
    const revokedSinkIds: string[] = []
    for (const sink of this.pairedSinks) {
      if (sink.revokedAt !== null) continue
      sink.revokedAt = now
      revokedSinkIds.push(sink.id)
      revokedCount += 1
    }
    if (revokedCount === 0) return 0
    this.closeAllHostClients()
    for (const sinkId of revokedSinkIds) this.connectedSinkStates.delete(sinkId)
    this.emitPairedSinksChange()
    this.emitStatus()
    return revokedCount
  }

  clearHostPresenceCache(sinkId?: string): ParallaxStatus {
    const normalizedSinkId = sinkId?.trim()
    if (normalizedSinkId) {
      this.connectedSinkStates.delete(normalizedSinkId)
    } else {
      this.connectedSinkStates.clear()
    }
    this.emitStatus()
    return this.getStatus()
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
      targetSinkId: options.targetSinkId,
      packets: []
    }
    // §14.1.4 — pre-resolve artwork bytes for sinks. Off-wire: never reaches `stream` payload.
    // Cleared first so the previous stream's image doesn't briefly serve under the new streamId.
    this.currentStreamArtwork = null
    this.pendingStreamArtwork = null
    if (options.artworkHash && this.resolveArtworkDataUrl) {
      const hash = options.artworkHash
      const streamIdAtRequest = stream.streamId
      const resolvePromise = this.resolveArtworkDataUrl(hash)
        .then((dataUrl) => {
          // Stale guard — a newer stream-start may have replaced us mid-resolve.
          if (!this.activeStream || this.activeStream.info.streamId !== streamIdAtRequest) return
          const parsed = parseParallaxArtworkDataUrl(dataUrl)
          if (!parsed) return
          this.currentStreamArtwork = {
            streamId: streamIdAtRequest,
            mimeType: parsed.mimeType,
            bytes: parsed.bytes
          }
        })
        .catch(() => {
          // Resolver failure is non-fatal; sink falls back to its placeholder glyph.
        })
      this.pendingStreamArtwork = { streamId: streamIdAtRequest, promise: resolvePromise }
    }
    this.broadcastTimelineEvent({
      type: 'stream-start',
      stream,
      timeline,
      emittedAtHostTimeMs: now
    }, options.targetSinkId)
    this.emitStatus()
    return timeline
  }

  publishHostTimeline(timeline: ParallaxTimelineState, options: ParallaxHostTimelinePublishOptions = {}): void {
    if (!this.activeStream || this.activeStream.info.streamId !== timeline.streamId) return
    const resetAudio = Boolean(options.resetAudio)
    if (resetAudio) {
      this.activeStream.packets = []
    }
    this.activeStream.timeline = { ...timeline }
    this.broadcastTimelineEvent({
      type: 'timeline',
      timeline,
      resetAudio: resetAudio || undefined,
      emittedAtHostTimeMs: parallaxNowMs()
    })
    if (resetAudio) {
      this.closeAudioClientsForStream(timeline.streamId)
    }
  }

  // Phase 2A — forward a host-emit-anchor over the existing SSE channel. The renderer publishes at
  // 5 Hz while a host stream is active; sinks fit a host-output-frame predictor from these. The
  // service drops anchors that don't match the active stream so a stale publisher can't pollute a
  // new stream's window.
  publishHostEmitAnchor(anchor: {
    streamId: string
    hostWallTimeMs: number
    sourceFrameAtHostOutput: number
    hostOutputLatencyMs: number
    hostBaseLatencyMs: number
    observedRatePpm: number | null
    sequence: number
  }): void {
    if (!this.activeStream || this.activeStream.info.streamId !== anchor.streamId) return
    this.broadcastTimelineEvent({
      type: 'host-emit-anchor',
      streamId: anchor.streamId,
      hostWallTimeMs: anchor.hostWallTimeMs,
      sourceFrameAtHostOutput: anchor.sourceFrameAtHostOutput,
      hostOutputLatencyMs: anchor.hostOutputLatencyMs,
      hostBaseLatencyMs: anchor.hostBaseLatencyMs,
      observedRatePpm: anchor.observedRatePpm,
      sequence: anchor.sequence,
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

    const targetSinkId = this.activeStream.targetSinkId
    for (const client of this.audioClients) {
      if (client.streamId !== chunk.streamId) continue
      if (targetSinkId && client.sinkId !== targetSinkId) continue
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

  private closeAudioClientsForStream(streamId: string): void {
    for (const client of Array.from(this.audioClients)) {
      if (client.streamId !== streamId) continue
      this.audioClients.delete(client)
      try { client.response.end() } catch { /* ignore */ }
    }
  }

  stopHostStream(): void {
    const streamId = this.activeStream?.info.streamId ?? null
    this.activeStream = null
    this.currentStreamArtwork = null
    this.pendingStreamArtwork = null
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

  // §20 Commit 3 host-side pair flow. Pre-stages the candidate (sinkId, token) LOCALLY and POSTs
  // a credential-free pair-request to the sink. Only on `submitPairPin` success does the
  // candidate move into `pairedSinks` — so a pair-request intercepted on the wire never harvests
  // credentials (Codex round 1 amendment §20.19(a)).
  async initiatePair(sinkBaseUrl: string): Promise<{
    pairingId: string
    sinkParallaxEndpointUuid: string | null
    sinkName: string
    expiresInSeconds: number
  }> {
    const normalizedBaseUrl = sanitizeBaseUrl(sinkBaseUrl)
    const pairingId = createOpaqueSecret(16)
    const sinkId = createOpaqueSecret(16)
    const token = createOpaqueSecret(32)
    const requestBody: ParallaxPairRequestBody = {
      pairingId,
      hostName: this.getHostDisplayName?.() ?? 'Astra Host',
      hostPort: this.config.port,
      parallaxEndpointUuid: this.getEndpointUuid?.() ?? ''
    }
    const response = await fetch(`${normalizedBaseUrl}/v1/parallax/pair-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    })
    const payload = await response.json().catch(() => null) as ParallaxPairRequestResponse | { error?: string } | null
    if (!response.ok) {
      const errorMessage = (payload && 'error' in payload && payload.error) ? String(payload.error) : `Pair-request failed (${response.status}).`
      throw new Error(errorMessage)
    }
    const ok = payload as ParallaxPairRequestResponse
    const now = Date.now()
    const expiresInSeconds = Math.min(
      Math.max(Number(ok.expiresInSeconds) || PARALLAX_PAIR_CANDIDATE_TTL_MS / 1000, 1),
      PARALLAX_PAIR_CANDIDATE_TTL_MS / 1000
    )
    const expiryTimer = setTimeout(() => this.pendingPairs.delete(pairingId), expiresInSeconds * 1000)
    this.pendingPairs.set(pairingId, {
      sinkId,
      token,
      sinkBaseUrl: normalizedBaseUrl,
      sinkParallaxEndpointUuid: pickStringTrim(ok.parallaxEndpointUuid) || null,
      sinkName: pickStringTrim(ok.sinkName) || normalizedBaseUrl,
      createdAtMs: now,
      expiresAtMs: now + expiresInSeconds * 1000,
      expiryTimer
    })
    return {
      pairingId,
      sinkParallaxEndpointUuid: pickStringTrim(ok.parallaxEndpointUuid) || null,
      sinkName: pickStringTrim(ok.sinkName) || normalizedBaseUrl,
      expiresInSeconds
    }
  }

  async submitPairPin(pairingId: string, pin: string, sinkName?: string): Promise<{
    sinkId: string
    sinkName: string
    sinkParallaxEndpointUuid: string | null
  }> {
    const candidate = this.pendingPairs.get(pairingId)
    if (!candidate) throw new Error('Pair candidate not found.')

    const body: ParallaxPairConfirmBody = {
      pairingId,
      pin: pin.trim(),
      sinkId: candidate.sinkId,
      token: candidate.token,
      sinkName: sinkName?.trim() || candidate.sinkName
    }
    const response = await fetch(`${candidate.sinkBaseUrl}/v1/parallax/pair-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const payload = await response.json().catch(() => null) as ParallaxPairConfirmResponse | { error?: string } | null

    if (response.status === 401) {
      throw new ParallaxAuthError(401, 'Wrong PIN.')
    }
    if (response.status === 410) {
      this.deletePendingPair(pairingId)
      throw new Error('Pairing expired. Start again on the host.')
    }
    if (response.status === 404) {
      this.deletePendingPair(pairingId)
      throw new Error('Sink has no record of this pairing.')
    }
    if (!response.ok) {
      const errorMessage = (payload && 'error' in payload && payload.error) ? String(payload.error) : `Pair-confirm failed (${response.status}).`
      throw new Error(errorMessage)
    }

    const ok = payload as ParallaxPairConfirmResponse
    const now = Date.now()
    const finalName = sinkName?.trim() || pickStringTrim(ok.sinkName) || candidate.sinkName
    const sink: PersistedParallaxPairedSink = {
      id: candidate.sinkId,
      name: normalizeDeviceLabel(finalName, 'Astra Sink'),
      tokenHash: hashToken(candidate.token),
      tokenPrefix: candidate.token.slice(0, TOKEN_PREFIX_LENGTH),
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null,
      remoteParallaxEndpointUuid: pickStringTrim(ok.parallaxEndpointUuid) || candidate.sinkParallaxEndpointUuid || undefined
    }
    this.pairedSinks = [sink, ...this.pairedSinks]
    this.deletePendingPair(pairingId)
    this.emitPairedSinksChange()
    this.emitStatus()
    return {
      sinkId: sink.id,
      sinkName: sink.name,
      sinkParallaxEndpointUuid: sink.remoteParallaxEndpointUuid ?? null
    }
  }

  cancelPair(pairingId: string): void {
    this.deletePendingPair(pairingId)
  }

  // Codex round 1 finding (medium): pending-pair timers must be drained on stop() and on
  // host-disable, otherwise the 90s candidate TTL setTimeout keeps the event loop alive
  // (parallax service tests held the process open for ~91s for exactly this reason).
  private clearAllPendingPairs(): void {
    for (const [, candidate] of this.pendingPairs) {
      clearTimeout(candidate.expiryTimer)
    }
    this.pendingPairs.clear()
  }

  // Test hook + internals — exposed read-only so service tests can verify pending state without
  // poking the private map. Returns shallow snapshots (no expiryTimer leakage to the test).
  getPendingPairSnapshot(pairingId: string): { sinkId: string; sinkBaseUrl: string; expiresAtMs: number } | null {
    const candidate = this.pendingPairs.get(pairingId)
    if (!candidate) return null
    return { sinkId: candidate.sinkId, sinkBaseUrl: candidate.sinkBaseUrl, expiresAtMs: candidate.expiresAtMs }
  }

  private deletePendingPair(pairingId: string): void {
    const existing = this.pendingPairs.get(pairingId)
    if (!existing) return
    clearTimeout(existing.expiryTimer)
    this.pendingPairs.delete(pairingId)
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

  // §14.1.2 follow-up (Codex 2026-06-06). The `connectSink()` catch block at the bottom of this
  // method ONLY handles failures DURING the initial connect attempt; the established-connection
  // backoff (`sinkReconnectTimer`, `sinkReconnectAttempts`) only kicks in for SSE/audio drops
  // mid-session. So "sink boots while host is down" needs its own retry loop, owned by the
  // auto-reconnect path in main/index.ts — not bolted into this method.

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
      // §14.1.2 follow-up. Successful connect clears the "removed by host" latch — covers the
      // re-pair-after-revoke path (user pairs again with a fresh token).
      this.sinkRemovedByHost = false
      this.emitStatus()
      void this.primeClockSync(this.sinkConnection)
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        this.sinkTimeline = join.timeline
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
      // §14.1.2 follow-up. 401 at initial connect = host has revoked us; same R-clear path the
      // boot loop already takes. The auth-revoked dispatcher itself calls disconnectSink + emits
      // status + fires the credential-clearing callback, so we just delegate and re-throw.
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleSinkAuthRevoked()
        throw error
      }
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
    this.sinkTimeline = null
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

  async forgetSinkOnHost(connection: Pick<ParallaxSinkConnectionConfig, 'baseUrl' | 'token'>): Promise<void> {
    const response = await fetch(`${connection.baseUrl}/v1/parallax/sink/forget`, {
      method: 'POST',
      signal: AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`
      }
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = toSafeOptionalString((payload as { error?: unknown } | null)?.error)
        ?? `Parallax host forget request failed (${response.status}).`
      if (response.status === 401) {
        throw new ParallaxAuthError(401, message)
      }
      throw new Error(message)
    }
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

  // §14.1.1 — public IPC entry. Host renderer (Settings UI) calls this when the user moves the
  // per-sink trim stepper. Persists the new value keyed by (sinkId, outputDeviceId) and broadcasts
  // `sink-trim-update` to that sink's SSE clients. Caps at ±500 ms (§15.1) to keep stale UI input
  // from producing absurd scheduling shifts.
  setSinkTrim(
    sinkId: string,
    outputDeviceId: string,
    outputDeviceLabel: string | null,
    advanceMs: number,
    source: 'manual' | 'calibration' = 'manual'
  ): ParallaxStatus {
    if (!Number.isFinite(advanceMs)) return this.getStatus()
    if (!sinkId || !outputDeviceId) return this.getStatus()
    const clamped = Math.max(-500, Math.min(500, advanceMs))
    const sink = this.pairedSinks.find((candidate) => candidate.id === sinkId)
    if (!sink) return this.getStatus()
    const existingTrims = sink.trims ?? []
    const nextEntry: ParallaxSinkTrim = {
      outputDeviceId,
      outputDeviceLabel,
      advanceMs: clamped,
      updatedAtMs: Date.now(),
      source
    }
    const matchIdx = existingTrims.findIndex((trim) => trim.outputDeviceId === outputDeviceId)
    sink.trims = matchIdx >= 0
      ? existingTrims.map((trim, i) => (i === matchIdx ? nextEntry : trim))
      : [...existingTrims, nextEntry]
    this.emitPairedSinksChange()
    this.broadcastSinkTrimUpdate(sinkId, outputDeviceId, clamped)
    this.emitStatus()
    return this.getStatus()
  }

  // §14.1.1 internals. Ensure a connected-sink state row exists, toggle online, ingest telemetry,
  // and push the persisted trim for the (sinkId, outputDeviceId) pair whenever the device id is
  // first known or changes mid-session.
  private ensureConnectedSinkState(sinkId: string): ParallaxConnectedSinkState {
    const existing = this.connectedSinkStates.get(sinkId)
    if (existing) return existing
    const paired = this.pairedSinks.find((candidate) => candidate.id === sinkId)
    const fresh: ParallaxConnectedSinkState = {
      sinkId,
      name: paired?.name ?? sinkId,
      online: false,
      outputDeviceId: null,
      outputDeviceLabel: null,
      appliedAdvanceMs: 0,
      lastSeenAt: null,
      rttMs: null
    }
    this.connectedSinkStates.set(sinkId, fresh)
    return fresh
  }

  private setSinkOnline(sinkId: string, online: boolean): void {
    const state = this.ensureConnectedSinkState(sinkId)
    state.online = online
    if (online) state.lastSeenAt = Date.now()
  }

  private ingestSinkTelemetry(sinkId: string, body: Partial<ParallaxSinkTelemetry>): void {
    if (!body || typeof body !== 'object') return
    const state = this.ensureConnectedSinkState(sinkId)
    state.lastSeenAt = Date.now()

    const previousOutputDeviceId = state.outputDeviceId
    const previousOutputDeviceLabel = state.outputDeviceLabel
    const previousAppliedAdvanceMs = state.appliedAdvanceMs
    const previousRttMs = state.rttMs

    if (typeof body.outputDeviceId === 'string') {
      state.outputDeviceId = body.outputDeviceId
    } else if (body.outputDeviceId === null) {
      state.outputDeviceId = null
    }
    if (typeof body.outputDeviceLabel === 'string') {
      state.outputDeviceLabel = body.outputDeviceLabel
    } else if (body.outputDeviceLabel === null) {
      state.outputDeviceLabel = null
    }
    if (Number.isFinite(body.appliedAdvanceMs)) {
      state.appliedAdvanceMs = Number(body.appliedAdvanceMs)
    }
    if (Number.isFinite(body.rttMs)) {
      state.rttMs = Number(body.rttMs)
    } else if (body.rttMs === null) {
      state.rttMs = null
    }

    // First learning of the sink's device, or a switch (e.g. user moved sink to Bluetooth) →
    // push the persisted trim for this (sinkId, outputDeviceId) tuple so the new device's
    // calibration takes effect. We push the persisted value even if it's the implicit 0 (no
    // trim yet) so the sink resets from any previous trim it might still be applying.
    const deviceChanged = !!state.outputDeviceId && state.outputDeviceId !== previousOutputDeviceId
    if (deviceChanged) {
      this.pushPersistedTrimForSink(sinkId, state.outputDeviceId!)
    } else if (state.outputDeviceId) {
      // §14.1.1 self-healing (Codex 2026-06-06). Device hasn't changed, so the device-change
      // branch above didn't fire — but the sink's reported `appliedAdvanceMs` may still drift
      // from the host's persisted intent (missed SSE event, half-dead control stream, sink
      // restart that wiped the AudioEngine field). Compare and resend if mismatched, with a
      // rate-limit so a persistently-stuck sink isn't hammered every telemetry tick.
      const desiredAdvanceMs = this.desiredAdvanceMsFor(sinkId, state.outputDeviceId)
      if (Math.abs(state.appliedAdvanceMs - desiredAdvanceMs) > this.TRIM_APPLIED_TOLERANCE_MS) {
        const resendKey = `${sinkId}|${state.outputDeviceId}`
        const lastResendAt = this.lastTrimResendAtMs.get(resendKey) ?? 0
        if (Date.now() - lastResendAt >= this.TRIM_RESEND_MIN_INTERVAL_MS) {
          this.lastTrimResendAtMs.set(resendKey, Date.now())
          this.broadcastSinkTrimUpdate(sinkId, state.outputDeviceId, desiredAdvanceMs)
        }
      }
    }

    // Emit status only when something the UI actually displays changed. `lastSeenAt` updates
    // every telemetry tick (1 Hz) and isn't worth a renderer re-render; the three fields the UI
    // reads from `connectedSinks` are these. Otherwise the renderer would only see device/trim/RTT
    // changes when some unrelated event fired emitStatus.
    if (
      state.outputDeviceId !== previousOutputDeviceId ||
      state.outputDeviceLabel !== previousOutputDeviceLabel ||
      state.appliedAdvanceMs !== previousAppliedAdvanceMs ||
      state.rttMs !== previousRttMs
    ) {
      this.emitStatus()
    }
  }

  // §14.1.1. Single lookup point for the host's "desired" trim, used by the CSV writer and the
  // self-healing path in `ingestSinkTelemetry`. Returns 0 if no entry is persisted yet.
  desiredAdvanceMsFor(sinkId: string, outputDeviceId: string): number {
    const sink = this.pairedSinks.find((candidate) => candidate.id === sinkId)
    const matching = sink?.trims?.find((trim) => trim.outputDeviceId === outputDeviceId)
    return matching?.advanceMs ?? 0
  }

  private pushPersistedTrimForSink(sinkId: string, outputDeviceId: string): void {
    const sink = this.pairedSinks.find((candidate) => candidate.id === sinkId)
    const matching = sink?.trims?.find((trim) => trim.outputDeviceId === outputDeviceId)
    this.broadcastSinkTrimUpdate(sinkId, outputDeviceId, matching?.advanceMs ?? 0)
  }

  private broadcastSinkTrimUpdate(sinkId: string, outputDeviceId: string, advanceMs: number): void {
    const event: ParallaxTimelineEvent = {
      type: 'sink-trim-update',
      sinkId,
      advanceMs,
      outputDeviceId,
      emittedAtHostTimeMs: parallaxNowMs()
    }
    // Same try/delete shape as `broadcastTimelineEvent`. A half-closed SSE response throws on
    // write; without this guard the exception would bubble out of `setSinkTrim` (breaking the
    // IPC reply) or `ingestSinkTelemetry` (poisoning the telemetry POST handler).
    for (const client of this.sseClients) {
      if (client.sinkId !== sinkId) continue
      try {
        writeSseEvent(client.response, 'parallax', event)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  // §14.1.4 — push the sink's host-assigned name to its SSE clients (Zone Display heading). Same
  // targeted try/delete shape as `broadcastSinkTrimUpdate`. Fired on connect + on rename.
  private broadcastSinkNameUpdate(sinkId: string): void {
    const sink = this.pairedSinks.find((candidate) => candidate.id === sinkId)
    if (!sink || sink.revokedAt !== null) return
    const event: ParallaxTimelineEvent = {
      type: 'sink-name-update',
      sinkId,
      name: sink.name,
      emittedAtHostTimeMs: parallaxNowMs()
    }
    for (const client of this.sseClients) {
      if (client.sinkId !== sinkId) continue
      try {
        writeSseEvent(client.response, 'parallax', event)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  // Phase 0 diagnostics: the host renderer reports its own output-latency signals (~1 Hz) so the
  // telemetry CSV can log both ends. Pure diagnostics; does not affect playback.
  recordHostLatencyMetrics(metrics: ParallaxOutputLatencyMetrics | null | undefined): void {
    if (!metrics || typeof metrics !== 'object') return
    this.lastHostLatencyMetrics = {
      outputLatencyMs: Number.isFinite(metrics.outputLatencyMs as number) ? Number(metrics.outputLatencyMs) : null,
      baseLatencyMs: Number.isFinite(metrics.baseLatencyMs as number) ? Number(metrics.baseLatencyMs) : null,
      timestampLatencyMs: Number.isFinite(metrics.timestampLatencyMs as number) ? Number(metrics.timestampLatencyMs) : null
    }
  }

  async stop(): Promise<void> {
    this.clearAllPendingPairs()
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
    let removed = false
    for (const client of this.sseClients) {
      if (client.sinkId !== sinkId) continue
      try { client.response.end() } catch { /* ignore */ }
      this.sseClients.delete(client)
      removed = true
    }
    for (const client of this.audioClients) {
      if (client.sinkId !== sinkId) continue
      try { client.response.end() } catch { /* ignore */ }
      this.audioClients.delete(client)
    }
    // §14.1.1. Without this the connectedSinks row would still report online: true for a revoked
    // sink, since the on-close cleanup hook only fires for direct disconnects, not forced closes.
    if (removed) {
      this.setSinkOnline(sinkId, false)
      this.emitStatus()
    }
  }

  private closeAllHostClients(): void {
    // §14.1.1. Walk the client set first to collect the unique sinkIds we'll mark offline once
    // they're closed. Doing this before clear() lets host-stop and the revoke-all path leave the
    // connectedSinks list in a consistent state.
    const affectedSinks = new Set<string>()
    for (const client of this.sseClients) {
      affectedSinks.add(client.sinkId)
      try { client.response.end() } catch { /* ignore */ }
    }
    for (const client of this.audioClients) {
      try { client.response.end() } catch { /* ignore */ }
    }
    this.sseClients.clear()
    this.audioClients.clear()
    if (affectedSinks.size > 0) {
      for (const sinkId of affectedSinks) this.setSinkOnline(sinkId, false)
      this.emitStatus()
    }
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
    // Host going offline must also abandon any in-flight pair candidates — the wizard's
    // pair-confirm POST will fail anyway, and we don't want their TTL timers keeping us alive.
    this.clearAllPendingPairs()

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
      // A targeted stream (trim test tone) is only for its target sink. Anyone else joining sees
      // no active stream, so they stay idle instead of playing the test.
      const targetSinkId = this.activeStream?.targetSinkId
      const visibleToThisSink = !targetSinkId || targetSinkId === sink.id
      toJsonResponse(res, 200, {
        sinkId: sink.id,
        groupLatencyMs: PARALLAX_DEFAULT_GROUP_LATENCY_MS,
        hostTimeMs,
        stream: visibleToThisSink ? (this.activeStream?.info ?? null) : null,
        timeline: visibleToThisSink ? this.getTimelineForNewSink(hostTimeMs) : null
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

    if (method === 'GET' && path === '/v1/parallax/artwork/current') {
      // §14.1.4 / §19.18(e) — sink Zone Display fetches once per stream-start, keyed by streamId.
      // Auth already enforced upstream via sink.id resolution. Codex finding 1 (high): if the
      // sink's fetch arrives before the host's async hash→bytes resolve completes, await the
      // pending promise (capped) instead of returning 404 immediately. Otherwise a fast sink
      // permanently sees no artwork for the stream.
      const requestedStreamId = requestUrl.searchParams.get('streamId')?.trim() || null
      const pending = this.pendingStreamArtwork
      if (pending && requestedStreamId && pending.streamId === requestedStreamId && !this.currentStreamArtwork) {
        await Promise.race([
          pending.promise,
          new Promise<void>((resolve) => setTimeout(resolve, this.PARALLAX_ARTWORK_FETCH_WAIT_TIMEOUT_MS))
        ])
      }
      const cached = this.currentStreamArtwork
      if (!cached) {
        toJsonResponse(res, 404, { error: 'Artwork not available.' })
        return
      }
      if (requestedStreamId && requestedStreamId !== cached.streamId) {
        toJsonResponse(res, 404, { error: 'Artwork not available for requested stream.' })
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', cached.mimeType)
      res.setHeader('Content-Length', cached.bytes.length.toString())
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(cached.bytes)
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
        const telemetryBody = await readJsonBody(req)
        // §14.1.1 follow-up. Look up the host's desired trim for the sink's currently-reported
        // device so the CSV writer can log it alongside the sink's `applied_advance_ms`. Done
        // here (route handler) because `appendParallaxTelemetryLog` is module-level and the
        // pairedSinks store lives on the service instance. Returns null when the body has no
        // outputDeviceId yet — the writer collapses null → '' in the CSV cell.
        const bodyOutputDeviceId = (telemetryBody as { outputDeviceId?: unknown } | null)?.outputDeviceId
        const desiredAdvanceMs = typeof bodyOutputDeviceId === 'string' && bodyOutputDeviceId
          ? this.desiredAdvanceMsFor(sink.id, bodyOutputDeviceId)
          : null
        appendParallaxTelemetryLog(
          telemetryBody,
          this.lastHostLatencyMetrics,
          this.activeStream?.info.sampleRate ?? null,
          desiredAdvanceMs
        )
        // §14.1.1. Mirror the sink's reported output device + applied trim into the host's
        // connected-sink state. If the device id changed since last seen, push the matching
        // persisted trim back to that sink so the new device's calibration takes effect.
        this.ingestSinkTelemetry(sink.id, telemetryBody as Partial<ParallaxSinkTelemetry>)
      } catch {
        toJsonResponse(res, 400, { error: 'Invalid telemetry payload.' })
        return
      }
      toJsonResponse(res, 200, { ok: true })
      return
    }

    // §14.1.4 / Codex finding 2 (high). Sink → host trim push. The Zone Display overlay lets the
    // user nudge trim from the sink side; this endpoint applies the requested value through the
    // normal setSinkTrim path (which persists, clamps, broadcasts back via SSE, and keeps host
    // state-of-truth intact per §15.2). The sink is identified by the existing token-auth
    // resolution (`sink.id`) — it cannot write trim for any other sink.
    if (method === 'POST' && path === '/v1/parallax/sink/trim') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        toJsonResponse(res, 400, { error: 'Invalid trim payload.' })
        return
      }
      const outputDeviceId = toSafeOptionalString((body as { outputDeviceId?: unknown } | null)?.outputDeviceId)
      const outputDeviceLabel = toSafeOptionalString((body as { outputDeviceLabel?: unknown } | null)?.outputDeviceLabel) ?? null
      const rawAdvanceMs = Number((body as { advanceMs?: unknown } | null)?.advanceMs)
      if (!outputDeviceId) {
        toJsonResponse(res, 400, { error: 'outputDeviceId is required.' })
        return
      }
      if (!Number.isFinite(rawAdvanceMs)) {
        toJsonResponse(res, 400, { error: 'advanceMs must be a finite number.' })
        return
      }
      this.setSinkTrim(sink.id, outputDeviceId, outputDeviceLabel, rawAdvanceMs)
      const persisted = (this.pairedSinks.find((candidate) => candidate.id === sink.id)?.trims ?? [])
        .find((trim) => trim.outputDeviceId === outputDeviceId)
      toJsonResponse(res, 200, {
        ok: true,
        outputDeviceId,
        advanceMs: persisted?.advanceMs ?? 0
      })
      return
    }

    // Sink-side "Forget Host" notification. The request is already authenticated as `sink`, so
    // the sink can only retire its own host-side pairing. Local forget still succeeds if this
    // request fails; this endpoint just prevents old sink ids from lingering on reachable hosts
    // when the user intentionally unpairs from the sink.
    if (method === 'POST' && path === '/v1/parallax/sink/forget') {
      this.revokePairedSink(sink.id)
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
    // §14.1.1. Mark this sink online + ensure its connected-state row exists. Telemetry will
    // populate outputDevice + appliedAdvanceMs once it starts flowing.
    this.setSinkOnline(sinkId, true)
    // §14.1.4. Push the host-assigned name so the speaker's Zone Display shows it immediately.
    this.broadcastSinkNameUpdate(sinkId)
    // §14.1.1 follow-up (Codex 2026-06-06). On SSE reconnect, if we already know this sink's
    // output device from a prior session, re-push the persisted trim immediately. Without this
    // the trim only flows on telemetry-triggered device-change (`ingestSinkTelemetry`), and a
    // reconnect with the same device would leave the sink at its post-reconnect default (0)
    // until self-healing kicks in on the next applied-vs-desired mismatch tick. Reset the
    // resend rate-limit token so this fresh push isn't blocked by a recent self-heal attempt.
    const reconnectState = this.connectedSinkStates.get(sinkId)
    if (reconnectState?.outputDeviceId) {
      this.lastTrimResendAtMs.delete(`${sinkId}|${reconnectState.outputDeviceId}`)
      this.pushPersistedTrimForSink(sinkId, reconnectState.outputDeviceId)
    }

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
      if (removed) {
        // §14.1.1. If no other SSE clients are still tracking this sink, mark it offline. State
        // row is kept for last-known display (output device + previous applied trim); we only
        // toggle the `online` flag so the UI can grey it.
        const stillConnected = Array.from(this.sseClients).some((c) => c.sinkId === sinkId)
        if (!stillConnected) this.setSinkOnline(sinkId, false)
        this.emitStatus()
      }
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

  private broadcastTimelineEvent(event: ParallaxTimelineEvent, onlySinkId?: string): void {
    for (const client of this.sseClients) {
      if (onlySinkId && client.sinkId !== onlySinkId) continue
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
      signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS)]),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(init.headers ?? {})
      }
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = toSafeOptionalString((payload as { error?: unknown } | null)?.error) ?? `Parallax host request failed (${response.status}).`
      // §14.1.2 / §16.12(c). 401 is the unambiguous "your credential is no longer valid"
      // signal — boot-path auto-reconnect treats it as host-side revocation (R-clear per §16.7)
      // by checking `instanceof ParallaxAuthError`. Other failures stay as generic Error so the
      // backoff-retry path can handle them uniformly. Do NOT message-parse downstream.
      if (response.status === 401) {
        throw new ParallaxAuthError(401, message)
      }
      throw new Error(message)
    }
    return payload as T
  }

  // §14.1.4 / Codex finding 2 (high). Sink → host trim push. Authenticated POST to the connected
  // host's `/v1/parallax/sink/trim` route. Host validates the body, applies via its own
  // setSinkTrim path (clamps, persists, broadcasts back), keeping host-state-of-truth intact.
  // Caller does NOT need to optimistically update the local AudioEngine advance — the host's
  // SSE rebroadcast (`sink-trim-update`) will arrive within a tick and the existing sink event
  // handler applies it. Token stays in main; renderer never sees it.
  async pushSinkTrimUpdate(
    outputDeviceId: string,
    outputDeviceLabel: string | null,
    advanceMs: number
  ): Promise<boolean> {
    const connection = this.sinkConnection
    if (!connection) return false
    if (!outputDeviceId.trim() || !Number.isFinite(advanceMs)) return false
    try {
      await this.fetchSinkJson('/v1/parallax/sink/trim', {
        method: 'POST',
        body: JSON.stringify({
          outputDeviceId: outputDeviceId.trim(),
          outputDeviceLabel,
          advanceMs
        })
      })
      return true
    } catch (error) {
      // Codex finding 2 (low, round 2): if this POST is the first channel to see a host
      // revocation, route through the same R-clear path the event/audio/clock channels use.
      // Other channels will probably catch it within a tick, but this keeps the auth-revoked
      // dispatch consistent across every authenticated sink path.
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleSinkAuthRevoked()
      }
      return false
    }
  }

  // §14.1.4 / §19.18(e) — sink-side fetch for the active stream's artwork from the connected host.
  // Returns a base64 data URL so the renderer can drop it directly into an <img src>. Returns null
  // on any failure (no auth, 404, network) — the Zone Display falls back to the placeholder glyph.
  // Main holds the token; renderer never sees it (§14.1.2 invariant).
  async fetchSinkArtworkDataUrl(streamId: string): Promise<string | null> {
    const connection = this.sinkConnection
    if (!connection) return null
    const trimmedStreamId = streamId.trim()
    if (!trimmedStreamId) return null
    try {
      const response = await fetch(
        `${connection.baseUrl}/v1/parallax/artwork/current?streamId=${encodeURIComponent(trimmedStreamId)}`,
        {
          signal: AbortSignal.any([connection.abortController.signal, AbortSignal.timeout(SINK_JSON_FETCH_TIMEOUT_MS)]),
          headers: { Authorization: `Bearer ${connection.token}` }
        }
      )
      if (!response.ok) return null
      const contentType = response.headers.get('content-type')?.trim() || 'image/jpeg'
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > PARALLAX_ARTWORK_MAX_BYTES) return null
      const base64 = Buffer.from(arrayBuffer).toString('base64')
      return `data:${contentType};base64,${base64}`
    } catch {
      return null
    }
  }

  private startClockSync(): void {
    this.stopClockSync()
    this.sinkClockTimer = setInterval(() => {
      void this.runClockProbe()
    }, CLOCK_SYNC_INTERVAL_MS)
    this.startAudioStallWatchdog()
  }

  // Detect a half-open (silently stalled) audio stream and re-request it from the live frame before
  // the sink's buffer drains, so playback is masked rather than cutting out. See PARALLAX_AUDIO_STALL_MS.
  private startAudioStallWatchdog(): void {
    this.stopAudioStallWatchdog()
    this.lastAudioChunkAtMs = Date.now()
    this.audioStallTimer = setInterval(() => {
      this.checkAudioStall()
    }, PARALLAX_AUDIO_STALL_CHECK_MS)
  }

  private stopAudioStallWatchdog(): void {
    if (this.audioStallTimer !== null) {
      clearInterval(this.audioStallTimer)
      this.audioStallTimer = null
    }
  }

  private checkAudioStall(): void {
    const connection = this.sinkConnection
    const stream = this.sinkActiveStream
    if (!connection || !stream || !connection.activeAudioStreamId) return
    // Only expect a steady chunk flow while playing; a paused host legitimately stops sending.
    if (this.sinkTimeline?.playbackState !== 'playing') return
    if (Date.now() - this.lastAudioChunkAtMs <= PARALLAX_AUDIO_STALL_MS) return
    // Stalled: bump the timestamp so we don't re-fire on every check while the re-request is in
    // flight, then re-request the audio stream from the live frame (consumeSinkAudio cancels the
    // hung reader and re-fetches; the host flushes a short recent backlog and resumes).
    this.lastAudioChunkAtMs = Date.now()
    void this.consumeSinkAudio(stream.streamId, this.sinkTimeline?.startFrame ?? 0, true)
  }

  // Burst a series of probes back-to-back so the offset converges quickly, then hand off to
  // the slow steady-state cadence. Status is emitted only by the final probe (see runClockProbe)
  // so the renderer's first non-null clock offset already reflects the best-of-burst sample.
  private async primeClockSync(connection: ParallaxSinkConnectionState): Promise<void> {
    for (let index = 0; index < CLOCK_PRIMING_PROBES; index += 1) {
      if (this.sinkConnection !== connection) return
      const isLast = index === CLOCK_PRIMING_PROBES - 1
      const ok = await this.runClockProbe(isLast)
      if (this.sinkConnection !== connection) return
      // Network isn't ready (timeout/failure): stop priming so the caller's rejoin can fail fast
      // and the normal reconnect retry takes over, rather than burning the whole burst.
      if (!ok) break
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
    this.stopAudioStallWatchdog()
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

    // Reflect the cleared clock (offset → null) before anything is re-applied.
    this.emitStatus()

    try {
      // Reconverge the clock BEFORE rejoining. The /join timeline is then computed and applied with
      // an accurate, freshly-primed offset (and full group-latency headroom). Previously the rejoin
      // applied immediately with the stale pre-drop offset, which left the sink badly out of sync
      // until a manual pause/play/seek re-anchored it.
      await this.primeClockSync(connection)
      if (this.sinkConnection !== connection) return

      const join = await this.fetchSinkJson<ParallaxJoinResponse>('/v1/parallax/join', {
        method: 'POST',
        body: JSON.stringify({ sinkId: connection.sinkId })
      })
      if (this.sinkConnection !== connection) return
      this.sinkReconnectAttempts = 0
      this.sinkActiveStream = join.stream
      this.sinkLastError = null
      this.emitStatus()
      void this.consumeSinkEvents()
      if (join.stream && join.timeline) {
        this.sinkTimeline = join.timeline
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
      // §14.1.2 follow-up. 401 in the scheduled reconnect path = host revoked us between the
      // last successful session and now. Fall into R-clear instead of looping the backoff
      // schedule — handleSinkAuthRevoked disconnects, fires the callback, emits status.
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleSinkAuthRevoked()
        return
      }
      const message = error instanceof Error ? error.message : 'Parallax reconnect failed.'
      this.sinkLastError = `Parallax reconnect failed: ${message}`
      this.emitStatus()
      this.scheduleSinkReconnect(connection, this.sinkLastError)
    }
  }

  private async runClockProbe(emit = true): Promise<boolean> {
    const connection = this.sinkConnection
    if (!connection) return false
    const sinkSentAtMs = parallaxNowMs()
    try {
      const response = await this.fetchSinkJson('/v1/parallax/clock', {
        method: 'POST',
        body: JSON.stringify({ sinkSentAtMs })
      })
      if (this.sinkConnection !== connection) return false
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
      return true
    } catch (error) {
      if (this.sinkConnection !== connection) return false
      // Aborts (reader replacement/disconnect) and timeouts are expected transient failures.
      if (isAbortLikeError(error) || isTimeoutError(error)) return false
      this.sinkLastError = error instanceof Error ? error.message : 'Parallax clock sync failed.'
      this.emitStatus()
      return false
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
        // §14.1.2 follow-up. 401 here = host revoked the sink mid-session; bubble a status-bearing
        // error so consumeSinkEvents' catch can fire handleSinkAuthRevoked instead of scheduling
        // another reconnect attempt with the dead credential.
        if (response.status === 401) {
          throw new ParallaxAuthError(401, 'Parallax event stream unauthorized.')
        }
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
      // §14.1.2 follow-up. 401 on event stream = host revoked us in-session. Trip R-clear
      // instead of scheduling more reconnect attempts the dead credential will fail too.
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleSinkAuthRevoked()
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
      this.sinkTimeline = event.timeline
      this.emitStatus()
      void this.consumeSinkAudio(event.stream.streamId, event.timeline.startFrame, true)
    } else if (event.type === 'timeline') {
      this.sinkTimeline = event.timeline
      // Give a fresh grace window after a state change (resume/seek) so the stall watchdog doesn't
      // fire before the host's chunk flow picks back up.
      this.lastAudioChunkAtMs = Date.now()
      if (event.resetAudio && this.sinkActiveStream?.streamId === event.timeline.streamId) {
        void this.consumeSinkAudio(event.timeline.streamId, event.timeline.startFrame, true)
      }
    } else if (event.type === 'stop') {
      this.sinkActiveStream = null
      this.sinkTimeline = null
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
    const timeline = this.sinkTimeline
    if (!activeStream || activeStream.streamId !== streamId || !timeline || timeline.streamId !== streamId) {
      return Math.max(0, Math.floor(fallbackFrame))
    }
    // Paused: resume from the paused position (don't advance past it).
    if (timeline.playbackState !== 'playing') {
      return Math.max(0, Math.min(activeStream.totalFrames, Math.floor(timeline.startFrame)))
    }
    // Playing: resume from the live host frame minus a short backfill, so the host replays only a
    // small recent backlog (not the whole track). The renderer still re-anchors via chunk timestamps.
    // Filtered offset (median over lower-RTT half) avoids a single bad probe biasing the resume frame.
    const offsetMs = selectFilteredParallaxClockOffsetMs(this.sinkClockSamples) ?? 0
    const hostNowMs = parallaxNowMs() + offsetMs
    const elapsedMs = Math.max(0, hostNowMs - timeline.startHostTimeMs)
    const liveFrame = timeline.startFrame + Math.floor((elapsedMs * activeStream.sampleRate) / 1000)
    const backfillFrames = Math.floor((PARALLAX_AUDIO_RECONNECT_BACKFILL_MS * activeStream.sampleRate) / 1000)
    return Math.max(0, Math.min(activeStream.totalFrames, liveFrame - backfillFrames))
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
        // §14.1.2 follow-up. Same auth-revoked detection as the event stream.
        if (response.status === 401) {
          throw new ParallaxAuthError(401, 'Parallax audio stream unauthorized.')
        }
        throw new Error(`Parallax audio stream failed (${response.status}).`)
      }

      const reader = response.body.getReader()
      if (this.sinkConnection !== connection || connection.activeAudioStreamId !== streamId || connection.audioGeneration !== audioGeneration) {
        await reader.cancel().catch(() => undefined)
        return
      }
      connection.audioReader = reader
      this.sinkLastError = null
      this.lastAudioChunkAtMs = Date.now()
      this.emitStatus()
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
      while (
        this.sinkConnection === connection
        && connection.activeAudioStreamId === streamId
        && connection.audioGeneration === audioGeneration
      ) {
        const { done, value } = await reader.read()
        if (
          this.sinkConnection !== connection
          || connection.activeAudioStreamId !== streamId
          || connection.audioGeneration !== audioGeneration
        ) {
          return
        }
        if (done) break
        if (!value) continue
        this.lastAudioChunkAtMs = Date.now()
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
      // §14.1.2 follow-up. Same 401 → R-clear branch as the event stream + scheduled reconnect.
      if (error instanceof ParallaxAuthError && error.status === 401) {
        this.handleSinkAuthRevoked()
        return
      }
      this.sinkLastError = error instanceof Error ? error.message : 'Parallax audio stream disconnected.'
      this.scheduleSinkReconnect(connection, this.sinkLastError)
    }
  }
}
