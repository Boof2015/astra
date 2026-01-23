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

  resize(): void {
    // Canvas resize is handled externally
    // This method can be called to trigger a redraw
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    // Get time domain data
    this.timeDomainData = audioEngine.getFloatTimeDomainData()
    const bufferLength = this.timeDomainData.length

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
    if (options.showGrid) {
      this.drawGrid()
    }

    // Find trigger point for pitch lock
    let startIndex = 0
    if (options.pitchLock) {
      startIndex = this.findTriggerPoint()
    }

    // Draw waveform
    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const sliceWidth = width / (bufferLength / 2) // Show half the buffer for better detail
    let x = 0

    for (let i = startIndex; i < startIndex + bufferLength / 2 && i < bufferLength; i++) {
      const sample = this.timeDomainData[i]
      // Map -1 to 1 range to canvas height
      const y = ((1 - sample) / 2) * height

      if (i === startIndex) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
      x += sliceWidth
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

    // Horizontal center line
    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()

    // Vertical center line
    ctx.beginPath()
    ctx.moveTo(width / 2, 0)
    ctx.lineTo(width / 2, height)
    ctx.stroke()

    // Quarter lines
    ctx.strokeStyle = options.gridColor.replace('0.1', '0.05')
    for (let i = 1; i < 4; i++) {
      if (i === 2) continue // Skip center
      // Horizontal
      ctx.beginPath()
      ctx.moveTo(0, (height / 4) * i)
      ctx.lineTo(width, (height / 4) * i)
      ctx.stroke()
      // Vertical
      ctx.beginPath()
      ctx.moveTo((width / 4) * i, 0)
      ctx.lineTo((width / 4) * i, height)
      ctx.stroke()
    }
  }

  private findTriggerPoint(): number {
    const data = this.timeDomainData
    const threshold = 0.0 // Trigger at zero crossing

    // Look for upward zero crossing in the first half of the buffer
    for (let i = 1; i < data.length / 2; i++) {
      if (data[i - 1] <= threshold && data[i] > threshold) {
        return i
      }
    }

    // Fallback: look for any upward crossing
    for (let i = 1; i < data.length / 2; i++) {
      if (data[i - 1] < data[i] && data[i] > 0) {
        return i
      }
    }

    return 0
  }

  dispose(): void {
    this.stop()
  }
}
