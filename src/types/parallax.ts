export const PARALLAX_LAN_HOST = '0.0.0.0'
export const PARALLAX_DEFAULT_PORT = 38403
export const PARALLAX_MIN_PORT = 1024
export const PARALLAX_MAX_PORT = 65535
export const PARALLAX_DEFAULT_GROUP_LATENCY_MS = 1000
export const PARALLAX_AUDIO_CHUNK_FRAMES = 4096
export const PARALLAX_CLOCK_SAMPLE_LIMIT = 8
export const PARALLAX_AUDIO_PACKET_MAGIC = 0x50584c58 // PXLX
export const PARALLAX_AUDIO_PACKET_VERSION = 2
export const PARALLAX_AUDIO_PACKET_HEADER_BYTES = 40

// Snapcast-style "snap-then-slew" sink correction tuning.
// PARALLAX_MAX_SLEW_PPM bounds the playback-rate nudge used to hold/close small offsets.
// 1000 ppm = 0.1% is musically inaudible (~1.7 cents) yet ~5-24x typical crystal drift, so the
// slew can actually correct a 10-30 ms offset smoothly within seconds and keep drift inside the
// deadzone — leaving the (audible) cursor snap only for genuine large discontinuities.
export const PARALLAX_MAX_SLEW_PPM = 1000
export const PARALLAX_HARD_SYNC_MS = 40
export const PARALLAX_RESYNC_LEAD_MS = 60
export const PARALLAX_RESYNC_MIN_INTERVAL_MS = 2500
export const PARALLAX_SYNC_DEADZONE_FRAMES = 64
// Snap only after drift stays past the threshold for this many consecutive 1s ticks, so a
// single jittery clock/drift measurement can't cause a spurious gap.
export const PARALLAX_SNAP_CONFIRM_TICKS = 2

// Underrun recovery: if the sink buffer drains while still connected, the worklet self-pauses into
// "rebuffering" after ~PARALLAX_STARVE_TRIGGER_MS of continuous starvation (mirrored as
// starveTriggerFrames in the worklet). The renderer then waits until the buffer covers the live
// host frame by at least PARALLAX_REBUFFER_MARGIN_MS before re-anchoring to live and resuming, so
// the cursor never free-runs into empty data. The host streams ~3 s ahead, so the margin refills fast.
export const PARALLAX_STARVE_TRIGGER_MS = 250
export const PARALLAX_REBUFFER_MARGIN_MS = 500

export type ParallaxPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type ParallaxRole = 'idle' | 'host' | 'sink'

