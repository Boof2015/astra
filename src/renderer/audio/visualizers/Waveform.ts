import { audioEngine } from '../AudioEngine'
import { waveform as nativeWaveform, type WaveformNativeAnalyzer } from '../native/index'
import { resolveColorToRgb } from '../../utils/color'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import {
  DEFAULT_WAVEFORM_GAIN_DB,
  DEFAULT_WAVEFORM_MODE,
  DEFAULT_WAVEFORM_SCROLL_SPEED,
  clampWaveformGainDb,
  clampWaveformScrollSpeed,
  type WaveformMode,
} from '../../../types/waveform'
import { MultibandSplitter, createMultibandChunk, type MultibandChunk } from './multibandSplitter'

export interface WaveformStereoChunk {
  left: Float32Array
  right: Float32Array
}

export interface WaveformDataSource extends VisualizerSessionSource {
  getPendingWaveformSamples: () => Float32Array[]
  getPendingWaveformStereoSamples: () => WaveformStereoChunk[]
}

export interface WaveformOptions {
  backgroundColor?: string
  lineColor?: string
  gridMajorColor?: string
  gridMinorColor?: string
  bandColors?: {
    low: string
    mid: string
    high: string
  }
  mode?: WaveformMode
  scrollSpeed?: number
  gainDb?: number
  multiband?: boolean
  dataSource?: WaveformDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: WaveformNativeAnalyzer | null
}

type ResolvedWaveformOptions = Required<Omit<WaveformOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

const defaultOptions: ResolvedWaveformOptions = {
  backgroundColor: 'transparent',
  lineColor: '#38bdf8',
  gridMajorColor: 'rgba(255, 255, 255, 0.08)',
  gridMinorColor: 'rgba(255, 255, 255, 0.04)',
  bandColors: {
    low: '#ff4444',
    mid: '#44dd44',
    high: '#4488ff',
  },
  mode: DEFAULT_WAVEFORM_MODE,
  scrollSpeed: DEFAULT_WAVEFORM_SCROLL_SPEED,
  gainDb: DEFAULT_WAVEFORM_GAIN_DB,
  multiband: false,
}

const MULTIBAND_WEIGHT_EMPHASIS = 2.6
const MULTIBAND_DOMINANCE_SENSITIVITY = 5
const MULTIBAND_FOCUSED_BLEND = 0.68
const MULTIBAND_FILL_ALPHA = 0.72
const MULTIBAND_EDGE_ALPHA = 1.0
const BASE_PIXELS_PER_SECOND = 128
const DISPLAY_MARGIN = 0.95

const defaultWaveformDataSource: WaveformDataSource = {
  getPendingWaveformSamples: () => audioEngine.flushPendingWaveformSamples(),
  getPendingWaveformStereoSamples: () => audioEngine.flushPendingWaveformStereoSamples(),
  ...defaultVisualizerSessionSource,
}

export class Waveform {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedWaveformOptions
  private dataSource: WaveformDataSource
  private nativeAnalyzer: WaveformNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop

  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private staticLayerKey = ''

  private leftColumnAccumulator: Float32Array = new Float32Array(0)
  private rightColumnAccumulator: Float32Array = new Float32Array(0)
  private columnAccumulatorPos = 0
  private samplesPerColumn = 0
  private lastSampleRate = 0

