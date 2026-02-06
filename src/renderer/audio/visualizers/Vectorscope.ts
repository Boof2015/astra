import { audioEngine } from '../AudioEngine'
import { vectorscope as nativeVectorscope, isNativeAvailable } from '../native'

export interface VectorscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  persistence?: number  // 0.0 (no trail) to 1.0 (infinite trail), default 0.92
  displayPoints?: number  // how many points to request from native, default 4096
}

const defaultOptions: Required<VectorscopeOptions> = {
  lineColor: '#00ffff',
  lineWidth: 1.5,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  persistence: 0.10,
  displayPoints: 4096
}

export class Vectorscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private offscreenCanvas: HTMLCanvasElement
  private offscreenCtx: CanvasRenderingContext2D
  private options: Required<VectorscopeOptions>
  private animationId: number | null = null
  private isRunning: boolean = false
  private nativeInitialized: boolean = false
  private lastSampleRate: number = 0
  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: VectorscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }

    // Create offscreen canvas for persistence/fade
    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenCanvas.width = canvas.width
    this.offscreenCanvas.height = canvas.height
    const offCtx = this.offscreenCanvas.getContext('2d')
    if (!offCtx) throw new Error('Could not get offscreen 2D context')
    this.offscreenCtx = offCtx

    // Initialize native module if available
    this.initNative()

    // Subscribe to track changes for clean reset
    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetDisplay()
    })
  }

  private initNative(): void {
    if (isNativeAvailable() && !this.nativeInitialized) {
      const sampleRate = audioEngine.getSampleRate()
      this.lastSampleRate = sampleRate
      nativeVectorscope.setSampleRate(sampleRate)
      this.nativeInitialized = true
      console.log(`Vectorscope: Using native DSP (${sampleRate}Hz)`)
    } else if (!isNativeAvailable()) {
      console.log('Vectorscope: Using JavaScript fallback')
    }
  }

  private updateSampleRateIfNeeded(): void {
    if (!isNativeAvailable()) return
    const currentRate = audioEngine.getSampleRate()
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.lastSampleRate = currentRate
      nativeVectorscope.setSampleRate(currentRate)
    }
  }

  private resetDisplay(): void {
    // Clear the offscreen canvas and reset native state
    if (isNativeAvailable()) {
      nativeVectorscope.reset()
    }
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height)
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
    // Canvas resize is handled externally; offscreen will sync in draw()
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, offscreenCanvas, offscreenCtx, options } = this
    const width = canvas.width
    const height = canvas.height
    const centerX = width / 2
    const centerY = height / 2
    const scale = Math.min(centerX, centerY) * 0.9

    // Sync offscreen canvas size
    if (offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
      offscreenCanvas.width = width
      offscreenCanvas.height = height
    }

    // Update sample rate if changed
    this.updateSampleRateIfNeeded()

    // ---- PERSISTENCE FADE ----
    // Fade existing content by drawing semi-transparent white with destination-in
    // This progressively reduces alpha of every existing pixel each frame
    offscreenCtx.globalCompositeOperation = 'destination-in'
    offscreenCtx.fillStyle = `rgba(255, 255, 255, ${options.persistence})`
    offscreenCtx.fillRect(0, 0, width, height)
    offscreenCtx.globalCompositeOperation = 'source-over'

    // ---- FLUSH SAMPLES TO NATIVE ----
    const pendingSamples = audioEngine.flushPendingVectorscopeSamples()

    if (isNativeAvailable()) {
      // Push all accumulated stereo chunks to native circular buffer
      for (const chunk of pendingSamples) {
        nativeVectorscope.pushSamples(chunk.left, chunk.right)
      }

      // Get filtered points from native circular buffer
      const pointsResult = nativeVectorscope.getPoints(options.displayPoints)

      if (pointsResult && pointsResult.count > 0) {
        this.drawPoints(offscreenCtx, pointsResult.x, pointsResult.y, pointsResult.count, centerX, centerY, scale)
      }
    } else {
      // JavaScript fallback: draw raw samples from pending chunks
      this.drawFallbackPoints(offscreenCtx, pendingSamples, centerX, centerY, scale)
    }

    // ---- COMPOSITE TO VISIBLE CANVAS ----
    ctx.clearRect(0, 0, width, height)

    // Draw background
    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    // Draw grid underneath
    if (options.showGrid) {
      this.drawGrid()
    }

    // Draw the accumulated vectorscope image on top
    ctx.drawImage(offscreenCanvas, 0, 0)

    this.animationId = requestAnimationFrame(this.draw)
  }

  private drawPoints(
    ctx: CanvasRenderingContext2D,
    x: Float32Array,
    y: Float32Array,
    count: number,
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    const { options } = this
    const dotSize = options.lineWidth

    // Draw dots with age-based opacity: oldest dimmer, newest brighter
    const segments = 8
    const pointsPerSegment = Math.ceil(count / segments)

    for (let seg = 0; seg < segments; seg++) {
      const startIdx = seg * pointsPerSegment
      const endIdx = Math.min((seg + 1) * pointsPerSegment, count)
      if (startIdx >= count) break

      // Older segments (lower seg) are dimmer
      const alpha = 0.15 + 0.85 * (seg / Math.max(segments - 1, 1))

      ctx.fillStyle = options.lineColor
      ctx.globalAlpha = alpha

      for (let i = startIdx; i < endIdx; i++) {
        const px = centerX + x[i] * scale
        const py = centerY - y[i] * scale
        ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize)
      }
    }
    ctx.globalAlpha = 1.0
  }

  private drawFallbackPoints(
    ctx: CanvasRenderingContext2D,
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    if (pendingSamples.length === 0) return

    const { options } = this
    const dotSize = options.lineWidth

    ctx.fillStyle = options.lineColor
    ctx.globalAlpha = 0.8

    for (const chunk of pendingSamples) {
      for (let i = 0; i < chunk.left.length; i++) {
        const px = centerX + chunk.right[i] * scale
        const py = centerY - chunk.left[i] * scale
        ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize)
      }
    }
    ctx.globalAlpha = 1.0
  }

  private drawGrid(): void {
    const { ctx, canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const centerX = width / 2
    const centerY = height / 2
    const radius = Math.min(centerX, centerY) * 0.9

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = 1

    // Draw circular guides
    const circles = [0.25, 0.5, 0.75, 1.0]
    for (const scale of circles) {
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius * scale, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Draw crosshairs
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

    // Diagonal lines (45 degrees)
    ctx.strokeStyle = options.gridColor.replace('0.1', '0.05')

    // +45 degrees
    ctx.beginPath()
    ctx.moveTo(centerX - radius * 0.707, centerY - radius * 0.707)
    ctx.lineTo(centerX + radius * 0.707, centerY + radius * 0.707)
    ctx.stroke()

    // -45 degrees
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

    // Unsubscribe from track changes
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }

    // Reset native module state
    if (isNativeAvailable()) {
      nativeVectorscope.reset()
    }
  }
}
