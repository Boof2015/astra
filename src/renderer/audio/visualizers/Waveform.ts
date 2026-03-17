import { audioEngine } from '../AudioEngine'

export interface WaveformDataSource {
  getPendingWaveformSamples: () => Float32Array[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface WaveformOptions {
  lineColor?: string
  dataSource?: WaveformDataSource
}

type ResolvedWaveformOptions = Required<Omit<WaveformOptions, 'dataSource'>>

const defaultOptions: ResolvedWaveformOptions = {
  lineColor: '#38bdf8',
}

const defaultWaveformDataSource: WaveformDataSource = {
  getPendingWaveformSamples: () => audioEngine.flushPendingWaveformSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

const HISTORY_DURATION_S = 8

function parseHexColor(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) || 56,
    parseInt(h.substring(2, 4), 16) || 189,
    parseInt(h.substring(4, 6), 16) || 248,
  ]
}

export class Waveform {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedWaveformOptions
  private dataSource: WaveformDataSource
  private animationId: number | null = null
  private isRunning = false

  // Offscreen canvas for scrolling content
  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D

  // Sample accumulator for current pixel column
  private columnAccumulator: Float32Array = new Float32Array(0)
  private columnAccumulatorPos = 0
  private samplesPerColumn = 0
  private lastSampleRate = 0

  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: WaveformOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false

    const { dataSource, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultWaveformDataSource

    this.waterfallCanvas = document.createElement('canvas')
    this.waterfallCanvas.width = canvas.width
    this.waterfallCanvas.height = canvas.height
    const waterfallCtx = this.waterfallCanvas.getContext('2d')
    if (!waterfallCtx) throw new Error('Could not get waterfall 2D context')
    this.waterfallCtx = waterfallCtx
    this.waterfallCtx.imageSmoothingEnabled = false

    this.recomputeSamplesPerColumn()

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetDisplay()
    })
  }

  private resetDisplay(): void {
    this.waterfallCtx.clearRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height)
    this.columnAccumulatorPos = 0
  }

  private recomputeSamplesPerColumn(): void {
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const width = Math.max(1, this.waterfallCanvas.width)
    const next = Math.max(1, Math.round((sampleRate * HISTORY_DURATION_S) / width))
    if (next !== this.samplesPerColumn) {
      this.samplesPerColumn = next
      this.columnAccumulator = new Float32Array(next)
      this.columnAccumulatorPos = 0
    }
    this.lastSampleRate = sampleRate
  }

  setOptions(options: Partial<WaveformOptions>): void {
    const { dataSource, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    if (dataSource) {
      this.dataSource = dataSource
    }
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
    // Resize handled in draw loop
  }

  private computeMinMax(): { min: number; max: number } {
    let min = this.columnAccumulator[0]
    let max = this.columnAccumulator[0]
    for (let i = 1; i < this.columnAccumulatorPos; i++) {
      const s = this.columnAccumulator[i]
      if (s < min) min = s
      if (s > max) max = s
    }
    return { min, max }
  }

  private shiftAndPaintColumn(min: number, max: number, width: number, height: number): void {
    // Shift existing content left by 1 pixel — use 'copy' to avoid
    // alpha accumulation from source-over compositing on semi-transparent pixels
    this.waterfallCtx.globalCompositeOperation = 'copy'
    this.waterfallCtx.drawImage(this.waterfallCanvas, -1, 0)
    this.waterfallCtx.globalCompositeOperation = 'source-over'

    const centerY = height / 2
    const gain = 0.95 // slight margin so full-scale doesn't clip at edge
    const yTop = Math.round(centerY - max * centerY * gain)
    const yBottom = Math.round(centerY - min * centerY * gain)
    const lineHeight = Math.max(1, yBottom - yTop)

    const [r, g, b] = parseHexColor(this.options.lineColor)

    // Draw the amplitude column — brighter at the edges, dimmer in the middle
    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`
    this.waterfallCtx.fillRect(width - 1, yTop, 1, lineHeight)

    // Bright edge pixels at min/max
    this.waterfallCtx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`
    this.waterfallCtx.fillRect(width - 1, yTop, 1, 1)
    if (lineHeight > 1) {
      this.waterfallCtx.fillRect(width - 1, yBottom - 1, 1, 1)
    }
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx
    const centerY = height / 2

    // Center line (zero crossing)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(width, centerY)
    ctx.stroke()

    // ±0.5 guide lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)'
    const quarterY = centerY * 0.5
    ctx.beginPath()
    ctx.moveTo(0, quarterY)
    ctx.lineTo(width, quarterY)
    ctx.moveTo(0, height - quarterY)
    ctx.lineTo(width, height - quarterY)
    ctx.stroke()
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const width = this.canvas.width
    const height = this.canvas.height

    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    this.ctx.imageSmoothingEnabled = false

    // Handle resize: preserve existing content anchored to right edge
    if (this.waterfallCanvas.width !== width || this.waterfallCanvas.height !== height) {
      const previousCanvas = document.createElement('canvas')
      previousCanvas.width = this.waterfallCanvas.width
      previousCanvas.height = this.waterfallCanvas.height
      const previousCtx = previousCanvas.getContext('2d')
      if (previousCtx) {
        previousCtx.drawImage(this.waterfallCanvas, 0, 0)
      }

      this.waterfallCanvas.width = width
      this.waterfallCanvas.height = height
      this.waterfallCtx.imageSmoothingEnabled = false

      if (previousCtx && previousCanvas.width > 0 && previousCanvas.height > 0) {
        const srcX = Math.max(0, previousCanvas.width - width)
        const srcW = Math.min(previousCanvas.width, width)
        const dstX = Math.max(0, width - previousCanvas.width)
        this.waterfallCtx.drawImage(
          previousCanvas,
          srcX, 0, srcW, previousCanvas.height,
          dstX, 0, srcW, height
        )
      }

      this.recomputeSamplesPerColumn()
    }

    // Handle sample rate changes
    const sampleRate = this.dataSource.getSampleRate()
    if (Math.abs(sampleRate - this.lastSampleRate) > 100) {
      this.recomputeSamplesPerColumn()
    }

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingWaveformSamples() // drain
      // Freeze display — show last waveform
      this.ctx.clearRect(0, 0, width, height)
      this.drawGrid(width, height)
      this.ctx.drawImage(this.waterfallCanvas, 0, 0)
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const pending = this.dataSource.getPendingWaveformSamples()
    const samplesPerCol = this.samplesPerColumn

    if (samplesPerCol > 0) {
      for (const chunk of pending) {
        for (let i = 0; i < chunk.length; i++) {
          this.columnAccumulator[this.columnAccumulatorPos] = chunk[i]
          this.columnAccumulatorPos++

          if (this.columnAccumulatorPos >= samplesPerCol) {
            const { min, max } = this.computeMinMax()
            this.shiftAndPaintColumn(min, max, width, height)
            this.columnAccumulatorPos = 0
          }
        }
      }
    }

    this.ctx.clearRect(0, 0, width, height)
    this.drawGrid(width, height)
    this.ctx.drawImage(this.waterfallCanvas, 0, 0)
    this.animationId = requestAnimationFrame(this.draw)
  }

  dispose(): void {
    this.stop()
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
  }
}
