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
  private detectedPeriod: number = 512
  private filteredBuffer: Float32Array = new Float32Array(0)
  private smoothedOffset: number = 0

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
   * Apply a simple lowpass filter to extract the fundamental frequency
   * This removes high-frequency harmonics that cause false triggers
   */
  private applyLowpassFilter(data: Float32Array): Float32Array {
    const len = data.length
    if (this.filteredBuffer.length !== len) {
      this.filteredBuffer = new Float32Array(len)
    }

    // Simple IIR lowpass filter: y[n] = alpha * x[n] + (1 - alpha) * y[n-1]
    // Lower alpha = more smoothing (lower cutoff frequency)
    // alpha ~0.1 gives roughly 200-300Hz cutoff at 44100Hz sample rate
    const alpha = 0.08

    this.filteredBuffer[0] = data[0]
    for (let i = 1; i < len; i++) {
      this.filteredBuffer[i] = alpha * data[i] + (1 - alpha) * this.filteredBuffer[i - 1]
    }

    // Run filter backwards too for zero phase delay (linear phase)
    for (let i = len - 2; i >= 0; i--) {
      this.filteredBuffer[i] = alpha * this.filteredBuffer[i] + (1 - alpha) * this.filteredBuffer[i + 1]
    }

    return this.filteredBuffer
  }

  /**
   * Detect the fundamental period using autocorrelation on filtered signal
   */
  private detectPeriod(filtered: Float32Array): number {
    const len = filtered.length
    const minPeriod = 22 // ~2000Hz
    const maxPeriod = Math.min(2205, Math.floor(len / 4)) // ~20Hz

    let bestPeriod = this.detectedPeriod
    let bestCorrelation = -Infinity

    for (let period = minPeriod; period < maxPeriod; period++) {
      let correlation = 0
      const samples = Math.min(len - period, 1024)

      for (let i = 0; i < samples; i++) {
        correlation += filtered[i] * filtered[i + period]
      }

      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestPeriod = period
      }
    }

    // Smooth period detection
    this.detectedPeriod = Math.round(this.detectedPeriod * 0.85 + bestPeriod * 0.15)

    return this.detectedPeriod
  }

  /**
   * Find trigger point using lowpass-filtered signal for stable zero-crossing
   * Smooths the offset over time to prevent chaotic jumping
   */
  private findTriggerPoint(data: Float32Array): number {
    // Apply lowpass filter to get clean fundamental for triggering
    const filtered = this.applyLowpassFilter(data)

    // Detect period on filtered signal
    const period = this.detectPeriod(filtered)
    const searchEnd = Math.min(period * 2, Math.floor(data.length / 3))

    // Find all rising zero-crossings on the filtered signal
    const zeroCrossings: number[] = []
    for (let i = 1; i < searchEnd; i++) {
      if (filtered[i - 1] <= 0 && filtered[i] > 0) {
        zeroCrossings.push(i)
      }
    }

    if (zeroCrossings.length === 0) {
      return Math.round(this.smoothedOffset)
    }

    // Find the zero-crossing closest to our current smoothed offset (modulo period)
    // This keeps the display locked to a consistent phase
    const targetPhase = this.smoothedOffset % period
    let bestCrossing = zeroCrossings[0]
    let bestDistance = Infinity

    for (const crossing of zeroCrossings) {
      const crossingPhase = crossing % period
      // Calculate phase distance (wrapping around)
      let distance = Math.abs(crossingPhase - targetPhase)
      distance = Math.min(distance, period - distance)

      if (distance < bestDistance) {
        bestDistance = distance
        bestCrossing = crossing
      }
    }

    // Smooth the offset - heavy smoothing for stability
    this.smoothedOffset = this.smoothedOffset * 0.9 + bestCrossing * 0.1

    return Math.round(this.smoothedOffset)
  }

  dispose(): void {
    this.stop()
    this.detectedPeriod = 512
    this.filteredBuffer = new Float32Array(0)
    this.smoothedOffset = 0
  }
}
