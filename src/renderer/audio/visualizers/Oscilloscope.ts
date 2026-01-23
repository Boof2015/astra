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
  private timeDomainData: Float32Array = new Float32Array(0)
  private lastPeriod: number = 512  // Default period estimate

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

    this.timeDomainData = audioEngine.getFloatTimeDomainData()
    const bufferLength = this.timeDomainData.length

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

    let startIndex = 0
    let samplesToShow = Math.floor(bufferLength * 0.5)

    if (options.pitchLock) {
      // Detect period and find stable trigger point
      const period = this.detectPeriodAutocorr()
      if (period > 0) {
        this.lastPeriod = this.lastPeriod * 0.7 + period * 0.3 // Smooth period changes
      }

      // Show ~2.5 periods
      samplesToShow = Math.min(Math.floor(this.lastPeriod * 2.5), Math.floor(bufferLength * 0.6))

      // Find trigger: rising zero crossing AFTER the first positive peak
      // This ensures consistent phase alignment
      startIndex = this.findStableTrigger()
    }

    samplesToShow = Math.min(samplesToShow, bufferLength - startIndex)

    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const sliceWidth = width / samplesToShow

    for (let i = 0; i < samplesToShow; i++) {
      const dataIndex = startIndex + i
      if (dataIndex >= bufferLength) break

      const sample = this.timeDomainData[dataIndex]
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
   * Simple autocorrelation-based period detection
   */
  private detectPeriodAutocorr(): number {
    const data = this.timeDomainData
    const len = data.length

    // Check signal level
    let maxVal = 0
    for (let i = 0; i < len; i++) {
      if (Math.abs(data[i]) > maxVal) maxVal = Math.abs(data[i])
    }
    if (maxVal < 0.01) return 0

    // Search range: ~30Hz to ~2000Hz at 48kHz sample rate
    const minPeriod = 24
    const maxPeriod = Math.min(1600, Math.floor(len / 4))

    let bestPeriod = 0
    let bestCorr = -1

    // Simplified autocorrelation - compare chunks
    for (let period = minPeriod; period < maxPeriod; period += 2) {
      let corr = 0
      const samples = Math.min(period * 2, len - period)

      for (let i = 0; i < samples; i++) {
        corr += data[i] * data[i + period]
      }
      corr /= samples

      if (corr > bestCorr) {
        bestCorr = corr
        bestPeriod = period
      }
    }

    // Refine around best period
    const searchStart = Math.max(minPeriod, bestPeriod - 10)
    const searchEnd = Math.min(maxPeriod, bestPeriod + 10)

    for (let period = searchStart; period <= searchEnd; period++) {
      let corr = 0
      const samples = Math.min(period * 2, len - period)

      for (let i = 0; i < samples; i++) {
        corr += data[i] * data[i + period]
      }
      corr /= samples

      if (corr > bestCorr) {
        bestCorr = corr
        bestPeriod = period
      }
    }

    return bestCorr > maxVal * maxVal * 0.3 ? bestPeriod : 0
  }

  /**
   * Find a stable trigger point by:
   * 1. Finding the first significant positive peak
   * 2. Then finding the rising zero crossing just before it
   * This ensures we always trigger at the same phase
   */
  private findStableTrigger(): number {
    const data = this.timeDomainData
    const len = data.length
    const searchEnd = Math.floor(len / 3)

    // Find max amplitude for threshold
    let maxAmp = 0
    for (let i = 0; i < searchEnd; i++) {
      if (Math.abs(data[i]) > maxAmp) maxAmp = Math.abs(data[i])
    }

    if (maxAmp < 0.01) return 0

    const peakThreshold = maxAmp * 0.7

    // Find first significant positive peak
    let peakIndex = -1
    for (let i = 1; i < searchEnd - 1; i++) {
      if (data[i] > peakThreshold && data[i] > data[i - 1] && data[i] >= data[i + 1]) {
        peakIndex = i
        break
      }
    }

    if (peakIndex < 0) {
      // Fallback: just find any rising zero crossing
      for (let i = 1; i < searchEnd; i++) {
        if (data[i - 1] < 0 && data[i] >= 0) {
          return i
        }
      }
      return 0
    }

    // Find the rising zero crossing just before this peak
    for (let i = peakIndex; i > 0; i--) {
      if (data[i - 1] < 0 && data[i] >= 0) {
        return i
      }
    }

    return 0
  }

  dispose(): void {
    this.stop()
  }
}
