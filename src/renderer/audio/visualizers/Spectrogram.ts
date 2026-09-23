import { buildFrequencyGuides, clampFrequencyRangeToNyquist } from '../../../types/frequencyScale'
import { audioEngine } from '../AudioEngine'
import {
  spectrogram as nativeSpectrogram,
  type SpectrogramNativeAnalyzer,
  type SpectrogramNativeOptions,
  type SpectrogramNativeResult,
} from '../native/index'
import { parseColorToRgba, resolveColorToRgb, type RgbaColor } from '../../utils/color'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import {
  DEFAULT_SPECTROGRAM_CLARITY_MODE,
  DEFAULT_SPECTROGRAM_CONTRAST,
  DEFAULT_SPECTROGRAM_ORIENTATION,
  DEFAULT_SPECTROGRAM_SCALE_MODE,
  DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  clampSpectrogramContrast,
  clampSpectrogramScrollSpeed,
  clampSpectrogramTiltDbPerOctave,
  isSpectrogramClarityMode,
  isSpectrogramOrientation,
  isSpectrogramScaleMode,
  type SpectrogramClarityMode,
  type SpectrogramOrientation,
  type SpectrogramScaleMode,
} from '../../../types/spectrogram'
import {
  HEAT_LOW_DB,
  HEAT_MID_DB,
  normalizeHeatDb,
} from './heatScale'

export interface SpectrogramDataSource extends VisualizerSessionSource {
  getPendingSpectrogramSamples: () => Float32Array[]
}

export interface SpectrogramOptions {
  fftSize?: number
  tiltDbPerOctave?: number
  minFrequency?: number
  maxFrequency?: number
  minDecibels?: number
  maxDecibels?: number
  scrollSpeed?: number
  contrast?: number
  clarityMode?: SpectrogramClarityMode
  scaleMode?: SpectrogramScaleMode
  orientation?: SpectrogramOrientation
  colorScheme?: 'heat' | 'mono'
  lineColor?: string
  heatColors?: [string, string, string]
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  labelColor?: string
  dataSource?: SpectrogramDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: SpectrogramNativeAnalyzer | null
}

type ResolvedSpectrogramOptions = Required<Omit<SpectrogramOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

// RGB words are loaded from RGBA bytes; only the alpha shift depends on byte order.
const ALPHA_SHIFT = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 24 : 0

const defaultOptions: ResolvedSpectrogramOptions = {
  fftSize: 4096,
  tiltDbPerOctave: DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE,
  minFrequency: 20,
  maxFrequency: 20000,
  minDecibels: -90,
  maxDecibels: -12,
  scrollSpeed: DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  contrast: DEFAULT_SPECTROGRAM_CONTRAST,
  clarityMode: DEFAULT_SPECTROGRAM_CLARITY_MODE,
  scaleMode: DEFAULT_SPECTROGRAM_SCALE_MODE,
  orientation: DEFAULT_SPECTROGRAM_ORIENTATION,
  colorScheme: 'heat',
  lineColor: '#38bdf8',
  heatColors: ['rgb(15, 7, 33)', 'rgb(163, 26, 121)', 'rgb(255, 241, 209)'],
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.12)',
  labelColor: 'rgba(255, 255, 255, 0.4)',
}

const defaultSpectrogramDataSource: SpectrogramDataSource = {
  getPendingSpectrogramSamples: () => audioEngine.flushPendingSpectrogramSamples(),
  ...defaultVisualizerSessionSource,
}

function resolveClarityMode(value: unknown, fallback: SpectrogramClarityMode): SpectrogramClarityMode {
  return isSpectrogramClarityMode(value) ? value : fallback
}

function resolveScaleMode(value: unknown, fallback: SpectrogramScaleMode): SpectrogramScaleMode {
  return isSpectrogramScaleMode(value) ? value : fallback
}

function resolveOrientation(value: unknown, fallback: SpectrogramOrientation): SpectrogramOrientation {
  return isSpectrogramOrientation(value) ? value : fallback
}

