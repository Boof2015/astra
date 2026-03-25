import { FrameScheduler } from './frameScheduler'

interface VisualizerFrameLoopOptions {
  frameScheduler?: FrameScheduler
  shouldRun: () => boolean
  onFrame: () => void
}

export class VisualizerFrameLoop {
  private readonly frameScheduler: FrameScheduler
  private readonly shouldRun: () => boolean
  private readonly onFrame: () => void
  private unsubscribeFrame: (() => void) | null = null
  private isStarted = false
  private isInvalidated = false

  constructor({ frameScheduler, shouldRun, onFrame }: VisualizerFrameLoopOptions) {
    this.frameScheduler = frameScheduler ?? new FrameScheduler()
    this.shouldRun = shouldRun
    this.onFrame = onFrame
  }

  start(): void {
    if (this.isStarted) return
    this.isStarted = true
    this.invalidate()
  }

  stop(): void {
    this.isStarted = false
    this.detach()
  }

  invalidate(): void {
    if (!this.isStarted) return
    this.isInvalidated = true
    this.sync()
  }

  dispose(): void {
    this.stop()
  }

  private sync(): void {
    if (!this.isStarted) {
      this.detach()
      return
    }

    if (this.isInvalidated || this.shouldRun()) {
      if (this.unsubscribeFrame === null) {
        this.unsubscribeFrame = this.frameScheduler.subscribe(this.tick)
      }
      return
    }

    this.detach()
  }

  private detach(): void {
    if (this.unsubscribeFrame) {
      this.unsubscribeFrame()
      this.unsubscribeFrame = null
    }
  }

  private tick = (): void => {
    if (!this.isStarted) return
    this.isInvalidated = false
    this.onFrame()
    this.sync()
  }
}
