import type { ProviderPlaybackSnapshot } from '../../types/providerPlayback'

/** Kept separate from history reset/generation changes and decoded-source IDs. */
export class ProviderPlaybackPublisher {
  private session: { id: string; path: string; duration: number; started: boolean } | null = null
  private last: ProviderPlaybackSnapshot | null = null
  private sentAt = 0
  private readonly send: (snapshot: ProviderPlaybackSnapshot) => void
  private readonly now: () => number

  constructor(send: (snapshot: ProviderPlaybackSnapshot) => void, now = () => performance.now()) {
    this.send = send
    this.now = now
  }

  start(id: string, path: string, duration: number): void {
    this.finish()
    if (!/^(subsonic|jellyfin):\/\//.test(path)) return
    this.session = { id, path, duration, started: false }
    this.last = null
  }

  observe(state: ProviderPlaybackSnapshot['state'], position: number, duration: number): void {
    const session = this.session
    // End is explicit: native device commands can temporarily emit stopped.
    if (!session || state === 'stopped' || (!session.started && state !== 'playing')) return
    if (Number.isFinite(duration) && duration > 0) session.duration = duration
    const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0
    const snapshot: ProviderPlaybackSnapshot = {
      sessionId: session.id, path: session.path, state,
      // The transport UI resets its displayed time while buffering.
      position: state === 'loading' ? this.last?.position ?? safePosition : safePosition,
      duration: Math.max(0, session.duration || 0)
    }
    const now = this.now()
    const elapsed = Math.max(0, now - this.sentAt) / 1000
    const discontinuity = this.last && Math.abs(snapshot.position - this.last.position
      - (this.last.state === 'playing' ? elapsed : 0)) > 1
    if (session.started && this.last?.state === state && !discontinuity && elapsed < 1) return
    session.started = true
    this.last = snapshot
    this.sentAt = now
    this.publish(snapshot)
  }

  finish(completedNaturally = false): void {
    if (this.session?.started && this.last) {
      this.publish({ ...this.last, state: 'stopped', position: completedNaturally
        ? Math.max(this.last.position, this.session.duration) : this.last.position })
    }
    this.session = null
    this.last = null
  }

  private publish(snapshot: ProviderPlaybackSnapshot): void {
    // Reporting must never interrupt playback when a bridge/window is closing.
    try { this.send(snapshot) } catch { /* best effort */ }
  }
}
