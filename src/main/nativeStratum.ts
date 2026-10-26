import { PassThrough } from 'node:stream'
import { StratumProofPcm } from './services/stratumProofPlayback.ts'
import { stratumPlaybackQuality } from './services/stratumQuality.ts'
import { canPrefetchStratum, StratumPrefetchGate } from './services/stratumPrefetch.ts'
import type { StratumProofAuthentication, StratumProofConnection, StratumProofQuality } from './services/stratumProofClient.ts'
import type { StratumAudioCache, StratumCacheOptions } from './services/stratumAudioCache.ts'
import type { AutomaticStreamingQuality, StreamingQualityRequest } from '../types/streamingQuality.ts'
import type { NativeRemoteProgress, NativeRemoteRequest, NativeStratumInfo } from '../types/nativeRemoteSource.ts'
import type { RemoteStreamQualityChange } from '../types/remoteStream.ts'
import type { StreamingDiagnosticsSession } from '../types/streamingDiagnostics.ts'

export interface NativeStratumRoute {
  connection: StratumProofAuthentication | StratumProofConnection
  track: string
  quality: StratumProofQuality
  mode?: AutomaticStreamingQuality
  pinInitial?: boolean
  key: string
  cache?: { owner: StratumAudioCache; options: StratumCacheOptions }
}
interface Entry {
  owner: number
  controller: AbortController
  slot: 'current' | 'next'
  sessionId: number
  pcm?: StratumProofPcm
  stream?: PassThrough
  feed?: Promise<void>
  iterator?: AsyncIterator<Buffer>
  first?: ArrayBuffer
  remainder: Buffer
  reading: boolean
  frames: number
  position: number
  bufferedEnd: number
  outputRate?: number
  loadedBytes: number
  complete: boolean
  error?: Error
  changes: RemoteStreamQualityChange[]
  info?: NativeStratumInfo
  closing?: Promise<void>
  releaseArtwork?: () => void
}

/** Main owns authentication, cache and decoding. Preload pulls bounded PCM into
 * the existing native ring; the native engine alone applies DSP/resampling.
 * Current and next share the same Stratum controller and prefetch policy as Standard. */
export class NativeStratumRegistry {
  private readonly owners = new Map<number, Map<string, Entry>>()
  private readonly completed = new Map<number, Map<number, StreamingDiagnosticsSession>>()
  private readonly gate = new StratumPrefetchGate()
  private readonly deps: {
    route(path: string, quality: StreamingQualityRequest | undefined, signal: AbortSignal): Promise<NativeStratumRoute | null>
    ffmpeg(): Promise<string | null>
    allocateId(): number
    started(path: string): void
    failed(path: string, error: unknown): void
    holdArtwork?(): () => void
  }
  constructor(deps: NativeStratumRegistry['deps']) { this.deps = deps }

