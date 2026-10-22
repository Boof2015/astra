export interface StratumPrefetchState {
  slot: 'current' | 'next'
  nextAhead: number
  current: Array<{ ahead: number; complete: boolean }>
}

/** Protect the playing track before spending its connection on a successor.
 * Eight seconds is enough to prime a gapless handoff; larger next-track fetches
 * need a healthy current reserve. Current-track fetching is never paced here. */
export function canPrefetchStratum(state: StratumPrefetchState): boolean {
  return state.slot === 'current' || state.current.every(current => current.complete
    || current.ahead >= (state.nextAhead < 8 ? 12 : 32))
}

/** Woken by existing cache/position/lifecycle events, never by a polling timer. */
export class StratumPrefetchGate {
  private waiting = new Set<() => void>()
  changed(): void { for (const check of [...this.waiting]) check() }
  wait(allowed: () => boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (allowed()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.waiting.delete(check); signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(signal.reason) }
      const check = () => {
        if (signal.aborted) { abort(); return }
        try { if (allowed()) { cleanup(); resolve() } }
        catch (error) { cleanup(); reject(error) }
      }
      this.waiting.add(check)
      signal.addEventListener('abort', abort, { once: true })
      check()
    })
  }
}
