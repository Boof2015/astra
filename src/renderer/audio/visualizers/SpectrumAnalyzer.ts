import { audioEngine } from '../AudioEngine'
import { spectrum as defaultNativeSpectrum, warnNativeUnavailableOnce, type SpectrumNativeAnalyzer } from '../native/index'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import { parseColorToRgba } from '../../utils/color'
import {
  DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  clampSpectrumTiltDbPerOctave,
  clampSpectrumHeatmapTiltDbPerOctave,
  formatSpectrumPitchInfo,
  resolveSpectrumPitchInfo,
  DEFAULT_SPECTRUM_DISPLAY_MODE,
  DEFAULT_SPECTRUM_BAR_DENSITY,
  DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
  DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
  DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
  clampSpectrumBarDensity,
  clampSpectrumBarGapPercent,
  clampSpectrumBarCornerRadiusPx,
  type SpectrumDisplayMode,
  type SpectrumPeakInfo,
} from '../../../types/spectrum'
import {
  HEAT_LOW_DB,
  HEAT_MID_DB,
  normalizeHeatDb,
} from './heatScale'
import { CLASSIC_SPECTRUM_HEAT_COLORS } from './spectrumHeatPalette'

type SpectrumStereoChunk = {
  left: Float32Array
  right: Float32Array
}

export interface SpectrumAnalyzerDataSource extends VisualizerSessionSource {
  getPendingSpectrumSamples: () => Float32Array[]
  getPendingSpectrumStereoSamples: () => SpectrumStereoChunk[]
}

export interface SpectrumAnalyzerOptions {
  lineColor?: string
  secondaryLineColor?: string
  lineWidth?: number
  fillGradient?: boolean
  heatmapFill?: boolean
  heatmapSmoothing?: number
  gradientColors?: string[]
  heatColors?: [string, string, string]
  heatBaseColor?: string
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  scaleType?: 'linear' | 'log'
  displayMode?: SpectrumDisplayMode
  smoothing?: number
  minDecibels?: number
  maxDecibels?: number
  minFrequency?: number
  maxFrequency?: number
  tiltDbPerOctave?: number
  heatmapTiltDbPerOctave?: number
  tiltReferenceHz?: number
  fftSize?: number
  showSideLine?: boolean
  barDensity?: number
  barGapPercent?: number
  barCornerRadiusPx?: number
  showBarPeaks?: boolean
  capturePeakInfo?: boolean
  onPeakInfo?: (peakInfo: SpectrumPeakInfo | null) => void
  dataSource?: SpectrumAnalyzerDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: SpectrumNativeAnalyzer | null
}

type ResolvedSpectrumAnalyzerOptions = Required<Omit<SpectrumAnalyzerOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>
type SpectrumPointFillResult = {
  pointCount: number
  peakInfo: SpectrumPeakInfo | null
}

type SpectrumRangePeak = {
  rawDb: number
  frequencyHz: number
}

type HeatColor = [number, number, number, number]
type HeatStop = { at: number; color: HeatColor }

const HEATMAP_GAMMA = 1.4
const FFT_SILENCE_DB = -100
const SIDE_LINE_WIDTH_RATIO = 0.75
const PEAK_SELECTION_MAX_DISTANCE_OCTAVES = 0.5
const PEAK_SELECTION_SWITCH_THRESHOLD_DB = 4
const PEAK_SELECTION_LOW_FREQUENCY_BIAS_DB_PER_OCTAVE = 0.75
const PEAK_SELECTION_UPWARD_SWITCH_THRESHOLD_DB = 2
const NOOP_SPECTRUM_PEAK_INFO_CALLBACK = (_peakInfo: SpectrumPeakInfo | null): void => {}

function clampSmoothing(value: number): number {
  return Math.min(0.99, Math.max(0, value))
}

function isLegacyDefaultHeatColors(colors: [string, string, string]): boolean {
  return colors.every((color, index) => {
    const left = parseColorToRgba(color)
    const right = parseColorToRgba(CLASSIC_SPECTRUM_HEAT_COLORS[index])
    return !!left
      && !!right
      && left.r === right.r
      && left.g === right.g
      && left.b === right.b
      && Math.round(left.a * 255) === Math.round(right.a * 255)
  })
}

function resolveHeatColor(color: string, fallback: string): HeatColor {
  const parsed = parseColorToRgba(color) ?? parseColorToRgba(fallback)
  if (!parsed) {
    return [0, 0, 0, 255]
  }
  return [parsed.r, parsed.g, parsed.b, Math.round(parsed.a * 255)]
}

function scaleHeatColor(color: HeatColor, factor: number): HeatColor {
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
    Math.round(color[3] * factor),
  ]
}

function lerpChannel(start: number, end: number, amount: number): number {
  return Math.round(start + ((end - start) * amount))
}

function buildHeatStops(colors: [string, string, string]): HeatStop[] {
  if (isLegacyDefaultHeatColors(colors)) {
    return [
      { at: 0, color: [0, 0, 0, 0] },
      { at: normalizeHeatDb(-80), color: [15, 7, 33, 255] },
      { at: normalizeHeatDb(-70), color: [61, 11, 94, 255] },
      { at: normalizeHeatDb(-60), color: [163, 26, 121, 255] },
      { at: normalizeHeatDb(-45), color: [255, 82, 87, 255] },
      { at: normalizeHeatDb(-35), color: [255, 166, 63, 255] },
      { at: 1, color: [255, 241, 209, 255] },
    ]
  }

  const low = resolveHeatColor(colors[0], CLASSIC_SPECTRUM_HEAT_COLORS[0])
  const mid = resolveHeatColor(colors[1], CLASSIC_SPECTRUM_HEAT_COLORS[1])
  const high = resolveHeatColor(colors[2], CLASSIC_SPECTRUM_HEAT_COLORS[2])

  return [
    { at: 0, color: [0, 0, 0, 0] },
    { at: normalizeHeatDb(-90), color: scaleHeatColor(low, 0.5) },
    { at: normalizeHeatDb(HEAT_LOW_DB), color: low },
    { at: normalizeHeatDb(HEAT_MID_DB), color: mid },
    { at: 1, color: high },
  ]
}

