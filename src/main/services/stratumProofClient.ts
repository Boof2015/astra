import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'

/** Checkpoint protocol only. This is not a discovery or production pairing API. */
export type StratumProofQuality = 'lossless' | 'opus-64' | 'opus-128'
export interface StratumProofConnection { endpoint: string; session: string }
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
  let url: URL
  try { url = new URL(value.endpoint) } catch { throw new Error('Invalid Stratum proof endpoint.') }
  // Literal loopback, no DNS, proxy, redirects, userinfo, paths or real Navidrome
  // credentials. A bearer comes from the disposable proof's external sign-in.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof value.session !== 'string' || !HASH.test(value.session)) {
    throw new Error('Stratum proof requires a loopback endpoint and a disposable session.')
  }
  return { endpoint: url.origin, session: value.session }
}

export class StratumProofError extends Error {
  readonly status: number
  constructor(status: number) {
    super(status === 401 ? 'The Stratum test sign-in expired. Create a new disposable session.'
      : status === 404 ? 'This track or playback is no longer available through Stratum.'
      : status === 415 ? 'This source format is not supported by the Stratum proof.'
      : status === 429 ? 'The Stratum proof is busy. Try again.'
      : status === 503 ? 'Stratum cannot reach its test music server.'
      : `The Stratum proof request failed (HTTP ${status}).`)
    this.status = status
  }
}

export class StratumProofClient {
  private connection: StratumProofConnection
  constructor(connection: StratumProofConnection) { this.connection = validateStratumProofConnection(connection) }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal,
    body?: unknown, authenticated = true, limit = 64 * 1024,
    observe?: (event: AudioTransferEvent) => void): Promise<{ bytes: Buffer; type: string }> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      let settled = false
      let transferring = false
      const finish = (error?: Error, result?: { bytes: Buffer; type: string }) => {
        if (settled) return
        settled = true
        if (transferring) observe?.({ phase: 'end', complete: !error })
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(result!)
      }
      const req = httpRequest(new URL(path, this.connection.endpoint), {
        method, agent: false, headers: {
          ...(authenticated ? { Authorization: `Bearer ${this.connection.session}` } : {}),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {})
        }
      }, response => {
        if (![200, 201, 204].includes(response.statusCode ?? 0)) {
          finish(new StratumProofError(response.statusCode ?? 0))
          response.destroy()
          return
        }
        const chunks: Buffer[] = []
        // Server authorization/encoding precedes headers. Measure body transfer
        // here; the adapter separately measures total time until PCM is ready.
        transferring = true
        observe?.({ phase: 'start' })
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          observe?.({ phase: 'data', bytes: chunk.length })
          if (length > limit) {
            finish(new Error('Stratum proof response exceeded its size limit.'))
            response.destroy()
          } else chunks.push(chunk)
        })
        response.on('error', () => finish(new Error('Stratum proof response was interrupted.')))
        response.on('end', () => finish(undefined, { bytes: Buffer.concat(chunks),
          type: String(response.headers['content-type'] ?? '').split(';')[0] }))
      })
      const abort = () => {
        finish(new Error('Stratum playback was cancelled.'))
        req.destroy()
      }
      const timer = setTimeout(() => {
        finish(new Error('Stratum proof request timed out.'))
        req.destroy()
      }, 12_000)
      timer.unref()
      req.on('error', () => finish(new Error('Could not connect to the Stratum proof.')))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      req.end(bytes)
    })
  }

  async open(trackId: string, signal: AbortSignal): Promise<StratumProofPlayback> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trackId)) throw new Error('Invalid Stratum test track.')
    const capabilities = await this.request('/access/v1/capabilities', 'GET', signal, undefined, false)
    const advertised = json(capabilities.bytes)
    if (advertised.protocol !== 'stratum-access-proof-1' || advertised.audioExperiment !== 'stratum-authenticated-audio-1') {
      throw new Error('This endpoint does not provide the authenticated Stratum audio proof.')
    }
    const response = await this.request(`/audio/v1/playbacks/${trackId}`, 'POST', signal)
    const value = json(response.bytes)
    const playback = hash(value.playback)
    try {
      const raw = record(value.source)
      const rate = integer(raw.sample_rate, 44100, 96000)
      if (![44100, 48000, 96000].includes(rate) || !['flac', 'pcm_s16le', 'pcm_s24le'].includes(String(raw.codec))
        || value.sourcePolicy !== 'complete-private-copy' || value.maxSegmentSeconds !== 4) invalid()
      const bits = integer(raw.bits_per_sample, 16, 24)
      if (bits !== 16 && bits !== 24) invalid()
      return { playback, source: { sha256: hash(raw.sha256), sample_rate: rate,
        channels: integer(raw.channels, 1, 2), bits_per_sample: bits, frames: integer(raw.frames, 1, rate * 1800) } }
    } catch (error) {
      await this.close(playback)
      throw error
    }
  }

  async segment(playback: StratumProofPlayback, start: number, frames: number, quality: StratumProofQuality,
    signal: AbortSignal, observe?: (event: AudioTransferEvent) => void): Promise<StratumProofSegment> {
    const source = playback.source
    integer(start, 0, source.frames - 1)
    integer(frames, 1, Math.min(4 * source.sample_rate, source.frames - start))
    if (!['lossless', 'opus-64', 'opus-128'].includes(quality)) invalid()
    const response = await this.request(`/audio/v1/playback/${hash(playback.playback)}/segment`, 'POST', signal,
      { start, frames, quality }, true, PAYLOAD_LIMIT + 16_388, observe)
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
      discard_end_frames: tail, presentation: { start, frames } } }
  }

  async close(playback: string): Promise<void> {
    if (!HASH.test(playback)) return
    try { await this.request(`/audio/v1/playback/${playback}`, 'DELETE', AbortSignal.timeout(1500)) }
    catch { /* Best effort: server expiry also reclaims abandoned handles. */ }
  }
}
