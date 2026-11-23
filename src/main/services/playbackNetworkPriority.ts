/** A track the listener just started outranks display artwork on a shared,
 * possibly slow link. Artwork downloads run a few at a time; while playback
 * holds priority, queued ones wait and in-flight ones are aborted and queued
 * again, so the link carries audio first. Cached artwork never comes here. */
export class PlaybackNetworkPriority {
  private readonly holds = new Set<symbol>()
  private readonly running = new Set<AbortController>()
  private readonly waiting = {
    display: [] as Array<(slot: AbortController) => void>,
    background: [] as Array<(slot: AbortController) => void>
  }
  private readonly limit: number
  constructor(limit = 6) { this.limit = limit }

  get held(): boolean { return this.holds.size > 0 }

  /** Returns its release. Aborting yields the link at once; work restarts later. */
  hold(): () => void {
    const id = Symbol()
    this.holds.add(id)
    for (const controller of this.running) controller.abort(yielded)
    return () => {
      if (this.holds.delete(id)) this.wake()
    }
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>, priority: 'display' | 'background' = 'background'): Promise<T> {
    for (;;) {
      const controller = this.held || this.running.size >= this.limit
        ? await new Promise<AbortController>(resolve => this.waiting[priority].push(resolve))
        : this.reserve()
      try {
        controller.signal.throwIfAborted()
        return await work(controller.signal)
      } catch (error) {
        // Yielding to playback is not a failure: queue the same work again.
        if (controller.signal.reason !== yielded) throw error
      } finally {
        this.running.delete(controller)
        this.wake()
      }
    }
  }

  private reserve(): AbortController {
    const controller = new AbortController()
    this.running.add(controller)
    return controller
  }

  private wake(): void {
    while (!this.held && this.running.size < this.limit) {
      const next = this.waiting.display.shift() ?? this.waiting.background.shift()
      if (!next) return
      next(this.reserve())
    }
  }
}

const yielded = new Error('Artwork yielded to playback.')