function buildHeatLUT(colors: [string, string, string]): Uint8ClampedArray {
  const heatStops = buildHeatStops(colors)
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255
    let start = heatStops[0]
    let end = heatStops[heatStops.length - 1]
    for (let stopIndex = 0; stopIndex < heatStops.length - 1; stopIndex += 1) {
      if (t <= heatStops[stopIndex + 1].at) {
        start = heatStops[stopIndex]
        end = heatStops[stopIndex + 1]
        break
      }
    }

    const amount = Math.max(0, Math.min(1, (t - start.at) / Math.max(1e-6, end.at - start.at)))
    lut[i * 4] = lerpChannel(start.color[0], end.color[0], amount)
    lut[i * 4 + 1] = lerpChannel(start.color[1], end.color[1], amount)
    lut[i * 4 + 2] = lerpChannel(start.color[2], end.color[2], amount)
    lut[i * 4 + 3] = lerpChannel(start.color[3], end.color[3], amount)
  }
  return lut
}

const defaultOptions: ResolvedSpectrumAnalyzerOptions = {
  lineColor: '#00ffff',
  secondaryLineColor: 'rgba(0, 255, 255, 0.5)',
  lineWidth: 2,
  fillGradient: true,
  heatmapFill: false,
  heatmapSmoothing: 0.5,
  gradientColors: ['rgba(0, 255, 255, 0)', 'rgba(0, 255, 255, 0.3)', 'rgba(138, 43, 226, 0.5)'],
  heatColors: [...CLASSIC_SPECTRUM_HEAT_COLORS],
  heatBaseColor: 'transparent',
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  scaleType: 'log',
  displayMode: DEFAULT_SPECTRUM_DISPLAY_MODE,
  smoothing: 0.9,
  minDecibels: -90,
  maxDecibels: -10,
  minFrequency: 20,
  maxFrequency: 20000,
  tiltDbPerOctave: DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  heatmapTiltDbPerOctave: DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  tiltReferenceHz: 1000,
  fftSize: 2048,
  showSideLine: false,
  barDensity: DEFAULT_SPECTRUM_BAR_DENSITY,
  barGapPercent: DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
  barCornerRadiusPx: DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
  showBarPeaks: DEFAULT_SPECTRUM_SHOW_BAR_PEAKS,
  capturePeakInfo: false,
  onPeakInfo: NOOP_SPECTRUM_PEAK_INFO_CALLBACK,
}

const defaultSpectrumDataSource: SpectrumAnalyzerDataSource = {
  getPendingSpectrumSamples: () => audioEngine.flushPendingSpectrumSamples(),
  getPendingSpectrumStereoSamples: () => audioEngine.flushPendingSpectrumStereoSamples(),
  ...defaultVisualizerSessionSource,
}

