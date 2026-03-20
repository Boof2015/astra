import { audioEngine } from '../AudioEngine'
import {
  DEFAULT_WAVEFORM_GAIN_DB,
  DEFAULT_WAVEFORM_SCROLL_SPEED,
  clampWaveformGainDb,
  clampWaveformScrollSpeed,
} from '../../../types/waveform'
import { MultibandSplitter } from './multibandSplitter'

export interface WaveformDataSource {
  getPendingWaveformSamples: () => Float32Array[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface WaveformOptions {
  lineColor?: string
  scrollSpeed?: number
  gainDb?: number
  multiband?: boolean
  dataSource?: WaveformDataSource
}

type ResolvedWaveformOptions = Required<Omit<WaveformOptions, 'dataSource'>>

const defaultOptions: ResolvedWaveformOptions = {
  lineColor: '#38bdf8',
  scrollSpeed: DEFAULT_WAVEFORM_SCROLL_SPEED,
  gainDb: DEFAULT_WAVEFORM_GAIN_DB,
  multiband: false,
}

// Band colors for multiband mode — same hues as vectorscope RGB
const BAND_LOW:  [number, number, number] = [255, 68, 68]   // red — bass
const BAND_MID:  [number, number, number] = [68, 221, 68]   // green — mids
const BAND_HIGH: [number, number, number] = [68, 136, 255]  // blue — highs
const MULTIBAND_WEIGHT_EMPHASIS = 2.6
const MULTIBAND_DOMINANCE_SENSITIVITY = 5
const MULTIBAND_FOCUSED_BLEND = 0.68
const MULTIBAND_FILL_ALPHA = 0.72
const MULTIBAND_EDGE_ALPHA = 1.0

const defaultWaveformDataSource: WaveformDataSource = {
  getPendingWaveformSamples: () => audioEngine.flushPendingWaveformSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

// Calibrate 1.0x to the prior 8s window at roughly 512px wide,
// while keeping scroll speed independent from panel width.
const BASE_PIXELS_PER_SECOND = 64

function parseHexColor(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) || 56,
    parseInt(h.substring(2, 4), 16) || 189,
    parseInt(h.substring(4, 6), 16) || 248,
  ]
}

export class Waveform {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedWaveformOptions
  private dataSource: WaveformDataSource
  private animationId: number | null = null
  private isRunning = false

  // Offscreen canvas for scrolling content
  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D

  // Sample accumulator for current pixel column
  private columnAccumulator: Float32Array = new Float32Array(0)
  private columnAccumulatorPos = 0
  private samplesPerColumn = 0
  private lastSampleRate = 0

  // Multiband analysis
  private splitter = new MultibandSplitter()
  private bandLowAcc: Float32Array = new Float32Array(0)
  private bandMidAcc: Float32Array = new Float32Array(0)
  private bandHighAcc: Float32Array = new Float32Array(0)

  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: WaveformOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false

    const { dataSource, ...optionOverrides } = options
    this.options = {
      ...defaultOptions,
      ...optionOverrides,
      scrollSpeed: clampWaveformScrollSpeed(optionOverrides.scrollSpeed ?? defaultOptions.scrollSpeed),
      gainDb: clampWaveformGainDb(optionOverrides.gainDb ?? defaultOptions.gainDb),
      multiband: optionOverrides.multiband ?? defaultOptions.multiband,
    }
    this.dataSource = dataSource ?? defaultWaveformDataSource

    this.waterfallCanvas = document.createElement('canvas')
    this.waterfallCanvas.width = canvas.width
    this.waterfallCanvas.height = canvas.height
    const waterfallCtx = this.waterfallCanvas.getContext('2d')
    if (!waterfallCtx) throw new Error('Could not get waterfall 2D context')
    this.waterfallCtx = waterfallCtx
    this.waterfallCtx.imageSmoothingEnabled = false

