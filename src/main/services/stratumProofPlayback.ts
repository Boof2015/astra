import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { StratumQualityController, stratumPlaybackQuality } from './stratumQuality.ts'
import type { AutomaticStreamingQuality as QualityMode, RemotePlaybackQuality } from '../../types/streamingQuality.ts'
import type { RemoteStreamQualityChange } from '../../types/remoteStream.ts'
import type { StratumAudioCache, StratumCachedPlayback, StratumCacheOptions } from './stratumAudioCache.ts'
import { StratumSegmentDiagnostics } from './streamingDiagnostics.ts'
import { StratumFetchAhead } from './stratumFetchAhead.ts'
import { StratumProofClient, type StratumProofAuthentication, type StratumProofConnection, type StratumProofPlayback,
  type StratumProofQuality, type StratumProofSegment } from './stratumProofClient.ts'

/** Container decoding applies Opus pre-skip/end trim exactly once. Then return
 * only the native presentation interval; output conversion is a separate pipe. */
export async function decodeStratumProofSegment(ffmpeg: string, segment: StratumProofSegment, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const { metadata: m } = segment
  const expectedBytes = m.decoded_frames * m.channels * 4
  const args = ['-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'pipe',
    '-f', m.quality === 'lossless' ? 'flac' : 'ogg', '-i', 'pipe:0', '-map', '0:a:0', '-vn',
    ...(m.codec_sample_rate !== m.sample_rate ? ['-af', stratumResampler(m.sample_rate)] : []),
    '-c:a', 'pcm_s32le', '-f', 's32le', 'pipe:1']
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let failure: Error | null = null
    const fail = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL') }
    const abort = () => fail('Stratum segment decoding was cancelled.')
    const timer = setTimeout(() => fail('Stratum segment decoding timed out.'), 8000)
    timer.unref()
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > expectedBytes) fail('Stratum decoded more frames than its contract allows.')
      else chunks.push(chunk)
    })
    child.stderr.resume() // Do not surface untrusted decoder text or credential-bearing diagnostics.
    child.stdin.on('error', () => fail('Stratum segment decoder input failed.'))
    child.on('error', () => { failure = new Error('Could not start the Stratum segment decoder.') })
    child.on('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure || signal.aborted || code !== 0 || size !== expectedBytes) {
        reject(failure ?? new Error('Stratum segment did not decode to its declared frame count.'))
        return
      }
      const decoded = Buffer.concat(chunks)
      const begin = m.discard_start_frames * m.channels * 4
      resolve(decoded.subarray(begin, begin + m.presentation.frames * m.channels * 4))
    })
    if (signal.aborted) abort()
    child.stdin.end(segment.payload)
  })
}

export function stratumResampler(rate: number): string {
  return `aresample=${rate}:resampler=swr:exact_rational=1:async=0:dither_method=none`
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }
export function stratumOutputInterval(source: StratumProofPlayback['source'], rate: number, seconds: number) {
  if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000 || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('Unsupported Stratum output clock or seek position.')
  }
  const origin = Math.floor(seconds * source.sample_rate)
  if (origin >= source.frames) throw new Error('Stratum seek is outside this track.')
  // Source-zero phase plus actual pre-roll for a seek. Never reset this converter
  // at a network segment or quality boundary, and never flush during starvation.
  const stride = source.sample_rate / gcd(source.sample_rate, rate)
  const begin = source.sample_rate === rate ? origin
    : Math.floor(Math.max(0, origin - Math.ceil(source.sample_rate * .12)) / stride) * stride
  const discard = Math.floor((origin - begin) * rate / source.sample_rate)
  const frames = Math.floor((source.frames - origin) * rate / source.sample_rate)
  if (frames < 1) throw new Error('Stratum seek has no output frames remaining.')
  return { origin, begin, discard, frames }
}

async function writePcm(input: Writable, pcm: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => done(new Error('Stratum PCM delivery was cancelled.'))
    const close = () => done(new Error('Stratum PCM input closed before completion.'))
    const done = (error?: Error | null) => {
      signal.removeEventListener('abort', abort)
      input.removeListener('close', close)
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
    input.once('close', close)
    input.write(pcm, done)
  })
  signal.throwIfAborted()
}

