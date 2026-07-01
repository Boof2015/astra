/**
 * 3-band crossover filter for multiband vectorscope coloring.
 *
 * Splits stereo audio into Low / Mid / High frequency bands using
 * 2nd-order Butterworth biquad filters (Linkwitz-Riley style crossover).
 *
 * Crossover frequencies:
 *   Low ↔ Mid : 250 Hz
 *   Mid ↔ High: 2500 Hz
 *
 * Each band carries independent left/right channels so the vectorscope
 * can render each band's stereo image in a distinct color.
 */

const LOW_MID_CROSSOVER = 250
const MID_HIGH_CROSSOVER = 2500

export const BAND_COLORS = {
  low: '#ff4444',   // Red — bass
  mid: '#44dd44',   // Green — mids
  high: '#4488ff',  // Blue — highs
} as const

export interface MultibandChunk {
  low:  { left: Float32Array; right: Float32Array }
  mid:  { left: Float32Array; right: Float32Array }
  high: { left: Float32Array; right: Float32Array }
}

export function createMultibandChunk(length: number): MultibandChunk {
  return {
    low: { left: new Float32Array(length), right: new Float32Array(length) },
    mid: { left: new Float32Array(length), right: new Float32Array(length) },
    high: { left: new Float32Array(length), right: new Float32Array(length) },
  }
}

// ---------- Biquad filter ----------

class BiquadFilter {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0

  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  setLowpass(freq: number, sampleRate: number): void {
    const w0 = (2 * Math.PI * freq) / sampleRate
    const cosw0 = Math.cos(w0)
    const sinw0 = Math.sin(w0)
    const alpha = sinw0 / (2 * Math.SQRT2) // Q = 1/sqrt(2) for Butterworth

    const a0 = 1 + alpha
    this.b0 = ((1 - cosw0) / 2) / a0
    this.b1 = (1 - cosw0) / a0
    this.b2 = ((1 - cosw0) / 2) / a0
    this.a1 = (-2 * cosw0) / a0
    this.a2 = (1 - alpha) / a0
  }

  setHighpass(freq: number, sampleRate: number): void {
    const w0 = (2 * Math.PI * freq) / sampleRate
    const cosw0 = Math.cos(w0)
    const sinw0 = Math.sin(w0)
    const alpha = sinw0 / (2 * Math.SQRT2)

    const a0 = 1 + alpha
    this.b0 = ((1 + cosw0) / 2) / a0
    this.b1 = (-(1 + cosw0)) / a0
    this.b2 = ((1 + cosw0) / 2) / a0
    this.a1 = (-2 * cosw0) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(input: Float32Array, output: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i]
      const y0 = this.b0 * x0 + this.b1 * this.x1 + this.b2 * this.x2
                 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = x0
      this.y2 = this.y1
      this.y1 = y0
      output[i] = y0
    }
  }

  reset(): void {
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }
}

// ---------- MultibandSplitter ----------

/**
 * Stateful 3-band stereo crossover filter.
 *
 * Call `configure(sampleRate)` whenever the sample rate changes,
 * then `split(left, right)` for each stereo chunk.
 */
export class MultibandSplitter {
  // Low band: lowpass at LOW_MID_CROSSOVER (L + R)
  private lowLpL = new BiquadFilter()
  private lowLpR = new BiquadFilter()

  // Mid band: highpass at LOW_MID_CROSSOVER → lowpass at MID_HIGH_CROSSOVER (L + R)
  private midHpL = new BiquadFilter()
  private midHpR = new BiquadFilter()
  private midLpL = new BiquadFilter()
  private midLpR = new BiquadFilter()

  // High band: highpass at MID_HIGH_CROSSOVER (L + R)
  private highHpL = new BiquadFilter()
  private highHpR = new BiquadFilter()

  private configuredSampleRate = 0
  private midTmpL = new Float32Array(0)
  private midTmpR = new Float32Array(0)

  private ensureScratch(size: number): void {
    if (this.midTmpL.length !== size) {
      this.midTmpL = new Float32Array(size)
      this.midTmpR = new Float32Array(size)
    }
  }

  configure(sampleRate: number): void {
    if (sampleRate === this.configuredSampleRate) return
    this.configuredSampleRate = sampleRate

    this.lowLpL.setLowpass(LOW_MID_CROSSOVER, sampleRate)
    this.lowLpR.setLowpass(LOW_MID_CROSSOVER, sampleRate)

    this.midHpL.setHighpass(LOW_MID_CROSSOVER, sampleRate)
    this.midHpR.setHighpass(LOW_MID_CROSSOVER, sampleRate)
    this.midLpL.setLowpass(MID_HIGH_CROSSOVER, sampleRate)
    this.midLpR.setLowpass(MID_HIGH_CROSSOVER, sampleRate)

    this.highHpL.setHighpass(MID_HIGH_CROSSOVER, sampleRate)
    this.highHpR.setHighpass(MID_HIGH_CROSSOVER, sampleRate)

    this.reset()
  }

  split(left: Float32Array, right: Float32Array): MultibandChunk {
    const target = createMultibandChunk(Math.min(left.length, right.length))
    this.splitInto(left, right, target)
    return target
  }

