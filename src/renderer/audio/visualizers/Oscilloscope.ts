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
  private lastPeriod: number = 512

  // Store previous waveform for correlation-based alignment
  private prevWaveform: Float32Array = new Float32Array(0)
  private displaySamples: number = 1024
  private lastOffset: number = 0

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

    let startIndex = 0

    if (options.pitchLock && this.prevWaveform.length > 0) {
      // Reset if lastOffset is invalid for this buffer
      if (this.lastOffset >= bufferLength - this.displaySamples) {
        this.lastOffset = 0
        this.prevWaveform = new Float32Array(0)
        startIndex = this.findSimpleTrigger(timeDomainData)
      } else {
        // Use correlation to find best alignment with previous frame
        startIndex = this.findBestAlignment(timeDomainData)
      }
    } else {
      // First frame or no pitch lock - find a rising zero crossing
      startIndex = this.findSimpleTrigger(timeDomainData)
    }

    // Calculate how many samples to display
    const samplesToShow = Math.min(this.displaySamples, bufferLength - startIndex)

    // Store this waveform section and offset for next frame comparison
    if (options.pitchLock) {
      this.lastOffset = startIndex
      if (this.prevWaveform.length !== samplesToShow) {
        this.prevWaveform = new Float32Array(samplesToShow)
      }
      for (let i = 0; i < samplesToShow; i++) {
        this.prevWaveform[i] = timeDomainData[startIndex + i]
      }
    }

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
   * Find the best alignment offset by correlating current buffer with previous waveform
   * Uses "sticky" alignment - stays at current position unless a much better match is found
   */
  private findBestAlignment(data: Float32Array): number {
    const prevLen = this.prevWaveform.length
    if (prevLen === 0) return this.lastOffset

    // Search window around the last offset
    const searchRadius = 256
    const minOffset = Math.max(0, this.lastOffset - searchRadius)
    const maxOffset = Math.min(data.length - prevLen, this.lastOffset + searchRadius)

    if (maxOffset <= minOffset) return this.lastOffset

    let bestOffset = this.lastOffset
    let bestCorrelation = -Infinity
    let currentCorrelation = -Infinity

    // Search for the offset that best matches the previous waveform
    for (let offset = minOffset; offset < maxOffset; offset++) {
      let correlation = 0
      const compareLen = Math.min(prevLen, data.length - offset)

      for (let i = 0; i < compareLen; i++) {
        correlation += this.prevWaveform[i] * data[offset + i]
      }

      // Track correlation at current position
      if (offset === this.lastOffset) {
        currentCorrelation = correlation
      }

      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestOffset = offset
      }
    }

    // "Sticky" behavior: only move if new position is significantly better (15% threshold)
    // This prevents the waveform from drifting when correlations are similar
    if (currentCorrelation > 0 && bestCorrelation < currentCorrelation * 1.15) {
      return this.lastOffset
    }

    return bestOffset
  }

  /**
   * Simple trigger for first frame - find rising zero crossing
   */
  private findSimpleTrigger(data: Float32Array): number {
    const searchEnd = Math.floor(data.length / 3)

    // Find max amplitude for threshold
    let maxAmp = 0
    for (let i = 0; i < searchEnd; i++) {
      if (Math.abs(data[i]) > maxAmp) maxAmp = Math.abs(data[i])
    }

    if (maxAmp < 0.01) return 0

    const threshold = maxAmp * 0.3

    // Find rising zero crossing after a negative peak
    for (let i = 1; i < searchEnd; i++) {
      if (data[i - 1] < -threshold && data[i] >= 0) {
        return i
      }
    }

    // Fallback: any rising zero crossing
    for (let i = 1; i < searchEnd; i++) {
      if (data[i - 1] < 0 && data[i] >= 0) {
        return i
      }
    }

    return 0
  }

  dispose(): void {
    this.stop()
    this.prevWaveform = new Float32Array(0)
    this.lastOffset = 0
  }
}
