import type { AutomaticQualityPlayback, StreamingQualityRequest, StreamQualityTarget } from '../../types/streamingQuality'
import { playbackQualityRequest } from '../../types/streamingQuality'

export interface AutomaticPlaybackSnapshot extends AutomaticQualityPlayback { identity: string }

/** One speculative replacement at a time. Controls invalidate it before they
 * change playback; a stale or failed preparation never gets to replace audio.
 */
export class AutomaticQualityCoordinator {
  private generation = 0
  private busy = false
  private lastCheck = -Infinity
  private preparation: string | null = null
  private observed: string | null = null
  private options: {
    snapshot: () => AutomaticPlaybackSnapshot | null
    recommend: (state: AutomaticQualityPlayback) => Promise<StreamQualityTarget | null>
    prepare: (id: string, state: AutomaticPlaybackSnapshot, request: StreamingQualityRequest) => Promise<{ complete: boolean }>
    release: (id: string) => Promise<unknown>
    apply: (state: AutomaticPlaybackSnapshot, request: StreamingQualityRequest) => Promise<void>
    failed: (state: AutomaticPlaybackSnapshot) => Promise<unknown>
    committed?: (state: AutomaticPlaybackSnapshot) => Promise<unknown>
    now?: () => number
  }
  constructor(options: AutomaticQualityCoordinator['options']) { this.options = options }

  cancel(): void {
    this.generation++
    if (this.preparation) void this.options.release(this.preparation).catch(() => {})
    this.preparation = null
  }

  async tick(): Promise<void> {
    const now = (this.options.now ?? (() => performance.now()))()
    if (this.busy || now - this.lastCheck < 1000) return
    const initial = this.options.snapshot()
    if (!initial?.quality.mode) return
    this.lastCheck = now
    this.busy = true
    const generation = this.generation
    const current = () => {
      const state = this.options.snapshot()
      return generation === this.generation && state?.identity === initial.identity
        && JSON.stringify(playbackQualityRequest(state.quality)) === JSON.stringify(playbackQualityRequest(initial.quality)) ? state : null
    }
    let id: string | null = null
    let applying = false
    try {
      const observed = `${initial.identity}:${initial.quality.requested}`
      if (this.observed !== observed) {
        await this.options.committed?.(initial)
        this.observed = observed
      }
      if (initial.complete || !current()) return
      const target = await this.options.recommend(initial)
      if (target === null || target === initial.quality.requested || !current()) return
      const request = { mode: initial.quality.mode, target }
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = current()
        if (!state || state.complete) return
        if (id) await this.options.release(id)
        id = this.preparation = `auto-${generation}-${Math.round(now)}-${attempt}`
        const prepared = await this.options.prepare(id, state, request)
        const ready = current()
        if (!ready || ready.complete) return
        // A slow first fetch may have fallen behind the playing position. Prime
        // again from the newer position while keeping the current stream alive.
        if (!prepared.complete && ready.position > state.position + 4) continue
        applying = true
        await this.options.apply(ready, request)
        await this.options.committed?.({ ...ready, quality: { ...ready.quality, requested: target } })
        return
      }
      if (current()) await this.options.failed(initial)
    } catch {
      if (current() || (applying && generation === this.generation)) await this.options.failed(initial).catch(() => {})
    } finally {
      if (id) await this.options.release(id).catch(() => {})
      if (this.preparation === id) this.preparation = null
      this.busy = false
    }
  }
}
