import { audioEngine } from '../AudioEngine'
import { spectrum as nativeSpectrum, isNativeAvailable } from '../native'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import {
  DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  clampSpectrumTiltDbPerOctave,
  clampSpectrumHeatmapTiltDbPerOctave,
} from '../../../types/spectrum'

export interface SpectrumAnalyzerDataSource {
  getPendingSpectrumSamples: () => Float32Array[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface SpectrumAnalyzerOptions {
  lineColor?: string
  lineWidth?: number
  fillGradient?: boolean
  heatmapFill?: boolean
  gradientColors?: string[]  // Bottom to top
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  scaleType?: 'linear' | 'log'
  smoothing?: number
  minDecibels?: number
  maxDecibels?: number
  minFrequency?: number
  maxFrequency?: number
  tiltDbPerOctave?: number
  heatmapTiltDbPerOctave?: number
  tiltReferenceHz?: number
  fftSize?: number
  dataSource?: SpectrumAnalyzerDataSource
  frameScheduler?: FrameScheduler
}

type ResolvedSpectrumAnalyzerOptions = Required<Omit<SpectrumAnalyzerOptions, 'dataSource' | 'frameScheduler'>>

// ---- Heat LUT for heatmap fill (same palette as Spectrogram) ----
type HeatStop = { at: number; color: [number, number, number] }
const HEAT_STOPS: readonly HeatStop[] = [
  { at: 0, color: [0, 0, 0] },
  { at: 0.14, color: [15, 7, 33] },
  { at: 0.32, color: [61, 11, 94] },
  { at: 0.54, color: [163, 26, 121] },
  { at: 0.74, color: [255, 82, 87] },
  { at: 0.9, color: [255, 166, 63] },
  { at: 1, color: [255, 241, 209] },
]

function buildHeatLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let s = HEAT_STOPS[0], e = HEAT_STOPS[HEAT_STOPS.length - 1]
    for (let si = 0; si < HEAT_STOPS.length - 1; si++) {
      if (t <= HEAT_STOPS[si + 1].at) { s = HEAT_STOPS[si]; e = HEAT_STOPS[si + 1]; break }
    }
    const a = Math.max(0, Math.min(1, (t - s.at) / Math.max(1e-6, e.at - s.at)))
    lut[i * 3] = Math.round(s.color[0] + (e.color[0] - s.color[0]) * a)
    lut[i * 3 + 1] = Math.round(s.color[1] + (e.color[1] - s.color[1]) * a)
    lut[i * 3 + 2] = Math.round(s.color[2] + (e.color[2] - s.color[2]) * a)
  }
  return lut
}
const HEAT_LUT = buildHeatLUT()
const HEATMAP_GAMMA = 1.4

const defaultOptions: ResolvedSpectrumAnalyzerOptions = {
  lineColor: '#00ffff',
  lineWidth: 2,
  fillGradient: true,
  heatmapFill: false,
  gradientColors: ['rgba(0, 255, 255, 0)', 'rgba(0, 255, 255, 0.3)', 'rgba(138, 43, 226, 0.5)'],
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  scaleType: 'log',
  smoothing: 0.9,
  minDecibels: -90,
  maxDecibels: -10,
  minFrequency: 20,
  maxFrequency: 20000,
  tiltDbPerOctave: DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE,
  heatmapTiltDbPerOctave: DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
  tiltReferenceHz: 1000,
  fftSize: 2048
}

