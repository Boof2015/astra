import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import type { DiagnosticSegmentQuality, StreamingDiagnosticSegment, StreamingDiagnosticsSession } from '../../types/streamingDiagnostics.ts'

export const STREAMING_DIAGNOSTIC_SEGMENT_LIMIT = 256

/** One small record per interval. No timers, IPC, logging or PCM work on the
 * playback path. Keeping a bounded tail allows opening the view mid-song. */
export class StratumSegmentDiagnostics {
  private segments: StreamingDiagnosticSegment[] = []
  private pending: { segment: StreamingDiagnosticSegment; started: number } | null = null
  private omitted = 0

  private now: () => number
  constructor(now: () => number = () => performance.now()) { this.now = now }

  begin(start: number, end: number, quality: DiagnosticSegmentQuality) {
    const started = this.now()
    const segment: StreamingDiagnosticSegment = { start, end, quality, state: 'requesting',
      receivedBytes: 0, payloadBytes: null, elapsedMs: 0, transferMs: null, decodeMs: null, serverCacheHit: null }
    this.segments.push(segment)
    if (this.segments.length > STREAMING_DIAGNOSTIC_SEGMENT_LIMIT) { this.segments.shift(); this.omitted++ }
    this.pending = { segment, started }
    let transferStarted: number | null = null
    let receivedAt = started
    return {
      observe: (event: AudioTransferEvent) => {
        if (event.phase === 'start') { segment.state = 'downloading'; transferStarted = this.now() }
        if (event.phase === 'data') segment.receivedBytes += event.bytes ?? 0
        if (event.phase === 'end' && transferStarted !== null) segment.transferMs = Math.max(0, this.now() - transferStarted)
      },
      received: (payloadBytes: number, cacheHit: boolean | null, localCacheHit?: boolean, quality?: DiagnosticSegmentQuality) => {
        if (quality) segment.quality = quality
        if (localCacheHit !== undefined) segment.localCacheHit = localCacheHit
        segment.state = 'received'
        segment.payloadBytes = payloadBytes
        segment.serverCacheHit = cacheHit
        receivedAt = this.now()
        segment.elapsedMs = Math.max(0, receivedAt - started)
        if (this.pending?.segment === segment) this.pending = null
      },
      // A retained interval may wait minutes for PCM capacity. That wait is
      // neither network nor decoder work.
      decoding: () => { receivedAt = this.now() },
      decoded: () => {
        segment.state = 'decoded'
        segment.decodeMs = Math.max(0, this.now() - receivedAt)
        segment.elapsedMs += segment.decodeMs
        if (this.pending?.segment === segment) this.pending = null
      },
      failed: (cancelled: boolean) => {
        segment.state = cancelled ? 'cancelled' : 'failed'
        segment.elapsedMs = Math.max(0, this.now() - started)
        if (this.pending?.segment === segment) this.pending = null
      }
    }
  }

  snapshot(): Pick<StreamingDiagnosticsSession, 'segments' | 'omittedSegments'> {
    return { omittedSegments: this.omitted, segments: this.segments.map(segment => ({ ...segment,
      elapsedMs: this.pending?.segment === segment ? Math.max(0, this.now() - this.pending.started) : segment.elapsedMs })) }
  }
}

/** Decoding may finish before the listener reaches EOF. Keep only four finished
 * Stratum sessions per renderer, without keeping a renderer or playback alive. */
export class CompletedStreamingDiagnostics {
  private owners = new WeakMap<object, Map<number, StreamingDiagnosticsSession>>()
  remember(owner: object, snapshot: StreamingDiagnosticsSession): void {
    let sessions = this.owners.get(owner)
    if (!sessions) { sessions = new Map(); this.owners.set(owner, sessions) }
    sessions.set(snapshot.sessionId, snapshot)
    while (sessions.size > 4) sessions.delete(sessions.keys().next().value!)
  }
  get(owner: object, id: number): StreamingDiagnosticsSession | undefined { return this.owners.get(owner)?.get(id) }
  forget(owner: object, id: number): void { this.owners.get(owner)?.delete(id) }
}