export interface ParallaxPairedSink {
  id: string
  name: string
  tokenPrefix: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface ParallaxPairingPin {
  pin: string
  createdAt: number
  expiresAt: number
}

export interface ParallaxHostConfig {
  enabled: boolean
  port: number
}

export interface ParallaxSinkConnectionConfig {
  baseUrl: string
  sinkId: string
  token: string
}

export interface ParallaxClockSyncResponse {
  sinkSentAtMs: number
  hostReceivedAtMs: number
  hostSentAtMs: number
}

export interface ParallaxClockSample {
  sinkSentAtMs: number
  sinkReceivedAtMs: number
  hostReceivedAtMs: number
  hostSentAtMs: number
  rttMs: number
  offsetMs: number
}

export interface ParallaxStreamInfo {
  streamId: string
  trackId: string
  trackPath: string
  title: string
  artist: string
  album: string
  sampleRate: number
  channels: number
  durationSeconds: number
  totalFrames: number
  chunkFrames: number
  groupLatencyMs: number
  createdAt: number
}

export interface ParallaxTimelineState {
  streamId: string
  playbackState: ParallaxPlaybackState
  startFrame: number
  // `startHostTimeMs` is the timeline anchor in host-clock wall time.
  //
  // INTENDED INVARIANT (enforced after step 5 — auto output-latency compensation): this is the
  // wall instant `startFrame` leaves *every endpoint's speaker* (host's and every sink's). Each
  // endpoint compensates by subtracting its own output latency from its scheduled `when`, so
  // `startHostTimeMs` is the shared acoustic anchor.
  //
  // CURRENT (pre-step-5): no output-latency compensation. This is the wall instant at which the
  // renderer schedules `sourceNode.start(...)` / `set-timeline`, so the DAC actually emits roughly
  // `outputLatency + baseLatency` later. The drift formula in `computeRateCorrectionPpm` does NOT
  // include a `+sinkLatency` term yet; that ships paired with the scheduling change in step 5.
  startHostTimeMs: number
  updatedHostTimeMs: number
  groupLatencyMs: number
}

// Options for publishHostStreamStart. Defaults reproduce a fresh play from the top.
// A sink joining mid-playback passes the host's current (latency-adjusted) frame and state so the
// stream is anchored to the in-progress song instead of restarting it.
export interface ParallaxHostStreamStartOptions {
  startFrame?: number
  playbackState?: ParallaxPlaybackState
}

export type ParallaxTimelineEvent =
  | {
      type: 'stream-start'
      stream: ParallaxStreamInfo
      timeline: ParallaxTimelineState
      emittedAtHostTimeMs: number
    }
  | {
      type: 'timeline'
      timeline: ParallaxTimelineState
      emittedAtHostTimeMs: number
    }
  | {
      type: 'stop'
      streamId: string | null
      emittedAtHostTimeMs: number
    }

export interface ParallaxAudioChunk {
  streamId: string
  sampleRate: number
  channels: number
  startFrame: number
  frameCount: number
  hostTimeMs: number
  pcmData: ArrayBuffer
}

export interface ParallaxAudioPacketHeader {
  version: number
  sampleRate: number
  channels: number
  startFrame: number
  frameCount: number
  hostTimeMs: number
  payloadBytes: number
}

// Phase 0 diagnostics: a device's reported audio output-latency signals (all in ms).
// outputLatencyMs/baseLatencyMs come from AudioContext; timestampLatencyMs is the median-filtered
// (currentTime - getOutputTimestamp().contextTime), the un-quantized acoustic-output latency.
export interface ParallaxOutputLatencyMetrics {
  outputLatencyMs: number | null
  baseLatencyMs: number | null
  timestampLatencyMs: number | null
}

export interface ParallaxSinkTelemetry {
  streamId: string | null
  bufferedMs: number
  driftFrames: number
  rttMs: number | null
  underruns: number
  playbackRatePpm: number
  reportedAtMs: number
  // Phase 0 diagnostics: the sink's own reported output-latency signals (optional; absent on older sinks).
  outputLatencyMs?: number | null
  baseLatencyMs?: number | null
  timestampLatencyMs?: number | null
  // Underrun-recovery diagnostics.
  rebuffering?: boolean
  starvedFrames?: number
}

export interface ParallaxHostStatus {
  enabled: boolean
  active: boolean
  bindHost: string
  port: number
  lanUrls: string[]
  activePairingPin: ParallaxPairingPin | null
  pairedSinkCount: number
  connectedSinkCount: number
  activeStream: ParallaxStreamInfo | null
  lastError: string | null
  // Phase 0 diagnostics: the host's own reported output-latency signals (ms), reported by the host renderer.
  outputLatencyMs?: number | null
  baseLatencyMs?: number | null
  timestampLatencyMs?: number | null
}

export interface ParallaxSinkStatus {
  connected: boolean
  baseUrl: string | null
  sinkId: string | null
  activeStream: ParallaxStreamInfo | null
  clockOffsetMs: number | null
  rttMs: number | null
  lastError: string | null
}

export interface ParallaxStatus {
  role: ParallaxRole
  host: ParallaxHostStatus
  sink: ParallaxSinkStatus
}

export interface ParallaxPairResponse {
  sinkId: string
  token: string
  tokenPrefix: string
}

export interface ParallaxJoinResponse {
  sinkId: string
  groupLatencyMs: number
  hostTimeMs: number
  stream: ParallaxStreamInfo | null
  timeline: ParallaxTimelineState | null
}

export function buildParallaxClockSample(
  response: ParallaxClockSyncResponse,
  sinkReceivedAtMs: number
): ParallaxClockSample {
  const rttMs = Math.max(0, sinkReceivedAtMs - response.sinkSentAtMs)
  const offsetMs = (
    (response.hostReceivedAtMs - response.sinkSentAtMs)
    + (response.hostSentAtMs - sinkReceivedAtMs)
  ) / 2

  return {
    sinkSentAtMs: response.sinkSentAtMs,
    sinkReceivedAtMs,
    hostReceivedAtMs: response.hostReceivedAtMs,
    hostSentAtMs: response.hostSentAtMs,
    rttMs,
    offsetMs
  }
}

export function selectBestParallaxClockSample(
  samples: readonly ParallaxClockSample[]
): ParallaxClockSample | null {
  let best: ParallaxClockSample | null = null

  for (const sample of samples) {
    if (!Number.isFinite(sample.rttMs) || !Number.isFinite(sample.offsetMs)) continue
    if (!best || sample.rttMs < best.rttMs) {
      best = sample
      continue
    }
    if (best && sample.rttMs === best.rttMs && sample.sinkReceivedAtMs > best.sinkReceivedAtMs) {
      best = sample
    }
  }

  return best
}

export function mapHostTimeToSinkTimeMs(hostTimeMs: number, hostMinusSinkOffsetMs: number): number {
  return hostTimeMs - hostMinusSinkOffsetMs
}

// Robust host↔sink clock offset across recent probes. Takes the lower-RTT half (rounded up) and
// medians those offsets. Asymmetric one-way times on a WiFi link skew the NTP-style per-sample
// offset estimate, so restricting to low-RTT samples reduces that error; medianing the survivors
// then makes the result robust to a single bad probe within the best-RTT set. Sign is preserved
// (host − sink) at every step. Returns null when no usable samples are available.
export function selectFilteredParallaxClockOffsetMs(
  samples: readonly ParallaxClockSample[]
): number | null {
  const valid = samples.filter((sample) =>
    Number.isFinite(sample.offsetMs) && Number.isFinite(sample.rttMs)
  )
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0].offsetMs
  const sortedByRtt = [...valid].sort((left, right) => left.rttMs - right.rttMs)
  const half = Math.max(1, Math.ceil(sortedByRtt.length / 2))
  const offsets = sortedByRtt.slice(0, half).map((sample) => sample.offsetMs).sort((a, b) => a - b)
  const mid = Math.floor(offsets.length / 2)
  return offsets.length % 2 === 1 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2
}

