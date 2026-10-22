import { createHash } from 'node:crypto'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import { stratumProofRequest, validateStratumProofEndpoint, StratumProofError } from './stratumProofTransport.ts'
import type { StratumRequest } from './stratumTransport.ts'
import { STRATUM_CONTROL_TIMEOUT_MS, STRATUM_CLEANUP_TIMEOUT_MS } from './stratumNetwork.ts'
export { StratumProofError } from './stratumProofTransport.ts'

/** Checkpoint protocol only. This is not a discovery or production pairing API. */
export type StratumProofQuality = 'lossless' | 'opus-64' | 'opus-128'
export interface StratumProofConnection { endpoint: string; session: string }
/** Main-process owner shared by current/next playback. Never sent over IPC. */
export interface StratumProofAuthentication {
  readonly endpoint: string
  readonly signal: AbortSignal
  /** Installed services supply a verified HTTPS transport; proofs stay loopback-only. */
  readonly request?: StratumRequest
  getBearer(signal: AbortSignal): Promise<string>
  reject(): void
}
export interface StratumProofSource {
  sha256: string; sample_rate: number; channels: number; bits_per_sample: number; frames: number
}
export interface StratumProofPlayback { playback: string; source: StratumProofSource }
export interface StratumProofSegment {
  payload: Buffer
  metadata: {
    quality: StratumProofQuality; sample_rate: number; codec_sample_rate: number
    channels: number; decoded_frames: number; discard_start_frames: number
    discard_end_frames: number; presentation: { start: number; frames: number }
    retained_cache_hit?: boolean
  }
}

const HASH = /^[a-f0-9]{64}$/
const PAYLOAD_LIMIT = 4 * 1024 * 1024
function invalid(): never { throw new Error('Invalid Stratum proof response.') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}
function json(bytes: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(bytes.toString('utf8'))) } catch { return invalid() }
}

export function validateStratumProofConnection(value: StratumProofConnection): StratumProofConnection {
  const endpoint = validateStratumProofEndpoint(value.endpoint)
  if (typeof value.session !== 'string' || !HASH.test(value.session)) {
    throw new Error('Stratum proof requires a disposable session.')
  }
  return { endpoint, session: value.session }
}

// A preparation reserves a server slot before its response reaches us. Serialize
// handle mutations across current/next clients so cancellation can reclaim it
// before a replacement reserves another. Segment delivery remains concurrent.
const playbackMutations = new WeakMap<object, Promise<unknown>>()

export class StratumProofClient {
  private connection: StratumProofConnection | StratumProofAuthentication
  constructor(connection: StratumProofConnection | StratumProofAuthentication) {
    if (!('request' in connection) || !connection.request) validateStratumProofEndpoint(connection.endpoint)
    if (!('getBearer' in connection)) validateStratumProofConnection(connection)
    this.connection = connection
  }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal,
    body?: unknown, authenticated = true, limit = 64 * 1024,
    observe?: (event: AudioTransferEvent) => void): Promise<{ bytes: Buffer; type: string }> {
    const owner = 'getBearer' in this.connection ? this.connection : undefined
    const combined = owner ? AbortSignal.any([signal, owner.signal]) : signal
    const bearer = authenticated ? owner ? await owner.getBearer(combined) : (this.connection as StratumProofConnection).session : undefined
    try {
      return await (owner?.request ? owner.request(path, method, combined, body, bearer, limit, observe)
        : stratumProofRequest(this.connection.endpoint, path, method, combined, body, bearer, limit, observe))
    } catch (error) {
      if (error instanceof StratumProofError && error.status === 401) owner?.reject()
      throw error
    }
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = playbackMutations.get(this.connection) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(work)
    playbackMutations.set(this.connection, task)
    void task.finally(() => {
      if (playbackMutations.get(this.connection) === task) playbackMutations.delete(this.connection)
    }).catch(() => {})
    return task
  }

  open(trackId: string, signal: AbortSignal): Promise<StratumProofPlayback> {
    return this.mutate(() => this.openHandle(trackId, signal))
  }

  private async openHandle(trackId: string, signal: AbortSignal): Promise<StratumProofPlayback> {
    signal.throwIfAborted()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trackId)) throw new Error('Invalid Stratum test track.')
    const capabilities = await this.request('/access/v1/capabilities', 'GET', signal, undefined, false)
    const advertised = json(capabilities.bytes)
    if (advertised.protocol !== 'stratum-access-proof-1' || advertised.audioExperiment !== 'stratum-authenticated-audio-1') {
      throw new Error('This endpoint does not provide the authenticated Stratum audio proof.')
    }
    signal.throwIfAborted()
    // Keep the bounded POST alive long enough to receive and delete its handle.
    // Destroying its socket on seek would discard the only handle we can close.
    const response = await this.request(`/audio/v1/playbacks/${trackId}`, 'POST', AbortSignal.timeout(STRATUM_CONTROL_TIMEOUT_MS))
    const value = json(response.bytes)
    const playback = hash(value.playback)
    try {
      signal.throwIfAborted()
      const raw = record(value.source)
      const rate = integer(raw.sample_rate, 44100, 96000)
      if (![44100, 48000, 96000].includes(rate) || !['flac', 'pcm_s16le', 'pcm_s24le'].includes(String(raw.codec))
        || value.sourcePolicy !== 'complete-private-copy' || value.maxSegmentSeconds !== 4) invalid()
      const bits = integer(raw.bits_per_sample, 16, 24)
      if (bits !== 16 && bits !== 24) invalid()
      return { playback, source: { sha256: hash(raw.sha256), sample_rate: rate,
        channels: integer(raw.channels, 1, 2), bits_per_sample: bits, frames: integer(raw.frames, 1, rate * 1800) } }
    } catch (error) {
      await this.closeHandle(playback)
      throw error
    }
  }

  async segment(playback: StratumProofPlayback, start: number, frames: number, quality: StratumProofQuality,
    signal: AbortSignal, observe?: (event: AudioTransferEvent) => void): Promise<StratumProofSegment> {
    const source = playback.source
    integer(start, 0, source.frames - 1)
    integer(frames, 1, Math.min(4 * source.sample_rate, source.frames - start))
    if (!['lossless', 'opus-64', 'opus-128'].includes(quality)) invalid()
    const response = await this.segmentResponse(playback, start, frames, quality, signal, observe)
    return parseStratumSegment(response, source, start, frames, quality, signal)
  }

  async segmentResponse(playback: StratumProofPlayback, start: number, frames: number, quality: StratumProofQuality,
    signal: AbortSignal, observe?: (event: AudioTransferEvent) => void) {
    integer(start, 0, playback.source.frames - 1)
    integer(frames, 1, Math.min(4 * playback.source.sample_rate, playback.source.frames - start))
    if (!['lossless', 'opus-64', 'opus-128'].includes(quality)) invalid()
    const response = await this.request(`/audio/v1/playback/${hash(playback.playback)}/segment`, 'POST', signal,
      { start, frames, quality }, true, PAYLOAD_LIMIT + 16_388, observe)
    parseStratumSegment(response, playback.source, start, frames, quality, signal)
    return response
  }

  close(playback: string): Promise<void> { return this.mutate(() => this.closeHandle(playback)) }

  /** Reserve cleanup's place before a replacement can open. Cached downloads
   * may still be completing an interval when their decoder is cancelled. */
  closeAfter(playback: Promise<StratumProofPlayback>, pending: Promise<unknown>[]): Promise<void> {
    return this.mutate(async () => {
      await Promise.allSettled(pending)
      try { await this.closeHandle((await playback).playback) } catch { /* Failed preparation has no handle. */ }
    })
  }

  private async closeHandle(playback: string): Promise<void> {
    if (!HASH.test(playback)) return
    try { await this.request(`/audio/v1/playback/${playback}`, 'DELETE', AbortSignal.timeout(STRATUM_CLEANUP_TIMEOUT_MS)) }
    catch { /* Best effort: server expiry also reclaims abandoned handles. */ }
  }
}

