import { audioEngine } from '../AudioEngine'
import { vectorscope as nativeVectorscope, isNativeAvailable } from '../native'
import type { VectorscopeMode } from '../../stores/visualizerSettingsStore'
import { transformPoint, drawVectorscopeGridForMode, getVectorscopeLayout } from './vectorscopeGrids'

export interface VectorscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  persistence?: number  // 0.0 (no trail) to 1.0 (infinite trail), default 0.10
  displayPoints?: number  // how many points to request from native, default 4096
  mode?: VectorscopeMode
}

const defaultOptions: Required<VectorscopeOptions> = {
  lineColor: '#00ffff',
  lineWidth: 1.5,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  persistence: 0.10,
  displayPoints: 4096,
  mode: 'lissajous',
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
    const isPolar = options.mode === 'polar-unipolar' || options.mode === 'polar-bipolar'
    const VISUAL_GAIN = isPolar ? 1.2 : 1.5
    const layout = getVectorscopeLayout(width, height, options.mode)
    const centerX = layout.centerX
    const centerY = layout.centerY
    const scale = layout.radius * VISUAL_GAIN

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
      const dpr = window.devicePixelRatio || 1
      drawVectorscopeGridForMode(ctx, width, height, options.gridColor, options.mode, dpr)
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
    const mode = options.mode
    const dpr = window.devicePixelRatio || 1
    const dotSize = options.lineWidth * dpr

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
        // Native returns x=Right, y=Left
        const point = transformPoint(y[i], x[i], mode)
        if (!point) continue

        const px = centerX + point.dx * scale
        const py = centerY - point.dy * scale
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
    const mode = options.mode
    const dpr = window.devicePixelRatio || 1
    const dotSize = options.lineWidth * dpr

    ctx.fillStyle = options.lineColor
    ctx.globalAlpha = 0.8

    for (const chunk of pendingSamples) {
      for (let i = 0; i < chunk.left.length; i++) {
        const point = transformPoint(chunk.left[i], chunk.right[i], mode)
        if (!point) continue

        const px = centerX + point.dx * scale
        const py = centerY - point.dy * scale
        ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize)
      }
    }
    ctx.globalAlpha = 1.0
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
