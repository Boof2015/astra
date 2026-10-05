import { normalizeProviderPlaybackSnapshot, type ProviderPlaybackSnapshot } from '../../types/providerPlayback'
import { parseJellyfinTrackPath } from './jellyfin'
import { parseSubsonicTrackPath } from './subsonic'

export interface PlaybackReport extends ProviderPlaybackSnapshot { startedAt: number }
export interface PlaybackReportClient {
  start(report: PlaybackReport, signal: AbortSignal): Promise<void>
  progress(report: PlaybackReport, signal: AbortSignal): Promise<void>
  stop(report: PlaybackReport, signal: AbortSignal): Promise<void>
  scrobble?(report: PlaybackReport, signal: AbortSignal): Promise<void>
}
export interface PlaybackReportSource { provider: 'subsonic' | 'jellyfin'; sourceId: number; trackId: string }
export function playbackReportSource(path: string): PlaybackReportSource | null {
  const jellyfin = parseJellyfinTrackPath(path)
  if (jellyfin) return { provider: 'jellyfin', sourceId: jellyfin.sourceId, trackId: jellyfin.sourceTrackId }
  const subsonic = parseSubsonicTrackPath(path)
  return subsonic ? { provider: 'subsonic', sourceId: subsonic.sourceId, trackId: subsonic.sourceTrackId } : null
}

interface Session {
  source: PlaybackReportSource
  report: PlaybackReport
  observedAt: number
  reportedAt: number
  listened: number
  submitted: boolean
  closed: boolean
  startAttempted: boolean
  client?: PlaybackReportClient | null
}
type Action = 'start' | 'progress' | 'stop' | 'scrobble'
interface Job { session: Session; action: Action; report: PlaybackReport }
interface Lane { queue: Job[]; running: Promise<void> | null }
interface ProviderPlaybackOptions {
  resolve: (source: PlaybackReportSource, signal: AbortSignal) => Promise<PlaybackReportClient | null>
  now?: () => number
  wallNow?: () => number
  onError?: (provider: PlaybackReportSource['provider']) => void
  requestTimeoutMs?: number
  watchdog?: boolean
}

/** One ordered, bounded delivery lane per account, outside the audio path. */
export class ProviderPlaybackService {
  private current: Session | null = null
  private readonly lanes = new Map<string, Lane>()
  private closed = false
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly options: ProviderPlaybackOptions

  constructor(options: ProviderPlaybackOptions) { this.options = options }

  observe(raw: unknown): void {
    if (this.closed) return
    const snapshot = normalizeProviderPlaybackSnapshot(raw)
    if (!snapshot) return
    const now = this.now()
    if (this.current && (this.current.report.sessionId !== snapshot.sessionId || this.current.report.path !== snapshot.path)) {
      if (snapshot.state !== 'playing') return // Late stop/progress from an older play.
      this.finishCurrent()
    }
    if (!this.current) {
      const source = playbackReportSource(snapshot.path)
      if (!source || snapshot.state !== 'playing') return
      this.current = { source, report: { ...snapshot, startedAt: (this.options.wallNow ?? Date.now)() },
        observedAt: now, reportedAt: now, listened: 0, submitted: false, closed: false, startAttempted: false }
      this.enqueue(this.current, 'start')
      this.startWatchdog()
      return
    }
    const session = this.current
    const previous = session.report
    // Loading is a UI reset, not a seek. Stop already carries the last audible position.
    const position = snapshot.state === 'loading' ? previous.position : snapshot.position
    const elapsed = Math.max(0, now - session.observedAt) / 1000
    if (previous.state === 'playing') {
      // Count musical advancement bounded by elapsed time, never a seek's skipped time
      // or an unobserved suspension of the renderer/system.
      session.listened += Math.min(5, elapsed, Math.max(0, position - previous.position))
    }
    session.report = { ...snapshot, position, startedAt: previous.startedAt }
    session.observedAt = now
    this.qualify(session)
    if (snapshot.state === 'stopped') { this.finishCurrent(); return }
    const changed = previous.state !== snapshot.state
      || Math.abs(position - previous.position - (previous.state === 'playing' ? elapsed : 0)) > 1
    if (changed || now - session.reportedAt >= 10_000) {
      session.reportedAt = now
      this.enqueue(session, 'progress')
    }
  }