function resolveOptions(base: ResolvedSpectrogramOptions, overrides: Partial<SpectrogramOptions>): ResolvedSpectrogramOptions {
  return {
    fftSize: typeof overrides.fftSize === 'number' ? overrides.fftSize : base.fftSize,
    tiltDbPerOctave: overrides.tiltDbPerOctave === undefined
      ? base.tiltDbPerOctave
      : clampSpectrogramTiltDbPerOctave(overrides.tiltDbPerOctave),
    minFrequency: typeof overrides.minFrequency === 'number' ? overrides.minFrequency : base.minFrequency,
    maxFrequency: typeof overrides.maxFrequency === 'number' ? overrides.maxFrequency : base.maxFrequency,
    minDecibels: typeof overrides.minDecibels === 'number' ? overrides.minDecibels : base.minDecibels,
    maxDecibels: typeof overrides.maxDecibels === 'number' ? overrides.maxDecibels : base.maxDecibels,
    scrollSpeed: overrides.scrollSpeed === undefined
      ? base.scrollSpeed
      : clampSpectrogramScrollSpeed(overrides.scrollSpeed),
    contrast: overrides.contrast === undefined
      ? base.contrast
      : clampSpectrogramContrast(overrides.contrast),
    clarityMode: resolveClarityMode(overrides.clarityMode, base.clarityMode),
    scaleMode: resolveScaleMode(overrides.scaleMode, base.scaleMode),
    orientation: resolveOrientation(overrides.orientation, base.orientation),
    colorScheme: overrides.colorScheme ?? base.colorScheme,
    lineColor: overrides.lineColor ?? base.lineColor,
    heatColors: overrides.heatColors ?? base.heatColors,
    backgroundColor: overrides.backgroundColor ?? base.backgroundColor,
    showGrid: overrides.showGrid ?? base.showGrid,
    gridColor: overrides.gridColor ?? base.gridColor,
    labelColor: overrides.labelColor ?? base.labelColor,
  }
}

type ColorStop = {
  at: number
  color: [number, number, number, number]
}

const LEGACY_DEFAULT_HEAT_COLORS: [string, string, string] = [
  'rgb(15, 7, 33)',
  'rgb(163, 26, 121)',
  'rgb(255, 241, 209)',
]

function isLegacyDefaultHeatColors(colors: [string, string, string]): boolean {
  return colors.every((color, index) => {
    const left = parseColorToRgba(color)
    const right = parseColorToRgba(LEGACY_DEFAULT_HEAT_COLORS[index])
    return !!left
      && !!right
      && left.r === right.r
      && left.g === right.g
      && left.b === right.b
      && Math.round(left.a * 255) === Math.round(right.a * 255)
  })
}

function resolveHeatColor(color: string, fallback: string): [number, number, number, number] {
  const parsed = parseColorToRgba(color) ?? parseColorToRgba(fallback)
  if (!parsed) {
    return [0, 0, 0, 255]
  }
  return [parsed.r, parsed.g, parsed.b, Math.round(parsed.a * 255)]
}

function scaleHeatColor(color: [number, number, number, number], factor: number): [number, number, number, number] {
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
    Math.round(color[3] * factor),
  ]
}

function buildHeatStops(colors: [string, string, string]): ColorStop[] {
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

  const low = resolveHeatColor(colors[0], LEGACY_DEFAULT_HEAT_COLORS[0])
  const mid = resolveHeatColor(colors[1], LEGACY_DEFAULT_HEAT_COLORS[1])
  const high = resolveHeatColor(colors[2], LEGACY_DEFAULT_HEAT_COLORS[2])

  return [
    { at: 0, color: [0, 0, 0, 0] },
    { at: normalizeHeatDb(-90), color: scaleHeatColor(low, 0.5) },
    { at: normalizeHeatDb(HEAT_LOW_DB), color: low },
    { at: normalizeHeatDb(HEAT_MID_DB), color: mid },
    { at: 1, color: high },
  ]
}

function lerpChannel(start: number, end: number, amount: number): number {
  return Math.round(start + ((end - start) * amount))
}

