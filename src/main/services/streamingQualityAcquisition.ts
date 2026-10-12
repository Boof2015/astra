import { isAutomaticStreamingQuality, qualityRequestForTrack,
  type StreamingQualityRequest, type StreamQualityTarget, type RemoteCompatibilityCodec } from '../../types/streamingQuality'
import type { AutomaticStreamingQuality } from './automaticStreamingQuality'
import type { RemoteAudioCache, RemoteAudioLease, RemoteAudioSource } from './remoteAudioCache'
import { setTimeout as delay } from 'node:timers/promises'

export async function acquireQualityAudio(options: {
  cache: Pick<RemoteAudioCache, 'hasComplete' | 'acquire'>
  policy: AutomaticStreamingQuality
  key: string
  make: (quality: StreamQualityTarget, compatibility?: RemoteCompatibilityCodec) => RemoteAudioSource
  track: { codec?: string | null; format?: string | null; bitrate?: number | null } | null
  originalKbps: number
  selected: StreamingQualityRequest
  signal: AbortSignal
}): Promise<RemoteAudioLease> {
  const { cache, policy, key, selected, signal, make, track } = options
  const mode = typeof selected === 'object' ? selected.mode : isAutomaticStreamingQuality(selected) ? selected : undefined
  let target: StreamQualityTarget = typeof selected === 'object' ? selected.target
    : isAutomaticStreamingQuality(selected) ? policy.select(key, selected, options.originalKbps) : selected
  let compatibility = typeof selected === 'object' ? selected.compatibility : undefined
  let cached: StreamQualityTarget | undefined
  if (mode && typeof selected !== 'object') {
    // A cached original always wins. A smaller cached copy must not silently
    // cap a healthy connection: keep it as an offline/slow-start fallback.
    for (const candidate of ['original', 320, 256, 192, 128, 64] as const) {
      if (await cache.hasComplete(make(qualityRequestForTrack(candidate, track)))) { cached = candidate; break }
    }
    if (cached === 'original' || (typeof cached === 'number' && typeof target === 'number' && cached >= target)) target = cached
  }
  signal.throwIfAborted()
  // These keys are only populated after an explicit decoder/format failure.
  // Reuse that compatible representation after restart, even if the original
  // has since been evicted and the server is currently offline.
  if (!compatibility) {
    for (const codec of target === 'original' ? ['flac', 'mp3'] as const : ['mp3'] as const) {
      const candidate = make(target, codec)
      // Older/inert factories may ignore the optional compatibility argument.
      if (candidate.representation !== make(qualityRequestForTrack(target, track)).representation
        && await cache.hasComplete(candidate)) { compatibility = codec; break }
    }
  }
  const acquire = async (target: StreamQualityTarget) => {
    const source = make(compatibility ? target : qualityRequestForTrack(target, track), compatibility)
    source.observeTransfer = policy.observer(key)
    return cache.acquire(source, signal)
  }
  let lease = await acquire(target)
  if (!compatibility && cached !== undefined && cached !== target) {
    let failed = false
    void lease.finished().catch(() => { failed = true })
    const deadline = performance.now() + 1500
    try {
      while (!failed && !lease.progress().loadedBytes && performance.now() < deadline) {
        await delay(25, undefined, { signal })
      }
      if (failed || !lease.progress().loadedBytes) {
        lease.release()
        target = cached
        lease = await acquire(target)
      }
    } catch (error) { lease.release(); throw error }
  }
  const request = qualityRequestForTrack(target, track)
  // A prefetch is not a playback change. The playback coordinator acknowledges
  // adoption separately, so failed/unused candidates cannot reset hysteresis.
  return { ...lease, quality: { requested: target, ...(mode ? { mode } : {}),
    ...(lease.cacheKey ? { analysisKey: lease.cacheKey, loudness: lease.analysis
      ? { loudnessLufs: lease.analysis.loudnessLufs, peakLinear: lease.analysis.peakLinear } : null } : {}),
    ...(compatibility ? { compatibility } : {}),
    requestedCodec: compatibility ?? (request === 'original' ? null : 'mp3'), delivered: null } }
}