  async open(owner: number, id: string, path: string, quality: StreamingQualityRequest | undefined,
    request: NativeRemoteRequest): Promise<NativeStratumInfo | null> {
    if (typeof id !== 'string' || !id.length || id.length > 128 || typeof path !== 'string'
      || !request || request.policy !== 'processed' || !['current', 'next'].includes(request.slot)
      || !Number.isFinite(request.startTimeSeconds) || request.startTimeSeconds < 0) throw new Error('Invalid native Stratum request.')
    const entries = this.owners.get(owner) ?? new Map<string, Entry>()
    if (entries.has(id) || [...entries.values()].filter(entry => !entry.closing).length >= 4) throw new Error('Too many native Stratum requests.')
    this.owners.set(owner, entries)
    const entry: Entry = { owner, controller: new AbortController(), slot: request.slot, sessionId: this.deps.allocateId(),
      reading: false, remainder: Buffer.alloc(0), frames: 0, position: request.startTimeSeconds,
      bufferedEnd: request.startTimeSeconds, loadedBytes: 0, complete: false, changes: [] }
    entries.set(id, entry)
    const signal = entry.controller.signal
    let route: NativeStratumRoute | null = null
    try {
      // A skip can arrive immediately after stop/withdrawal. Let those server
      // handles close before consuming another of Sidecar's two session slots.
      await Promise.all([...entries.values()].flatMap(other => other.closing ? [other.closing] : []))
      signal.throwIfAborted()
      route = await this.deps.route(path, quality, signal)
      signal.throwIfAborted()
      if (!route) { await this.release(owner, id); return null }
      entry.releaseArtwork = request.slot === 'current' ? this.deps.holdArtwork?.() : undefined
      const binary = await this.deps.ffmpeg()
      signal.throwIfAborted()
      if (!binary) throw new Error('FFmpeg could not be resolved for Stratum playback.')
      const pcm = await StratumProofPcm.open(route.connection, route.track, null, request.startTimeSeconds, signal, route.cache)
      entry.pcm = pcm
      if (signal.aborted) { pcm.dispose(); await pcm.release(); signal.throwIfAborted() }
      const source = pcm.playback.source
      entry.position = pcm.interval.origin / source.sample_rate
      entry.bufferedEnd = entry.position
      entry.info = { sessionId: entry.sessionId, sampleRate: source.sample_rate, channels: source.channels,
        startFrame: pcm.interval.origin, duration: source.frames / source.sample_rate,
        quality: pcm.withAnalysis(stratumPlaybackQuality(source, route.quality, route.mode)) }
      const stream = entry.stream = new PassThrough({ highWaterMark: 64 * 1024 })
      stream.on('error', () => {})
      entry.iterator = stream[Symbol.asyncIterator]()
      entry.feed = pcm.feed(stream, binary, signal, route.quality, bytes => {
        entry.loadedBytes += bytes
        this.gate.changed()
      }, route.mode ? { mode: route.mode, key: route.key, pinInitial: route.pinInitial,
        buffer: () => ({ position: entry.position, ahead: Math.max(0, entry.bufferedEnd - entry.position) }) } : undefined,
      waitSignal => this.gate.wait(() => this.allowed(entry), waitSignal)).catch(error => {
        entry.error = error instanceof Error ? error : new Error('Stratum audio preparation failed.')
        stream.destroy(entry.error)
        throw entry.error
      })
      void entry.feed.catch(() => {})
      // Refusals/startup failures fall back before any PCM is handed to native.
      entry.first = await this.readEntry(entry) ?? undefined
      if (!entry.first) throw new Error('Stratum returned no audio.')
      entry.info.quality = pcm.initialQuality ?? entry.info.quality
      signal.throwIfAborted()
      if (entry.releaseArtwork) {
        const release = entry.releaseArtwork
        const timer = setTimeout(() => { entry.releaseArtwork?.(); entry.releaseArtwork = undefined }, 10_000)
        timer.unref()
        entry.releaseArtwork = () => { clearTimeout(timer); release() }
      }
      this.deps.started(path)
      return entry.info
    } catch (error) {
      const cancelled = signal.aborted
      await this.release(owner, id)
      if (cancelled) throw new Error('Native Stratum request cancelled.')
      if (route) this.deps.failed(path, error)
      return null
    }
  }

  private allowed(entry: Entry): boolean {
    return canPrefetchStratum({ slot: entry.slot, nextAhead: entry.pcm?.playableAhead(entry.position) ?? 0,
      current: [...(this.owners.get(entry.owner)?.values() ?? [])].filter(other => other !== entry
        && other.slot === 'current' && other.pcm && !other.controller.signal.aborted).map(other => {
        const ahead = Math.max(other.bufferedEnd - other.position, other.pcm!.playableAhead(other.position))
        return { ahead, complete: other.complete || other.position + ahead >= other.info!.duration - .001 }
      }) })
  }

  async read(owner: number, id: string): Promise<ArrayBuffer | null> {
    const entry = this.require(owner, id)
    if (entry.first) { const first = entry.first; entry.first = undefined; return first }
    return this.readEntry(entry)
  }
  private async readEntry(entry: Entry): Promise<ArrayBuffer | null> {
    if (entry.reading) throw new Error('A Stratum PCM read is already pending.')
    entry.reading = true
    try {
      entry.controller.signal.throwIfAborted()
      if (entry.error) throw entry.error
      if (!entry.remainder.length) {
        const next = await entry.iterator!.next()
        entry.controller.signal.throwIfAborted()
        if (next.done) {
          await entry.pcm!.verifyComplete(entry.frames)
          entry.complete = true
          this.gate.changed()
          return null
        }
        entry.remainder = next.value
      }
      const stride = entry.info!.channels * 4
      const count = Math.min(entry.remainder.length, Math.floor(64 * 1024 / stride) * stride)
      if (count % stride) throw new Error('Stratum returned an incomplete PCM frame.')
      const data = Uint8Array.from(entry.remainder.subarray(0, count)).buffer
      entry.remainder = entry.remainder.subarray(count)
      entry.frames += count / stride
      entry.changes.push(...entry.pcm!.takeQualityChanges(entry.frames))
      return data
    } finally { entry.reading = false }
  }

