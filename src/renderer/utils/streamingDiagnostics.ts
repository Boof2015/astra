import type { DiagnosticSegmentQuality, StreamingDiagnosticsSession } from '../../types/streamingDiagnostics'
import type { RemotePlaybackQuality } from '../../types/streamingQuality'

export interface StreamingDiagnosticsReading {
  trackKey?: string
  title: string
  artist: string
  position: number
  duration: number
  playbackState: string
  bufferedEnd: number
  start: number | null
  completeLocalBuffer: boolean
  transport: 'stratum' | 'stream' | 'local'
  quality?: RemotePlaybackQuality
  session: StreamingDiagnosticsSession | null
  next: StreamingDiagnosticsSession | null
  loadedBytes: number | null
  totalBytes: number | null
}

export function diagnosticQualityLabel(quality: DiagnosticSegmentQuality): string {
  return quality === 'lossless' ? 'Original' : quality === 'opus-64' ? 'Opus 64' : 'Opus 128'
}

export function diagnosticWindow(duration: number, position: number): { start: number; end: number } | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  // Keep blocks legible on long recordings. The scale is always labelled.
  const span = Math.min(240, duration)
  const start = Math.floor(Math.max(0, Math.min(position - 48, duration - span)) / 4) * 4
  return { start, end: Math.min(duration, start + span) }
}

export function diagnosticBufferedRange(reading: StreamingDiagnosticsReading): { start: number; end: number } | null {
  if (reading.completeLocalBuffer) return { start: 0, end: reading.duration }
  const start = reading.session?.start ?? reading.start
  // A seek origin is necessary: an absolute decoded end is not a range from zero.
  if (start === null || !Number.isFinite(start) || !Number.isFinite(reading.bufferedEnd)) return null
  return { start: Math.max(0, start), end: Math.min(reading.duration, Math.max(start, reading.bufferedEnd)) }
}

export interface DiagnosticMapSpan {
  start: number
  end: number
  state: 'buffered' | 'cached' | 'downloading' | 'waiting' | 'unprepared'
  quality: DiagnosticSegmentQuality | null
  qualities: DiagnosticSegmentQuality[]
  progress: number | null
}

/** Track-time boundaries come only from actual PCM, cache inventory and segment
 * requests. Download percentages describe a packet, never playable track time. */
export function diagnosticMapSpans(reading: StreamingDiagnosticsReading): DiagnosticMapSpan[] {
  const window = diagnosticWindow(reading.duration, reading.position)
  if (!window) return []
  const intersects = (item: { start: number; end: number }) => item.end > window.start && item.start < window.end
  const segments = (reading.session?.segments ?? []).filter(intersects).reverse()
  const cached = (reading.session?.cachedRanges ?? []).filter(intersects)
  const buffer = diagnosticBufferedRange(reading)
  // Progressive PCM behind the playhead has been consumed. It may still exist
  // on disk, but it must not keep the stronger "prepared" fill.
  const prepared = buffer && { start: reading.completeLocalBuffer ? buffer.start : Math.max(buffer.start, reading.position), end: buffer.end }
  const boundaries = new Set([window.start, window.end])
  for (const item of [...segments, ...cached, ...(prepared ? [prepared] : [])]) {
    if (!intersects(item)) continue
    boundaries.add(Math.max(window.start, item.start)); boundaries.add(Math.min(window.end, item.end))
  }
  const points = [...boundaries].sort((a, b) => a - b)
  return points.slice(0, -1).map((start, i): DiagnosticMapSpan => {
    const end = points[i + 1], at = (start + end) / 2
    const segment = segments.find(item => item.start <= at && item.end > at)
    const inventory = cached.find(item => item.start <= at && item.end > at)
    const qualities = inventory?.qualities ?? []
    const quality = segment && qualities.includes(segment.quality) ? segment.quality : qualities[0] ?? null
    const base = { start, end, quality, qualities, progress: null }
    if (prepared && at >= prepared.start && at < prepared.end) {
      return { ...base, state: 'buffered', quality: reading.transport === 'stratum' ? segment?.quality ?? null : null }
    }
    const active = segment?.state === 'requesting' || segment?.state === 'downloading'
    if (active && !qualities.includes(segment.quality)) {
      const total = segment.transferTotalBytes
      return { ...base, state: segment.state === 'requesting' ? 'waiting' : 'downloading', quality: segment.quality,
        progress: total && total > 0 ? Math.min(1, Math.max(0, segment.receivedBytes / total)) : null }
    }
    if (qualities.length || (reading.transport === 'stream' && reading.session?.localCacheComplete)) return { ...base, state: 'cached' }
    return { ...base, state: 'unprepared' }
  })
}

/** Recursive sampling prevents slow IPC from queuing overlapping requests. A
 * visibility change/unmount invalidates an outstanding result before delivery. */
export function pollStreamingDiagnostics<T>(options: {
  read: () => Promise<T>
  deliver: (value: T) => void
  failed: () => void
  visible: () => boolean
  subscribeVisibility: (changed: () => void) => () => void
  intervalMs?: number
}): () => void {
  let disposed = false
  let pending = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (disposed || pending || !options.visible()) return
    pending = true
    const started = generation
    try {
      const value = await options.read()
      if (!disposed && options.visible() && started === generation) options.deliver(value)
    } catch {
      if (!disposed && options.visible() && started === generation) options.failed()
    } finally {
      pending = false
      if (!disposed && options.visible()) timer = setTimeout(() => void tick(), options.intervalMs ?? 500)
    }
  }
  const unsubscribe = options.subscribeVisibility(() => {
    generation++
    clearTimeout(timer)
    if (options.visible()) void tick()
  })
  void tick()
  return () => { disposed = true; generation++; clearTimeout(timer); unsubscribe() }
}