function buildHeatLUT(colors: [string, string, string]): Uint8ClampedArray {
  const heatStops = buildHeatStops(colors)
  const lut = new Uint8ClampedArray(256 * 4)

  for (let index = 0; index < 256; index += 1) {
    const t = index / 255
    let start = heatStops[0]
    let end = heatStops[heatStops.length - 1]

    for (let stopIndex = 0; stopIndex < heatStops.length - 1; stopIndex += 1) {
      const nextStop = heatStops[stopIndex + 1]
      if (t <= nextStop.at) {
        start = heatStops[stopIndex]
        end = nextStop
        break
      }
    }

    const span = Math.max(1e-6, end.at - start.at)
    const amount = Math.max(0, Math.min(1, (t - start.at) / span))
    lut[index * 4] = lerpChannel(start.color[0], end.color[0], amount)
    lut[index * 4 + 1] = lerpChannel(start.color[1], end.color[1], amount)
    lut[index * 4 + 2] = lerpChannel(start.color[2], end.color[2], amount)
    lut[index * 4 + 3] = lerpChannel(start.color[3], end.color[3], amount)
  }

  return lut
}

export class Spectrogram {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedSpectrogramOptions
  private dataSource: SpectrogramDataSource
  private nativeAnalyzer: SpectrogramNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop

  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D

  private waterfallOffset = 0
  private stripImageData: ImageData | null = null
  private stripPixels = new Uint32Array(0)
  private stripColumnCapacity = 0
  private heatLut: Uint8ClampedArray
  private heatRgb = new Uint32Array(256)
  private monoRgb = new Uint32Array(1)
  private monoAlpha = 1

  private gridCanvas = document.createElement('canvas')
  private gridKey = ''
  private lastNativeConfigKey: string | null = null
  private unsubscribeSessionChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: SpectrogramOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = resolveOptions(defaultOptions, optionOverrides)
    this.dataSource = dataSource ?? defaultSpectrogramDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? nativeSpectrogram : nativeAnalyzer
    this.heatLut = buildHeatLUT(this.options.heatColors)
    this.updatePackedColors()
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