    this.recomputeSamplesPerColumn()

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetDisplay()
    })
  }

  private resetDisplay(): void {
    this.waterfallCtx.clearRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height)
    this.columnAccumulatorPos = 0
    this.splitter.reset()
  }

  private recomputeSamplesPerColumn(): void {
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const pixelsPerSecond = BASE_PIXELS_PER_SECOND * this.options.scrollSpeed
    const next = Math.max(1, Math.round(sampleRate / pixelsPerSecond))
    if (next !== this.samplesPerColumn) {
      this.samplesPerColumn = next
      this.columnAccumulator = new Float32Array(next)
      this.bandLowAcc = new Float32Array(next)
      this.bandMidAcc = new Float32Array(next)
      this.bandHighAcc = new Float32Array(next)
      this.columnAccumulatorPos = 0
    }
    this.lastSampleRate = sampleRate
    this.splitter.configure(sampleRate)
  }

  setOptions(options: Partial<WaveformOptions>): void {
    const { dataSource, ...optionUpdates } = options
    const nextOptions: ResolvedWaveformOptions = {
      ...this.options,
      ...optionUpdates,
      lineColor: optionUpdates.lineColor ?? this.options.lineColor,
      scrollSpeed: clampWaveformScrollSpeed(optionUpdates.scrollSpeed ?? this.options.scrollSpeed),
      gainDb: clampWaveformGainDb(optionUpdates.gainDb ?? this.options.gainDb),
      multiband: optionUpdates.multiband ?? this.options.multiband,
    }
    const speedChanged = nextOptions.scrollSpeed !== this.options.scrollSpeed
    const multibandChanged = nextOptions.multiband !== this.options.multiband

    this.options = nextOptions
    if (dataSource) {
      this.dataSource = dataSource
    }
    if (speedChanged) {
      this.recomputeSamplesPerColumn()
      this.resetDisplay()
    }
    if (multibandChanged) {
      this.splitter.reset()
      this.resetDisplay()
    }
  }

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.draw()
  }

  stop(): void {
    this.isRunning = false
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  resize(): void {
    // Resize handled in draw loop
  }

  private computeMinMax(): { min: number; max: number } {
    let min = this.columnAccumulator[0]
    let max = this.columnAccumulator[0]
    for (let i = 1; i < this.columnAccumulatorPos; i++) {
      const s = this.columnAccumulator[i]
      if (s < min) min = s
      if (s > max) max = s
    }
    return { min, max }
  }

  private computeBandColor(): [number, number, number] {
    const n = this.columnAccumulatorPos
    if (n === 0) return BAND_MID

    // Compute RMS energy for each band
    let lowSum = 0
    let midSum = 0
    let highSum = 0
    for (let i = 0; i < n; i++) {
      const l = this.bandLowAcc[i]
      const m = this.bandMidAcc[i]
      const h = this.bandHighAcc[i]
      lowSum += l * l
      midSum += m * m
      highSum += h * h
    }

    const lowRms = Math.sqrt(lowSum / n)
    const midRms = Math.sqrt(midSum / n)
    const highRms = Math.sqrt(highSum / n)
    const total = lowRms + midRms + highRms

    if (total < 1e-10) return BAND_MID

    const emphasizedWeights = [
      Math.pow(lowRms / total, MULTIBAND_WEIGHT_EMPHASIS),
      Math.pow(midRms / total, MULTIBAND_WEIGHT_EMPHASIS),
      Math.pow(highRms / total, MULTIBAND_WEIGHT_EMPHASIS),
    ] as const
    const emphasizedTotal = emphasizedWeights[0] + emphasizedWeights[1] + emphasizedWeights[2]
    if (emphasizedTotal < 1e-10) return BAND_MID

    const normalizedBands = [
      { color: BAND_LOW, weight: emphasizedWeights[0] / emphasizedTotal },
      { color: BAND_MID, weight: emphasizedWeights[1] / emphasizedTotal },
      { color: BAND_HIGH, weight: emphasizedWeights[2] / emphasizedTotal },
    ] as const

    const blended: [number, number, number] = [
      Math.round(normalizedBands[0].color[0] * normalizedBands[0].weight + normalizedBands[1].color[0] * normalizedBands[1].weight + normalizedBands[2].color[0] * normalizedBands[2].weight),
      Math.round(normalizedBands[0].color[1] * normalizedBands[0].weight + normalizedBands[1].color[1] * normalizedBands[1].weight + normalizedBands[2].color[1] * normalizedBands[2].weight),
      Math.round(normalizedBands[0].color[2] * normalizedBands[0].weight + normalizedBands[1].color[2] * normalizedBands[1].weight + normalizedBands[2].color[2] * normalizedBands[2].weight),
    ]

    const sortedBands = [...normalizedBands].sort((left, right) => right.weight - left.weight)
    const dominance = Math.max(0, Math.min(1, (sortedBands[0].weight - sortedBands[1].weight) * MULTIBAND_DOMINANCE_SENSITIVITY))
    const dominantMix = 0.78 + (0.14 * dominance)
    const secondaryMix = 1 - dominantMix
    const focused: [number, number, number] = [
      Math.round(sortedBands[0].color[0] * dominantMix + sortedBands[1].color[0] * secondaryMix),
      Math.round(sortedBands[0].color[1] * dominantMix + sortedBands[1].color[1] * secondaryMix),
      Math.round(sortedBands[0].color[2] * dominantMix + sortedBands[1].color[2] * secondaryMix),
    ]

    const focusBlend = MULTIBAND_FOCUSED_BLEND + ((1 - MULTIBAND_FOCUSED_BLEND) * dominance)
    return [
      Math.round(blended[0] * (1 - focusBlend) + focused[0] * focusBlend),
      Math.round(blended[1] * (1 - focusBlend) + focused[1] * focusBlend),
      Math.round(blended[2] * (1 - focusBlend) + focused[2] * focusBlend),
    ]
  }

  private shiftAndPaintColumn(min: number, max: number, width: number, height: number): void {
    // Shift existing content left by 1 pixel — use 'copy' to avoid
    // alpha accumulation from source-over compositing on semi-transparent pixels
    this.waterfallCtx.globalCompositeOperation = 'copy'
    this.waterfallCtx.drawImage(this.waterfallCanvas, -1, 0)
    this.waterfallCtx.globalCompositeOperation = 'source-over'

    const centerY = height / 2
    const amplitudeGain = Math.pow(10, this.options.gainDb / 20)
    const scaledMin = Math.max(-1, Math.min(1, min * amplitudeGain))
    const scaledMax = Math.max(-1, Math.min(1, max * amplitudeGain))
    const displayMargin = 0.95 // slight margin so full-scale doesn't clip at edge
    const yTop = Math.round(centerY - scaledMax * centerY * displayMargin)
    const yBottom = Math.round(centerY - scaledMin * centerY * displayMargin)
    const lineHeight = Math.max(1, yBottom - yTop)

    let r: number, g: number, b: number
    if (this.options.multiband) {
      ;[r, g, b] = this.computeBandColor()
    } else {
      ;[r, g, b] = parseHexColor(this.options.lineColor)
    }

    const fillAlpha = this.options.multiband ? MULTIBAND_FILL_ALPHA : 0.55
    const edgeAlpha = this.options.multiband ? MULTIBAND_EDGE_ALPHA : 0.9

    // Draw the amplitude column — brighter at the edges, dimmer in the middle
    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${fillAlpha})`
    this.waterfallCtx.fillRect(width - 1, yTop, 1, lineHeight)

    // Bright edge pixels at min/max
    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${edgeAlpha})`
    this.waterfallCtx.fillRect(width - 1, yTop, 1, 1)
    if (lineHeight > 1) {
      this.waterfallCtx.fillRect(width - 1, yBottom - 1, 1, 1)
    }
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx
    const centerY = height / 2

    // Center line (zero crossing)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(width, centerY)
    ctx.stroke()

    // ±0.5 guide lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)'
    const quarterY = centerY * 0.5
    ctx.beginPath()
    ctx.moveTo(0, quarterY)
    ctx.lineTo(width, quarterY)
    ctx.moveTo(0, height - quarterY)
    ctx.lineTo(width, height - quarterY)
    ctx.stroke()
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const width = this.canvas.width
    const height = this.canvas.height

    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    this.ctx.imageSmoothingEnabled = false

    // Handle resize: preserve existing content anchored to right edge
    if (this.waterfallCanvas.width !== width || this.waterfallCanvas.height !== height) {
      const previousCanvas = document.createElement('canvas')
      previousCanvas.width = this.waterfallCanvas.width
      previousCanvas.height = this.waterfallCanvas.height
      const previousCtx = previousCanvas.getContext('2d')
      if (previousCtx) {
        previousCtx.drawImage(this.waterfallCanvas, 0, 0)
      }

      this.waterfallCanvas.width = width
      this.waterfallCanvas.height = height
      this.waterfallCtx.imageSmoothingEnabled = false

      if (previousCtx && previousCanvas.width > 0 && previousCanvas.height > 0) {
        const srcX = Math.max(0, previousCanvas.width - width)
        const srcW = Math.min(previousCanvas.width, width)
        const dstX = Math.max(0, width - previousCanvas.width)
        this.waterfallCtx.drawImage(
          previousCanvas,
          srcX, 0, srcW, previousCanvas.height,
          dstX, 0, srcW, height
        )
      }

      this.recomputeSamplesPerColumn()
    }

    // Handle sample rate changes
    const sampleRate = this.dataSource.getSampleRate()
    if (Math.abs(sampleRate - this.lastSampleRate) > 100) {
      this.recomputeSamplesPerColumn()
    }

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingWaveformSamples() // drain
      // Freeze display — show last waveform
      this.ctx.clearRect(0, 0, width, height)
      this.drawGrid(width, height)
      this.ctx.drawImage(this.waterfallCanvas, 0, 0)
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const pending = this.dataSource.getPendingWaveformSamples()
    const samplesPerCol = this.samplesPerColumn
    const multiband = this.options.multiband

    if (samplesPerCol > 0) {
      for (const chunk of pending) {
        // When multiband is enabled, split each chunk through the crossover filters
        let lowBand: Float32Array | null = null
        let midBand: Float32Array | null = null
        let highBand: Float32Array | null = null
        if (multiband) {
          const bands = this.splitter.split(chunk, chunk)
          lowBand = bands.low.left
          midBand = bands.mid.left
          highBand = bands.high.left
        }

        for (let i = 0; i < chunk.length; i++) {
          this.columnAccumulator[this.columnAccumulatorPos] = chunk[i]
          if (multiband && lowBand && midBand && highBand) {
            this.bandLowAcc[this.columnAccumulatorPos] = lowBand[i]
            this.bandMidAcc[this.columnAccumulatorPos] = midBand[i]
            this.bandHighAcc[this.columnAccumulatorPos] = highBand[i]
          }
          this.columnAccumulatorPos++

          if (this.columnAccumulatorPos >= samplesPerCol) {
            const { min, max } = this.computeMinMax()
            this.shiftAndPaintColumn(min, max, width, height)
            this.columnAccumulatorPos = 0
          }
        }
      }
    }

    this.ctx.clearRect(0, 0, width, height)
    this.drawGrid(width, height)
    this.ctx.drawImage(this.waterfallCanvas, 0, 0)
    this.animationId = requestAnimationFrame(this.draw)
  }

  dispose(): void {
    this.stop()
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
  }
}
