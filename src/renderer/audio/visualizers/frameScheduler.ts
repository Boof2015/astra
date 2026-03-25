export type FrameSchedulerCallback = () => void

export class FrameScheduler {
  private callbacks = new Set<FrameSchedulerCallback>()
  private frameId: number | null = null

  subscribe(callback: FrameSchedulerCallback): () => void {
    this.callbacks.add(callback)
    this.start()

    return () => {
      this.callbacks.delete(callback)
      if (this.callbacks.size === 0) {
        this.stop()
      }
    }
  }

  private start(): void {
    if (this.frameId !== null || this.callbacks.size === 0) {
      return
    }

    this.frameId = window.requestAnimationFrame(this.tick)
  }

  private stop(): void {
    if (this.frameId !== null) {
      window.cancelAnimationFrame(this.frameId)
      this.frameId = null
    }
  }

  private tick = (): void => {
    this.frameId = null
    if (this.callbacks.size === 0) {
      return
    }

    for (const callback of [...this.callbacks]) {
      callback()
    }

    this.start()
  }
}
