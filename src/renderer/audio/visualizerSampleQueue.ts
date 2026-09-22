/** Owns chunk references, never their samples. Overflow keeps the newest audio. */
export class VisualizerSampleQueue<T> {
  private chunks: T[] = []
  private frames = 0

  private readonly frameCount: (chunk: T) => number
  private readonly trimStart: (chunk: T, frames: number) => T

  constructor(frameCount: (chunk: T) => number, trimStart: (chunk: T, frames: number) => T) {
    this.frameCount = frameCount
    this.trimStart = trimStart
  }

  get length(): number { return this.chunks.length }

  push(chunk: T, maxFrames: number): void {
    const count = this.frameCount(chunk)
    if (count <= 0) return
    const limit = Math.max(1, Math.floor(maxFrames))
    if (count >= limit) {
      this.chunks = [count === limit ? chunk : this.trimStart(chunk, count - limit)]
      this.frames = limit
      return
    }
    this.chunks.push(chunk)
    this.frames += count
    while (this.frames > limit) {
      const first = this.chunks[0]
      const firstCount = this.frameCount(first)
      const overflow = this.frames - limit
      if (firstCount <= overflow) {
        this.chunks.shift()
        this.frames -= firstCount
      } else {
        this.chunks[0] = this.trimStart(first, overflow)
        this.frames = limit
      }
    }
  }

  drain(): T[] {
    const chunks = this.chunks
    this.clear()
    return chunks
  }

  clear(): void {
    this.chunks = []
    this.frames = 0
  }
}

export const createMonoSampleQueue = () => new VisualizerSampleQueue<Float32Array>(
  (chunk) => chunk.length,
  (chunk, skip) => chunk.subarray(skip),
)

export const createStereoSampleQueue = () => new VisualizerSampleQueue<{ left: Float32Array; right: Float32Array }>(
  (chunk) => Math.min(chunk.left.length, chunk.right.length),
  (chunk, skip) => ({ left: chunk.left.subarray(skip), right: chunk.right.subarray(skip) }),
)

export const createMultichannelSampleQueue = () => new VisualizerSampleQueue<{ channels: Float32Array[] }>(
  (chunk) => chunk.channels[0]?.length ?? 0,
  (chunk, skip) => ({ channels: chunk.channels.map((channel) => channel.subarray(skip)) }),
)

export const createMiniSampleQueue = () => new VisualizerSampleQueue<{ left: Float32Array; mono: Float32Array }>(
  (chunk) => Math.max(chunk.left.length, chunk.mono.length),
  (chunk, skip) => ({ left: chunk.left.subarray(skip), mono: chunk.mono.subarray(skip) }),
)
