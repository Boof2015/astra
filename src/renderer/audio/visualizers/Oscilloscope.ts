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

  // Pitch detection state
  private detectedPitch: number = 200 // Hz
  private detectedPeriod: number = 220 // samples at 44100Hz

  // Bandpass filter state (biquad)
  private bpX1: number = 0
  private bpX2: number = 0
  private bpY1: number = 0
  private bpY2: number = 0
  private bpB0: number = 0
  private bpB1: number = 0
  private bpB2: number = 0
  private bpA1: number = 0
  private bpA2: number = 0

  private filteredBuffer: Float32Array = new Float32Array(0)
  private lastTriggerIndex: number = 0

  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }
    this.updateBandpassCoefficients(200)
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

  /**
   * Update biquad bandpass filter coefficients for a given center frequency
   * Using peaking EQ style bandpass with Q = 2
   */
  private updateBandpassCoefficients(centerFreq: number): void {
    const sampleRate = 44100
    const Q = 2.0 // Resonance - higher = narrower band
    const omega = (2 * Math.PI * centerFreq) / sampleRate
    const sinOmega = Math.sin(omega)
    const cosOmega = Math.cos(omega)
    const alpha = sinOmega / (2 * Q)

    // Bandpass filter coefficients (constant 0 dB peak gain)
    const b0 = alpha
    const b1 = 0
    const b2 = -alpha
    const a0 = 1 + alpha
    const a1 = -2 * cosOmega
    const a2 = 1 - alpha

    // Normalize
    this.bpB0 = b0 / a0
    this.bpB1 = b1 / a0
    this.bpB2 = b2 / a0
    this.bpA1 = a1 / a0
    this.bpA2 = a2 / a0
  }

  /**
   * Apply bandpass filter to extract the fundamental frequency
   */
  private applyBandpassFilter(data: Float32Array): Float32Array {
    const len = data.length
    if (this.filteredBuffer.length !== len) {
      this.filteredBuffer = new Float32Array(len)
    }

    // Reset filter state for consistent results
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0

    // Forward pass
    for (let i = 0; i < len; i++) {
      const x0 = data[i]
      const y0 = this.bpB0 * x0 + this.bpB1 * x1 + this.bpB2 * x2
                 - this.bpA1 * y1 - this.bpA2 * y2
      this.filteredBuffer[i] = y0
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
    }

    // Backward pass for zero phase delay (linear phase)
    x1 = 0; x2 = 0; y1 = 0; y2 = 0
    for (let i = len - 1; i >= 0; i--) {
      const x0 = this.filteredBuffer[i]
      const y0 = this.bpB0 * x0 + this.bpB1 * x1 + this.bpB2 * x2
                 - this.bpA1 * y1 - this.bpA2 * y2
      this.filteredBuffer[i] = y0
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
    }

    return this.filteredBuffer
  }

  /**
   * Detect pitch using FFT peak finding with parabolic interpolation
   * Note: getFloatFrequencyData returns dB values (negative numbers)
   */
  private detectPitchFromFFT(): void {
    const freqData = audioEngine.getFloatFrequencyData()
    if (freqData.length === 0) return

    const sampleRate = 44100
    const fftSize = freqData.length * 2
    const binWidth = sampleRate / fftSize

    // Find the peak bin (skip DC and very low frequencies)
    // Values are in dB, so higher (less negative) = louder
    const minBin = Math.max(1, Math.floor(40 / binWidth))  // Start at ~40Hz
    const maxBin = Math.min(freqData.length - 1, Math.floor(2000 / binWidth)) // Up to 2000Hz

    let peakBin = minBin
    let peakMag = -200 // Very low dB as starting point

    for (let i = minBin; i <= maxBin; i++) {
      const mag = freqData[i]
      if (mag > peakMag) {
        peakMag = mag
        peakBin = i
      }
    }

    // Only process if we have a reasonably strong signal
    if (peakMag < -80) return

    // Parabolic interpolation for sub-bin accuracy
    let interpBin = peakBin
    if (peakBin > minBin && peakBin < maxBin) {
      const y0 = freqData[peakBin - 1]
      const y1 = freqData[peakBin]
      const y2 = freqData[peakBin + 1]
      const denom = y0 - 2 * y1 + y2
      if (Math.abs(denom) > 0.0001) {
        const delta = 0.5 * (y0 - y2) / denom
        interpBin = peakBin + Math.max(-1, Math.min(1, delta))
      }
    }

    const newPitch = interpBin * binWidth

    // Smooth pitch detection to avoid jitter
    if (newPitch > 30 && newPitch < 3000) {
      this.detectedPitch = this.detectedPitch * 0.85 + newPitch * 0.15
      this.detectedPeriod = Math.round(sampleRate / this.detectedPitch)

      // Update bandpass filter
      this.updateBandpassCoefficients(this.detectedPitch)
    }
  }

  /**
   * Find trigger point using bandpass-filtered signal
   */
  private findTriggerPoint(data: Float32Array): number {
    // Detect pitch from FFT
    this.detectPitchFromFFT()

    // Apply bandpass filter centered on detected pitch
    const filtered = this.applyBandpassFilter(data)

    // Search range: about 2 periods of the detected pitch
    const searchRange = Math.min(this.detectedPeriod * 2, Math.floor(data.length / 3))

    // Find rising zero-crossing on bandpassed signal
    let foundTrigger = -1
    for (let i = 1; i < searchRange; i++) {
      if (filtered[i - 1] <= 0 && filtered[i] > 0) {
        foundTrigger = i
        break
      }
    }

    // Fallback: try finding zero-crossing on raw signal if bandpass didn't work
    if (foundTrigger < 0) {
      for (let i = 1; i < searchRange; i++) {
        if (data[i - 1] <= 0 && data[i] > 0) {
          foundTrigger = i
          break
        }
      }
    }

    // Still nothing? Use last known good position
    if (foundTrigger < 0) {
      return this.lastTriggerIndex
    }

    // Smooth the trigger to avoid jitter
    if (this.lastTriggerIndex === 0) {
      this.lastTriggerIndex = foundTrigger
    } else {
      this.lastTriggerIndex = Math.round(
        this.lastTriggerIndex * 0.7 + foundTrigger * 0.3
      )
    }

    return this.lastTriggerIndex
  }

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
      // Show ~6 cycles of the detected period
      const cyclesToShow = 6
      samplesToShow = Math.min(this.detectedPeriod * cyclesToShow, bufferLength - startIndex)
    }

    samplesToShow = Math.max(100, Math.min(samplesToShow, bufferLength - startIndex))

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

  dispose(): void {
    this.stop()
    this.detectedPitch = 200
    this.detectedPeriod = 220
    this.filteredBuffer = new Float32Array(0)
    this.lastTriggerIndex = 0
  }
}
