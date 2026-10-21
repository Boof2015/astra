import type { DiagnosticSegmentQuality, StreamingDiagnosticsSession } from '../../types/streamingDiagnostics'
import type { RemotePlaybackQuality } from '../../types/streamingQuality'

export interface StreamingDiagnosticsReading {
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
