import { audioEngine } from '../AudioEngine'

export interface VectorscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  fadeAmount?: number  // 0-1, how much to fade previous frame
  colorByIntensity?: boolean
  intensityColors?: string[]  // Low to high intensity
}

const defaultOptions: Required<VectorscopeOptions> = {
  lineColor: '#00ffff',
  lineWidth: 1.5,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  fadeAmount: 0.15,
  colorByIntensity: true,
  intensityColors: ['#00ffff', '#ff00ff', '#ff0066']
}

export class Vectorscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: Required<VectorscopeOptions>
  private animationId: number | null = null
  private isRunning: boolean = false

  constructor(canvas: HTMLCanvasElement, options: VectorscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }
  }

  setOptions(options: Partial<VectorscopeOptions>): void {
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
    const centerX = width / 2
    const centerY = height / 2
    const scale = Math.min(centerX, centerY) * 0.85

    // Get stereo time domain data
    const { left, right } = audioEngine.getStereoTimeDomainData()

    if (left.length === 0 || right.length === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Fade previous frame for trail effect
    if (options.fadeAmount > 0) {
      ctx.fillStyle = options.backgroundColor === 'transparent'
        ? `rgba(10, 10, 15, ${options.fadeAmount})`
        : options.backgroundColor.replace(')', `, ${options.fadeAmount})`).replace('rgb', 'rgba')
      ctx.fillRect(0, 0, width, height)
    } else {
      ctx.clearRect(0, 0, width, height)
      if (options.backgroundColor !== 'transparent') {
        ctx.fillStyle = options.backgroundColor
        ctx.fillRect(0, 0, width, height)
      }
    }

    // Draw grid (only on first frame or when no fade)
    if (options.showGrid && options.fadeAmount === 0) {
      this.drawGrid()
    }

    // Draw the Lissajous pattern as connected lines
    ctx.lineWidth = options.lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Draw in segments for color variation based on intensity
    const segmentSize = 64
    const numSegments = Math.floor(left.length / segmentSize)

    for (let seg = 0; seg < numSegments; seg++) {
      const startIdx = seg * segmentSize
      const endIdx = Math.min(startIdx + segmentSize, left.length)

      ctx.beginPath()

      for (let i = startIdx; i < endIdx; i++) {
        const l = left[i]
        const r = right[i]

        // Standard Lissajous: plot L vs R
        // X = Right channel, Y = Left channel (inverted for canvas)
        // Or Mid/Side: X = (L+R)/2, Y = (L-R)/2
        const x = centerX + r * scale
        const y = centerY - l * scale

        if (i === startIdx) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      }

      // Color by intensity
      if (options.colorByIntensity) {
        // Calculate average intensity for this segment
        let avgIntensity = 0
        for (let i = startIdx; i < endIdx; i++) {
          avgIntensity += Math.sqrt(left[i] * left[i] + right[i] * right[i])
        }
        avgIntensity /= (endIdx - startIdx)

        // Map intensity to color
        const normalizedIntensity = Math.min(1, avgIntensity * 2) // Scale up for visibility
        const colorIndex = Math.floor(normalizedIntensity * (options.intensityColors.length - 1))
        ctx.strokeStyle = options.intensityColors[Math.min(colorIndex, options.intensityColors.length - 1)]
      } else {
        ctx.strokeStyle = options.lineColor
      }

      ctx.stroke()
    }

    // Draw grid on top if using fade (so it stays visible)
    if (options.showGrid && options.fadeAmount > 0) {
      this.drawGrid()
    }

    this.animationId = requestAnimationFrame(this.draw)
  }

  private drawGrid(): void {
    const { ctx, canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const centerX = width / 2
    const centerY = height / 2
    const radius = Math.min(centerX, centerY) * 0.85

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = 1

    // Draw circular guides
    const circles = [0.25, 0.5, 0.75, 1.0]
    for (const scale of circles) {
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * scale, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Draw crosshairs (L/R and phase lines)
    // Vertical line (mono/center)
    ctx.beginPath()
    ctx.moveTo(centerX, centerY - radius)
    ctx.lineTo(centerX, centerY + radius)
    ctx.stroke()

    // Horizontal line
    ctx.beginPath()
    ctx.moveTo(centerX - radius, centerY)
    ctx.lineTo(centerX + radius, centerY)
    ctx.stroke()

    // Diagonal lines (45 degrees - L and R)
    ctx.strokeStyle = options.gridColor.replace('0.1', '0.05')

    // +45 degrees (L only)
    ctx.beginPath()
    ctx.moveTo(centerX - radius * 0.707, centerY - radius * 0.707)
    ctx.lineTo(centerX + radius * 0.707, centerY + radius * 0.707)
    ctx.stroke()

    // -45 degrees (R only)
    ctx.beginPath()
    ctx.moveTo(centerX + radius * 0.707, centerY - radius * 0.707)
    ctx.lineTo(centerX - radius * 0.707, centerY + radius * 0.707)
    ctx.stroke()

    // Labels
    ctx.fillStyle = options.gridColor
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('L', centerX - radius - 12, centerY + 4)
    ctx.fillText('R', centerX + radius + 12, centerY + 4)
    ctx.fillText('+', centerX, centerY - radius - 6)
    ctx.fillText('-', centerX, centerY + radius + 12)
  }

  dispose(): void {
    this.stop()
  }
}
