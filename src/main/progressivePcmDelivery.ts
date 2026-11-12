/** Frame-aligned PCM delivery with an explicit consumer-ready gate. A stdout
 * chunk can contain several IPC chunks; pausing stdout alone cannot gate them.
 */
export class ProgressivePcmDelivery {
  private remainder: Buffer = Buffer.alloc(0)
  private ended = false
  private readonly frameBytes: number
  private readonly chunkFrames: number | (() => number)
  private readonly canEmit: () => boolean
  private readonly emit: (chunk: Buffer) => void

  constructor(channels: number, chunkFrames: number | (() => number), canEmit: () => boolean, emit: (chunk: Buffer) => void) {
    this.frameBytes = channels * 4
    this.chunkFrames = chunkFrames
    this.canEmit = canEmit
    this.emit = emit
  }

  get drained(): boolean { return this.ended && this.remainder.length < this.frameBytes }

  push(chunk: Buffer): void {
    this.remainder = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk
    this.drain()
  }

  finish(): void { this.ended = true; this.drain() }

  drain(): void {
    while (this.canEmit()) {
      const chunkBytes = (typeof this.chunkFrames === 'function' ? this.chunkFrames() : this.chunkFrames) * this.frameBytes
      const length = this.ended
        ? Math.min(chunkBytes, this.remainder.length - this.remainder.length % this.frameBytes)
        : this.remainder.length >= chunkBytes ? chunkBytes : 0
      if (!length) return
      const chunk = this.remainder.subarray(0, length)
      this.remainder = this.remainder.subarray(length)
      this.emit(chunk)
    }
  }
}
