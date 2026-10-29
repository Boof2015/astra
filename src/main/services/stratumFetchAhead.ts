import type { StratumCachedPlayback } from './stratumAudioCache.ts'
import { stratumQualityRank, type StratumQualityController } from './stratumQuality.ts'
import type { StratumProofQuality } from './stratumProofClient.ts'
import type { StratumSegmentDiagnostics } from './streamingDiagnostics.ts'

type Prepared = { quality: StratumProofQuality; diagnostic: ReturnType<StratumSegmentDiagnostics['begin']> }
// The decoder needs an interval this long before playback reaches it.
const UPGRADE_MARGIN_SECONDS = 2

/** Resolves with the value if it settles within `ms`, otherwise undefined. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
    promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
  })
}

/** One sequential downloader per active playback, independent of PCM pressure.
 * Audio lives in the budgeted disk cache; only small interval receipts are queued
 * here (at most 7,200 for the supported eight-hour source limit). No decoder or
 * playback-clock wait limits how far a healthy connection can fetch ahead.
 * Replacing a retained interval with a better one is optional: it may use only
 * the time before playback needs that interval, and never delays the retained copy. */
export class StratumFetchAhead {
  private readonly prepared = new Map<number, Promise<Prepared | undefined>>()
  private readonly done = new Map<number, Prepared | undefined>()
  /** Pending upgrades of retained intervals, dropped once the decoder needs them. */
  private readonly upgrades = new Map<number, AbortController>()
  /** Intervals the decoder already took as retained audio. */
  private readonly taken = new Set<number>()
  readonly finished: Promise<void>
  private readonly cached: StratumCachedPlayback
  private readonly signal: AbortSignal
  private readonly diagnostics: StratumSegmentDiagnostics
  private readonly automatic?: StratumQualityController

  constructor(cached: StratumCachedPlayback, begin: number, signal: AbortSignal,
    quality: StratumProofQuality | ((start: number) => StratumProofQuality),
    diagnostics: StratumSegmentDiagnostics, onBytes: (bytes: number) => void,
    automatic?: StratumQualityController, beforeFetch?: (signal: AbortSignal) => Promise<void>) {
    this.cached = cached
    this.signal = signal
    this.diagnostics = diagnostics
    this.automatic = automatic
    const source = cached.playback.source
    let previous: Promise<unknown> = Promise.resolve()
    for (let start = begin; start < source.frames; start += 4 * source.sample_rate) {
      const frames = Math.min(4 * source.sample_rate, source.frames - start)
      const ready = previous.then(async (): Promise<Prepared | undefined> => {
        signal.throwIfAborted()
        const preferred = typeof quality === 'function' ? quality(start) : quality
        const retained = cached.retainedQuality(start, preferred)
        if (retained && this.taken.has(start)) return undefined
        const read = async (selected: StratumProofQuality, attemptSignal: AbortSignal, timing?: ReturnType<StratumQualityController['begin']>): Promise<Prepared> => {
          const diagnostic = diagnostics.begin(start / source.sample_rate, (start + frames) / source.sample_rate, selected)
          try {
            const segment = await cached.segment(start, selected, attemptSignal, event => {
              timing?.observe(event)
              diagnostic.observe(event)
            })
            attemptSignal.throwIfAborted()
            const actual = segment.metadata.quality
            diagnostic.received(segment.payload.length, segment.localCacheHit ? null : segment.metadata.retained_cache_hit ?? null,
              segment.localCacheHit, actual)
            // Disk reads are not network delivery.
            if (!segment.localCacheHit) timing?.ready(actual, frames, segment.payload.length)
            onBytes(segment.payload.length)
            // Never return/retain the packet in the receipt. The decoder reads it
            // from disk when needed, with at most one interval of PCM pending.
            return { quality: actual, diagnostic }
          } catch (error) { diagnostic.failed(attemptSignal.aborted); throw error }
        }
        if (retained && automatic?.prefers(retained)) {
          const optional = new AbortController()
          this.upgrades.set(start, optional)
          const upgradeSignal = AbortSignal.any([signal, optional.signal])
          try {
            // Waiting for the next-track gate is not network latency.
            await beforeFetch?.(upgradeSignal)
            upgradeSignal.throwIfAborted()
            const requested = automatic.choose(frames)
            // Never fetch below what is retained: such a rung reads the retained copy.
            const better = (quality: StratumProofQuality, attemptSignal: AbortSignal, timing?: ReturnType<StratumQualityController['begin']>) =>
              read(stratumQualityRank(quality) > stratumQualityRank(retained) ? quality : retained, attemptSignal, timing)
            if (stratumQualityRank(requested) > stratumQualityRank(retained)) {
              return await automatic.fetch(frames, requested, upgradeSignal, better, start)
            }
          } catch { signal.throwIfAborted() } finally { this.upgrades.delete(start) }
          // A dropped, failed or unwarranted upgrade leaves the retained copy.
          return this.taken.has(start) ? undefined : read(retained, signal)
        }
        // Wait before starting quality/diagnostic clocks. Deliberately yielding
        // to current playback is not network latency. Retained audio needs no turn.
        if (!retained) await beforeFetch?.(signal)
        signal.throwIfAborted()
        const requested = automatic?.choose(frames) ?? preferred
        const selected = retained ?? requested
        return automatic ? automatic.fetch(frames, selected, signal, read, start) : read(selected, signal)
      })
      void ready.then(value => { this.done.set(start, value) }, () => {})
      this.prepared.set(start, ready)
      previous = ready
    }
    // A failure ahead of the listener is delivered when that interval is needed;
    // already prepared audio remains playable. Both paths promptly free the
    // service slot, without releasing the disk-cache pins needed by the decoder.
    this.finished = previous.then(() => cached.releaseRemote(), () => cached.releaseRemote())
  }

  async take(start: number) {
    this.signal.throwIfAborted()
    const pending = this.prepared.get(start)
    if (!pending) throw new Error('Stratum interval was not scheduled.')
    let receipt = this.done.get(start)
    const retained = this.automatic && !receipt ? this.cached.retainedQuality(start, 'lossless') : undefined
    if (retained) {
      // An upgrade still pending (or waiting for the gate) may use only the time
      // before playback needs this interval; then the retained copy plays.
      receipt = await within(pending, (this.automatic!.secondsUntil(start) - UPGRADE_MARGIN_SECONDS) * 1000)
      if (!receipt) {
        this.taken.add(start)
        this.upgrades.get(start)?.abort()
        this.prepared.delete(start)
        return this.retainedNow(start, retained)
      }
    }
    receipt ??= await pending
    this.prepared.delete(start)
    this.signal.throwIfAborted()
    if (!receipt) throw new Error('Stratum interval was not scheduled.')
    const prepared = receipt
    try {
      const segment = await this.cached.segment(start, prepared.quality, this.signal)
      return { segment, diagnostic: prepared.diagnostic }
    } catch (error) { prepared.diagnostic.failed(this.signal.aborted); throw error }
  }

  private async retainedNow(start: number, quality: StratumProofQuality) {
    const { sample_rate: rate, frames } = this.cached.playback.source
    const diagnostic = this.diagnostics.begin(start / rate, Math.min(start + 4 * rate, frames) / rate, quality)
    try {
      const segment = await this.cached.segment(start, quality, this.signal)
      diagnostic.received(segment.payload.length, null, true, quality)
      return { segment, diagnostic }
    } catch (error) { diagnostic.failed(this.signal.aborted); throw error }
  }
}
