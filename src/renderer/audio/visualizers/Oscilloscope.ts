import { audioEngine } from '../AudioEngine'

export interface OscilloscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  pitchLock?: boolean
}

const defaultOptions: Required<OscilloscopeOptions> = {
  lineColor: '#00ffff',
  lineWidth: 2,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  pitchLock: true
}

export class Oscilloscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: Required<OscilloscopeOptions>
  private animationId: number | null = null
  private isRunning: boolean = false
  private displaySamples: number = 2048
  private detectedPeriod: number = 512 // Smoothed period for stability

  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }
  }

  setOptions(options: Partial<OscilloscopeOptions>): void {
    this.options = { ...this.options, ...options }
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

  resize(): void {}

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    const timeDomainData = audioEngine.getFloatTimeDomainData()
    const bufferLength = timeDomainData.length

    if (bufferLength === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    ctx.clearRect(0, 0, width, height)

    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    if (options.showGrid) {
      this.drawGrid()
    }

    // Find trigger point and determine samples to show
    let startIndex = 0
    let samplesToShow = this.displaySamples

    if (options.pitchLock) {
      startIndex = this.findTriggerPoint(timeDomainData)
      // Show 4-8 cycles of the detected period
      const cyclesToShow = 6
      samplesToShow = Math.min(this.detectedPeriod * cyclesToShow, bufferLength - startIndex)
    }

    samplesToShow = Math.min(samplesToShow, bufferLength - startIndex)

    // Draw waveform
    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const sliceWidth = width / samplesToShow

    for (let i = 0; i < samplesToShow; i++) {
      const dataIndex = startIndex + i
      if (dataIndex >= bufferLength) break

      const sample = timeDomainData[dataIndex]
      const y = ((1 - sample) / 2) * height
      const x = i * sliceWidth

      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    ctx.stroke()
    this.animationId = requestAnimationFrame(this.draw)
  }

  private drawGrid(): void {
    const { ctx, canvas, options } = this
    const width = canvas.width
    const height = canvas.height

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = 1

    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(width / 2, 0)
    ctx.lineTo(width / 2, height)
    ctx.stroke()

    ctx.strokeStyle = options.gridColor.replace('0.1', '0.05')
    for (let i = 1; i < 4; i++) {
      if (i === 2) continue
      ctx.beginPath()
      ctx.moveTo(0, (height / 4) * i)
      ctx.lineTo(width, (height / 4) * i)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo((width / 4) * i, 0)
      ctx.lineTo((width / 4) * i, height)
      ctx.stroke()
    }
  }

  /**
   * Detect the fundamental period using autocorrelation
   */
  private detectPeriod(data: Float32Array): number {
    const len = data.length
    // Search for periods between ~20Hz and ~2000Hz (assuming 44100 sample rate)
    const minPeriod = 22 // ~2000Hz
    const maxPeriod = Math.min(2205, Math.floor(len / 4)) // ~20Hz

    let bestPeriod = this.detectedPeriod
    let bestCorrelation = -Infinity

    // Autocorrelation to find the dominant period
    for (let period = minPeriod; period < maxPeriod; period++) {
      let correlation = 0
      const samples = Math.min(len - period, 1024)

      for (let i = 0; i < samples; i++) {
        correlation += data[i] * data[i + period]
      }

      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestPeriod = period
      }
    }

    // Smooth the period to avoid jitter (80% previous, 20% new)
    this.detectedPeriod = Math.round(this.detectedPeriod * 0.8 + bestPeriod * 0.2)

    return this.detectedPeriod
  }

  /**
   * Find trigger point - rising zero-crossing aligned with the fundamental frequency
   */
  private findTriggerPoint(data: Float32Array): number {
    const period = this.detectPeriod(data)
    const searchEnd = Math.min(period * 2, Math.floor(data.length / 3))

    // Find a rising zero-crossing within one period
    // This ensures we trigger at the same phase of the fundamental
    for (let i = 1; i < searchEnd; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) {
        return i
      }
    }

    return 0
  }

  dispose(): void {
    this.stop()
    this.detectedPeriod = 512
  }
}