export class SpectrumAnalyzer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedSpectrumAnalyzerOptions
  private dataSource: SpectrumAnalyzerDataSource
  private nativeAnalyzer: SpectrumNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized = false
  private sampleRate = 48000
  private lastSampleRate = 0
  private heatLut: Uint8ClampedArray
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private staticLayerKey = ''
  private unsubscribeSessionChange: (() => void) | null = null
  private barConfigurationKey = ''
  private warnedMissingBarFrames = false

  private nativeMagnitudeBuffer = new Float32Array(0)
  private nativeRawMagnitudeBuffer = new Float32Array(0)
  private nativeSideMagnitudeBuffer = new Float32Array(0)
  private heatmapMagnitudeBuffer = new Float32Array(0)
  private nativeBufferedSamples = 0
  private nativeHasSpectrumData = false
  private pushScratch = new Float32Array(0)
  private pushScratchRight = new Float32Array(0)
  private primaryPointX = new Float32Array(0)
  private primaryPointY = new Float32Array(0)
  private heatmapPointY = new Float32Array(0)
  private primaryPointHeatmap = new Float32Array(0)
  private secondaryPointX = new Float32Array(0)
  private secondaryPointY = new Float32Array(0)
  private primaryPointDb = new Float32Array(0)
  private primaryPointFrequency = new Float32Array(0)
  private lastSelectedPeakInfo: SpectrumPeakInfo | null = null

  constructor(canvas: HTMLCanvasElement, options: SpectrumAnalyzerOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = {
      ...defaultOptions,
      ...optionOverrides,
      tiltDbPerOctave: clampSpectrumTiltDbPerOctave(
        optionOverrides.tiltDbPerOctave ?? defaultOptions.tiltDbPerOctave
      ),
      heatmapTiltDbPerOctave: clampSpectrumHeatmapTiltDbPerOctave(
        optionOverrides.heatmapTiltDbPerOctave ?? defaultOptions.heatmapTiltDbPerOctave
      ),
      barDensity: clampSpectrumBarDensity(optionOverrides.barDensity ?? defaultOptions.barDensity),
      barGapPercent: clampSpectrumBarGapPercent(optionOverrides.barGapPercent ?? defaultOptions.barGapPercent),
      barCornerRadiusPx: clampSpectrumBarCornerRadiusPx(
        optionOverrides.barCornerRadiusPx ?? defaultOptions.barCornerRadiusPx
      ),
    }
    this.dataSource = dataSource ?? defaultSpectrumDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? defaultNativeSpectrum : nativeAnalyzer
    this.heatLut = buildHeatLUT(this.options.heatColors)
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      // Spectrum DSP is native-only; stop the loop after one frame when native is
      // unavailable (warned once) rather than spinning — preserves Astra fallback behavior.
      shouldRun: () => this.isNativeAvailable() && this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx

    this.resetAnalyzerBuffers()
    this.initNative()
    this.subscribeToSessionChanges()
  }

  private subscribeToSessionChanges(): void {
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
    }

    this.unsubscribeSessionChange = this.dataSource.subscribeToSessionChanges(() => {
      this.resetState()
    })
  }

  private initNative(): void {
    this.sampleRate = Math.max(1, this.dataSource.getSampleRate())
    this.lastSampleRate = 0

    if (this.isNativeAvailable() && !this.nativeInitialized) {
      this.nativeAnalyzer?.setFFTSize(this.options.fftSize)
      this.nativeAnalyzer?.setSampleRate(this.sampleRate)
      this.nativeAnalyzer?.setSmoothing(this.getNativeSmoothing())
      this.nativeInitialized = true
      console.log(`SpectrumAnalyzer: Using native DSP (${this.sampleRate}Hz)`)
    } else if (!this.isNativeAvailable()) {
      warnNativeUnavailableOnce('SpectrumAnalyzer')
    }
  }

  private ensureMagnitudeBufferSize(): void {
    const length = Math.max(1, Math.floor(this.options.fftSize / 2))
    if (this.nativeMagnitudeBuffer.length !== length) {
      this.nativeMagnitudeBuffer = new Float32Array(length)
    }
    if (this.nativeRawMagnitudeBuffer.length !== length) {
      this.nativeRawMagnitudeBuffer = new Float32Array(length)
    }
    if (this.nativeSideMagnitudeBuffer.length !== length) {
      this.nativeSideMagnitudeBuffer = new Float32Array(length)
    }
    if (this.heatmapMagnitudeBuffer.length !== length) {
      this.heatmapMagnitudeBuffer = new Float32Array(length)
    }
  }

  private resetAnalyzerBuffers(): void {
    this.ensureMagnitudeBufferSize()
    this.nativeMagnitudeBuffer.fill(FFT_SILENCE_DB)
    this.nativeRawMagnitudeBuffer.fill(FFT_SILENCE_DB)
    this.nativeSideMagnitudeBuffer.fill(FFT_SILENCE_DB)
    this.heatmapMagnitudeBuffer.fill(FFT_SILENCE_DB)
    this.nativeBufferedSamples = 0
    this.nativeHasSpectrumData = false
    this.lastSelectedPeakInfo = null
  }

  private isNativeAvailable(): boolean {
    return Boolean(this.nativeAnalyzer) && this.nativeAnalyzer?.isAvailable?.() !== false
  }

  private updateSampleRateIfNeeded(): void {
    const currentRate = Math.max(1, this.dataSource.getSampleRate())
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.sampleRate = currentRate
      this.lastSampleRate = currentRate
      if (this.isNativeAvailable()) {
        this.nativeAnalyzer?.setSampleRate(currentRate)
      }
      console.log(`SpectrumAnalyzer: Sample rate updated to ${currentRate}Hz`)
    }
  }

  private getNativeSmoothing(): number {
    const base = clampSmoothing(this.options.smoothing)
    const fftRatio = Math.max(0.5, this.options.fftSize / 2048)
    return clampSmoothing(Math.pow(base, fftRatio))
  }

  private resetState(): void {
    if (this.isNativeAvailable()) {
      this.nativeAnalyzer?.reset()
    }
    this.resetAnalyzerBuffers()
    this.sampleRate = Math.max(1, this.dataSource.getSampleRate())
    this.lastSampleRate = 0
    this.invalidate()
  }

  setOptions(options: Partial<SpectrumAnalyzerOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, nativeAnalyzer, ...optionUpdates } = options
    const previousOptions = this.options
    const nextOptions = { ...previousOptions, ...optionUpdates }
    if (optionUpdates.tiltDbPerOctave !== undefined) {
      nextOptions.tiltDbPerOctave = clampSpectrumTiltDbPerOctave(optionUpdates.tiltDbPerOctave)
    }
    if (optionUpdates.heatmapTiltDbPerOctave !== undefined) {
      nextOptions.heatmapTiltDbPerOctave = clampSpectrumHeatmapTiltDbPerOctave(optionUpdates.heatmapTiltDbPerOctave)
    }
    if (optionUpdates.barDensity !== undefined) {
      nextOptions.barDensity = clampSpectrumBarDensity(optionUpdates.barDensity)
    }
    if (optionUpdates.barGapPercent !== undefined) {
      nextOptions.barGapPercent = clampSpectrumBarGapPercent(optionUpdates.barGapPercent)
    }
    if (optionUpdates.barCornerRadiusPx !== undefined) {
      nextOptions.barCornerRadiusPx = clampSpectrumBarCornerRadiusPx(optionUpdates.barCornerRadiusPx)
    }

    const fftSizeChanged = nextOptions.fftSize !== previousOptions.fftSize
    const smoothingChanged = nextOptions.smoothing !== previousOptions.smoothing
    const showSideLineChanged = nextOptions.showSideLine !== previousOptions.showSideLine
    const shouldResetForOptions = fftSizeChanged || showSideLineChanged

    const heatColorsChanged = nextOptions.heatColors.some(
      (color, index) => color !== previousOptions.heatColors[index]
    )
    this.options = nextOptions
    if (heatColorsChanged) {
      this.heatLut = buildHeatLUT(this.options.heatColors)
    }
    if (
      nextOptions.barDensity !== previousOptions.barDensity
      || nextOptions.showBarPeaks !== previousOptions.showBarPeaks
      || nextOptions.minFrequency !== previousOptions.minFrequency
      || nextOptions.maxFrequency !== previousOptions.maxFrequency
      || nextOptions.minDecibels !== previousOptions.minDecibels
      || nextOptions.maxDecibels !== previousOptions.maxDecibels
      || nextOptions.tiltDbPerOctave !== previousOptions.tiltDbPerOctave
      || nextOptions.heatmapTiltDbPerOctave !== previousOptions.heatmapTiltDbPerOctave
      || nextOptions.heatmapSmoothing !== previousOptions.heatmapSmoothing
      || nextOptions.tiltReferenceHz !== previousOptions.tiltReferenceHz
      || fftSizeChanged
    ) {
      this.barConfigurationKey = ''
    }
    let didReset = false

    if (nativeAnalyzer !== undefined && nativeAnalyzer !== this.nativeAnalyzer) {
      this.nativeAnalyzer = nativeAnalyzer
      this.nativeInitialized = false
      this.barConfigurationKey = ''
      this.warnedMissingBarFrames = false
      this.initNative()
      this.resetState()
      didReset = true
    }

    if (dataSource && dataSource !== this.dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
      this.resetState()
      didReset = true
    }

    if (this.isNativeAvailable()) {
      if (fftSizeChanged) {
        this.nativeAnalyzer?.setFFTSize(nextOptions.fftSize)
      }
      if (smoothingChanged || fftSizeChanged) {
        this.nativeAnalyzer?.setSmoothing(this.getNativeSmoothing())
      }
    }

    if (shouldResetForOptions && !didReset) {
      this.resetState()
      didReset = true
    }

    this.staticLayerKey = ''
    if (!didReset) {
      this.invalidate()
    }
  }

  start(): void {
    this.frameLoop.start()
  }

  stop(): void {
    this.frameLoop.stop()
    if (this.isNativeAvailable()) {
      this.nativeAnalyzer?.reset()
    }
    this.resetAnalyzerBuffers()
  }

  invalidate(): void {
    this.frameLoop.invalidate()
  }

  resize(): void {
    this.staticLayerKey = ''
    this.barConfigurationKey = ''
    this.invalidate()
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  private getInterpolatedValue(data: Float32Array, index: number): number {
    const i0 = Math.floor(index)
    const i1 = Math.min(i0 + 1, data.length - 1)
    const t = index - i0
    return this.lerp(data[i0], data[i1], t)
  }

  private frequencyAtPosition(t: number, minFrequency: number, maxFrequency: number): number {
    if (this.options.scaleType === 'log') {
      const logMin = Math.log10(minFrequency)
      const logMax = Math.log10(maxFrequency)
      return Math.pow(10, logMin + t * (logMax - logMin))
    }
    return minFrequency + t * (maxFrequency - minFrequency)
  }

  private resolvePeakInRange(
    data: Float32Array,
    startIndex: number,
    endIndex: number,
    binWidth: number,
  ): SpectrumRangePeak {
    const clampedStart = Math.max(0, Math.min(data.length - 1, startIndex))
    const clampedEnd = Math.max(0, Math.min(data.length - 1, endIndex))
    const lo = Math.floor(Math.min(clampedStart, clampedEnd))
    const hi = Math.ceil(Math.max(clampedStart, clampedEnd))

    if (hi <= lo) {
      const rawDb = this.getInterpolatedValue(data, clampedStart)
      return {
        rawDb,
        frequencyHz: Math.max(0, clampedStart * binWidth),
      }
    }

    let peakBin = lo
    let peakDb = Number.NEGATIVE_INFINITY
    for (let i = lo; i <= hi; i += 1) {
      if (data[i] > peakDb) {
        peakDb = data[i]
        peakBin = i
      }
    }

    if (peakBin > 0 && peakBin < data.length - 1) {
      const y1 = data[peakBin - 1]
      const y2 = data[peakBin]
      const y3 = data[peakBin + 1]
      const denominator = y1 - (2 * y2) + y3
      if (Math.abs(denominator) > 1e-9) {
        const offset = Math.max(-0.5, Math.min(0.5, 0.5 * (y1 - y3) / denominator))
        const interpolatedDb = y2 - (0.25 * (y1 - y3) * offset)
        return {
          rawDb: interpolatedDb,
          frequencyHz: Math.max(0, (peakBin + offset) * binWidth),
        }
      }
    }

    return {
      rawDb: peakDb,
      frequencyHz: Math.max(0, peakBin * binWidth),
    }
  }

  private applyTilt(db: number, frequency: number, tiltDbPerOctave = this.options.tiltDbPerOctave): number {
    const safeFreq = Math.max(1, frequency)
    const reference = Math.max(1, this.options.tiltReferenceHz)
    const octaves = Math.log2(safeFreq / reference)
    return db + tiltDbPerOctave * octaves
  }

  private configureNativeBars(minFrequency: number, maxFrequency: number, dpr: number): boolean {
    if (!this.nativeAnalyzer?.supportsBarFrames?.()) {
      if (!this.warnedMissingBarFrames) {
        console.warn('SpectrumAnalyzer: Native addon does not support adaptive bar frames')
        this.warnedMissingBarFrames = true
      }
      return false
    }

    const canvasCssWidth = this.canvas.width / Math.max(1, dpr)
    const barCount = Math.min(512, Math.max(8, Math.round(
      canvasCssWidth * this.options.barDensity / 100
    )))
    const key = [
      barCount,
      minFrequency,
      maxFrequency,
      this.options.minDecibels,
      this.options.maxDecibels,
      this.options.tiltDbPerOctave,
      this.options.heatmapTiltDbPerOctave,
      this.options.tiltReferenceHz,
      this.options.heatmapSmoothing,
      this.options.showBarPeaks,
    ].join(':')
    if (this.barConfigurationKey !== key) {
      this.nativeAnalyzer.configureBars?.({
        barCount,
        minFrequency,
        maxFrequency,
        minDecibels: this.options.minDecibels,
        maxDecibels: this.options.maxDecibels,
        tiltDbPerOctave: this.options.tiltDbPerOctave,
        heatmapTiltDbPerOctave: this.options.heatmapTiltDbPerOctave,
        tiltReferenceHz: this.options.tiltReferenceHz,
        heatmapSmoothing: this.options.heatmapSmoothing,
        showPeaks: this.options.showBarPeaks,
      })
      this.barConfigurationKey = key
    }
    return true
  }

  private renderNativeBars(frame: Float32Array, dpr: number): void {
    const barCount = Math.floor(frame.length / 3)
    if (barCount <= 0) return

    const width = this.canvas.width
    const height = this.canvas.height
    const slotWidth = width / barCount
    const gapWidth = slotWidth * (this.options.barGapPercent / 100)
    const nominalBarWidth = Math.max(Math.min(dpr, slotWidth), slotWidth - gapWidth)
    const shouldSnapBarEdges = this.options.barGapPercent === 0

    for (let index = 0; index < barCount; index += 1) {
      const slotLeft = index * slotWidth
      const slotRight = index === barCount - 1 ? width : (index + 1) * slotWidth
      const nominalX = slotLeft + ((slotWidth - nominalBarWidth) / 2)
      const x = shouldSnapBarEdges ? Math.floor(slotLeft) : nominalX
      const right = shouldSnapBarEdges
        ? Math.min(width, Math.ceil(slotRight))
        : nominalX + nominalBarWidth
      const barWidth = right - x
      const level = Math.max(0, Math.min(1, frame[index * 3]))
      const barHeight = level * height
      if (barHeight > 0) {
        const y = height - barHeight
        const radius = Math.min(
          this.options.barCornerRadiusPx * dpr,
          barWidth / 2,
          barHeight / 2,
        )
        if (this.options.heatmapFill) {
          const heat = Math.max(0, Math.min(1, frame[index * 3 + 1]))
          const lutIndex = Math.round(heat * 255)
          const r = this.heatLut[lutIndex * 4]
          const g = this.heatLut[lutIndex * 4 + 1]
          const b = this.heatLut[lutIndex * 4 + 2]
          this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.88)`
        } else {
          this.ctx.fillStyle = this.options.lineColor
        }
        this.ctx.beginPath()
        this.ctx.roundRect(x, y, barWidth, barHeight, radius)
        this.ctx.fill()
      }

      if (this.options.showBarPeaks) {
        const peak = Math.max(0, Math.min(1, frame[index * 3 + 2]))
        const capThickness = Math.max(1, Math.min(2 * dpr, barWidth, height))
        const capY = Math.max(0, Math.min(height - capThickness, height - (peak * height) - (capThickness / 2)))
        this.ctx.fillStyle = this.options.lineColor
        this.ctx.beginPath()
        this.ctx.roundRect(x, capY, barWidth, capThickness, Math.min(capThickness / 2, barWidth / 2))
        this.ctx.fill()
      }
    }
  }

  private ensurePointBuffers(pointCount: number): void {
    if (this.primaryPointX.length !== pointCount) {
      this.primaryPointX = new Float32Array(pointCount)
      this.primaryPointY = new Float32Array(pointCount)
      this.heatmapPointY = new Float32Array(pointCount)
      this.primaryPointHeatmap = new Float32Array(pointCount)
      this.secondaryPointX = new Float32Array(pointCount)
      this.secondaryPointY = new Float32Array(pointCount)
      this.primaryPointDb = new Float32Array(pointCount)
      this.primaryPointFrequency = new Float32Array(pointCount)
    }
  }

  private recordNativeBufferedSamples(length: number): void {
    if (length <= 0) {
      return
    }
    this.nativeBufferedSamples = Math.min(this.options.fftSize, this.nativeBufferedSamples + length)
  }

  private pushPendingSpectrumChunks(pendingSpectrum: Float32Array[]): number {
    if (pendingSpectrum.length === 0) return 0

    if (pendingSpectrum.length === 1) {
      if (pendingSpectrum[0].length > 0) {
        this.nativeAnalyzer?.pushSamples(pendingSpectrum[0])
        this.recordNativeBufferedSamples(pendingSpectrum[0].length)
      }
      return pendingSpectrum[0].length
    }

    let totalLength = 0
    for (const chunk of pendingSpectrum) {
      totalLength += chunk.length
    }
    if (totalLength === 0) return 0

    if (this.pushScratch.length < totalLength) {
      this.pushScratch = new Float32Array(totalLength)
    }

    const merged = this.pushScratch.length === totalLength
      ? this.pushScratch
      : this.pushScratch.subarray(0, totalLength)

    let offset = 0
    for (const chunk of pendingSpectrum) {
      if (chunk.length > 0) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
    }

    this.nativeAnalyzer?.pushSamples(merged)
    this.recordNativeBufferedSamples(totalLength)
    return totalLength
  }

  private pushPendingSpectrumStereoChunks(pendingSpectrum: SpectrumStereoChunk[]): number {
    if (pendingSpectrum.length === 0) return 0

    if (pendingSpectrum.length === 1) {
      const chunk = pendingSpectrum[0]
      const length = Math.min(chunk.left.length, chunk.right.length)
      if (length > 0) {
        const left = chunk.left.length === length ? chunk.left : chunk.left.subarray(0, length)
        const right = chunk.right.length === length ? chunk.right : chunk.right.subarray(0, length)
        this.nativeAnalyzer?.pushStereoSamples(left, right)
        this.recordNativeBufferedSamples(length)
      }
      return length
    }

    let totalLength = 0
    for (const chunk of pendingSpectrum) {
      totalLength += Math.min(chunk.left.length, chunk.right.length)
    }
    if (totalLength === 0) return 0

    if (this.pushScratch.length < totalLength) {
      this.pushScratch = new Float32Array(totalLength)
    }
    if (this.pushScratchRight.length < totalLength) {
      this.pushScratchRight = new Float32Array(totalLength)
    }

    const mergedLeft = this.pushScratch.length === totalLength
      ? this.pushScratch
      : this.pushScratch.subarray(0, totalLength)
    const mergedRight = this.pushScratchRight.length === totalLength
      ? this.pushScratchRight
      : this.pushScratchRight.subarray(0, totalLength)

    let offset = 0
    for (const chunk of pendingSpectrum) {
      const length = Math.min(chunk.left.length, chunk.right.length)
      if (length > 0) {
        mergedLeft.set(chunk.left.subarray(0, length), offset)
        mergedRight.set(chunk.right.subarray(0, length), offset)
        offset += length
      }
    }

    this.nativeAnalyzer?.pushStereoSamples(mergedLeft, mergedRight)
    this.recordNativeBufferedSamples(totalLength)
    return totalLength
  }

  private clearPendingSpectrumQueues(): void {
    this.dataSource.getPendingSpectrumSamples()
    this.dataSource.getPendingSpectrumStereoSamples()
  }

  private updateSmoothedMagnitudes(
    rawMagnitudes: Float32Array,
    dataLength: number,
    smoothedMagnitudes: Float32Array,
    smoothing: number,
    bypassSmoothing: boolean,
  ): number {
    const count = Math.min(dataLength, rawMagnitudes.length, smoothedMagnitudes.length)
    if (count <= 0) {
      return 0
    }

    const smoothingAmount = clampSmoothing(smoothing)
    for (let index = 0; index < count; index += 1) {
      const rawDb = Number.isFinite(rawMagnitudes[index]) ? rawMagnitudes[index] : FFT_SILENCE_DB
      if (bypassSmoothing) {
        smoothedMagnitudes[index] = rawDb
        continue
      }

      smoothedMagnitudes[index] = smoothingAmount * smoothedMagnitudes[index] + (1 - smoothingAmount) * rawDb
      if (!Number.isFinite(smoothedMagnitudes[index])) {
        smoothedMagnitudes[index] = FFT_SILENCE_DB
      }
    }

    return count
  }

  private fillSpectrumPoints(
    frequencyData: Float32Array,
    dataLength: number,
    width: number,
    height: number,
    minFrequency: number,
    maxFrequency: number,
    nyquist: number,
    tiltDbPerOctave: number,
    xOut: Float32Array,
    yOut: Float32Array,
    heatmapIntensityOut: Float32Array | null,
    capturePeakInfo = false,
  ): SpectrumPointFillResult {
    const bufferLength = Math.min(dataLength, frequencyData.length)
    if (bufferLength <= 0) {
      return { pointCount: 0, peakInfo: null }
    }
    const binWidth = nyquist / bufferLength
    const numPoints = Math.max(2, Math.floor(width))

    for (let index = 0; index < numPoints; index += 1) {
      const t0 = index / (numPoints - 1)
      const t1 = Math.min(1, (index + 1) / (numPoints - 1))
      const x = t0 * width

      const frequency0 = this.frequencyAtPosition(t0, minFrequency, maxFrequency)
      const frequency1 = this.frequencyAtPosition(t1, minFrequency, maxFrequency)
      const centerFrequency = (frequency0 + frequency1) * 0.5
      const bin0 = frequency0 / binWidth
      const bin1 = frequency1 / binWidth
      const centerBin = (bin0 + bin1) * 0.5
      const binSpan = Math.abs(bin1 - bin0)
      const resolvedPeak = (capturePeakInfo || binSpan > 1)
        ? this.resolvePeakInRange(frequencyData, bin0, bin1, binWidth)
        : null
      const rawDb = binSpan <= 1
        ? this.getInterpolatedValue(frequencyData, Math.min(centerBin, bufferLength - 1))
        : (resolvedPeak?.rawDb ?? this.getInterpolatedValue(frequencyData, Math.min(centerBin, bufferLength - 1)))
      const db = this.applyTilt(rawDb, centerFrequency, tiltDbPerOctave)

      const normalized = (db - this.options.minDecibels) / (this.options.maxDecibels - this.options.minDecibels)
      const clampedNormalized = Math.max(0, Math.min(1, normalized))

      xOut[index] = x
      yOut[index] = height - clampedNormalized * height
      if (heatmapIntensityOut) {
        heatmapIntensityOut[index] = Math.pow(normalizeHeatDb(db), HEATMAP_GAMMA)
      }

      if (capturePeakInfo) {
        this.primaryPointDb[index] = db
        this.primaryPointFrequency[index] = resolvedPeak?.frequencyHz ?? centerFrequency
      }
    }

    return {
      pointCount: numPoints,
      peakInfo: capturePeakInfo ? this.selectPeakInfo(numPoints, height) : null,
    }
  }

  private buildPeakInfoAt(index: number, height: number): SpectrumPeakInfo | null {
    if (
      index < 0
      || index >= this.primaryPointDb.length
      || index >= this.primaryPointFrequency.length
      || index >= this.primaryPointX.length
      || index >= this.primaryPointY.length
    ) {
      return null
    }

    const frequencyHz = this.primaryPointFrequency[index]
    const db = this.primaryPointDb[index]
    return {
      db,
      frequencyHz,
      normalizedX: this.primaryPointX[index] / Math.max(1, this.canvas.width),
      normalizedY: this.primaryPointY[index] / Math.max(1, height),
      key: formatSpectrumPitchInfo(resolveSpectrumPitchInfo(frequencyHz)),
    }
  }

  private isLocalPeak(index: number, pointCount: number): boolean {
    const currentDb = this.primaryPointDb[index]
    const previousDb = index > 0
      ? this.primaryPointDb[index - 1]
      : Number.NEGATIVE_INFINITY
    const nextDb = index + 1 < pointCount
      ? this.primaryPointDb[index + 1]
      : Number.NEGATIVE_INFINITY

    return currentDb >= previousDb
      && currentDb >= nextDb
      && (currentDb > previousDb || currentDb > nextDb)
  }

  private getPeakSelectionScore(index: number): number {
    const frequencyHz = this.primaryPointFrequency[index]
    const db = this.primaryPointDb[index]
    if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || !Number.isFinite(db)) {
      return Number.NEGATIVE_INFINITY
    }

    const referenceFrequencyHz = Math.max(1, this.options.minFrequency)
    const octaveOffset = Math.max(0, Math.log2(frequencyHz / referenceFrequencyHz))
    return db - octaveOffset * PEAK_SELECTION_LOW_FREQUENCY_BIAS_DB_PER_OCTAVE
  }

  private isBetterPeakIndex(candidateIndex: number, bestIndex: number): boolean {
    const candidateScore = this.getPeakSelectionScore(candidateIndex)
    const bestScore = this.getPeakSelectionScore(bestIndex)
    if (candidateScore !== bestScore) {
      return candidateScore > bestScore
    }

    const candidateDb = this.primaryPointDb[candidateIndex]
    const bestDb = this.primaryPointDb[bestIndex]
    if (candidateDb !== bestDb) {
      return candidateDb > bestDb
    }

    return this.primaryPointFrequency[candidateIndex] < this.primaryPointFrequency[bestIndex]
  }

  private findBestPeakIndex(candidateIndices: number[]): number {
    let bestIndex = candidateIndices[0]

    for (let index = 1; index < candidateIndices.length; index += 1) {
      const candidateIndex = candidateIndices[index]
      if (this.isBetterPeakIndex(candidateIndex, bestIndex)) {
        bestIndex = candidateIndex
      }
    }

    return bestIndex
  }

  private findBestPointIndex(pointCount: number): number {
    let bestIndex = 0

    for (let index = 1; index < pointCount; index += 1) {
      if (this.isBetterPeakIndex(index, bestIndex)) {
        bestIndex = index
      }
    }

    return bestIndex
  }

  private findBestNearbyPeakIndex(candidateIndices: number[], targetFrequencyHz: number): number {
    let bestIndex = -1

    for (const candidateIndex of candidateIndices) {
      const candidateFrequencyHz = this.primaryPointFrequency[candidateIndex]
      if (!Number.isFinite(candidateFrequencyHz) || candidateFrequencyHz <= 0) {
        continue
      }

      const octaveDistance = Math.abs(Math.log2(candidateFrequencyHz / targetFrequencyHz))
      if (octaveDistance > PEAK_SELECTION_MAX_DISTANCE_OCTAVES) {
        continue
      }

      if (bestIndex === -1 || this.isBetterPeakIndex(candidateIndex, bestIndex)) {
        bestIndex = candidateIndex
      }
    }

    return bestIndex
  }

  private selectPeakInfo(pointCount: number, height: number): SpectrumPeakInfo | null {
    if (pointCount <= 0) {
      this.lastSelectedPeakInfo = null
      return null
    }

    const candidateIndices: number[] = []
    for (let index = 0; index < pointCount; index += 1) {
      if (this.isLocalPeak(index, pointCount)) {
        candidateIndices.push(index)
      }
    }

    if (candidateIndices.length === 0) {
      candidateIndices.push(this.findBestPointIndex(pointCount))
    }

    const strongestIndex = this.findBestPeakIndex(candidateIndices)
    const strongestScore = this.getPeakSelectionScore(strongestIndex)

    const previousPeak = this.lastSelectedPeakInfo
    let selectedIndex = strongestIndex

    if (previousPeak && Number.isFinite(previousPeak.frequencyHz) && previousPeak.frequencyHz > 0) {
      const stickyIndex = this.findBestNearbyPeakIndex(candidateIndices, previousPeak.frequencyHz)

      if (
        stickyIndex !== -1
        && strongestScore < (
          this.getPeakSelectionScore(stickyIndex)
          + PEAK_SELECTION_SWITCH_THRESHOLD_DB
          + (
            this.primaryPointFrequency[strongestIndex] > this.primaryPointFrequency[stickyIndex]
              ? PEAK_SELECTION_UPWARD_SWITCH_THRESHOLD_DB
              : 0
          )
        )
      ) {
        selectedIndex = stickyIndex
      }
    }

    const peakInfo = this.buildPeakInfoAt(selectedIndex, height)
    this.lastSelectedPeakInfo = peakInfo
    return peakInfo
  }

  private emitPeakInfo(peakInfo: SpectrumPeakInfo | null): void {
    if (peakInfo === null) {
      this.lastSelectedPeakInfo = null
    }
    this.options.onPeakInfo(peakInfo)
  }

  private renderHeatmap(xPoints: Float32Array, yPoints: Float32Array, heatmapIntensity: Float32Array, pointCount: number, width: number, height: number): void {
    const baseColor = this.options.heatBaseColor
    const parsedBaseColor = baseColor ? parseColorToRgba(baseColor) : null
    const shouldRenderBaseColor = !!baseColor && baseColor !== 'transparent' && (!parsedBaseColor || parsedBaseColor.a > 0)

    for (let index = 0; index < pointCount; index += 1) {
      const x = Math.floor(xPoints[index])
      const y = yPoints[index]
      const nextX = index < pointCount - 1 ? Math.floor(xPoints[index + 1]) : width
      const columnWidth = Math.max(1, nextX - x)
      const fillHeight = height - y
      if (fillHeight <= 0) {
        continue
      }

      if (shouldRenderBaseColor) {
        this.ctx.fillStyle = baseColor
        this.ctx.fillRect(x, Math.floor(y), columnWidth, Math.ceil(fillHeight))
      }

      const lutIndex = Math.round(heatmapIntensity[index] * 255)
      const r = this.heatLut[lutIndex * 4]
      const g = this.heatLut[lutIndex * 4 + 1]
      const b = this.heatLut[lutIndex * 4 + 2]
      const a = Math.round((this.heatLut[lutIndex * 4 + 3] * heatmapIntensity[index]))
      if (a <= 0) {
        continue
      }

      this.ctx.fillStyle = a >= 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`
      this.ctx.fillRect(x, Math.floor(y), columnWidth, Math.ceil(fillHeight))
    }
  }

  private renderGradientFill(xPoints: Float32Array, yPoints: Float32Array, pointCount: number, width: number, height: number): void {
    this.ctx.beginPath()
    this.ctx.moveTo(xPoints[0], yPoints[0])

    for (let index = 1; index < pointCount; index += 1) {
      this.ctx.lineTo(xPoints[index], yPoints[index])
    }

    this.ctx.lineTo(width, height)
    this.ctx.lineTo(0, height)
    this.ctx.closePath()

    const gradient = this.ctx.createLinearGradient(0, height, 0, 0)
    const colors = this.options.gradientColors
    for (let index = 0; index < colors.length; index += 1) {
      gradient.addColorStop(index / (colors.length - 1), colors[index])
    }

    this.ctx.fillStyle = gradient
    this.ctx.fill()
  }

  private renderStroke(xPoints: Float32Array, yPoints: Float32Array, pointCount: number, color: string, lineWidth: number): void {
    if (pointCount === 0) {
      return
    }

    this.ctx.beginPath()
    this.ctx.moveTo(xPoints[0], yPoints[0])
    for (let index = 1; index < pointCount; index += 1) {
      this.ctx.lineTo(xPoints[index], yPoints[index])
    }

    this.ctx.lineWidth = lineWidth
    this.ctx.strokeStyle = color
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
    this.ctx.stroke()
  }

  private drawFrame = (): void => {
    const { canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1
    if (width <= 0 || height <= 0) {
      return
    }

    this.updateSampleRateIfNeeded()

    const nyquist = this.sampleRate / 2
    const minFrequency = Math.max(1, Math.min(options.minFrequency, nyquist))
    const maxFrequency = Math.max(minFrequency + 1, Math.min(options.maxFrequency, nyquist))

    if (!this.dataSource.isPlaying()) {
      this.clearPendingSpectrumQueues()
      if (this.isNativeAvailable()) {
        this.nativeAnalyzer?.reset()
      }
      this.resetAnalyzerBuffers()
      this.renderStaticLayer(minFrequency, maxFrequency)
      this.emitPeakInfo(null)
      return
    }

    let primaryData: Float32Array | null = null
    let heatmapData: Float32Array | null = null
    let secondaryData: Float32Array | null = null
    let primaryDataLength = 0
    let heatmapDataLength = 0
    let secondaryDataLength = 0

    if (!this.isNativeAvailable()) {
      // Native DSP required; don't touch the sample queues (nothing can process them)
      // and warn once instead of logging every frame.
      warnNativeUnavailableOnce('SpectrumAnalyzer')
      this.renderStaticLayer(minFrequency, maxFrequency)
      this.emitPeakInfo(null)
      return
    }

    if (options.displayMode === 'bars') {
      if (!this.configureNativeBars(minFrequency, maxFrequency, dpr)) {
        this.renderBarNativeUnavailable(minFrequency, maxFrequency, dpr)
        this.emitPeakInfo(null)
        return
      }

      this.pushPendingSpectrumChunks(this.dataSource.getPendingSpectrumSamples())
      const barFrame = this.nativeAnalyzer?.getBarFrame?.() ?? null
      this.renderStaticLayer(minFrequency, maxFrequency)
      if (barFrame && barFrame.length >= 3) {
        this.renderNativeBars(barFrame, dpr)
      }
      this.emitPeakInfo(null)
      return
    }

    const receivedNativeSamples = options.showSideLine
      ? this.pushPendingSpectrumStereoChunks(this.dataSource.getPendingSpectrumStereoSamples())
      : this.pushPendingSpectrumChunks(this.dataSource.getPendingSpectrumSamples())

    this.ensureMagnitudeBufferSize()
    primaryData = this.nativeMagnitudeBuffer
    primaryDataLength = this.nativeAnalyzer?.fillMagnitudes(this.nativeMagnitudeBuffer) ?? 0

    if (receivedNativeSamples > 0 || !this.nativeHasSpectrumData) {
      heatmapDataLength = this.nativeAnalyzer?.fillRawMagnitudes(this.nativeRawMagnitudeBuffer) ?? 0
      if (heatmapDataLength > 0) {
        this.updateSmoothedMagnitudes(
          this.nativeRawMagnitudeBuffer,
          heatmapDataLength,
          this.heatmapMagnitudeBuffer,
          options.heatmapSmoothing,
          this.nativeBufferedSamples < options.fftSize,
        )
        this.nativeHasSpectrumData = true
      }
    } else if (this.nativeHasSpectrumData) {
      heatmapDataLength = this.heatmapMagnitudeBuffer.length
    }

    heatmapData = this.nativeHasSpectrumData ? this.heatmapMagnitudeBuffer : null

    if (options.showSideLine) {
      secondaryData = this.nativeSideMagnitudeBuffer
      secondaryDataLength = this.nativeAnalyzer?.fillSideMagnitudes(this.nativeSideMagnitudeBuffer) ?? 0
    }

    if (!primaryData || primaryDataLength === 0) {
      this.renderStaticLayer(minFrequency, maxFrequency)
      this.emitPeakInfo(null)
      return
    }

    const pointCount = Math.max(2, Math.floor(width))
    this.ensurePointBuffers(pointCount)
    const primaryRender = this.fillSpectrumPoints(
      primaryData,
      primaryDataLength,
      width,
      height,
      minFrequency,
      maxFrequency,
      nyquist,
      options.tiltDbPerOctave,
      this.primaryPointX,
      this.primaryPointY,
      null,
      options.capturePeakInfo,
    )
    const heatmapRender = heatmapData && heatmapDataLength > 0
      ? this.fillSpectrumPoints(
        heatmapData,
        heatmapDataLength,
        width,
        height,
        minFrequency,
        maxFrequency,
        nyquist,
        options.heatmapTiltDbPerOctave,
        this.primaryPointX,
        this.heatmapPointY,
        this.primaryPointHeatmap,
      )
      : { pointCount: 0, peakInfo: null }

    const secondaryRender = secondaryData && secondaryDataLength > 0
      ? this.fillSpectrumPoints(
        secondaryData,
        secondaryDataLength,
        width,
        height,
        minFrequency,
        maxFrequency,
        nyquist,
        options.tiltDbPerOctave,
        this.secondaryPointX,
        this.secondaryPointY,
        null,
      )
      : { pointCount: 0, peakInfo: null }

    this.renderStaticLayer(minFrequency, maxFrequency)

    if (options.heatmapFill && heatmapRender.pointCount > 0) {
      const renderPointCount = Math.min(primaryRender.pointCount, heatmapRender.pointCount)
      this.renderHeatmap(
        this.primaryPointX,
        this.primaryPointY,
        this.primaryPointHeatmap,
        renderPointCount,
        width,
        height,
      )
    } else if (options.fillGradient && primaryRender.pointCount > 0) {
      this.renderGradientFill(this.primaryPointX, this.primaryPointY, primaryRender.pointCount, width, height)
    }

    this.renderStroke(this.primaryPointX, this.primaryPointY, primaryRender.pointCount, options.lineColor, options.lineWidth * dpr)
    if (secondaryRender.pointCount > 0) {
      const secondaryLineWidth = Math.max(dpr, options.lineWidth * SIDE_LINE_WIDTH_RATIO * dpr)
      this.renderStroke(this.secondaryPointX, this.secondaryPointY, secondaryRender.pointCount, options.secondaryLineColor, secondaryLineWidth)
    }

    this.emitPeakInfo(primaryRender.peakInfo)
  }

  private renderStaticLayer(minFrequency: number, maxFrequency: number): void {
    this.ensureStaticLayer(minFrequency, maxFrequency)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.staticLayerCanvas, 0, 0)
  }

  private renderBarNativeUnavailable(minFrequency: number, maxFrequency: number, dpr: number): void {
    this.renderStaticLayer(minFrequency, maxFrequency)
    this.ctx.fillStyle = this.options.gridColor
    this.ctx.font = `${12 * dpr}px monospace`
    this.ctx.textAlign = 'center'
    this.ctx.fillText(
      'Native adaptive bars unavailable',
      this.canvas.width / 2,
      this.canvas.height / 2,
    )
  }

  private ensureStaticLayer(minFrequency: number, maxFrequency: number): void {
    const { canvas, options } = this
    const key = [
      canvas.width,
      canvas.height,
      options.backgroundColor,
      options.showGrid,
      options.gridColor,
      options.scaleType,
      options.minDecibels,
      options.maxDecibels,
      minFrequency,
      maxFrequency,
    ].join(':')

    if (this.staticLayerKey === key) {
      return
    }

    this.staticLayerCanvas.width = canvas.width
    this.staticLayerCanvas.height = canvas.height
    this.staticLayerCtx.clearRect(0, 0, canvas.width, canvas.height)

    if (options.backgroundColor !== 'transparent') {
      this.staticLayerCtx.fillStyle = options.backgroundColor
      this.staticLayerCtx.fillRect(0, 0, canvas.width, canvas.height)
    }

    if (options.showGrid) {
      this.drawGrid(this.staticLayerCtx, minFrequency, maxFrequency)
    }

    this.staticLayerKey = key
  }

  private drawGrid(ctx: CanvasRenderingContext2D, minFrequency: number, maxFrequency: number): void {
    const { canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = dpr

    const dbSteps = [-80, -60, -40, -20, 0]
    ctx.fillStyle = options.gridColor
    ctx.font = `${10 * dpr}px monospace`
    ctx.textAlign = 'left'

    for (const db of dbSteps) {
      const normalized = (db - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const y = height - normalized * height

      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()

      ctx.fillText(`${db}dB`, 4 * dpr, y - 2 * dpr)
    }

    const freqSteps = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
    ctx.textAlign = 'center'

    for (const freq of freqSteps) {
      if (freq < minFrequency || freq > maxFrequency) continue

      let x: number
      if (options.scaleType === 'log') {
        const logMin = Math.log10(minFrequency)
        const logMax = Math.log10(maxFrequency)
        const logFreq = Math.log10(freq)
        x = ((logFreq - logMin) / (logMax - logMin)) * width
      } else {
        x = ((freq - minFrequency) / (maxFrequency - minFrequency)) * width
      }

      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`
      ctx.fillText(label, x, height - 4 * dpr)
    }
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }

    if (this.isNativeAvailable()) {
      this.nativeAnalyzer?.reset()
    }
    this.resetAnalyzerBuffers()
    this.lastSampleRate = 0
    this.emitPeakInfo(null)
  }
}
