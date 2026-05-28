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
  startHostTimeMs: number
  updatedHostTimeMs: number
  groupLatencyMs: number
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

export interface ParallaxSinkTelemetry {
  streamId: string | null
  bufferedMs: number
  driftFrames: number
  rttMs: number | null
  underruns: number
  playbackRatePpm: number
  reportedAtMs: number
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

export function clampParallaxPlaybackRatePpm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-250, Math.min(250, value))
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