  finishCurrent(): void {
    const session = this.current
    if (!session) return
    session.closed = true
    session.report = { ...session.report, state: 'stopped' }
    this.enqueue(session, 'stop')
    this.current = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  async shutdown(): Promise<void> {
    this.finishCurrent()
    this.closed = true
    await this.flush()
  }

  async flush(): Promise<void> {
    while (this.lanes.size) await Promise.all([...this.lanes.values()].map(lane => lane.running))
  }

  private now(): number { return (this.options.now ?? (() => performance.now()))() }

  private qualify(session: Session): void {
    const duration = session.report.duration
    const threshold = duration > 0 ? Math.max(30, Math.min(duration / 2, 240)) : 240
    if (session.source.provider !== 'subsonic' || session.submitted || (duration > 0 && duration < 30)
      || session.listened < threshold) return
    session.submitted = true // Never retry an ambiguous counted-play submission.
    this.enqueue(session, 'scrobble')
  }

  private startWatchdog(): void {
    if (this.options.watchdog === false || this.watchdog) return
    this.watchdog = setInterval(() => {
      // Do not leave an RPC/server timer advancing after renderer failure or sleep.
      // Freeze instead of ending the session: a subsequent observation can resume
      // the same play without duplicating its start/count or losing listened time.
      if (this.current?.report.state === 'playing' && this.now() - this.current.observedAt >= 30_000) {
        this.current.report = { ...this.current.report, state: 'loading' }
        this.enqueue(this.current, 'progress')
      }
    }, 5000)
    this.watchdog.unref()
  }

  private enqueue(session: Session, action: Action): void {
    const key = `${session.source.provider}:${session.source.sourceId}`
    let lane = this.lanes.get(key)
    if (!lane) { lane = { queue: [], running: null }; this.lanes.set(key, lane) }
    if (action === 'progress' || action === 'stop') {
      lane.queue = lane.queue.filter(job => job.session !== session || job.action !== 'progress')
    }
    lane.queue.push({ session, action, report: { ...session.report } })
    while (lane.queue.length > 32) {
      // Discard old unsent sessions first; retain stop for any attempted start.
      const index = lane.queue.findIndex(job => !job.session.startAttempted || job.action === 'progress')
      lane.queue.splice(index < 0 ? 0 : index, 1)
    }
    this.runLane(key, lane)
  }

  private runLane(key: string, lane: Lane): void {
    if (lane.running) return
    lane.running = Promise.resolve().then(() => this.drain(lane)).finally(() => {
      lane.running = null
      if (lane.queue.length) this.runLane(key, lane)
      else this.lanes.delete(key)
    })
  }

  private async drain(lane: Lane): Promise<void> {
    while (lane.queue.length) {
      const job = lane.queue.shift()!
      const { session, action } = job
      if ((action === 'start' || action === 'progress') && session.closed) continue
      if (action === 'stop' && !session.startAttempted) continue
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 8000)
      try {
        const signal = controller.signal
        session.client ??= await this.options.resolve(session.source, signal)
        if (!session.client || signal.aborted) continue
        if ((action === 'start' || action === 'progress') && session.closed) continue
        const needsStart = (action === 'start' || action === 'progress') && !session.startAttempted
        if (needsStart) session.startAttempted = true
        // Take the freshest position before dispatch; queued progress is coalesced.
        const report = needsStart ? { ...session.report } : job.report
        if (action === 'scrobble') await session.client.scrobble?.(report, signal)
        else if (needsStart) {
          await session.client.start(report, signal)
          // Auth/discovery may have delayed the request. Correct its position or
          // pause state immediately instead of waiting for the next heartbeat.
          if (!session.closed && (session.report.position !== report.position || session.report.state !== report.state)) {
            this.enqueue(session, 'progress')
          }
        }
        else await session.client[action](report, signal)
      } catch {
        this.options.onError?.(session.source.provider)
      } finally { clearTimeout(timeout) }
    }
  }
}
