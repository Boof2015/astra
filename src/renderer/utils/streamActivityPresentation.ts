import { diagnosticMapSpans, diagnosticWindow, type DiagnosticMapSpan, type StreamingDiagnosticsReading } from './streamingDiagnostics.ts'

export const ACTIVITY_SETTLE_MS = 650
export interface ActivityChange {
  id: number
  start: number
  end: number
  quality: DiagnosticMapSpan['quality']
  from: 'cached' | 'unprepared'
  to: 'cached' | 'buffered' | 'downloading'
  kind: 'arrival' | 'prepared' | 'bytes'
  started: number
}
export interface ActivityFrame {
  spans: DiagnosticMapSpan[]
  changes: ActivityChange[]
  smoothPosition: boolean
}

/** Presentation only: transitions follow observed changes, never predict arrivals.
 * Opening, seeking and resuming visibility establish a quiet baseline. */
export class StreamActivityPresentation {
  private previous: { identity: string; position: number; spans: DiagnosticMapSpan[]; bytes: Map<string, number> } | null = null
  private changes: ActivityChange[] = []
  private nextId = 0

  update(reading: StreamingDiagnosticsReading, now: number, animate = true): ActivityFrame {
    const range = diagnosticWindow(reading.duration, reading.position)
    const spans = diagnosticMapSpans(reading)
    const identity = JSON.stringify([reading.trackKey ?? [reading.title, reading.artist], reading.transport,
      reading.session?.sessionId, reading.session?.start ?? reading.start, reading.duration, range?.start])
    const bytes = new Map((reading.session?.segments ?? []).map(s => [`${s.start}:${s.end}:${s.quality}`, s.receivedBytes]))
    const previous = this.previous
    this.previous = { identity, position: reading.position, spans, bytes }
    const continuous = previous?.identity === identity && reading.position >= previous.position && reading.position - previous.position <= 2
    if (!animate || !continuous || !previous) {
      this.changes = []
      return { spans, changes: [], smoothPosition: false }
    }

    // A failed/cancelled transfer or a changed cache range immediately discards
    // its decoration. Nothing continues over data that is no longer there.
    this.changes = this.changes.filter(change => {
      const covering = spans.filter(span => span.end > change.start && span.start < change.end)
      return now - change.started < ACTIVITY_SETTLE_MS && change.start >= reading.position
        && covering.length > 0 && covering[0].start <= change.start && covering.at(-1)!.end >= change.end
        && covering.every(span => span.state === change.to && span.quality === change.quality)
    })
    const points = [...new Set([...spans, ...previous.spans].flatMap(s => [s.start, s.end]))].sort((a, b) => a - b)
    const arrivals: ActivityChange[] = []
    for (let i = 0; i < points.length - 1; i++) {
      const start = Math.max(points[i], reading.position), end = points[i + 1]
      if (end <= start) continue
      const at = (start + end) / 2
      const before = previous.spans.find(s => s.start <= at && s.end > at)
      const after = spans.find(s => s.start <= at && s.end > at)
      if (!before || !after) continue
      const prepared = after.state === 'buffered' && before.state !== 'buffered'
      const arrived = after.state === 'cached' && !['cached', 'buffered'].includes(before.state)
      if (!prepared && !arrived) continue
      if (before.quality && before.quality !== after.quality) continue
      const from = before.state === 'cached' ? 'cached' : 'unprepared'
      const kind = prepared ? 'prepared' : 'arrival'
      const last = arrivals.at(-1)
      if (last?.end === start && last.kind === kind && last.from === from && last.quality === after.quality) last.end = end
      else arrivals.push({ id: this.nextId++, start, end, quality: after.quality, from,
        to: prepared ? 'buffered' : 'cached', kind, started: now })
    }
    this.changes.push(...arrivals)

    // Unknown-size transfers can acknowledge newly observed bytes, but cannot
    // honestly display a percentage. No byte change means no new animation.
    for (const segment of reading.session?.segments ?? []) {
      const key = `${segment.start}:${segment.end}:${segment.quality}`
      if (segment.state !== 'downloading' || segment.receivedBytes <= (previous.bytes.get(key) ?? 0)) continue
      const span = spans.find(s => s.state === 'downloading' && s.progress === null && s.start === segment.start && s.end === segment.end)
      if (!span) continue
      this.changes = this.changes.filter(c => !(c.kind === 'bytes' && c.start === span.start))
      this.changes.push({ id: this.nextId++, start: span.start, end: span.end, quality: span.quality,
        from: 'unprepared', to: 'downloading', kind: 'bytes', started: now })
    }
    return { spans, changes: [...this.changes], smoothPosition: reading.playbackState === 'playing' }
  }
}