  splitInto(left: Float32Array, right: Float32Array, target: MultibandChunk): number {
    const n = Math.min(
      left.length,
      right.length,
      target.low.left.length,
      target.low.right.length,
      target.mid.left.length,
      target.mid.right.length,
      target.high.left.length,
      target.high.right.length,
    )
    if (n <= 0) {
      return 0
    }

    const leftInput = left.length === n ? left : left.subarray(0, n)
    const rightInput = right.length === n ? right : right.subarray(0, n)
    this.ensureScratch(n)

    this.lowLpL.process(leftInput, target.low.left)
    this.lowLpR.process(rightInput, target.low.right)

    this.midHpL.process(leftInput, this.midTmpL)
    this.midHpR.process(rightInput, this.midTmpR)
    this.midLpL.process(this.midTmpL, target.mid.left)
    this.midLpR.process(this.midTmpR, target.mid.right)

    this.highHpL.process(leftInput, target.high.left)
    this.highHpR.process(rightInput, target.high.right)

    return n
  }

  reset(): void {
    this.lowLpL.reset()
    this.lowLpR.reset()
    this.midHpL.reset()
    this.midHpR.reset()
    this.midLpL.reset()
    this.midLpR.reset()
    this.highHpL.reset()
    this.highHpR.reset()
  }
}

// ---------- MultibandBuffer ----------

const MULTIBAND_BUFFER_SIZE = 4096

interface BandRingBuffer {
  left: Float32Array
  right: Float32Array
}

/**
 * Circular buffer that accumulates band-split stereo samples.
 *
 * Mirrors the native vectorscope's circular buffer so that each frame
 * can re-draw ALL buffered points (not just newly-arrived ones),
 * producing the same dense persistence effect as the single-color path.
 */
export class MultibandBuffer {
  private buffers: Record<'low' | 'mid' | 'high', BandRingBuffer>
  private writePos = 0
  private validSamples = 0
  private readonly capacity: number

  constructor(capacity = MULTIBAND_BUFFER_SIZE) {
    this.capacity = capacity
    this.buffers = {
      low:  { left: new Float32Array(capacity), right: new Float32Array(capacity) },
      mid:  { left: new Float32Array(capacity), right: new Float32Array(capacity) },
      high: { left: new Float32Array(capacity), right: new Float32Array(capacity) },
    }
  }

  push(bands: MultibandChunk, count = bands.low.left.length): void {
    const n = Math.min(
      count,
      bands.low.left.length,
      bands.low.right.length,
      bands.mid.left.length,
      bands.mid.right.length,
      bands.high.left.length,
      bands.high.right.length,
    )
    for (let i = 0; i < n; i++) {
      const pos = this.writePos
      this.buffers.low.left[pos] = bands.low.left[i]
      this.buffers.low.right[pos] = bands.low.right[i]
      this.buffers.mid.left[pos] = bands.mid.left[i]
      this.buffers.mid.right[pos] = bands.mid.right[i]
      this.buffers.high.left[pos] = bands.high.left[i]
      this.buffers.high.right[pos] = bands.high.right[i]

      this.writePos = (pos + 1) % this.capacity
      if (this.validSamples < this.capacity) {
        this.validSamples++
      }
    }
  }

  /**
   * Returns the most recent `maxPoints` samples for each band,
   * ordered oldest-first (matching the native getPoints() convention).
   */
  fillPointsInto(target: MultibandChunk, maxPoints: number): number {
    const count = Math.min(
      maxPoints,
      this.validSamples,
      target.low.left.length,
      target.low.right.length,
      target.mid.left.length,
      target.mid.right.length,
      target.high.left.length,
      target.high.right.length,
    )
    if (count === 0) {
      return 0
    }

    for (let i = 0; i < count; i++) {
      const idx = (this.writePos + this.capacity - count + i) % this.capacity
      target.low.left[i] = this.buffers.low.left[idx]
      target.low.right[i] = this.buffers.low.right[idx]
      target.mid.left[i] = this.buffers.mid.left[idx]
      target.mid.right[i] = this.buffers.mid.right[idx]
      target.high.left[i] = this.buffers.high.left[idx]
      target.high.right[i] = this.buffers.high.right[idx]
    }

    return count
  }

  getPoints(maxPoints: number): {
    bands: Record<'low' | 'mid' | 'high', { left: Float32Array; right: Float32Array }>
    count: number
  } {
    const count = Math.min(maxPoints, this.validSamples)
    if (count === 0) {
      return {
        bands: {
          low:  { left: new Float32Array(0), right: new Float32Array(0) },
          mid:  { left: new Float32Array(0), right: new Float32Array(0) },
          high: { left: new Float32Array(0), right: new Float32Array(0) },
        },
        count: 0,
      }
    }

    const out = createMultibandChunk(count)
    this.fillPointsInto(out, count)

    return { bands: out, count }
  }

  reset(): void {
    for (const band of ['low', 'mid', 'high'] as const) {
      this.buffers[band].left.fill(0)
      this.buffers[band].right.fill(0)
    }
    this.writePos = 0
    this.validSamples = 0
  }
}
