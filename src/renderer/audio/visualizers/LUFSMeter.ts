import { audioEngine } from '../AudioEngine'
import type { LUFSMeterMode } from '../../../types/lufsmeter'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'

export interface LUFSMeterDataSource {
  getPendingLUFSMeterSamples: () => Array<{ left: Float32Array; right: Float32Array }>
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface LUFSMeterOptions {
  mode?: LUFSMeterMode
  lineColor?: string
  dataSource?: LUFSMeterDataSource
  frameScheduler?: FrameScheduler
}

type ResolvedLUFSMeterOptions = Required<Omit<LUFSMeterOptions, 'dataSource' | 'frameScheduler'>>

const defaultOptions: ResolvedLUFSMeterOptions = {
  mode: 'bar',
  lineColor: '#38bdf8',
}

const defaultLUFSMeterDataSource: LUFSMeterDataSource = {
  getPendingLUFSMeterSamples: () => audioEngine.flushPendingLUFSMeterSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

// ---- Constants ----

const METER_MIN_LUFS = -60
const METER_MAX_LUFS = 0
const MOMENTARY_WINDOW_S = 0.4
const SHORT_TERM_WINDOW_S = 3.0
const INTEGRATED_BLOCK_S = 0.4
const INTEGRATED_HOP_S = 0.1
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_OFFSET = -10
const TARGET_LUFS = -14
const SMOOTHING = 0.7

// ---- K-weighting filter coefficients (ITU-R BS.1770) ----

interface BiquadCoeffs {
  b0: number; b1: number; b2: number
  a1: number; a2: number
}

// Pre-filter (high shelf) — 48kHz
const PRE_FILTER_48K: BiquadCoeffs = {
  b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
  a1: -1.69065929318241, a2: 0.73248077421585,
}

// RLB weighting (high pass) — 48kHz
const RLB_FILTER_48K: BiquadCoeffs = {
  b0: 1.0, b1: -2.0, b2: 1.0,
  a1: -1.99004745483398, a2: 0.99007225036621,
}

// Pre-filter — 44.1kHz
const PRE_FILTER_44K: BiquadCoeffs = {
  b0: 1.5308412300498355, b1: -2.6509799951536985, b2: 1.1690790799210956,
  a1: -1.6636551132560204, a2: 0.7125954280732254,
}

// RLB — 44.1kHz
const RLB_FILTER_44K: BiquadCoeffs = {
  b0: 1.0, b1: -2.0, b2: 1.0,
  a1: -1.9891696736297957, a2: 0.9891990357870394,
}

function getKWeightingCoeffs(sampleRate: number): { pre: BiquadCoeffs; rlb: BiquadCoeffs } {
  if (Math.abs(sampleRate - 44100) < 100) {
    return { pre: PRE_FILTER_44K, rlb: RLB_FILTER_44K }
  }
  // Default to 48kHz (also reasonable approximation for 96kHz, etc.)
  return { pre: PRE_FILTER_48K, rlb: RLB_FILTER_48K }
}

// ---- Biquad filter state ----

interface BiquadState {
  x1: number; x2: number
  y1: number; y2: number
}

function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 }
}

function applyBiquad(coeffs: BiquadCoeffs, state: BiquadState, input: number): number {
  const output = coeffs.b0 * input + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1 - coeffs.a2 * state.y2
  state.x2 = state.x1
  state.x1 = input
  state.y2 = state.y1
  state.y1 = output
  return output
}

// ---- Color utilities ----

function parseHexColor(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) || 56,
    parseInt(h.substring(2, 4), 16) || 189,
    parseInt(h.substring(4, 6), 16) || 248,
  ]
}

// ---- LUFS Meter class ----

export class LUFSMeter {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedLUFSMeterOptions
  private dataSource: LUFSMeterDataSource
  private frameLoop: VisualizerFrameLoop

  // K-weighting filter state (per channel, two stages)
  private preFilterL = createBiquadState()
  private preFilterR = createBiquadState()
  private rlbFilterL = createBiquadState()
  private rlbFilterR = createBiquadState()
  private currentSampleRate = 48000
  private kWeightingCoeffs = getKWeightingCoeffs(48000)

  // Ring buffer for K-weighted squared samples (sized for SHORT_TERM_WINDOW_S)
  private ringBufferL = new Float32Array(0)
  private ringBufferR = new Float32Array(0)
  private ringBufferPos = 0
  private ringBufferFilled = 0  // how many samples have been written total (capped at buffer size)

  // Integrated loudness: accumulate 400ms block mean-squares with 100ms hop
  private integratedBlockSumL = 0
  private integratedBlockSumR = 0
  private integratedBlockSamples = 0
  private integratedHopCounter = 0
  private integratedBlockLoudness: number[] = []  // LUFS per block