export class StratumProofPcm {
  readonly diagnostics = new StratumSegmentDiagnostics()
  initialQuality?: RemotePlaybackQuality
  private qualityChanges: RemoteStreamQualityChange[] = []
  private previousQuality?: StratumProofQuality
  readonly playback: StratumProofPlayback
  readonly interval: ReturnType<typeof stratumOutputInterval>
  readonly outputRate: number
  private client: StratumProofClient
  private releasePromise: Promise<void> | null = null
  private feeding: Promise<void> | null = null
  private completedInput = false
  private readonly cached?: StratumCachedPlayback
  private readonly stop = new AbortController()

  private constructor(client: StratumProofClient, playback: StratumProofPlayback, rate: number, seconds: number, cached?: StratumCachedPlayback) {
    this.cached = cached
    this.client = client
    this.playback = playback
    this.outputRate = rate
    this.interval = stratumOutputInterval(playback.source, rate, seconds)
  }

  static async open(connection: StratumProofConnection | StratumProofAuthentication, track: string, rate: number | null, seconds: number, signal: AbortSignal, cache?: { owner: StratumAudioCache; options: StratumCacheOptions }): Promise<StratumProofPcm> {
    const client = new StratumProofClient(connection)
    const cached = cache && 'getBearer' in connection ? await cache.owner.open(connection, cache.options, signal) : undefined
    const playback = cached?.playback ?? await client.open(track, signal)
    try {
      signal.throwIfAborted()
      // Native processed output accepts source-rate PCM and owns its resampler.
      return new StratumProofPcm(client, playback, rate ?? playback.source.sample_rate, seconds, cached)
    } catch (error) {
      if (cached) cached.dispose()
      else await client.close(playback.playback)
      throw error
    }
  }

  /** Same output rate selected by Astra's Standard AudioContext; no device changes. */
  converterArgs(): string[] {
    const { source } = this.playback
    const { discard, frames } = this.interval
    return ['-v', 'error', '-nostdin', '-f', 's32le', '-ar', String(source.sample_rate), '-ac', String(source.channels),
      '-probesize', '32', '-analyzeduration', '0', '-blocksize', '8192', '-i', 'pipe:0',
      '-af', `${stratumResampler(this.outputRate)},atrim=start_sample=${discard}:end_sample=${discard + frames}`,
      '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', '-flush_packets', '1', 'pipe:1']
  }

