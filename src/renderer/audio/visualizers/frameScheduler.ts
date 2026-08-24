export type FrameSchedulerCallback = () => void

import type { VisualizerFrameTarget } from '../../../types/performance'

const FPS_WINDOW_MS = 1000
const TARGET_EPSILON_MS = 0.5

interface FrameSchedulerOptions {
  frameTarget?: VisualizerFrameTarget
}

export class FrameScheduler {
  private callbacks = new Set<FrameSchedulerCallback>()
  private fpsListeners = new Set<(fps: number) => void>()
  private dispatchTimestamps: number[] = []
  private frameId: number | null = null
  private actualFps = 0
  private frameTarget: VisualizerFrameTarget
  private lastDispatchTimestamp: number | null = null
  private trackFpsForGetter = false

  constructor(options: FrameSchedulerOptions = {}) {
    this.frameTarget = options.frameTarget ?? 'display-sync'
  }

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

  setFrameTarget(target: VisualizerFrameTarget): void {
    if (this.frameTarget === target) return
    this.frameTarget = target
    this.lastDispatchTimestamp = null
    this.dispatchTimestamps = []
    this.updateActualFps(0)
  }

  getFrameTarget(): VisualizerFrameTarget {
    return this.frameTarget
  }

  getActualFps(): number {
    // FPS sampling is diagnostics-only. Calling the getter opts this scheduler
    // into tracking; the default render path keeps only one timestamp.
    this.trackFpsForGetter = true
    return this.actualFps
  }

  subscribeToActualFps(listener: (fps: number) => void): () => void {
    if (this.fpsListeners.size === 0 && !this.trackFpsForGetter) {
      this.dispatchTimestamps = []
      this.updateActualFps(0)
    }
    this.fpsListeners.add(listener)
    listener(this.actualFps)

    return () => {
      this.fpsListeners.delete(listener)
      if (this.fpsListeners.size === 0 && !this.trackFpsForGetter) {
        this.dispatchTimestamps = []
        this.updateActualFps(0)
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

    this.dispatchTimestamps = []
    this.lastDispatchTimestamp = null
    this.updateActualFps(0)
  }

  private tick = (timestamp: number): void => {
    this.frameId = null
    if (this.callbacks.size === 0) {
      return
    }

    const now = Number.isFinite(timestamp)
      ? timestamp
      : typeof performance !== 'undefined'
        ? performance.now()
        : Date.now()

    if (this.shouldDispatchFrame(now)) {
      this.lastDispatchTimestamp = now
      if (this.trackFpsForGetter || this.fpsListeners.size > 0) {
        this.recordDispatch(now)
      }
      for (const callback of [...this.callbacks]) {
        callback()
      }
    }

    this.start()
  }

  private shouldDispatchFrame(timestamp: number): boolean {
    if (this.frameTarget === 'display-sync') {
      return true
    }

    if (this.lastDispatchTimestamp === null) {
      return true
    }

    return timestamp - this.lastDispatchTimestamp >= (1000 / this.frameTarget) - TARGET_EPSILON_MS
  }

  private recordDispatch(timestamp: number): void {
    this.dispatchTimestamps.push(timestamp)

    const cutoff = timestamp - FPS_WINDOW_MS
    while (this.dispatchTimestamps.length > 0 && this.dispatchTimestamps[0] < cutoff) {
      this.dispatchTimestamps.shift()
    }

    const nextFps = this.computeActualFps()
    this.updateActualFps(nextFps)
  }

  private computeActualFps(): number {
    if (this.dispatchTimestamps.length < 2) {
      return 0
    }

    const firstTimestamp = this.dispatchTimestamps[0]
    const lastTimestamp = this.dispatchTimestamps[this.dispatchTimestamps.length - 1]
    const elapsed = lastTimestamp - firstTimestamp
    if (elapsed <= 0) {
      return 0
    }

    return ((this.dispatchTimestamps.length - 1) * 1000) / elapsed
  }

  private updateActualFps(fps: number): void {
    if (this.actualFps === fps) return

    this.actualFps = fps
    for (const listener of this.fpsListeners) {
      listener(fps)
    }
  }
}
