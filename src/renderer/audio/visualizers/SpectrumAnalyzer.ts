import { audioEngine } from '../AudioEngine'
import { spectrum as nativeSpectrum, isNativeAvailable } from '../native'

export interface SpectrumAnalyzerDataSource {
  getPendingSpectrumSamples: () => Float32Array[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface SpectrumAnalyzerOptions {
  lineColor?: string
  lineWidth?: number
  fillGradient?: boolean
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
  tiltReferenceHz?: number
  fftSize?: number
  dataSource?: SpectrumAnalyzerDataSource
}

type ResolvedSpectrumAnalyzerOptions = Required<Omit<SpectrumAnalyzerOptions, 'dataSource'>>

const defaultOptions: ResolvedSpectrumAnalyzerOptions = {
  lineColor: '#00ffff',
  lineWidth: 2,
  fillGradient: true,
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
  tiltDbPerOctave: 2.0,
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
  private animationId: number | null = null
  private isRunning: boolean = false
  private nativeInitialized: boolean = false
  private sampleRate: number = 48000
  private lastSampleRate: number = 0

  constructor(canvas: HTMLCanvasElement, options: SpectrumAnalyzerOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    const { dataSource, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultSpectrumDataSource

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
    const { dataSource, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
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
    // Canvas resize is handled externally
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

  private applyTilt(db: number, frequency: number): number {
    const safeFreq = Math.max(1, frequency)
    const reference = Math.max(1, this.options.tiltReferenceHz)
    const octaves = Math.log2(safeFreq / reference)
    return db + this.options.tiltDbPerOctave * octaves
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

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1
    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Get frequency data from native FFT
    if (!isNativeAvailable()) {
      console.error('SpectrumAnalyzer: Native DSP required')
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    this.updateSampleRateIfNeeded()

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingSpectrumSamples()
      nativeSpectrum.reset()

      ctx.clearRect(0, 0, width, height)
      if (options.backgroundColor !== 'transparent') {
        ctx.fillStyle = options.backgroundColor
        ctx.fillRect(0, 0, width, height)
      }

      const nyquist = this.sampleRate / 2
      const minFrequency = Math.max(1, Math.min(options.minFrequency, nyquist))
      const maxFrequency = Math.max(minFrequency + 1, Math.min(options.maxFrequency, nyquist))
      if (options.showGrid) {
        this.drawGrid(minFrequency, maxFrequency)
      }

      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const pendingSpectrum = this.dataSource.getPendingSpectrumSamples()
    const monoData = this.mergePendingSpectrumChunks(pendingSpectrum)
    if (!monoData) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const nativeResult = nativeSpectrum.process(monoData)
    if (!nativeResult) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    let frequencyData = nativeResult
    const bufferLength = frequencyData.length

    if (bufferLength === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Clear canvas
    ctx.clearRect(0, 0, width, height)

    // Draw background if not transparent
    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    // Draw grid
    const nyquist = this.sampleRate / 2
    const minFrequency = Math.max(1, Math.min(options.minFrequency, nyquist))
    const maxFrequency = Math.max(minFrequency + 1, Math.min(options.maxFrequency, nyquist))
    if (options.showGrid) {
      this.drawGrid(minFrequency, maxFrequency)
    }

    // Calculate frequency mapping
    const binWidth = nyquist / bufferLength

    // Build one point per horizontal pixel and preserve local peaks.
    const points: { x: number; y: number }[] = []
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

      // Normalize to 0-1 range
      const normalized = (db - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const y = height - Math.max(0, Math.min(1, normalized)) * height

      points.push({ x, y })
    }

    // Draw filled area with gradient
    if (options.fillGradient && points.length > 0) {
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

    this.animationId = requestAnimationFrame(this.draw)
  }

  private drawGrid(minFrequency: number, maxFrequency: number): void {
    const { ctx, canvas, options } = this
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

    // Reset native module state
    if (isNativeAvailable()) {
      nativeSpectrum.reset()
    }
    this.lastSampleRate = 0
  }
}
