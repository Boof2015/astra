import type { OutputBackend } from './types'

// Simulated audio device for dev machines without ALSA (macOS) and for unit tests. Consumes
// written frames at exactly `sampleRate` against a wall clock (injectable for tests), holding at
// most `maxBufferFrames` — writes beyond that are rejected the same way a full ALSA buffer
// rejects them. When the buffer drains while more audio should have been consumed, the shortfall
// counts as an underrun episode, mirroring an xrun.

export interface NullOutputOptions {
  sampleRate?: number
  channels?: number
  maxBufferMs?: number
  nowMs?: () => number
}

export class NullOutput implements OutputBackend {
  readonly deviceId = 'null'
  readonly deviceLabel = 'Null output (no audio)'
  readonly sampleRate: number
  readonly channels: number

  private readonly maxBufferFrames: number
  private readonly nowMs: () => number
  private readonly openedAtMs: number
  private written = 0
  private consumed = 0
  private underrunCount = 0
  private starving = false
  private closed = false

  constructor(options: NullOutputOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2
    this.maxBufferFrames = Math.max(1, Math.round(((options.maxBufferMs ?? 500) / 1000) * this.sampleRate))
    this.nowMs = options.nowMs ?? (() => performance.timeOrigin + performance.now())
    this.openedAtMs = this.nowMs()
  }

  private advanceClock(): void {
    if (this.closed) return
    const elapsedFrames = Math.floor(((this.nowMs() - this.openedAtMs) / 1000) * this.sampleRate)
    const target = Math.min(this.written, elapsedFrames)
    if (target > this.consumed) this.consumed = target
    // The device wanted more frames than were ever written: a starvation episode. Count each
    // transition once, like an ALSA xrun, not once per check.
    if (elapsedFrames > this.written) {
      if (!this.starving) {
        this.starving = true
        this.underrunCount += 1
      }
    } else {
      this.starving = false
    }
  }

  write(_interleaved: Float32Array, frames: number): number {
    if (this.closed || frames <= 0) return 0
    this.advanceClock()
    const room = this.maxBufferFrames - (this.written - this.consumed)
    const accepted = Math.max(0, Math.min(frames, room))
    this.written += accepted
    return accepted
  }

  framesWritten(): number {
    return this.written
  }

  bufferedFrames(): number {
    this.advanceClock()
    return this.written - this.consumed
  }

  underruns(): number {
    this.advanceClock()
    return this.underrunCount
  }

  close(): void {
    this.closed = true
  }
}
