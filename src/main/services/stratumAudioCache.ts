import { createHash, randomBytes } from 'node:crypto'
import { RemoteAudioCache, remoteAudioCacheKey, type RemoteAudioSource, type RemoteAudioLease } from './remoteAudioCache.ts'
import { isStratumRefusal } from './stratumProofTransport.ts'
import { StratumProofClient, parseStratumSegment, type StratumProofAuthentication, type StratumProofPlayback,
  type StratumProofSource, type StratumProofQuality, type StratumProofSegment } from './stratumProofClient.ts'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import type { RemoteAudioAnalysis } from '../../types/remoteAudioAnalysis.ts'
import type { StreamingDiagnosticCacheRange } from '../../types/streamingDiagnostics.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const qualities: StratumProofQuality[] = ['lossless', 'opus-128', 'opus-64']
const packetType = 'application/vnd.stratum.segment'
const packetLimit = 4 * 1024 * 1024 + 16_388
export interface StratumCacheOptions {
  scope: string
  track: string
  revision: string
  profile: StratumProofQuality | 'automatic' | 'automatic-original'
}
interface AnalysisTools {
  decode(segment: StratumProofSegment, signal: AbortSignal): Promise<Buffer>
  scan(source: StratumProofSource, pcm: AsyncIterable<Buffer>, signal: AbortSignal): Promise<RemoteAudioAnalysis>
}

function sourceFromBytes(bytes: Buffer): StratumProofSource {
  const s = JSON.parse(bytes.toString()) as StratumProofSource
  if (!s || !/^[a-f0-9]{64}$/.test(s.sha256) || ![44100, 48000, 96000].includes(s.sample_rate)
    || ![16, 24].includes(s.bits_per_sample) || ![1, 2].includes(s.channels)
    || !Number.isSafeInteger(s.frames) || s.frames < 1 || s.frames > s.sample_rate * 1800) {
    throw new Error('Invalid retained Stratum source.')
  }
  return s
}

/** Stratum uses the existing disk cache and eviction budget. Only completed,
 * independently validated intervals survive interruption; all keys are scoped to
 * the approved account/installation and source revision. No remote handle is saved. */
export class StratumAudioCache {
  private readonly queue = new Map<string, () => Promise<void>>()
  private running: Promise<void> | null = null
  private active: string | null = null
  private readonly controller = new AbortController()
  readonly cache: RemoteAudioCache
  readonly tools: AnalysisTools
  constructor(cache: RemoteAudioCache, tools: AnalysisTools) { this.cache = cache; this.tools = tools }

  async open(connection: StratumProofAuthentication, options: StratumCacheOptions, signal: AbortSignal): Promise<StratumCachedPlayback> {
    if (this.controller.signal.aborted) throw new Error('Stratum cache is closed.')
    return StratumCachedPlayback.open(this, connection, options, signal)
  }

  schedule(key: string, work: () => Promise<void>): void {
    if (this.controller.signal.aborted || this.queue.has(key) || this.active === key) return
    this.queue.set(key, work)
    if (this.queue.size > 32) this.queue.delete(this.queue.keys().next().value!)
    this.startQueued()
  }

  private startQueued(): void {
    if (this.running || !this.queue.size || this.controller.signal.aborted) return
    this.running = this.pump().finally(() => {
      this.running = null
      this.startQueued()
    })
  }

  private async pump(): Promise<void> {
    while (this.queue.size && !this.controller.signal.aborted) {
      const [key, work] = this.queue.entries().next().value!
      this.queue.delete(key)
      this.active = key
      try { await work() } catch { /* Optional analysis never blocks playback. */ }
      this.active = null
    }
  }

  get signal(): AbortSignal { return this.controller.signal }
  async close(): Promise<void> { this.controller.abort(); await this.running; this.queue.clear() }
}