  private splitter = new MultibandSplitter()
  private leftBandLowAcc: Float32Array = new Float32Array(0)
  private leftBandMidAcc: Float32Array = new Float32Array(0)
  private leftBandHighAcc: Float32Array = new Float32Array(0)
  private rightBandLowAcc: Float32Array = new Float32Array(0)
  private rightBandMidAcc: Float32Array = new Float32Array(0)
  private rightBandHighAcc: Float32Array = new Float32Array(0)
  private multibandScratch: MultibandChunk = createMultibandChunk(0)
  private unsubscribeSessionChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: WaveformOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = {
      ...defaultOptions,
      ...optionOverrides,
      mode: optionOverrides.mode ?? defaultOptions.mode,
      scrollSpeed: clampWaveformScrollSpeed(optionOverrides.scrollSpeed ?? defaultOptions.scrollSpeed),
      gainDb: clampWaveformGainDb(optionOverrides.gainDb ?? defaultOptions.gainDb),
      multiband: optionOverrides.multiband ?? defaultOptions.multiband,
    }
    this.dataSource = dataSource ?? defaultWaveformDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? nativeWaveform : nativeAnalyzer
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })

    this.waterfallCanvas = document.createElement('canvas')
    this.waterfallCanvas.width = canvas.width
    this.waterfallCanvas.height = canvas.height
    const waterfallCtx = this.waterfallCanvas.getContext('2d')
    if (!waterfallCtx) throw new Error('Could not get waterfall 2D context')
    this.waterfallCtx = waterfallCtx
    this.waterfallCtx.imageSmoothingEnabled = false

    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get static 2D context')
    this.staticLayerCtx = staticLayerCtx

    this.recomputeSamplesPerColumn()
    this.subscribeToSessionChanges()
  }

  private subscribeToSessionChanges(): void {
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
    }
    this.unsubscribeSessionChange = this.dataSource.subscribeToSessionChanges(() => {
      this.resetDisplay()
    })
  }

  private resetDisplay(): void {
    this.waterfallCtx.clearRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height)
    this.columnAccumulatorPos = 0
    this.splitter.reset()
    this.nativeAnalyzer?.reset()
    this.configureNativeAnalyzer()
    this.invalidate()
  }

  private configureNativeAnalyzer(): void {
    if (this.nativeAnalyzer?.isAvailable?.() === false) {
      return
    }
    this.nativeAnalyzer?.configure(this.lastSampleRate || Math.max(1, this.dataSource.getSampleRate()), this.samplesPerColumn)
  }

  private recomputeSamplesPerColumn(): void {
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const pixelsPerSecond = BASE_PIXELS_PER_SECOND * this.options.scrollSpeed
    const next = Math.max(1, Math.round(sampleRate / pixelsPerSecond))
    if (next !== this.samplesPerColumn) {
      this.samplesPerColumn = next
      this.leftColumnAccumulator = new Float32Array(next)
      this.rightColumnAccumulator = new Float32Array(next)
      this.leftBandLowAcc = new Float32Array(next)
      this.leftBandMidAcc = new Float32Array(next)
      this.leftBandHighAcc = new Float32Array(next)
      this.rightBandLowAcc = new Float32Array(next)
      this.rightBandMidAcc = new Float32Array(next)
      this.rightBandHighAcc = new Float32Array(next)
      this.columnAccumulatorPos = 0
    }
    this.lastSampleRate = sampleRate
    this.splitter.configure(sampleRate)
    this.configureNativeAnalyzer()
  }

  setOptions(options: Partial<WaveformOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, nativeAnalyzer, ...optionUpdates } = options
    const nextOptions: ResolvedWaveformOptions = {
      ...this.options,
      ...optionUpdates,
      mode: optionUpdates.mode ?? this.options.mode,
      gainDb: clampWaveformGainDb(optionUpdates.gainDb ?? this.options.gainDb),
      lineColor: optionUpdates.lineColor ?? this.options.lineColor,
      scrollSpeed: clampWaveformScrollSpeed(optionUpdates.scrollSpeed ?? this.options.scrollSpeed),
      multiband: optionUpdates.multiband ?? this.options.multiband,
    }
    const speedChanged = nextOptions.scrollSpeed !== this.options.scrollSpeed
    const multibandChanged = nextOptions.multiband !== this.options.multiband
    const modeChanged = nextOptions.mode !== this.options.mode
    const dataSourceChanged = Boolean(dataSource && dataSource !== this.dataSource)
    const nativeAnalyzerChanged = nativeAnalyzer !== undefined && nativeAnalyzer !== this.nativeAnalyzer

    this.options = nextOptions

    if (nativeAnalyzerChanged) {
      this.nativeAnalyzer = nativeAnalyzer
      this.nativeAnalyzer?.reset()
      this.configureNativeAnalyzer()
    }

    if (dataSourceChanged && dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
    }

    if (dataSourceChanged || speedChanged) {
      this.recomputeSamplesPerColumn()
    }

    if (multibandChanged || modeChanged) {
      this.splitter.reset()
      this.nativeAnalyzer?.reset()
      this.configureNativeAnalyzer()
    }

    this.staticLayerKey = ''
    if (dataSourceChanged || speedChanged || multibandChanged || modeChanged || nativeAnalyzerChanged) {
      this.resetDisplay()
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
    this.staticLayerKey = ''
    this.invalidate()
  }

  private computeMinMax(samples: Float32Array): { min: number; max: number } {
    if (this.columnAccumulatorPos === 0) {
      return { min: 0, max: 0 }
    }

    let min = samples[0]
    let max = samples[0]
    for (let i = 1; i < this.columnAccumulatorPos; i++) {
      const sample = samples[i]
      if (sample < min) min = sample
      if (sample > max) max = sample
    }
    return { min, max }
  }

  private computeBandColor(
    lowBandSamples: Float32Array,
    midBandSamples: Float32Array,
    highBandSamples: Float32Array,
  ): [number, number, number] {
    const n = this.columnAccumulatorPos
    if (n === 0) return this.toBandColorTuple(this.options.bandColors.mid)

    let lowSum = 0
    let midSum = 0
    let highSum = 0
    for (let i = 0; i < n; i++) {
      const low = lowBandSamples[i]
      const mid = midBandSamples[i]
      const high = highBandSamples[i]
      lowSum += low * low
      midSum += mid * mid
      highSum += high * high
    }

    return this.computeBandColorFromRms(
      Math.sqrt(lowSum / n),
      Math.sqrt(midSum / n),
      Math.sqrt(highSum / n),
    )
  }

  private computeBandColorFromRms(
    lowRms: number,
    midRms: number,
    highRms: number,
  ): [number, number, number] {
    const lowBand = this.toBandColorTuple(this.options.bandColors.low)
    const midBand = this.toBandColorTuple(this.options.bandColors.mid)
    const highBand = this.toBandColorTuple(this.options.bandColors.high)
    const total = lowRms + midRms + highRms

    if (total < 1e-10) return midBand

    const emphasizedWeights = [
      Math.pow(lowRms / total, MULTIBAND_WEIGHT_EMPHASIS),
      Math.pow(midRms / total, MULTIBAND_WEIGHT_EMPHASIS),
      Math.pow(highRms / total, MULTIBAND_WEIGHT_EMPHASIS),
    ] as const
    const emphasizedTotal = emphasizedWeights[0] + emphasizedWeights[1] + emphasizedWeights[2]
    if (emphasizedTotal < 1e-10) return midBand

    const normalizedBands = [
      { color: lowBand, weight: emphasizedWeights[0] / emphasizedTotal },
      { color: midBand, weight: emphasizedWeights[1] / emphasizedTotal },
      { color: highBand, weight: emphasizedWeights[2] / emphasizedTotal },
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

  private resolveNativeColumnColor(lowRms: number, midRms: number, highRms: number): [number, number, number] {
    if (this.options.multiband) {
      return this.computeBandColorFromRms(lowRms, midRms, highRms)
    }

    const lineColor = resolveColorToRgb(this.options.lineColor)
    return [lineColor.r, lineColor.g, lineColor.b]
  }

  private toBandColorTuple(color: string): [number, number, number] {
    const { r, g, b } = resolveColorToRgb(color)
    return [r, g, b]
  }

  private resolveColumnColor(
    lowBandSamples: Float32Array,
    midBandSamples: Float32Array,
    highBandSamples: Float32Array,
  ): [number, number, number] {
    if (this.options.multiband) {
      return this.computeBandColor(lowBandSamples, midBandSamples, highBandSamples)
    }

    const lineColor = resolveColorToRgb(this.options.lineColor)
    return [lineColor.r, lineColor.g, lineColor.b]
  }

  private shiftWaterfall(columns = 1): void {
    this.waterfallCtx.globalCompositeOperation = 'copy'
    this.waterfallCtx.drawImage(this.waterfallCanvas, -columns, 0)
    this.waterfallCtx.globalCompositeOperation = 'source-over'
  }

  private paintColumn(
    min: number,
    max: number,
    width: number,
    laneTop: number,
    laneHeight: number,
    color: [number, number, number],
    x: number = width - 1,
  ): void {
    const gain = Math.pow(10, this.options.gainDb / 20)
    const scaledMin = Math.max(-1, Math.min(1, min * gain))
    const scaledMax = Math.max(-1, Math.min(1, max * gain))
    const centerY = laneTop + (laneHeight / 2)
    const displayHalfHeight = (laneHeight / 2) * DISPLAY_MARGIN
    const yTop = Math.round(centerY - scaledMax * displayHalfHeight)
    const yBottom = Math.round(centerY - scaledMin * displayHalfHeight)
    const lineHeight = Math.max(1, yBottom - yTop)

    const fillAlpha = this.options.multiband ? MULTIBAND_FILL_ALPHA : 0.55
    const edgeAlpha = this.options.multiband ? MULTIBAND_EDGE_ALPHA : 0.9
    const [r, g, b] = color

    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${fillAlpha})`
    this.waterfallCtx.fillRect(x, yTop, 1, lineHeight)

    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${edgeAlpha})`
    this.waterfallCtx.fillRect(x, yTop, 1, 1)
    if (lineHeight > 1) {
      this.waterfallCtx.fillRect(x, yBottom - 1, 1, 1)
    }
  }

  private renderStaticLayer(width: number, height: number): void {
    this.ensureStaticLayer(width, height)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.staticLayerCanvas, 0, 0)
  }

  private ensureStaticLayer(width: number, height: number): void {
    const key = `${width}:${height}:${this.options.mode}:${this.options.backgroundColor}`
    if (this.staticLayerKey === key) {
      return
    }

    this.staticLayerCanvas.width = this.canvas.width
    this.staticLayerCanvas.height = this.canvas.height
    this.staticLayerCtx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (this.options.backgroundColor !== 'transparent') {
      this.staticLayerCtx.fillStyle = this.options.backgroundColor
      this.staticLayerCtx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    }
    this.drawGrid(this.staticLayerCtx, width, height)
    this.staticLayerKey = key
  }

  private drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.options.mode === 'stereo') {
      this.drawStereoGrid(ctx, width, height)
      return
    }

    this.drawMonoGrid(ctx, width, height)
  }

  private drawMonoGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const centerY = height / 2

    ctx.strokeStyle = this.options.gridMajorColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(width, centerY)
    ctx.stroke()

    ctx.strokeStyle = this.options.gridMinorColor
    const quarterY = centerY * 0.5
    ctx.beginPath()
    ctx.moveTo(0, quarterY)
    ctx.lineTo(width, quarterY)
    ctx.moveTo(0, height - quarterY)
    ctx.lineTo(width, height - quarterY)
    ctx.stroke()
  }

  private drawStereoGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const laneHeight = height / 2

    ctx.strokeStyle = this.options.gridMajorColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, laneHeight * 0.5)
    ctx.lineTo(width, laneHeight * 0.5)
    ctx.moveTo(0, laneHeight)
    ctx.lineTo(width, laneHeight)
    ctx.moveTo(0, laneHeight * 1.5)
    ctx.lineTo(width, laneHeight * 1.5)
    ctx.stroke()

    ctx.strokeStyle = this.options.gridMinorColor
    ctx.beginPath()
    ctx.moveTo(0, laneHeight * 0.25)
    ctx.lineTo(width, laneHeight * 0.25)
    ctx.moveTo(0, laneHeight * 0.75)
    ctx.lineTo(width, laneHeight * 0.75)
    ctx.moveTo(0, laneHeight * 1.25)
    ctx.lineTo(width, laneHeight * 1.25)
    ctx.moveTo(0, laneHeight * 1.75)
    ctx.lineTo(width, laneHeight * 1.75)
    ctx.stroke()
  }

  private drainPendingSamples(): void {
    if (this.options.mode === 'stereo') {
      this.dataSource.getPendingWaveformStereoSamples()
      return
    }

    this.dataSource.getPendingWaveformSamples()
  }

  private processMonoChunk(chunk: Float32Array, width: number, height: number): void {
    if (this.useNativeAnalyzer()) {
      if (this.processNativeMonoChunk(chunk, width, height)) {
        return
      }
    }

    let lowBand: Float32Array | null = null
    let midBand: Float32Array | null = null
    let highBand: Float32Array | null = null
    if (this.options.multiband) {
      const bands = this.ensureMultibandScratch(chunk.length)
      this.splitter.splitInto(chunk, chunk, bands)
      lowBand = bands.low.left
      midBand = bands.mid.left
      highBand = bands.high.left
    }

    for (let i = 0; i < chunk.length; i++) {
      this.leftColumnAccumulator[this.columnAccumulatorPos] = chunk[i]
      if (lowBand && midBand && highBand) {
        this.leftBandLowAcc[this.columnAccumulatorPos] = lowBand[i]
        this.leftBandMidAcc[this.columnAccumulatorPos] = midBand[i]
        this.leftBandHighAcc[this.columnAccumulatorPos] = highBand[i]
      }
      this.columnAccumulatorPos += 1

      if (this.columnAccumulatorPos >= this.samplesPerColumn) {
        const { min, max } = this.computeMinMax(this.leftColumnAccumulator)
        const color = this.resolveColumnColor(this.leftBandLowAcc, this.leftBandMidAcc, this.leftBandHighAcc)
        this.shiftWaterfall()
        this.paintColumn(min, max, width, 0, height, color)
        this.columnAccumulatorPos = 0
      }
    }
  }

  private processStereoChunk(chunk: WaveformStereoChunk, width: number, height: number): void {
    const length = Math.min(chunk.left.length, chunk.right.length)
    if (length === 0) {
      return
    }

    const leftSamples = chunk.left.length === length ? chunk.left : chunk.left.subarray(0, length)
    const rightSamples = chunk.right.length === length ? chunk.right : chunk.right.subarray(0, length)

    if (this.useNativeAnalyzer()) {
      if (this.processNativeStereoChunk(leftSamples, rightSamples, width, height)) {
        return
      }
    }

    let lowLeft: Float32Array | null = null
    let midLeft: Float32Array | null = null
    let highLeft: Float32Array | null = null
    let lowRight: Float32Array | null = null
    let midRight: Float32Array | null = null
    let highRight: Float32Array | null = null
    if (this.options.multiband) {
      const bands = this.ensureMultibandScratch(length)
      this.splitter.splitInto(leftSamples, rightSamples, bands)
      lowLeft = bands.low.left
      midLeft = bands.mid.left
      highLeft = bands.high.left
      lowRight = bands.low.right
      midRight = bands.mid.right
      highRight = bands.high.right
    }

    const laneHeight = height / 2
    for (let i = 0; i < length; i++) {
      this.leftColumnAccumulator[this.columnAccumulatorPos] = leftSamples[i]
      this.rightColumnAccumulator[this.columnAccumulatorPos] = rightSamples[i]
      if (lowLeft && midLeft && highLeft && lowRight && midRight && highRight) {
        this.leftBandLowAcc[this.columnAccumulatorPos] = lowLeft[i]
        this.leftBandMidAcc[this.columnAccumulatorPos] = midLeft[i]
        this.leftBandHighAcc[this.columnAccumulatorPos] = highLeft[i]
        this.rightBandLowAcc[this.columnAccumulatorPos] = lowRight[i]
        this.rightBandMidAcc[this.columnAccumulatorPos] = midRight[i]
        this.rightBandHighAcc[this.columnAccumulatorPos] = highRight[i]
      }
      this.columnAccumulatorPos += 1

      if (this.columnAccumulatorPos >= this.samplesPerColumn) {
        const leftMinMax = this.computeMinMax(this.leftColumnAccumulator)
        const rightMinMax = this.computeMinMax(this.rightColumnAccumulator)
        const leftColor = this.resolveColumnColor(this.leftBandLowAcc, this.leftBandMidAcc, this.leftBandHighAcc)
        const rightColor = this.resolveColumnColor(this.rightBandLowAcc, this.rightBandMidAcc, this.rightBandHighAcc)
        this.shiftWaterfall()
        this.paintColumn(leftMinMax.min, leftMinMax.max, width, 0, laneHeight, leftColor)
        this.paintColumn(rightMinMax.min, rightMinMax.max, width, laneHeight, laneHeight, rightColor)
        this.columnAccumulatorPos = 0
      }
    }
  }

  private useNativeAnalyzer(): boolean {
    // The native analyzer computes per-column min/max (and band RMS) identically to
    // the JS sample loop, so prefer it whenever available — for plain mode it just
    // colors columns with lineColor. The JS path below remains the fallback when no
    // native analyzer is present (and is what feeds raw samples in the Electron app
    // when the addon is unavailable).
    return Boolean(this.nativeAnalyzer) && this.nativeAnalyzer?.isAvailable?.() !== false
  }

  private processNativeMonoChunk(chunk: Float32Array, width: number, height: number): boolean {
    const summaries = this.nativeAnalyzer?.processMono(chunk)
    if (!summaries) {
      return false
    }

    const stride = 5
    const columnCount = Math.floor(summaries.length / stride)
    if (columnCount <= 0) return true

    // Scroll once for the whole batch, then paint the new columns — far cheaper than
    // a full-canvas self-blit per column (which dominates cost at high scroll speeds).
    this.shiftWaterfall(Math.min(columnCount, width))
    for (let column = 0; column < columnCount; column += 1) {
      const x = width - columnCount + column
      if (x < 0) continue
      const offset = column * stride
      const color = this.resolveNativeColumnColor(summaries[offset + 2], summaries[offset + 3], summaries[offset + 4])
      this.paintColumn(summaries[offset], summaries[offset + 1], width, 0, height, color, x)
    }
    return true
  }

  private processNativeStereoChunk(leftSamples: Float32Array, rightSamples: Float32Array, width: number, height: number): boolean {
    const summaries = this.nativeAnalyzer?.processStereo(leftSamples, rightSamples)
    if (!summaries) {
      return false
    }

    const stride = 10
    const laneHeight = height / 2
    const columnCount = Math.floor(summaries.length / stride)
    if (columnCount <= 0) return true

    this.shiftWaterfall(Math.min(columnCount, width))
    for (let column = 0; column < columnCount; column += 1) {
      const x = width - columnCount + column
      if (x < 0) continue
      const offset = column * stride
      const leftColor = this.resolveNativeColumnColor(summaries[offset + 2], summaries[offset + 3], summaries[offset + 4])
      const rightColor = this.resolveNativeColumnColor(summaries[offset + 7], summaries[offset + 8], summaries[offset + 9])
      this.paintColumn(summaries[offset], summaries[offset + 1], width, 0, laneHeight, leftColor, x)
      this.paintColumn(summaries[offset + 5], summaries[offset + 6], width, laneHeight, laneHeight, rightColor, x)
    }
    return true
  }

  private ensureMultibandScratch(length: number): MultibandChunk {
    if (this.multibandScratch.low.left.length < length) {
      this.multibandScratch = createMultibandChunk(length)
    }
    return this.multibandScratch
  }

  private drawFrame = (): void => {
    const width = this.canvas.width
    const height = this.canvas.height

    if (width <= 0 || height <= 0) {
      return
    }

    this.ctx.imageSmoothingEnabled = false

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
          dstX, 0, srcW, height,
        )
      }

      this.recomputeSamplesPerColumn()
      this.staticLayerKey = ''
    }

    const sampleRate = this.dataSource.getSampleRate()
    if (Math.abs(sampleRate - this.lastSampleRate) > 100) {
      this.recomputeSamplesPerColumn()
    }

    if (!this.dataSource.isPlaying()) {
      this.drainPendingSamples()
      this.renderStaticLayer(width, height)
      this.ctx.drawImage(this.waterfallCanvas, 0, 0)
      return
    }

    if (this.options.mode === 'stereo') {
      const pending = this.dataSource.getPendingWaveformStereoSamples()
      for (const chunk of pending) {
        this.processStereoChunk(chunk, width, height)
      }
    } else {
      const pending = this.dataSource.getPendingWaveformSamples()
      for (const chunk of pending) {
        this.processMonoChunk(chunk, width, height)
      }
    }

    this.renderStaticLayer(width, height)
    this.ctx.drawImage(this.waterfallCanvas, 0, 0)
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    this.nativeAnalyzer?.reset()
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }
  }
}