/** Apply the same contract and payload hash checks to disk and network bytes. */
export function parseStratumSegment(response: { bytes: Buffer; type: string }, source: StratumProofSource,
  start: number, frames: number, quality: StratumProofQuality, signal: AbortSignal): StratumProofSegment {
    const bytes = response.bytes
    if (response.type !== 'application/vnd.stratum.segment' || bytes.length < 4) invalid()
    const size = bytes.readUInt32BE(0)
    if (size > 16_384 || size + 4 >= bytes.length) invalid()
    const metadata = json(bytes.subarray(4, 4 + size))
    const payload = bytes.subarray(4 + size)
    if (payload.length > PAYLOAD_LIMIT || metadata.experiment !== 'stratum-audio-poc-2'
      || metadata.source_sha256 !== source.sha256 || metadata.quality !== quality
      || metadata.sample_rate !== source.sample_rate || metadata.channels !== source.channels
      || metadata.source_bytes_preserved !== false || metadata.source_pcm_preserved !== (quality === 'lossless')
      || metadata.payload_bytes !== payload.length || hash(metadata.payload_sha256) !== createHash('sha256').update(payload).digest('hex')) invalid()
    hash(metadata.encoder)
    const codecRate = quality === 'lossless' ? source.sample_rate : 48000
    if (metadata.codec_sample_rate !== codecRate) invalid()
    const presented = record(metadata.presentation)
    const encoded = record(metadata.encoded_interval)
    if (presented.start !== start || presented.frames !== frames) invalid()
    const encodedStart = integer(encoded.start, 0, start)
    const encodedFrames = integer(encoded.frames, frames, Math.min(source.frames - encodedStart, source.sample_rate * 5))
    if (encodedStart + encodedFrames < start + frames) invalid()
    const decoded = integer(metadata.decoded_frames, encodedFrames, encodedFrames + 1)
    const skip = integer(metadata.discard_start_frames, 0, source.sample_rate)
    const tail = integer(metadata.discard_end_frames, 0, source.sample_rate + 1)
    if (skip !== start - encodedStart || skip + frames + tail !== decoded
      || metadata.resample_tail_frames !== decoded - encodedFrames) invalid()
    integer(metadata.codec_decoded_frames, 1, codecRate * 5)
    integer(metadata.codec_preskip_frames, 0, 65535)
    signal.throwIfAborted()
    return { payload, metadata: { quality, sample_rate: source.sample_rate, codec_sample_rate: codecRate,
      channels: source.channels, decoded_frames: decoded, discard_start_frames: skip,
      discard_end_frames: tail, presentation: { start, frames },
      // Optional diagnostic hint. Older proofs omit it; absence is not a miss.
      ...(typeof metadata.retained_cache_hit === 'boolean' ? { retained_cache_hit: metadata.retained_cache_hit } : {}) } }
}