export class StratumCachedPlayback {
  readonly playback: StratumProofPlayback
  readonly analysisKey: string
  readonly analysis: RemoteAudioAnalysis | null
  private readonly client: StratumProofClient
  private remote: Promise<StratumProofPlayback> | null
  private readonly leases = new Map<string, RemoteAudioLease>()
  private readonly available = new Map<number, Set<StratumProofQuality>>()
  private readonly requests = new Set<Promise<unknown>>()
  private closed = false
  private remoteRelease: Promise<void> | null = null

  private readonly owner: StratumAudioCache
  private readonly options: StratumCacheOptions
  private readonly group: string
  private readonly unpin: () => void
  private readonly index: RemoteAudioLease
  private readonly analysisSource: RemoteAudioSource
  private readonly analysisLease: RemoteAudioLease

  private constructor(owner: StratumAudioCache, options: StratumCacheOptions,
    connection: StratumProofAuthentication, source: StratumProofSource,
    remote: Promise<StratumProofPlayback> | null, group: string,
    unpin: () => void, index: RemoteAudioLease,
    analysisSource: RemoteAudioSource, analysisLease: RemoteAudioLease,
    analysis: RemoteAudioAnalysis | null) {
    this.owner = owner; this.options = options; this.group = group; this.unpin = unpin
    this.index = index; this.analysisSource = analysisSource; this.analysisLease = analysisLease
    this.client = new StratumProofClient(connection)
    this.remote = remote
    this.playback = { playback: randomBytes(32).toString('hex'), source }
    this.analysisKey = remoteAudioCacheKey(analysisSource)
    this.analysis = analysis
  }

  static async open(owner: StratumAudioCache, connection: StratumProofAuthentication,
    options: StratumCacheOptions, signal: AbortSignal): Promise<StratumCachedPlayback> {
    const group = digest(['stratum:v1', options.scope, options.track, options.revision])
    const unpin = owner.cache.pinGroup(group)
    const client = new StratumProofClient(connection)
    let remote: Promise<StratumProofPlayback> | null = null
    let index: RemoteAudioLease | undefined, analysisLease: RemoteAudioLease | undefined
    try {
      const indexSource: RemoteAudioSource = { provider: 'stratum', account: options.scope, track: options.track,
        representation: 'source:v1', revision: options.revision, analyze: false, group,
        open: async () => {
          if (!remote) throw new Error('Stratum source metadata is not retained.')
          return new Response(JSON.stringify((await remote).source), { headers: { 'Content-Type': 'application/vnd.stratum.source' } })
        } }
      // Handle preparation has its own cancellation/cleanup contract. Do not
      // put it behind the generic cache's delayed download cancellation.
      if (!await owner.cache.hasComplete(indexSource)) {
        remote = client.open(options.track, signal)
        await remote
      }
      index = await owner.cache.acquire(indexSource, signal)
      const source = sourceFromBytes(await index.readBytes!(4096))
      signal.throwIfAborted()
      const analysisSource: RemoteAudioSource = { provider: 'stratum', account: options.scope, track: options.track,
        representation: `analysis:v1:${options.profile}`, revision: JSON.stringify([options.revision, source]), analyze: false, group,
        open: async () => new Response(JSON.stringify(source), { headers: { 'Content-Type': 'application/vnd.stratum.source' } }) }
      analysisLease = await owner.cache.acquire(analysisSource, signal)
      await analysisLease.finished()
      const result = new StratumCachedPlayback(owner, options, connection, source, remote, group, unpin, index,
        analysisSource, analysisLease, await owner.cache.getAnalysis(remoteAudioCacheKey(analysisSource)))
      await result.inventory()
      signal.throwIfAborted()
      result.scheduleAnalysis()
      return result
    } catch (error) {
      index?.release(); analysisLease?.release(); unpin()
      // Source staging may finish just after cancellation. Reclaim its handle.
      if (remote) void (remote as Promise<StratumProofPlayback>).then(value => client.close(value.playback)).catch(() => {})
      throw error
    }
  }

