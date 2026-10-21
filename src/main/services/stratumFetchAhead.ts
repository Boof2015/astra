import type { StratumCachedPlayback } from './stratumAudioCache.ts'
import type { StratumAutomaticQuality } from './stratumAutomaticQuality.ts'
import type { StratumProofQuality } from './stratumProofClient.ts'
import type { StratumSegmentDiagnostics } from './streamingDiagnostics.ts'

type Prepared = { quality: StratumProofQuality; diagnostic: ReturnType<StratumSegmentDiagnostics['begin']> }

/** One sequential downloader per active playback, independent of PCM pressure.
 * Audio lives in the budgeted disk cache; only small interval receipts are queued
 * here (at most 450 for the supported 30-minute source limit). No decoder or
 * playback-clock wait limits how far a healthy connection can fetch ahead. */
export class StratumFetchAhead {
  private readonly prepared = new Map<number, Promise<Prepared>>()
  readonly finished: Promise<void>
  private readonly cached: StratumCachedPlayback
  private readonly signal: AbortSignal

  constructor(cached: StratumCachedPlayback, begin: number, signal: AbortSignal,
    quality: StratumProofQuality | ((start: number) => StratumProofQuality),
    diagnostics: StratumSegmentDiagnostics, onBytes: (bytes: number) => void,
    automatic?: StratumAutomaticQuality) {
    this.cached = cached
    this.signal = signal
    const source = cached.playback.source
    let previous: Promise<unknown> = Promise.resolve()
    for (let start = begin; start < source.frames; start += 4 * source.sample_rate) {
      const frames = Math.min(4 * source.sample_rate, source.frames - start)
      const ready = previous.then(async (): Promise<Prepared> => {
        signal.throwIfAborted()
        const requested = automatic?.choose(frames) ?? (typeof quality === 'function' ? quality(start) : quality)
        const selected = cached.retainedQuality(start, requested) ?? requested
        const timing = automatic?.begin(frames)
        const diagnostic = diagnostics.begin(start / source.sample_rate, (start + frames) / source.sample_rate, selected)
        try {
          const segment = await cached.segment(start, selected, signal, event => {
            timing?.observe(event)
            diagnostic.observe(event)
          })
          signal.throwIfAborted()
          const actual = segment.metadata.quality
          diagnostic.received(segment.payload.length, segment.localCacheHit ? null : segment.metadata.retained_cache_hit ?? null,
            segment.localCacheHit, actual)
          if (segment.localCacheHit) automatic?.retained(actual)
          else timing?.ready(actual, frames, segment.payload.length)
          onBytes(segment.payload.length)
          // Never return/retain the packet in the receipt. The decoder reads it
          // from disk when needed, with at most one interval of PCM pending.
          return { quality: actual, diagnostic }
        } catch (error) { diagnostic.failed(signal.aborted); throw error }
      })
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
    const receipt = await pending
    this.prepared.delete(start)
    this.signal.throwIfAborted()
    try {
      const segment = await this.cached.segment(start, receipt.quality, this.signal)
      return { segment, diagnostic: receipt.diagnostic }
    } catch (error) { receipt.diagnostic.failed(this.signal.aborted); throw error }
  }
}