    this.ctx.imageSmoothingEnabled = false
    this.waterfallCtx.imageSmoothingEnabled = false

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
    this.nativeAnalyzer?.reset()
    this.lastNativeConfigKey = null
    this.waterfallCtx.clearRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height)
    this.waterfallOffset = 0
    this.invalidate()
  }

  setOptions(options: Partial<SpectrogramOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, nativeAnalyzer, ...optionUpdates } = options
    const previousOptions = this.options
    this.options = resolveOptions(previousOptions, optionUpdates)
    if (this.options.heatColors.some((color, index) => color !== previousOptions.heatColors[index])) {
      this.heatLut = buildHeatLUT(this.options.heatColors)
      this.updatePackedColors()
    } else if (this.options.lineColor !== previousOptions.lineColor) {
      this.updatePackedColors()
    }
    if (this.options.orientation !== previousOptions.orientation) {
      this.clearStripBuffer()
    }

    if (nativeAnalyzer !== undefined && nativeAnalyzer !== this.nativeAnalyzer) {
      this.nativeAnalyzer = nativeAnalyzer
      this.lastNativeConfigKey = null
      this.resetDisplay()
    }

    if (dataSource && dataSource !== this.dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
      this.resetDisplay()
    }

    if (
      this.options.fftSize !== previousOptions.fftSize
      || this.options.scaleMode !== previousOptions.scaleMode
      || this.options.orientation !== previousOptions.orientation
      || this.options.minFrequency !== previousOptions.minFrequency
      || this.options.maxFrequency !== previousOptions.maxFrequency
      || (this.options.clarityMode !== previousOptions.clarityMode
        && (this.options.clarityMode === 'reassigned' || previousOptions.clarityMode === 'reassigned'))
    ) {
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
    this.invalidate()
  }

  private getFrequencyPixelCount(width: number, height: number): number {
    return this.options.orientation === 'vertical' ? width : height
  }

  private clearStripBuffer(): void {
    this.stripImageData = null
    this.stripPixels = new Uint32Array(0)
    this.stripColumnCapacity = 0
  }

  private ensureStripBuffer(columnCount: number, rowCount: number, vertical: boolean, span: number): ImageData {
    const frequencyPixels = vertical ? this.stripImageData?.width : this.stripImageData?.height
    if (!this.stripImageData || frequencyPixels !== rowCount || this.stripColumnCapacity < columnCount) {
      // A single growing buffer avoids allocations as successive FFT batches alternate
      // between (for example) three and four columns. Never retain more than a screen.
      this.stripColumnCapacity = Math.min(span, Math.max(columnCount, this.stripColumnCapacity * 2, 4))
      this.stripImageData = new ImageData(
        vertical ? rowCount : this.stripColumnCapacity,
        vertical ? this.stripColumnCapacity : rowCount,
      )
      this.stripPixels = new Uint32Array(this.stripImageData.data.buffer)
    }
    return this.stripImageData
  }

  // Keep history in place. Only newly arrived columns are uploaded; the cursor
  // determines their chronological position when the history is drawn.
  private appendColumns(display: Float32Array, heat: Float32Array, columnCount: number, rowCount: number): void {
    const width = this.waterfallCanvas.width
    const height = this.waterfallCanvas.height
    if (width <= 0 || height <= 0 || columnCount <= 0 || rowCount <= 0) return

    const vertical = this.options.orientation === 'vertical'
    const span = vertical ? height : width
    const count = Math.min(columnCount, span)
    const skipped = columnCount - count
    const strip = this.ensureStripBuffer(count, rowCount, vertical, span)
    const isHeat = this.options.colorScheme === 'heat'
    const stride = vertical ? 1 : strip.width
    for (let column = 0; column < count; column += 1) {
      const start = (skipped + column) * rowCount
      let destination = vertical ? column * rowCount : column
      for (let row = 0; row < rowCount; row += 1) {
        const intensity = Math.max(0, Math.min(1, display[start + row]))
        const heatIntensity = Math.max(0, Math.min(1, heat[start + row] ?? intensity))
        const lutIndex = Math.round(heatIntensity * 255)
        const alpha = Math.round((isHeat ? this.heatLut[lutIndex * 4 + 3] : 255 * this.monoAlpha) * intensity)
        this.stripPixels[destination] = (isHeat ? this.heatRgb[lutIndex] : this.monoRgb[0]) | (alpha << ALPHA_SHIFT)
        destination += stride
      }
    }

    const offset = (this.waterfallOffset + skipped) % span
    const first = Math.min(count, span - offset)
    if (vertical) {
      this.waterfallCtx.putImageData(strip, 0, offset, 0, 0, rowCount, first)
      if (first < count) this.waterfallCtx.putImageData(strip, 0, -first, 0, first, rowCount, count - first)
    } else {
      this.waterfallCtx.putImageData(strip, offset, 0, 0, 0, first, rowCount)
      if (first < count) this.waterfallCtx.putImageData(strip, -first, 0, first, 0, count - first, rowCount)
    }
    this.waterfallOffset = (offset + count) % span
  }

  private isNativeAnalyzerReady(): boolean {
    if (!this.nativeAnalyzer) {
      return false
    }
    return this.nativeAnalyzer.isAvailable?.() ?? true
  }

  private buildNativeConfig(width: number, height: number): SpectrogramNativeOptions {
    return {
      fftSize: this.options.fftSize,
      sampleRate: Math.max(1, this.dataSource.getSampleRate()),
      rowCount: this.getFrequencyPixelCount(width, height),
      minFrequency: this.options.minFrequency,
      maxFrequency: this.options.maxFrequency,
      minDecibels: this.options.minDecibels,
      maxDecibels: this.options.maxDecibels,
      scrollSpeed: this.options.scrollSpeed,
      contrast: this.options.contrast,
      tiltDbPerOctave: this.options.tiltDbPerOctave,
      clarityMode: this.options.clarityMode,
      scaleMode: this.options.scaleMode,
      orientation: this.options.orientation,
    }
  }

  private configureNativeAnalyzer(config: SpectrogramNativeOptions): boolean {
    if (!this.nativeAnalyzer || config.rowCount <= 0) {
      return false
    }

    const key = [
      config.fftSize,
      config.sampleRate,
      config.rowCount,
      config.minFrequency,
      config.maxFrequency,
      config.minDecibels,
      config.maxDecibels,
      config.scrollSpeed,
      config.contrast,
      config.tiltDbPerOctave,
      config.clarityMode,
      config.scaleMode,
      config.orientation,
    ].join('|')

    if (key !== this.lastNativeConfigKey) {
      this.nativeAnalyzer.configure(config)
      this.lastNativeConfigKey = key
    }

    return true
  }

  private isValidNativeResult(result: SpectrogramNativeResult | null, rowCount: number): result is SpectrogramNativeResult {
    if (!result) {
      return false
    }

    const columnCount = Math.max(0, Math.floor(result.columnCount))
    if (result.rowCount !== rowCount || columnCount !== result.columnCount) {
      return false
    }

    const expectedLength = rowCount * columnCount
    return result.display.length >= expectedLength && result.heat.length >= expectedLength
  }

  private tryDrawNativeColumns(pendingSamples: Float32Array[], width: number, height: number): boolean {
    if (!this.isNativeAnalyzerReady()) {
      return false
    }

    const config = this.buildNativeConfig(width, height)
    if (config.rowCount <= 0) {
      return false
    }

    const results: SpectrogramNativeResult[] = []
    try {
      if (!this.configureNativeAnalyzer(config)) {
        return false
      }

      for (const chunk of pendingSamples) {
        const result = this.nativeAnalyzer?.process(chunk) ?? null
        if (!this.isValidNativeResult(result, config.rowCount)) {
          return false
        }
        if (result.columnCount > 0) {
          results.push(result)
        }
      }
    } catch (error) {
      console.warn('Spectrogram: native analyzer failed', error)
      this.nativeAnalyzer?.reset()
      this.lastNativeConfigKey = null
      return false
    }

    for (const result of results) {
      this.appendColumns(result.display, result.heat, result.columnCount, result.rowCount)
    }

    return true
  }

  private updatePackedColors(): void {
    const heatBytes = new Uint8ClampedArray(this.heatRgb.buffer)
    heatBytes.set(this.heatLut)
    for (let alpha = 3; alpha < heatBytes.length; alpha += 4) heatBytes[alpha] = 0
    const tint: RgbaColor = parseColorToRgba(this.options.lineColor)
      ?? { ...resolveColorToRgb(this.options.lineColor), a: 1 }
    new Uint8ClampedArray(this.monoRgb.buffer).set([tint.r, tint.g, tint.b, 0])
    this.monoAlpha = tint.a
  }

  private drawHistory(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.waterfallCanvas
    if (width <= 0 || height <= 0) return
    const offset = this.waterfallOffset
    if (offset === 0) {
      ctx.drawImage(this.waterfallCanvas, 0, 0)
    } else if (this.options.orientation === 'vertical') {
      ctx.drawImage(this.waterfallCanvas, 0, offset, width, height - offset, 0, 0, width, height - offset)
      ctx.drawImage(this.waterfallCanvas, 0, 0, width, offset, 0, height - offset, width, offset)
    } else {
      ctx.drawImage(this.waterfallCanvas, offset, 0, width - offset, height, 0, 0, width - offset, height)
      ctx.drawImage(this.waterfallCanvas, 0, 0, offset, height, width - offset, 0, offset, height)
    }
  }

  private paintWaterfall(width: number, height: number): void {
    this.ctx.clearRect(0, 0, width, height)
    if (this.options.backgroundColor !== 'transparent') {
      this.ctx.fillStyle = this.options.backgroundColor
      this.ctx.fillRect(0, 0, width, height)
    }
    this.drawHistory(this.ctx)
    this.drawFrequencyGrid(width, height)
  }

  private drawFrequencyGrid(width: number, height: number): void {
    const options = this.options
    if (!options.showGrid) return
    const sampleRate = this.dataSource.getSampleRate()
    const dpr = window.devicePixelRatio || 1
    const key = [width, height, dpr, sampleRate, options.minFrequency, options.maxFrequency,
      options.scaleMode, options.orientation, options.gridColor, options.labelColor].join(':')
    if (key !== this.gridKey) {
      this.gridCanvas.width = width
      this.gridCanvas.height = height
      const ctx = this.gridCanvas.getContext('2d')
      if (!ctx) return
      const vertical = options.orientation === 'vertical'
      const span = vertical ? width : height
      const range = clampFrequencyRangeToNyquist(sampleRate, options.minFrequency, options.maxFrequency)
      const guides = buildFrequencyGuides(range.minFrequency, range.maxFrequency, options.scaleMode, span / dpr)
      ctx.lineWidth = dpr
      ctx.font = `${10 * dpr}px monospace`
      ctx.textBaseline = 'bottom'
      ctx.textAlign = vertical ? 'center' : 'left'
      let previousLabelEnd = -Infinity
      for (const guide of guides) {
        const position = guide.normalizedPosition * span
        ctx.beginPath()
        ctx.strokeStyle = options.gridColor
        ctx.globalAlpha = guide.kind === 'minor' ? 0.28 : 1
        if (vertical) {
          ctx.moveTo(position, 0)
          ctx.lineTo(position, height)
        } else {
          ctx.moveTo(0, height - position)
          ctx.lineTo(width, height - position)
        }
        ctx.stroke()
        ctx.globalAlpha = 1
        if (guide.label) {
          const extent = vertical ? ctx.measureText(guide.label).width / 2 : 6 * dpr
          if (position - extent >= Math.max(0, previousLabelEnd + 4 * dpr) && position + extent <= span) {
            ctx.fillStyle = options.labelColor
            ctx.fillText(guide.label, vertical ? position : 4 * dpr, vertical ? height - 4 * dpr : height - position - 2 * dpr)
            previousLabelEnd = position + extent
          }
        }
      }
      this.gridKey = key
    }
    this.ctx.drawImage(this.gridCanvas, 0, 0)
  }

  private drawFrame = (): void => {
    const width = this.canvas.width
    const height = this.canvas.height
    if (width <= 0 || height <= 0) {
      return
    }

    // Re-set after external resize resets context state
    this.ctx.imageSmoothingEnabled = false

    if (this.waterfallCanvas.width !== width || this.waterfallCanvas.height !== height) {
      const previousCanvas = document.createElement('canvas')
      previousCanvas.width = this.waterfallCanvas.width
      previousCanvas.height = this.waterfallCanvas.height
      const previousCtx = previousCanvas.getContext('2d')
      if (previousCtx) {
        this.drawHistory(previousCtx)
      }

      this.waterfallCanvas.width = width
      this.waterfallCanvas.height = height
      this.waterfallCtx.imageSmoothingEnabled = false
      this.waterfallOffset = 0
      this.clearStripBuffer()

      if (previousCtx && previousCanvas.width > 0 && previousCanvas.height > 0) {
        if (this.options.orientation === 'vertical') {
          // Anchor bottom edge so newest rows stay visible.
          const srcY = Math.max(0, previousCanvas.height - height)
          const srcH = Math.min(previousCanvas.height, height)
          const dstY = Math.max(0, height - previousCanvas.height)
          this.waterfallCtx.drawImage(
            previousCanvas,
            0, srcY, previousCanvas.width, srcH,
            0, dstY, width, srcH
          )
        } else {
          // Anchor right edge so newest columns stay visible.
          const srcX = Math.max(0, previousCanvas.width - width)
          const srcW = Math.min(previousCanvas.width, width)
          const dstX = Math.max(0, width - previousCanvas.width)
          this.waterfallCtx.drawImage(
            previousCanvas,
            srcX, 0, srcW, previousCanvas.height,
            dstX, 0, srcW, height
          )
        }
      }
    }

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingSpectrogramSamples()
      // Freeze waterfall in place instead of blanking
      this.paintWaterfall(width, height)
      return
    }

    const pendingSamples = this.dataSource.getPendingSpectrogramSamples()
    this.tryDrawNativeColumns(pendingSamples, width, height)
    this.paintWaterfall(width, height)
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    this.clearStripBuffer()
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }
  }
}