  private segmentSource(start: number, quality: StratumProofQuality,
    fetch: RemoteAudioSource['open'] = async () => { throw new Error('Stratum interval is not retained.') }): RemoteAudioSource {
    return { provider: 'stratum', account: this.options.scope, track: this.options.track,
      representation: `segment:v1:${quality}:${start}:${this.frames(start)}`,
      revision: JSON.stringify([this.options.revision, this.playback.source]), analyze: false, group: this.group, open: fetch,
      // An interval nobody reads any more stops competing for the link at once;
      // a refusal keeps its safe type so callers do not retry it.
      releaseGraceMs: 0, refusal: error => isStratumRefusal(error) ? error : null,
      // Automatic quality retries a failed interval at a cheaper representation itself.
      ...(this.options.profile.startsWith('automatic') ? { retries: 0 } : {}) }
  }
  private frames(start: number): number { return Math.min(4 * this.playback.source.sample_rate, this.playback.source.frames - start) }

  private async inventory(): Promise<void> {
    for (let start = 0; start < this.playback.source.frames; start += 4 * this.playback.source.sample_rate) {
      const found = new Set<StratumProofQuality>()
      for (const quality of qualities) if (await this.owner.cache.hasComplete(this.segmentSource(start, quality))) found.add(quality)
      this.available.set(start, found)
    }
  }

  private async remotePlayback(signal: AbortSignal): Promise<StratumProofPlayback> {
    this.remote ??= this.client.open(this.options.track, signal)
    const playback = await this.remote
    if (JSON.stringify(playback.source) !== JSON.stringify(this.playback.source)) {
      throw new Error('The Stratum source audio changed. Clear the streaming cache and retry.')
    }
    return playback
  }

  async segment(start: number, quality: StratumProofQuality, signal: AbortSignal,
    observe?: (event: AudioTransferEvent) => void): Promise<StratumProofSegment & { localCacheHit: boolean }> {
    signal.throwIfAborted()
    // Fetching can finish long before decoding. Releasing the server handle
    // must still allow reads of the retained intervals pinned by this playback.
    if (this.closed) throw new Error('Stratum playback was released.')
    if (!Number.isSafeInteger(start) || start < 0 || start >= this.playback.source.frames
      || start % (4 * this.playback.source.sample_rate) !== 0 || !qualities.includes(quality)) {
      throw new Error('Invalid Stratum cache interval.')
    }
    const source = this.segmentSource(start, quality, requestSignal => {
      const task = (async () => {
        if (this.closed || this.remoteRelease) throw new Error('Stratum playback was released.')
        const playback = await this.remotePlayback(requestSignal)
        const response = await this.client.segmentResponse(playback, start, this.frames(start), quality, requestSignal, observe)
        return new Response(new Uint8Array(response.bytes), { headers: { 'Content-Type': packetType } })
      })()
      this.requests.add(task)
      void task.finally(() => this.requests.delete(task)).catch(() => {})
      return task
    })
    const key = remoteAudioCacheKey(source)
    const localCacheHit = await this.owner.cache.hasComplete(source)
    const lease = this.leases.get(key) ?? await this.owner.cache.acquire(source, signal)
    if (this.closed || signal.aborted) { lease.release(); signal.throwIfAborted(); throw new Error('Stratum playback was released.') }
    this.leases.set(key, lease)
    let bytes: Buffer
    try { bytes = await lease.readBytes!(packetLimit) }
    catch (error) {
      this.leases.delete(key)
      lease.release()
      signal.throwIfAborted()
      // Automatic playback may use a different retained representation offline.
      // A fixed/original request never silently substitutes a lower quality.
      this.available.get(start)?.delete(quality)
      const alternative = this.options.profile.startsWith('automatic') && qualities.find(candidate =>
        candidate !== quality && this.available.get(start)?.has(candidate))
      if (alternative) return this.segment(start, alternative, signal)
      throw error
    }
    const segment = parseStratumSegment({ bytes, type: packetType },
      this.playback.source, start, this.frames(start), quality, signal)
    this.available.get(start)?.add(quality)
    this.scheduleAnalysis()
    return { ...segment, localCacheHit }
  }