  // Smoothed display values
  private momentaryLUFS = METER_MIN_LUFS
  private shortTermLUFS = METER_MIN_LUFS
  private integratedLUFS = METER_MIN_LUFS

  // Track change subscription
  private unsubscribeTrackChange: (() => void) | null = null
  private unsubscribePlaybackState: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: LUFSMeterOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultLUFSMeterDataSource
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })

    this.initRingBuffer(this.dataSource.getSampleRate())

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetMeters()
    })
    this.unsubscribePlaybackState = audioEngine.on('stateChange', () => {
      this.invalidate()
    })
  }

  private initRingBuffer(sampleRate: number): void {
    this.currentSampleRate = Math.max(1, sampleRate)
    this.kWeightingCoeffs = getKWeightingCoeffs(this.currentSampleRate)
    const bufferSize = Math.ceil(this.currentSampleRate * SHORT_TERM_WINDOW_S)
    this.ringBufferL = new Float32Array(bufferSize)
    this.ringBufferR = new Float32Array(bufferSize)
    this.ringBufferPos = 0
    this.ringBufferFilled = 0
  }

  private resetMeters(): void {
    this.momentaryLUFS = METER_MIN_LUFS
    this.shortTermLUFS = METER_MIN_LUFS
    this.integratedLUFS = METER_MIN_LUFS
    this.ringBufferL.fill(0)
    this.ringBufferR.fill(0)
    this.ringBufferPos = 0
    this.ringBufferFilled = 0
    this.integratedBlockSumL = 0
    this.integratedBlockSumR = 0
    this.integratedBlockSamples = 0
    this.integratedHopCounter = 0
    this.integratedBlockLoudness = []
    this.preFilterL = createBiquadState()
    this.preFilterR = createBiquadState()
    this.rlbFilterL = createBiquadState()
    this.rlbFilterR = createBiquadState()
    this.invalidate()
  }

  setOptions(options: Partial<LUFSMeterOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    if (dataSource) {
      this.dataSource = dataSource
    }
    this.invalidate()
  }

  start(): void {
    this.frameLoop.start()
  }

  stop(): void {
    this.frameLoop.stop()
  }

  invalidate(): void {
    this.frameLoop.invalidate()
  }

  resize(): void {
    // Canvas resize handled externally
    this.invalidate()
  }

  private processAudio(): void {
    const chunks = this.dataSource.getPendingLUFSMeterSamples()

    // Check if sample rate changed
    const sr = this.dataSource.getSampleRate()
    if (Math.abs(sr - this.currentSampleRate) > 100) {
      this.initRingBuffer(sr)
      this.resetMeters()
    }

    const playing = this.dataSource.isPlaying()

    if (!playing && chunks.length === 0) {
      // Decay toward silence only when truly stopped
      this.momentaryLUFS = this.momentaryLUFS * SMOOTHING + METER_MIN_LUFS * (1 - SMOOTHING)
      this.shortTermLUFS = this.shortTermLUFS * SMOOTHING + METER_MIN_LUFS * (1 - SMOOTHING)
      return
    }

    // Process any new audio chunks into the ring buffer
    if (chunks.length > 0) {
      const { pre, rlb } = this.kWeightingCoeffs
      const bufLen = this.ringBufferL.length
      const hopSamples = Math.round(this.currentSampleRate * INTEGRATED_HOP_S)
      const blockSamples = Math.round(this.currentSampleRate * INTEGRATED_BLOCK_S)

      for (const chunk of chunks) {
        const len = Math.min(chunk.left.length, chunk.right.length)
        for (let i = 0; i < len; i++) {
          // Apply K-weighting: pre-filter then RLB, per channel
          const kwL = applyBiquad(rlb, this.rlbFilterL, applyBiquad(pre, this.preFilterL, chunk.left[i]))
          const kwR = applyBiquad(rlb, this.rlbFilterR, applyBiquad(pre, this.preFilterR, chunk.right[i]))

          // Store squared K-weighted samples in ring buffer
          const sqL = kwL * kwL
          const sqR = kwR * kwR
          this.ringBufferL[this.ringBufferPos] = sqL
          this.ringBufferR[this.ringBufferPos] = sqR
          this.ringBufferPos = (this.ringBufferPos + 1) % bufLen
          if (this.ringBufferFilled < bufLen) this.ringBufferFilled++

          // Accumulate for integrated measurement
          this.integratedBlockSumL += sqL
          this.integratedBlockSumR += sqR
          this.integratedBlockSamples++
          this.integratedHopCounter++

          // Every hop interval, store a block loudness value
          if (this.integratedHopCounter >= hopSamples && this.integratedBlockSamples >= blockSamples) {
            const meanSqL = this.integratedBlockSumL / this.integratedBlockSamples
            const meanSqR = this.integratedBlockSumR / this.integratedBlockSamples
            const blockLUFS = -0.691 + 10 * Math.log10(Math.max(meanSqL + meanSqR, 1e-10))
            this.integratedBlockLoudness.push(blockLUFS)

            // Slide the block window: remove oldest hop worth of samples
            // Approximate by keeping a running sum and subtracting the hop fraction
            const hopFraction = hopSamples / this.integratedBlockSamples
            this.integratedBlockSumL *= (1 - hopFraction)
            this.integratedBlockSumR *= (1 - hopFraction)
            this.integratedBlockSamples = Math.round(this.integratedBlockSamples * (1 - hopFraction))
            this.integratedHopCounter = 0
          }
        }
      }
    }

    // Always compute M/S from the ring buffer (it persists across frames)
    const bufLen = this.ringBufferL.length

    // Compute momentary loudness (last 400ms)
    const momentarySamples = Math.min(
      Math.round(this.currentSampleRate * MOMENTARY_WINDOW_S),
      this.ringBufferFilled
    )
    if (momentarySamples > 0) {
      let sumL = 0, sumR = 0
      for (let i = 0; i < momentarySamples; i++) {
        const idx = (this.ringBufferPos - 1 - i + bufLen) % bufLen
        sumL += this.ringBufferL[idx]
        sumR += this.ringBufferR[idx]
      }
      const rawM = -0.691 + 10 * Math.log10(Math.max(sumL / momentarySamples + sumR / momentarySamples, 1e-10))
      this.momentaryLUFS = this.momentaryLUFS * SMOOTHING + Math.max(METER_MIN_LUFS, rawM) * (1 - SMOOTHING)
    }

    // Compute short-term loudness (last 3s)
    const shortTermSamples = Math.min(
      Math.round(this.currentSampleRate * SHORT_TERM_WINDOW_S),
      this.ringBufferFilled
    )
    if (shortTermSamples > 0) {
      let sumL = 0, sumR = 0
      for (let i = 0; i < shortTermSamples; i++) {
        const idx = (this.ringBufferPos - 1 - i + bufLen) % bufLen
        sumL += this.ringBufferL[idx]
        sumR += this.ringBufferR[idx]
      }
      const rawS = -0.691 + 10 * Math.log10(Math.max(sumL / shortTermSamples + sumR / shortTermSamples, 1e-10))
      this.shortTermLUFS = this.shortTermLUFS * SMOOTHING + Math.max(METER_MIN_LUFS, rawS) * (1 - SMOOTHING)
    }

    // Compute integrated loudness with gating
    this.integratedLUFS = this.computeGatedIntegratedLoudness()
  }

  private computeGatedIntegratedLoudness(): number {
    const blocks = this.integratedBlockLoudness
    if (blocks.length === 0) return METER_MIN_LUFS

    // Absolute gate: remove blocks below -70 LUFS
    const afterAbsolute = blocks.filter(l => l > ABSOLUTE_GATE_LUFS)
    if (afterAbsolute.length === 0) return METER_MIN_LUFS

    // Compute mean of blocks passing absolute gate
    let sum = 0
    for (const l of afterAbsolute) sum += Math.pow(10, l / 10)
    const ungatedMean = 10 * Math.log10(sum / afterAbsolute.length)

    // Relative gate: remove blocks below (ungatedMean - 10) LUFS
    const relativeThreshold = ungatedMean + RELATIVE_GATE_OFFSET
    const afterRelative = afterAbsolute.filter(l => l > relativeThreshold)
    if (afterRelative.length === 0) return METER_MIN_LUFS

    // Final integrated loudness
    let finalSum = 0
    for (const l of afterRelative) finalSum += Math.pow(10, l / 10)
    return Math.max(METER_MIN_LUFS, 10 * Math.log10(finalSum / afterRelative.length))
  }

  private drawFrame = (): void => {
    const { canvas, ctx } = this
    const width = canvas.width
    const height = canvas.height

    if (width <= 0 || height <= 0) {
      return
    }

    this.processAudio()

    ctx.clearRect(0, 0, width, height)

    this.drawBars(width, height)
  }

  private drawBars(width: number, height: number): void {
    const ctx = this.ctx
    const [tintR, tintG, tintB] = parseHexColor(this.options.lineColor)
    const dpr = window.devicePixelRatio || 1

    const padding = Math.round(8 * dpr)
    const labelHeight = Math.round(20 * dpr)
    const readoutHeight = Math.round(18 * dpr)
    const scaleWidth = Math.round(32 * dpr)
    const barAreaTop = padding + labelHeight
    const barAreaBottom = height - padding - readoutHeight
    const barAreaHeight = Math.max(1, barAreaBottom - barAreaTop)
    const barAreaWidth = width - scaleWidth - padding

    const barCount = 3
    const barGap = Math.round(4 * dpr)
    const totalGaps = (barCount - 1) * barGap
    const barWidth = Math.max(4, Math.floor((barAreaWidth - totalGaps) / barCount))

    const values = [this.momentaryLUFS, this.shortTermLUFS, this.integratedLUFS]
    const labels = ['M', 'S', 'I']
    const dbRange = METER_MAX_LUFS - METER_MIN_LUFS

    const fontSize = Math.min(Math.round(13 * dpr), Math.max(Math.round(9 * dpr), Math.round(barWidth * 0.4)))
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    for (let i = 0; i < barCount; i++) {
      const x = scaleWidth + i * (barWidth + barGap)
      const lufs = values[i]
      const normalized = Math.max(0, Math.min(1, (lufs - METER_MIN_LUFS) / dbRange))
      const barH = Math.round(normalized * barAreaHeight)

      // Bar label
      ctx.font = `600 ${fontSize}px "Inter", system-ui, sans-serif`
      ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, 0.7)`
      ctx.fillText(labels[i], x + barWidth / 2, padding)

      // Bar background
      ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, 0.08)`
      ctx.fillRect(x, barAreaTop, barWidth, barAreaHeight)

      // Bar fill — gradient from dim at bottom to bright at top
      if (barH > 0) {
        const gradient = ctx.createLinearGradient(0, barAreaBottom, 0, barAreaBottom - barH)
        gradient.addColorStop(0, `rgba(${tintR}, ${tintG}, ${tintB}, 0.3)`)
        gradient.addColorStop(0.5, `rgba(${tintR}, ${tintG}, ${tintB}, 0.6)`)
        gradient.addColorStop(1, `rgba(${tintR}, ${tintG}, ${tintB}, 0.9)`)
        ctx.fillStyle = gradient
        ctx.fillRect(x, barAreaBottom - barH, barWidth, barH)
      }

      // Bright cap line at top of bar
      if (barH > 1) {
        ctx.fillStyle = `rgb(${tintR}, ${tintG}, ${tintB})`
        ctx.fillRect(x, barAreaBottom - barH, barWidth, Math.max(1, Math.round(2 * dpr)))
      }

      // LUFS readout below bar
      const displayLufs = lufs <= METER_MIN_LUFS + 1 ? '-∞' : lufs.toFixed(1)
      ctx.font = `500 ${Math.max(Math.round(8 * dpr), fontSize - Math.round(2 * dpr))}px "JetBrains Mono", "SF Mono", monospace`
      ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, 0.8)`
      ctx.fillText(displayLufs, x + barWidth / 2, barAreaBottom + Math.round(4 * dpr))
    }

    // Target reference line (-14 LUFS)
    const targetNorm = Math.max(0, Math.min(1, (TARGET_LUFS - METER_MIN_LUFS) / dbRange))
    const targetY = Math.round(barAreaBottom - targetNorm * barAreaHeight)
    ctx.strokeStyle = `rgba(${tintR}, ${tintG}, ${tintB}, 0.25)`
    ctx.lineWidth = Math.max(1, dpr)
    ctx.setLineDash([Math.round(4 * dpr), Math.round(3 * dpr)])
    ctx.beginPath()
    ctx.moveTo(scaleWidth, targetY)
    ctx.lineTo(scaleWidth + barCount * barWidth + (barCount - 1) * barGap, targetY)
    ctx.stroke()
    ctx.setLineDash([])

    // Scale markings on left
    const scaleFont = Math.max(Math.round(7 * dpr), Math.round(9 * dpr))
    ctx.font = `400 ${scaleFont}px "JetBrains Mono", "SF Mono", monospace`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, 0.35)`

    const tickValues = [-60, -48, -36, -24, -18, -14, -9, -6, -3, 0]
    for (const tick of tickValues) {
      const norm = (tick - METER_MIN_LUFS) / dbRange
      if (norm < 0 || norm > 1) continue
      const y = Math.round(barAreaBottom - norm * barAreaHeight)
      ctx.fillText(`${tick}`, scaleWidth - Math.round(4 * dpr), y)

      // Tick mark
      ctx.fillRect(scaleWidth - Math.round(3 * dpr), y, Math.round(2 * dpr), Math.max(1, dpr))
    }

  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
    if (this.unsubscribePlaybackState) {
      this.unsubscribePlaybackState()
      this.unsubscribePlaybackState = null
    }
  }
}