  progress(owner: number, id: string, position?: number, bufferedEnd?: number, outputRate?: number): NativeRemoteProgress {
    const entry = this.require(owner, id), info = entry.info!
    if (Number.isInteger(outputRate) && outputRate! > 0 && outputRate! <= 768000) entry.outputRate = outputRate
    const deliveredEnd = (info.startFrame + entry.frames) / info.sampleRate
    if (Number.isFinite(position)) entry.position = Math.max(info.startFrame / info.sampleRate, Math.min(deliveredEnd, position!))
    if (Number.isFinite(bufferedEnd)) entry.bufferedEnd = Math.max(entry.position, Math.min(deliveredEnd, bufferedEnd!))
    if (entry.bufferedEnd - entry.position >= 8) { entry.releaseArtwork?.(); entry.releaseArtwork = undefined }
    this.gate.changed()
    const frame = Math.floor(entry.position * info.sampleRate) - info.startFrame
    while (entry.changes.length > 1 && entry.changes[1].frame <= frame) entry.changes.shift()
    const quality = entry.changes[0]?.frame <= frame ? entry.changes[0].quality : info.quality
    return { loadedBytes: entry.loadedBytes, totalBytes: null, complete: entry.pcm!.cacheComplete,
      error: entry.error?.message ?? null, quality, transport: 'stratum-proof',
      analysisReady: entry.pcm!.analysisReady, diagnosticsSessionId: entry.sessionId }
  }

  activate(owner: number, id: string): void { this.require(owner, id).slot = 'current'; this.gate.changed() }
  async finished(owner: number, id: string): Promise<void> {
    const entry = this.require(owner, id)
    await entry.pcm!.verifyComplete(entry.frames)
  }

  diagnostics(owner: number, sessionId: number): StreamingDiagnosticsSession | undefined {
    const entry = [...(this.owners.get(owner)?.values() ?? [])].find(e => e.sessionId === sessionId && e.info && e.pcm)
    return entry ? this.snapshot(entry) : this.completed.get(owner)?.get(sessionId)
  }
  private snapshot(entry: Entry): StreamingDiagnosticsSession {
    const info = entry.info!, pcm = entry.pcm!
    return { sessionId: entry.sessionId, transport: 'stratum', start: info.startFrame / info.sampleRate,
      duration: info.duration, bufferedEnd: entry.bufferedEnd, sourceRate: info.sampleRate, outputRate: entry.outputRate ?? info.sampleRate,
      channels: info.channels, loadedBytes: entry.loadedBytes, totalBytes: null, localCacheComplete: pcm.cacheComplete,
      cachedRanges: pcm.cachedRanges, state: entry.error ? 'failed' : entry.complete ? 'complete' : 'preparing',
      ...pcm.diagnostics.snapshot() }
  }

  async release(owner: number, id: string): Promise<void> {
    const entries = this.owners.get(owner), entry = entries?.get(id)
    if (!entry) return
    if (entry.closing) return entry.closing
    entry.closing = (async () => {
      entry.controller.abort()
      entry.releaseArtwork?.(); entry.releaseArtwork = undefined
      entry.stream?.destroy(new Error('Native Stratum playback was released.'))
      this.gate.changed()
      await entry.feed?.catch(() => {})
      if (entry.info && entry.pcm) {
        const completed = this.completed.get(owner) ?? new Map<number, StreamingDiagnosticsSession>()
        completed.set(entry.sessionId, { ...this.snapshot(entry), localCacheComplete: false, cachedRanges: [] })
        while (completed.size > 4) completed.delete(completed.keys().next().value!)
        this.completed.set(owner, completed)
      }
      entry.pcm?.dispose()
      await entry.pcm?.release()
      entry.remainder = Buffer.alloc(0); entry.first = undefined
      entries!.delete(id)
      if (!entries!.size) this.owners.delete(owner)
      this.gate.changed()
    })()
    return entry.closing
  }
  async releaseOwner(owner: number): Promise<void> {
    await Promise.all([...(this.owners.get(owner)?.keys() ?? [])].map(id => this.release(owner, id)))
    this.completed.delete(owner)
  }
  async close(): Promise<void> { await Promise.all([...this.owners.keys()].map(owner => this.releaseOwner(owner))) }
  private require(owner: number, id: string): Entry {
    const entry = this.owners.get(owner)?.get(id)
    if (!entry?.info || entry.controller.signal.aborted) throw new Error('Native Stratum source is no longer available.')
    return entry
  }
}