  /** Automatic uses the best retained interval before spending more bandwidth.
   * Explicit Original/Fixed requests still require their exact representation. */
  retainedQuality(start: number, requested: StratumProofQuality): StratumProofQuality | undefined {
    const available = this.available.get(start)
    return this.options.profile.startsWith('automatic')
      ? qualities.find(quality => available?.has(quality)) : available?.has(requested) ? requested : undefined
  }

  playableAhead(position: number): number {
    const { sample_rate: rate, frames } = this.playback.source
    const origin = Math.max(0, Math.floor(position * rate))
    let end = Math.floor(origin / (4 * rate)) * 4 * rate
    const fixed = qualities.includes(this.options.profile as StratumProofQuality) ? this.options.profile as StratumProofQuality : undefined
    while (end < frames) {
      const available = this.available.get(end)
      if (fixed ? !available?.has(fixed) : !available?.size) break
      end += this.frames(end)
    }
    return Math.max(0, end - origin) / rate
  }

  private analysisPlan(): Array<{ start: number; quality: StratumProofQuality }> | null {
    const plan: Array<{ start: number; quality: StratumProofQuality }> = []
    for (const [start, available] of this.available) {
      const quality = qualities.includes(this.options.profile as StratumProofQuality)
        ? available.has(this.options.profile as StratumProofQuality) ? this.options.profile as StratumProofQuality : undefined
        : qualities.find(quality => available.has(quality))
      if (!quality) return null
      plan.push({ start, quality })
    }
    return plan.length ? plan : null
  }

  private scheduleAnalysis(): void {
    if (this.analysis) return
    const candidate = this.analysisPlan()
    if (!candidate) return
    const plan = candidate
    this.owner.schedule(this.analysisKey, async () => {
      if (await this.owner.cache.getAnalysis(this.analysisKey)) return
      const unpin = this.owner.cache.pinGroup(this.group)
      let lease: RemoteAudioLease | undefined
      try {
        lease = await this.owner.cache.acquire(this.analysisSource, this.owner.signal)
        await lease.finished()
        const scan = this
        async function* pcm() {
          for (const { start, quality } of plan) {
            const source = scan.segmentSource(start, quality)
            // Analysis never fetches a missing interval from the server.
            if (!await scan.owner.cache.hasComplete(source)) throw new Error('Stratum analysis interval was evicted.')
            const cached = await scan.owner.cache.acquire(source, scan.owner.signal)
            try {
              const segment = parseStratumSegment({ bytes: await cached.readBytes!(packetLimit), type: packetType },
                scan.playback.source, start, scan.frames(start), quality, scan.owner.signal)
              yield await scan.owner.tools.decode(segment, scan.owner.signal)
            } finally { cached.release() }
          }
        }
        const analysis = await this.owner.tools.scan(this.playback.source, pcm(), this.owner.signal)
        this.owner.signal.throwIfAborted()
        await this.owner.cache.storeAnalysis(this.analysisKey, analysis)
      } finally { lease?.release(); unpin() }
    })
  }

  get complete(): boolean { return !!this.analysisPlan() }
  /** The active group is pinned against clear/eviction. Sampling this existing
   * inventory does no I/O and includes retained intervals from earlier seeks. */
  get cachedRanges(): StreamingDiagnosticCacheRange[] {
    if (this.closed) return []
    const rate = this.playback.source.sample_rate
    return [...this.available].flatMap(([start, found]) => found.size ? [{
      start: start / rate, end: (start + this.frames(start)) / rate,
      qualities: qualities.filter(quality => found.has(quality))
    }] : [])
  }
  get analysisReady(): boolean { return this.owner.cache.hasAnalysis(this.analysisKey) }
  releaseRemote(): Promise<void> {
    return this.remoteRelease ??= this.remote
      ? this.client.closeAfter(this.remote, [...this.requests]) : Promise.resolve()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const lease of this.leases.values()) lease.release()
    this.leases.clear(); this.index.release(); this.analysisLease.release(); this.unpin()
    void this.releaseRemote()
  }
}
