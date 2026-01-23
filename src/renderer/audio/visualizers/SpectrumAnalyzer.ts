import { audioEngine } from '../AudioEngine'

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
}

const defaultOptions: Required<SpectrumAnalyzerOptions> = {
  lineColor: '#00ffff',
  lineWidth: 2,
  fillGradient: true,
  gradientColors: ['rgba(0, 255, 255, 0)', 'rgba(0, 255, 255, 0.3)', 'rgba(138, 43, 226, 0.5)'],
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  scaleType: 'log',
  smoothing: 0.8,
  minDecibels: -90,
  maxDecibels: -10,
  minFrequency: 20,
  maxFrequency: 20000
}

export class SpectrumAnalyzer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: Required<SpectrumAnalyzerOptions>
  private animationId: number | null = null
  private isRunning: boolean = false
  private smoothedData: Float32Array = new Float32Array(0)

  constructor(canvas: HTMLCanvasElement, options: SpectrumAnalyzerOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }
  }

  setOptions(options: Partial<SpectrumAnalyzerOptions>): void {
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
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    // Get frequency data (in dB, -Infinity to 0)
    const frequencyData = audioEngine.getFloatFrequencyData()
    const bufferLength = frequencyData.length

    if (bufferLength === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Initialize smoothed data if needed
    if (this.smoothedData.length !== bufferLength) {
      this.smoothedData = new Float32Array(bufferLength)
      this.smoothedData.fill(options.minDecibels)
    }

    // Apply smoothing
    for (let i = 0; i < bufferLength; i++) {
      this.smoothedData[i] = this.smoothedData[i] * options.smoothing +
                             frequencyData[i] * (1 - options.smoothing)
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

    // Calculate frequency bin info
    const analyser = audioEngine.analyser
    const sampleRate = analyser ? 48000 : 48000 // Fallback if not available
    const binWidth = sampleRate / (bufferLength * 2)

    // Build path for the spectrum line
    ctx.beginPath()

    const points: { x: number; y: number }[] = []
    const numPoints = Math.min(width, 512) // Limit points for performance

    for (let i = 0; i < numPoints; i++) {
      const x = i / (numPoints - 1) * width

      // Map x position to frequency
      let frequency: number
      if (options.scaleType === 'log') {
        const logMin = Math.log10(options.minFrequency)
        const logMax = Math.log10(options.maxFrequency)
        frequency = Math.pow(10, logMin + (i / numPoints) * (logMax - logMin))
      } else {
        frequency = options.minFrequency + (i / numPoints) * (options.maxFrequency - options.minFrequency)
      }

      // Convert frequency to bin index
      const binIndex = Math.round(frequency / binWidth)
      const clampedIndex = Math.max(0, Math.min(bufferLength - 1, binIndex))

      // Get dB value and normalize to 0-1
      const db = this.smoothedData[clampedIndex]
      const normalized = (db - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const y = height - Math.max(0, Math.min(1, normalized)) * height

      points.push({ x, y })

      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    // Draw fill gradient below the line
    if (options.fillGradient && points.length > 0) {
      // Complete the path for filling
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

      // Redraw the line on top
      ctx.beginPath()
      for (let i = 0; i < points.length; i++) {
        if (i === 0) {
          ctx.moveTo(points[i].x, points[i].y)
        } else {
          ctx.lineTo(points[i].x, points[i].y)
        }
      }
    }

    // Stroke the line
    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()

    this.animationId = requestAnimationFrame(this.draw)
  }

  private drawGrid(): void {
    const { ctx, canvas, options } = this
    const width = canvas.width
    const height = canvas.height

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = 1

    // Horizontal dB lines
    const dbSteps = [-80, -60, -40, -20, 0]
    ctx.fillStyle = options.gridColor
    ctx.font = '10px monospace'
    ctx.textAlign = 'left'

    for (const db of dbSteps) {
      const normalized = (db - options.minDecibels) / (options.maxDecibels - options.minDecibels)
      const y = height - normalized * height

      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()

      // Label
      ctx.fillText(`${db}dB`, 4, y - 2)
    }

    // Vertical frequency lines (log scale)
    const freqSteps = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
    ctx.textAlign = 'center'

    for (const freq of freqSteps) {
      if (freq < options.minFrequency || freq > options.maxFrequency) continue

      let x: number
      if (options.scaleType === 'log') {
        const logMin = Math.log10(options.minFrequency)
        const logMax = Math.log10(options.maxFrequency)
        const logFreq = Math.log10(freq)
        x = ((logFreq - logMin) / (logMax - logMin)) * width
      } else {
        x = ((freq - options.minFrequency) / (options.maxFrequency - options.minFrequency)) * width
      }

      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      // Label
      const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`
      ctx.fillText(label, x, height - 4)
    }
  }

  dispose(): void {
    this.stop()
  }
}