  feed(input: Writable, ffmpeg: string, signal: AbortSignal,
    quality: StratumProofQuality | ((start: number) => StratumProofQuality), onBytes: (count: number) => void = () => {},
    automatic?: { mode: QualityMode; key: string; pinInitial?: boolean;
      buffer: () => { position: number; ahead: number } },
    beforeFetch?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.feeding) throw new Error('Stratum PCM input already started.')
    signal = AbortSignal.any([signal, this.stop.signal])
    const controller = automatic && typeof quality === 'string' ? new StratumQualityController({ ...automatic,
      source: this.playback.source, initial: quality,
      qualities: () => this.cached?.qualities ?? this.playback.qualities,
      buffer: () => {
        const buffer = automatic.buffer()
        return { ...buffer, ahead: Math.max(buffer.ahead, this.cached?.playableAhead(buffer.position) ?? 0) }
      } }) : undefined
    this.feeding = this.run(input, ffmpeg, signal, quality, onBytes, controller, automatic?.mode, beforeFetch)
      .finally(() => this.stop.abort())
    return this.feeding
  }

  private async run(input: Writable, ffmpeg: string, signal: AbortSignal,
    quality: StratumProofQuality | ((start: number) => StratumProofQuality), onBytes: (count: number) => void,
    automatic?: StratumQualityController, mode?: QualityMode, beforeFetch?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const source = this.playback.source
    const begin = this.cached ? Math.floor(this.interval.begin / (4 * source.sample_rate)) * 4 * source.sample_rate : this.interval.begin
    const fetching = this.cached ? new StratumFetchAhead(this.cached, begin, signal, quality, this.diagnostics, onBytes, automatic, beforeFetch) : undefined
    try {
      for (let start = begin; start < source.frames;) {
        signal.throwIfAborted()
        const frames = Math.min(4 * source.sample_rate, source.frames - start)
        if (!fetching) await beforeFetch?.(signal)
        let selected: StratumProofQuality = fetching ? 'lossless' : automatic?.choose(frames) ?? (typeof quality === 'function' ? quality(start) : quality)
        let diagnostic: ReturnType<StratumSegmentDiagnostics['begin']> | undefined
        let segment: StratumProofSegment & { localCacheHit?: boolean }
        let pcm: Buffer
        try {
          if (fetching) {
            const prepared = await fetching.take(start)
            segment = prepared.segment
            diagnostic = prepared.diagnostic
          } else {
            const read = async (requested: StratumProofQuality, attemptSignal: AbortSignal,
              timing?: ReturnType<StratumQualityController['begin']>) => {
              const current = this.diagnostics.begin(start / source.sample_rate, (start + frames) / source.sample_rate, requested)
              diagnostic = current
              try {
                const result = await this.client.segment(this.playback, start, frames, requested, attemptSignal, event => {
                  timing?.observe(event)
                  current.observe(event)
                })
                current.received(result.payload.length, result.metadata.retained_cache_hit ?? null, false, result.metadata.quality)
                timing?.ready(result.metadata.quality, frames, result.payload.length)
                return result
              } catch (error) { current.failed(attemptSignal.aborted); throw error }
            }
            segment = automatic ? await automatic.fetch(frames, selected, signal, read) : await read(selected, signal)
          }
          selected = segment.metadata.quality
          signal.throwIfAborted()
          diagnostic!.decoding()
          pcm = await decodeStratumProofSegment(ffmpeg, segment, signal)
          if (start < this.interval.begin) pcm = pcm.subarray((this.interval.begin - start) * source.channels * 4)
          signal.throwIfAborted()
          diagnostic!.decoded()
        } catch (error) {
          diagnostic?.failed(signal.aborted)
          throw error
        }
        if (this.previousQuality !== selected) {
          const value = this.withAnalysis(stratumPlaybackQuality(source, selected, mode))
          this.initialQuality ??= value
          // Match the continuous converter's source-zero phase and seek trim.
          const frame = Math.max(0, Math.ceil((start - this.interval.begin) * this.outputRate / source.sample_rate) - this.interval.discard)
          this.qualityChanges.push({ frame, quality: value })
          this.previousQuality = selected
        }
        if (!fetching) onBytes(segment.payload.length)
        // Await each write: output backpressure propagates through the continuous
        // converter, keeping at most one decoded segment pending off the audio thread.
        await writePcm(input, pcm, signal)
        start += frames
      }
      signal.throwIfAborted()
      this.completedInput = true
      // Every interval is now on the client. Release the service slot before EOF
      // can promote another track; audible completion may be much later.
      await this.release()
      signal.throwIfAborted()
      input.end()
    } finally {
      // Decoder failure/seek/skip stops future requests too. Wait for a pending
      // request's cleanup before another playback can reuse the service slot.
      this.stop.abort()
      await fetching?.finished
    }
  }

  takeQualityChanges(endFrame: number): RemoteStreamQualityChange[] {
    let count = 0
    while (count < this.qualityChanges.length && this.qualityChanges[count].frame < endFrame) count++
    return this.qualityChanges.splice(0, count)
  }

  async verifyComplete(outputFrames: number): Promise<void> {
    await this.feeding
    if (!this.completedInput || outputFrames !== this.interval.frames) {
      throw new Error('Stratum playback ended before its complete output interval.')
    }
  }

  withAnalysis(quality: RemotePlaybackQuality): RemotePlaybackQuality {
    return this.cached ? { ...quality, analysisKey: this.cached.analysisKey,
      ...(this.cached.analysis ? { loudness: { loudnessLufs: this.cached.analysis.loudnessLufs,
        peakLinear: this.cached.analysis.peakLinear } } : {}) } : quality
  }
  playableAhead(position: number): number { return this.cached?.playableAhead(position) ?? 0 }
  get retainsCache(): boolean { return !!this.cached }
  get cacheComplete(): boolean { return this.cached?.complete ?? false }
  get cachedRanges() { return this.cached?.cachedRanges ?? [] }
  get analysisReady(): boolean { return this.cached?.analysisReady ?? false }
  dispose(): void { this.stop.abort(); this.cached?.dispose(); void this.release() }
  release(): Promise<void> { return this.releasePromise ??= this.cached ? this.cached.releaseRemote() : this.client.close(this.playback.playback) }
}