export function clampParallaxPlaybackRatePpm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-PARALLAX_MAX_SLEW_PPM, Math.min(PARALLAX_MAX_SLEW_PPM, value))
}

export type ParallaxSinkCorrectionMode = 'hold' | 'slew' | 'snap'

export interface ParallaxSinkCorrection {
  mode: ParallaxSinkCorrectionMode
  playbackRatePpm: number
}

// Decide how the sink should react to measured drift (currentFrame - expectedFrame):
// - |drift| beyond PARALLAX_HARD_SYNC_MS  -> 'snap' the cursor (rate correction can't catch up)
// - |drift| within PARALLAX_SYNC_DEADZONE_FRAMES -> 'hold' (avoid micro-hunting around zero)
// - otherwise -> 'slew' the playback rate to counter ongoing drift.
export function decideParallaxSinkCorrection(
  driftFrames: number,
  sampleRate: number
): ParallaxSinkCorrection {
  if (!Number.isFinite(driftFrames)) return { mode: 'hold', playbackRatePpm: 0 }
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  const hardSyncFrames = (PARALLAX_HARD_SYNC_MS / 1000) * safeSampleRate
  const magnitude = Math.abs(driftFrames)
  if (magnitude > hardSyncFrames) {
    return { mode: 'snap', playbackRatePpm: 0 }
  }
  if (magnitude < PARALLAX_SYNC_DEADZONE_FRAMES) {
    return { mode: 'hold', playbackRatePpm: 0 }
  }
  return { mode: 'slew', playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2) }
}

export function encodeParallaxAudioPacket(chunk: ParallaxAudioChunk): ArrayBuffer {
  const source = new Uint8Array(chunk.pcmData)
  const payloadBytes = source.byteLength
  const packet = new ArrayBuffer(PARALLAX_AUDIO_PACKET_HEADER_BYTES + payloadBytes)
  const view = new DataView(packet)

  view.setUint32(0, PARALLAX_AUDIO_PACKET_MAGIC, true)
  view.setUint16(4, PARALLAX_AUDIO_PACKET_VERSION, true)
  view.setUint16(6, 0, true)
  view.setUint32(8, Math.max(1, Math.round(chunk.sampleRate)), true)
  view.setUint16(12, Math.max(1, Math.min(8, Math.round(chunk.channels))), true)
  view.setUint16(14, 0, true)
  view.setUint32(16, Math.max(0, Math.floor(chunk.startFrame)), true)
  view.setUint32(20, Math.max(0, Math.floor(chunk.frameCount)), true)
  view.setUint32(24, payloadBytes, true)
  view.setFloat64(28, Number.isFinite(chunk.hostTimeMs) ? chunk.hostTimeMs : 0, true)
  view.setUint32(36, 0, true)
  new Uint8Array(packet, PARALLAX_AUDIO_PACKET_HEADER_BYTES).set(source)

  return packet
}

export function readParallaxAudioPacketHeader(
  bytes: Uint8Array,
  offset: number = 0
): ParallaxAudioPacketHeader | null {
  if (bytes.byteLength - offset < PARALLAX_AUDIO_PACKET_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, PARALLAX_AUDIO_PACKET_HEADER_BYTES)
  if (view.getUint32(0, true) !== PARALLAX_AUDIO_PACKET_MAGIC) return null
  const version = view.getUint16(4, true)
  if (version !== PARALLAX_AUDIO_PACKET_VERSION) return null

  return {
    version,
    sampleRate: view.getUint32(8, true),
    channels: view.getUint16(12, true),
    startFrame: view.getUint32(16, true),
    frameCount: view.getUint32(20, true),
    hostTimeMs: view.getFloat64(28, true),
    payloadBytes: view.getUint32(24, true)
  }
}

export function decodeParallaxAudioPacket(
  bytes: Uint8Array,
  offset: number = 0
): { chunk: Omit<ParallaxAudioChunk, 'streamId'>; bytesRead: number } | null {
  const header = readParallaxAudioPacketHeader(bytes, offset)
  if (!header) return null
  const packetBytes = PARALLAX_AUDIO_PACKET_HEADER_BYTES + header.payloadBytes
  if (bytes.byteLength - offset < packetBytes) return null

  const payloadStart = offset + PARALLAX_AUDIO_PACKET_HEADER_BYTES
  const payload = bytes.slice(payloadStart, payloadStart + header.payloadBytes)
  return {
    chunk: {
      sampleRate: header.sampleRate,
      channels: header.channels,
      startFrame: header.startFrame,
      frameCount: header.frameCount,
      hostTimeMs: header.hostTimeMs,
      pcmData: payload.buffer
    },
    bytesRead: packetBytes
  }
}