const defaultSpectrumDataSource: SpectrumAnalyzerDataSource = {
  getPendingSpectrumSamples: () => audioEngine.flushPendingSpectrumSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

export class SpectrumAnalyzer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedSpectrumAnalyzerOptions
  private dataSource: SpectrumAnalyzerDataSource
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized: boolean = false
  private sampleRate: number = 48000
  private lastSampleRate: number = 0
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private staticLayerKey = ''
  private unsubscribePlaybackState: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: SpectrumAnalyzerOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    const { dataSource, frameScheduler, ...optionOverrides } = options
    this.options = {
      ...defaultOptions,
      ...optionOverrides,
      tiltDbPerOctave: clampSpectrumTiltDbPerOctave(
        optionOverrides.tiltDbPerOctave ?? defaultOptions.tiltDbPerOctave
      ),
      heatmapTiltDbPerOctave: clampSpectrumHeatmapTiltDbPerOctave(
        optionOverrides.heatmapTiltDbPerOctave ?? defaultOptions.heatmapTiltDbPerOctave
      ),
    }
    this.dataSource = dataSource ?? defaultSpectrumDataSource
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx
    this.unsubscribePlaybackState = audioEngine.on('stateChange', () => {
      this.invalidate()
    })

    // Initialize native module
    this.initNative()
  }

  private initNative(): void {
    if (isNativeAvailable() && !this.nativeInitialized) {
      this.sampleRate = Math.max(1, this.dataSource.getSampleRate())
      this.lastSampleRate = this.sampleRate
      nativeSpectrum.setFFTSize(this.options.fftSize)
      nativeSpectrum.setSampleRate(this.sampleRate)
      nativeSpectrum.setSmoothing(this.getNativeSmoothing())
      this.nativeInitialized = true
      console.log(`SpectrumAnalyzer: Using native DSP (${this.sampleRate}Hz)`)
    } else if (!isNativeAvailable()) {
      console.error('SpectrumAnalyzer: Native DSP not available!')
    }
  }

  private updateSampleRateIfNeeded(): void {
    if (!isNativeAvailable()) return
    const currentRate = Math.max(1, this.dataSource.getSampleRate())
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.sampleRate = currentRate
      this.lastSampleRate = currentRate
      nativeSpectrum.setSampleRate(currentRate)
      console.log(`SpectrumAnalyzer: Sample rate updated to ${currentRate}Hz`)
    }
  }

  private getNativeSmoothing(): number {
    const base = Math.min(0.99, Math.max(0, this.options.smoothing))
    const fftRatio = Math.max(0.5, this.options.fftSize / 2048)
    return Math.min(0.99, Math.max(0, Math.pow(base, fftRatio)))
  }

  setOptions(options: Partial<SpectrumAnalyzerOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, ...optionUpdates } = options
    const nextOptions = { ...this.options, ...optionUpdates }
    if (optionUpdates.tiltDbPerOctave !== undefined) {
      nextOptions.tiltDbPerOctave = clampSpectrumTiltDbPerOctave(optionUpdates.tiltDbPerOctave)
    }
    if (optionUpdates.heatmapTiltDbPerOctave !== undefined) {
      nextOptions.heatmapTiltDbPerOctave = clampSpectrumHeatmapTiltDbPerOctave(optionUpdates.heatmapTiltDbPerOctave)
    }
    this.options = nextOptions
    if (dataSource) {
      this.dataSource = dataSource
    }

    // Update native module settings
    if (isNativeAvailable()) {
      if (options.fftSize !== undefined) {
        nativeSpectrum.setFFTSize(options.fftSize)
      }
      if (options.smoothing !== undefined || options.fftSize !== undefined) {
        nativeSpectrum.setSmoothing(this.getNativeSmoothing())
      }
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

  // Linear interpolation helper
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  // Get interpolated value from frequency data
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

  private getPeakInRange(data: Float32Array, startIndex: number, endIndex: number): number {
    const clampedStart = Math.max(0, Math.min(data.length - 1, startIndex))
    const clampedEnd = Math.max(0, Math.min(data.length - 1, endIndex))
    const lo = Math.floor(Math.min(clampedStart, clampedEnd))
    const hi = Math.ceil(Math.max(clampedStart, clampedEnd))

    if (hi <= lo) {
      return this.getInterpolatedValue(data, clampedStart)
    }

    let peak = -Infinity
    for (let i = lo; i <= hi; i++) {
      peak = Math.max(peak, data[i])
    }

    return Math.max(
      peak,
      this.getInterpolatedValue(data, clampedStart),
      this.getInterpolatedValue(data, clampedEnd)
    )
  }

  private applyTilt(db: number, frequency: number, tiltDbPerOctave = this.options.tiltDbPerOctave): number {
    const safeFreq = Math.max(1, frequency)
    const reference = Math.max(1, this.options.tiltReferenceHz)
    const octaves = Math.log2(safeFreq / reference)
    return db + tiltDbPerOctave * octaves
  }

  private mergePendingSpectrumChunks(pendingSpectrum: Float32Array[]): Float32Array | null {
    if (pendingSpectrum.length === 0) return null
    if (pendingSpectrum.length === 1) return pendingSpectrum[0]

    let totalLength = 0
    for (const chunk of pendingSpectrum) totalLength += chunk.length

    const monoData = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of pendingSpectrum) {
      monoData.set(chunk, offset)
      offset += chunk.length
    }

    return monoData
  }

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1
    if (width <= 0 || height <= 0) {
      return
    }

    // Get frequency data from native FFT
    if (!isNativeAvailable()) {
      console.error('SpectrumAnalyzer: Native DSP required')
      return
    }

    this.updateSampleRateIfNeeded()

    const nyquist = this.sampleRate / 2
    const minFrequency = Math.max(1, Math.min(options.minFrequency, nyquist))
    const maxFrequency = Math.max(minFrequency + 1, Math.min(options.maxFrequency, nyquist))

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingSpectrumSamples()
      nativeSpectrum.reset()
      this.renderStaticLayer(minFrequency, maxFrequency)
      return
    }

    const pendingSpectrum = this.dataSource.getPendingSpectrumSamples()
    const monoData = this.mergePendingSpectrumChunks(pendingSpectrum)
    if (!monoData) {
      return
    }

    const nativeResult = nativeSpectrum.process(monoData)
    if (!nativeResult) {
      return
    }

    let frequencyData = nativeResult
    const bufferLength = frequencyData.length

    if (bufferLength === 0) {
      return
    }

    this.renderStaticLayer(minFrequency, maxFrequency)

    // Calculate frequency mapping
    const binWidth = nyquist / bufferLength

    // Build one point per horizontal pixel and preserve local peaks.
    const points: { x: number; y: number; heatmapIntensity: number }[] = []
    const numPoints = Math.max(2, Math.floor(width))

    for (let i = 0; i < numPoints; i++) {
      const t0 = i / (numPoints - 1)
      const t1 = Math.min(1, (i + 1) / (numPoints - 1))
      const x = t0 * width

      const frequency0 = this.frequencyAtPosition(t0, minFrequency, maxFrequency)
      const frequency1 = this.frequencyAtPosition(t1, minFrequency, maxFrequency)
      const centerFrequency = (frequency0 + frequency1) * 0.5
      const bin0 = frequency0 / binWidth
      const bin1 = frequency1 / binWidth

      const centerBin = (bin0 + bin1) * 0.5
      const binSpan = Math.abs(bin1 - bin0)

      // Low frequencies can look stepped because each pixel maps to <1 FFT bin.
      // Use sub-bin interpolation there, and keep peak-hold for wider spans.
      const rawDb = binSpan <= 1
        ? this.getInterpolatedValue(frequencyData, Math.min(centerBin, bufferLength - 1))
        : this.getPeakInRange(frequencyData, bin0, bin1)
      const db = this.applyTilt(rawDb, centerFrequency)
      const heatmapDb = this.applyTilt(rawDb, centerFrequency, options.heatmapTiltDbPerOctave)

      // Normalize to 0-1 range
      const normalized = (db - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const heatmapNormalized = (heatmapDb - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const y = height - Math.max(0, Math.min(1, normalized)) * height
      const heatmapIntensity = Math.pow(Math.max(0, Math.min(1, heatmapNormalized)), HEATMAP_GAMMA)

      points.push({ x, y, heatmapIntensity })
    }

    // Draw filled area
    if (options.heatmapFill && points.length > 0) {
      // Per-column heat-colored fill — each frequency colored by its intensity
      for (let i = 0; i < points.length; i++) {
        const x = Math.floor(points[i].x)
        const y = points[i].y
        const nextX = i < points.length - 1 ? Math.floor(points[i + 1].x) : width
        const colWidth = Math.max(1, nextX - x)
        const fillHeight = height - y
        if (fillHeight <= 0) continue

        const intensity = points[i].heatmapIntensity
        const li = Math.round(intensity * 255)
        const r = HEAT_LUT[li * 3]
        const g = HEAT_LUT[li * 3 + 1]
        const b = HEAT_LUT[li * 3 + 2]

        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`
        ctx.fillRect(x, Math.floor(y), colWidth, Math.ceil(fillHeight))
      }
    } else if (options.fillGradient && points.length > 0) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }

      // Complete path for fill
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()

      // Create gradient
      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      const colors = options.gradientColors
      for (let i = 0; i < colors.length; i++) {
        gradient.addColorStop(i / (colors.length - 1), colors[i])
      }

      ctx.fillStyle = gradient
      ctx.fill()
    }

    // Draw the line on top
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y)
    }

    ctx.lineWidth = options.lineWidth * dpr
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()

  }

  private renderStaticLayer(minFrequency: number, maxFrequency: number): void {
    this.ensureStaticLayer(minFrequency, maxFrequency)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.staticLayerCanvas, 0, 0)
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

    // Horizontal dB lines
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

    // Vertical frequency lines (log scale)
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
    if (this.unsubscribePlaybackState) {
      this.unsubscribePlaybackState()
      this.unsubscribePlaybackState = null
    }

    // Reset native module state
    if (isNativeAvailable()) {
      nativeSpectrum.reset()
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.staticLayerCanvas.width = 0
    this.staticLayerCanvas.height = 0
    this.canvas.width = 0
    this.canvas.height = 0
    this.staticLayerKey = ''
    this.lastSampleRate = 0
  }
}
