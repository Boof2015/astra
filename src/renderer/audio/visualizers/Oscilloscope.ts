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

  // State for stable triggering
  private lastTrigger: number = 0
  private filteredBuffer: Float32Array = new Float32Array(0)

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

  /**
   * Bidirectional IIR lowpass filter for zero phase delay
   */
  private lowpass(data: Float32Array): Float32Array {
    const len = data.length
    if (this.filteredBuffer.length !== len) {
      this.filteredBuffer = new Float32Array(len)
    }

    // IIR lowpass: alpha ~0.05 gives good bass extraction
    const alpha = 0.05

    // Forward pass
    this.filteredBuffer[0] = data[0]
    for (let i = 1; i < len; i++) {
      this.filteredBuffer[i] = alpha * data[i] + (1 - alpha) * this.filteredBuffer[i - 1]
    }

    // Backward pass for zero phase delay
    for (let i = len - 2; i >= 0; i--) {
      this.filteredBuffer[i] = alpha * this.filteredBuffer[i] + (1 - alpha) * this.filteredBuffer[i + 1]
    }

    return this.filteredBuffer
  }

  /**
   * Find trigger point - rising zero-crossing on lowpass filtered signal
   * with smoothing to reduce frame-to-frame jitter
   */
  private findTrigger(data: Float32Array): number {
    const filtered = this.lowpass(data)
    const searchEnd = Math.floor(data.length / 2)

    // Find first rising zero-crossing
    let newTrigger = 0
    for (let i = 1; i < searchEnd; i++) {
      if (filtered[i - 1] < 0 && filtered[i] >= 0) {
        newTrigger = i
        break
      }
    }

    // Smooth the trigger position to reduce jitter
    // But allow it to snap if the difference is large (frequency changed)
    const diff = Math.abs(newTrigger - this.lastTrigger)
    if (diff > 100 || this.lastTrigger === 0) {
      // Large change or first frame - snap immediately
      this.lastTrigger = newTrigger
    } else {
      // Small change - smooth it
      this.lastTrigger = Math.round(this.lastTrigger * 0.8 + newTrigger * 0.2)
    }

    return this.lastTrigger
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

    // Find trigger point
    let startIndex = 0
    if (options.pitchLock) {
      startIndex = this.findTrigger(timeDomainData)
    }

    // Show more samples for multi-cycle view (like MiniMeters "multi" mode)
    const samplesToShow = Math.min(4096, bufferLength - startIndex)

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
    this.lastTrigger = 0
    this.filteredBuffer = new Float32Array(0)
  }
}
