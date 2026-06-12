import { audioEngine } from '../AudioEngine'
import { vectorscope as nativeVectorscope, isNativeAvailable } from '../native/index'
import { createStereoSilenceChunk, isPlaybackAnalyzerActive } from '../visualizerSilence'
import type { VectorscopeMode } from '../../stores/visualizerSettingsStore'
import { transformPoint, drawVectorscopeGridForMode, getVectorscopeLayout } from './vectorscopeGrids'
import { MultibandSplitter, MultibandBuffer, BAND_COLORS } from './multibandSplitter'
import { getCanvasBackingPixelRatio } from '../../utils/canvasSizing'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'

export interface VectorscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  persistence?: number  // 0.0 (no trail) to 1.0 (infinite trail), default 0.10
  displayPoints?: number  // how many points to request from native, default 4096
  mode?: VectorscopeMode
  multiband?: boolean
  frameScheduler?: FrameScheduler
}

const defaultOptions: Required<Omit<VectorscopeOptions, 'frameScheduler'>> = {
  lineColor: '#00ffff',
  lineWidth: 1.5,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  persistence: 0.10,
  displayPoints: 4096,
  mode: 'lissajous',
  multiband: false,
}

const BAND_ORDER = ['low', 'mid', 'high'] as const

export class Vectorscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private offscreenCanvas: HTMLCanvasElement
  private offscreenCtx: CanvasRenderingContext2D
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private options: Required<Omit<VectorscopeOptions, 'frameScheduler'>>
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized: boolean = false
  private lastSampleRate: number = 0
  private unsubscribeTrackChange: (() => void) | null = null
  private unsubscribePlaybackState: (() => void) | null = null
  private splitter: MultibandSplitter = new MultibandSplitter()
  private multibandBuffer: MultibandBuffer = new MultibandBuffer()
  private staticLayerKey = ''

  constructor(canvas: HTMLCanvasElement, options: VectorscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    const { frameScheduler, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => isPlaybackAnalyzerActive(audioEngine.playbackState),
      onFrame: this.drawFrame,
    })

    // Create offscreen canvas for persistence/fade
    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenCanvas.width = canvas.width
    this.offscreenCanvas.height = canvas.height
    const offCtx = this.offscreenCanvas.getContext('2d')
    if (!offCtx) throw new Error('Could not get offscreen 2D context')
    this.offscreenCtx = offCtx
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get static offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx

    // Initialize native module if available
    this.initNative()

    // Subscribe to track changes for clean reset
    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetDisplay()
    })
    this.unsubscribePlaybackState = audioEngine.on('stateChange', () => {
      this.invalidate()
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
    const currentRate = audioEngine.getSampleRate()
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.lastSampleRate = currentRate
      if (isNativeAvailable()) {
        nativeVectorscope.setSampleRate(currentRate)
      }
      this.splitter.configure(currentRate)
    }
  }

  private resetDisplay(): void {
    // Clear the offscreen canvas and reset native state
    if (isNativeAvailable()) {
      nativeVectorscope.reset()
    }
    this.splitter.reset()
    this.multibandBuffer.reset()
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height)
    this.invalidate()
  }

  setOptions(options: Partial<VectorscopeOptions>): void {
    const { frameScheduler: _frameScheduler, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    this.staticLayerKey = ''
    this.invalidate()
  }

  start(): void {
    this.frameLoop.start()
  }

  stop(): void {
    this.frameLoop.stop()
  }

  invalidate(): void {
    this.frameLoop.invalidate()
  }

  resize(): void {
    // Canvas resize is handled externally; offscreen will sync in draw()
    this.staticLayerKey = ''
    this.invalidate()
  }

  private drawFrame = (): void => {
    const { canvas, ctx, offscreenCanvas, offscreenCtx, options } = this
    const width = canvas.width
    const height = canvas.height
    if (width <= 0 || height <= 0) return
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

    const playbackState = audioEngine.playbackState
    const isPlaying = playbackState === 'playing'
    const isActive = isPlaybackAnalyzerActive(playbackState)

    if (!isActive) {
      audioEngine.flushPendingVectorscopeSamples()
      this.renderStaticLayer()
      ctx.drawImage(offscreenCanvas, 0, 0)
      return
    }

    // ---- PERSISTENCE FADE ----
    offscreenCtx.globalCompositeOperation = 'destination-in'
    offscreenCtx.fillStyle = `rgba(255, 255, 255, ${options.persistence})`
    offscreenCtx.fillRect(0, 0, width, height)
    offscreenCtx.globalCompositeOperation = 'source-over'

    // ---- FLUSH SAMPLES ----
    const pendingSamples = isPlaying
      ? audioEngine.flushPendingVectorscopeSamples()
      : (() => {
          audioEngine.flushPendingVectorscopeSamples()
          return [createStereoSilenceChunk(audioEngine.getSampleRate())]
        })()

    if (options.multiband) {
      // Multiband path: split into 3 bands, render each with its own color
      this.drawMultibandPoints(offscreenCtx, pendingSamples, centerX, centerY, scale)
    } else if (isNativeAvailable()) {
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
    this.renderStaticLayer()

    // Draw the accumulated vectorscope image on top
    ctx.drawImage(offscreenCanvas, 0, 0)
  }

  private renderStaticLayer(): void {
    this.ensureStaticLayer()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.staticLayerCanvas, 0, 0)
  }

  private ensureStaticLayer(): void {
    const { canvas, options } = this
    const key = [
      canvas.width,
      canvas.height,
      options.backgroundColor,
      options.showGrid,
      options.gridColor,
      options.mode,
    ].join(':')

    if (this.staticLayerKey === key) {
      return
    }

    this.staticLayerCanvas.width = canvas.width
    this.staticLayerCanvas.height = canvas.height
    this.staticLayerCtx.clearRect(0, 0, canvas.width, canvas.height)

    if (options.backgroundColor !== 'transparent') {
      this.staticLayerCtx.fillStyle = options.backgroundColor
      this.staticLayerCtx.fillRect(0, 0, canvas.width, canvas.height)
    }

    if (options.showGrid) {
      const dpr = getCanvasBackingPixelRatio(canvas)
      drawVectorscopeGridForMode(this.staticLayerCtx, canvas.width, canvas.height, options.gridColor, options.mode, dpr)
    }

    this.staticLayerKey = key
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
    const dpr = getCanvasBackingPixelRatio(this.canvas)
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
    const dpr = getCanvasBackingPixelRatio(this.canvas)
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

  private drawMultibandPoints(
    ctx: CanvasRenderingContext2D,
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    const { options } = this
    const mode = options.mode
    const dpr = getCanvasBackingPixelRatio(this.canvas)
    const dotSize = options.lineWidth * dpr

    // Ensure splitter is configured
    const sampleRate = audioEngine.getSampleRate()
    if (sampleRate > 0) {
      this.splitter.configure(sampleRate)
    }

    // Also push to native so switching back to single-color is seamless
    if (isNativeAvailable()) {
      for (const chunk of pendingSamples) {
        nativeVectorscope.pushSamples(chunk.left, chunk.right)
      }
    }

    // Split new samples into bands and push into circular buffer
    for (const chunk of pendingSamples) {
      const bands = this.splitter.split(chunk.left, chunk.right)
      this.multibandBuffer.push(bands)
    }

    // Read all buffered points and draw with age-based opacity (same as native path)
    const result = this.multibandBuffer.getPoints(options.displayPoints)
    if (result.count === 0) return

    const segments = 8
    const pointsPerSegment = Math.ceil(result.count / segments)

    for (let seg = 0; seg < segments; seg++) {
      const startIdx = seg * pointsPerSegment
      const endIdx = Math.min((seg + 1) * pointsPerSegment, result.count)
      if (startIdx >= result.count) break

      const alpha = 0.15 + 0.85 * (seg / Math.max(segments - 1, 1))
      ctx.globalAlpha = alpha

      for (const band of BAND_ORDER) {
        const bandData = result.bands[band]
        ctx.fillStyle = BAND_COLORS[band]

        for (let i = startIdx; i < endIdx; i++) {
          const point = transformPoint(bandData.left[i], bandData.right[i], mode)
          if (!point) continue

          const px = centerX + point.dx * scale
          const py = centerY - point.dy * scale
          ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize)
        }
      }
    }
    ctx.globalAlpha = 1.0
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()

    // Unsubscribe from track changes
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
    if (this.unsubscribePlaybackState) {
      this.unsubscribePlaybackState()
      this.unsubscribePlaybackState = null
    }

    // Reset native module state
    if (isNativeAvailable()) {
      nativeVectorscope.reset()
    }

    this.splitter.reset()
    this.multibandBuffer.reset()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.offscreenCanvas.width = 0
    this.offscreenCanvas.height = 0
    this.staticLayerCanvas.width = 0
    this.staticLayerCanvas.height = 0
    this.canvas.width = 0
    this.canvas.height = 0
    this.staticLayerKey = ''
    this.lastSampleRate = 0
  }
}
