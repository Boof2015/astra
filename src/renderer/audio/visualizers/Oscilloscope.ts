import { audioEngine } from '../AudioEngine'
import {
  oscilloscope as defaultNativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  warnNativeUnavailableOnce,
  type OscilloscopeNativeAnalyzer,
} from '../native/index'
import { getNormalizedOscilloscopeDisplaySamples } from '../native/oscilloscopeDisplaySamples'
import { colorToRgbChannels, multiplyColorAlpha } from '../../utils/color'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'

export interface OscilloscopeDataSource extends VisualizerSessionSource {
  getPendingOscilloscopeSamples: () => Float32Array[]
}

export interface OscilloscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridMajorColor?: string
  gridMinorColor?: string
  underfillColor?: string
  pitchLock?: boolean
  underfillEnabled?: boolean
  dataSource?: OscilloscopeDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: OscilloscopeNativeAnalyzer | null
}

type ResolvedOscilloscopeOptions = Required<Omit<OscilloscopeOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

const defaultOptions: ResolvedOscilloscopeOptions = {
  lineColor: '#00ffff',
  lineWidth: 2,
  backgroundColor: 'transparent',
  showGrid: true,
  gridMajorColor: 'rgba(255, 255, 255, 0.1)',
  gridMinorColor: 'rgba(255, 255, 255, 0.05)',
  underfillColor: 'rgba(245, 248, 252, 0.18)',
  pitchLock: true,
  underfillEnabled: false,
}

const defaultOscilloscopeDataSource: OscilloscopeDataSource = {
  getPendingOscilloscopeSamples: () => audioEngine.flushPendingOscilloscopeSamples(),
  ...defaultVisualizerSessionSource,
}

// Amplitude the trace is drawn at (Astra rendered the scope 1.8x taller than raw samples).
const OSCILLOSCOPE_VISUAL_GAIN = 1.8

function highContrastUnderfillColor(accentColor: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha))
  const channels = colorToRgbChannels(accentColor)
  const nearWhite = { r: 245, g: 248, b: 252 }
  const tintAmount = 0.18

  if (!channels) {
    return `rgba(${nearWhite.r}, ${nearWhite.g}, ${nearWhite.b}, ${safeAlpha})`
  }

  const [accentR, accentG, accentB] = channels
    .split(',')
    .map((token) => Number.parseFloat(token.trim()))

  if (!Number.isFinite(accentR) || !Number.isFinite(accentG) || !Number.isFinite(accentB)) {
    return `rgba(${nearWhite.r}, ${nearWhite.g}, ${nearWhite.b}, ${safeAlpha})`
  }

  const mix = (base: number, tint: number): number => Math.round((base * (1 - tintAmount)) + (tint * tintAmount))
  const r = mix(nearWhite.r, accentR)
  const g = mix(nearWhite.g, accentG)
  const b = mix(nearWhite.b, accentB)
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`
}

export class Oscilloscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedOscilloscopeOptions
  private dataSource: OscilloscopeDataSource
  private nativeAnalyzer: OscilloscopeNativeAnalyzer
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized = false
  private samplesReceived = 0
  private lastSampleRate = 0
  private unsubscribeSessionChange: (() => void) | null = null
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private staticLayerKey = ''
  private renderBuffer = new Float32Array(0)
  private pushScratch = new Float32Array(0)
  private static readonly WARMUP_SAMPLES = 4096

  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultOscilloscopeDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? defaultNativeOscilloscope : (nativeAnalyzer ?? defaultNativeOscilloscope)
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      // Native DSP is required; when it's unavailable, stop the loop after one
      // frame (warned once) instead of spinning — preserves Astra's fallback behavior.
      shouldRun: () => this.nativeReady() && this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx

    this.initNative()
    this.subscribeToSessionChanges()
  }

  private subscribeToSessionChanges(): void {
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
    }
    this.unsubscribeSessionChange = this.dataSource.subscribeToSessionChanges(() => {
      this.reset()
    })
  }

  private nativeReady(): boolean {
    return Boolean(this.nativeAnalyzer) && this.nativeAnalyzer.isAvailable?.() !== false
  }

  private initNative(): void {
    if (this.nativeReady() && !this.nativeInitialized) {
      const sampleRate = this.dataSource.getSampleRate()
      this.lastSampleRate = 0
      this.nativeAnalyzer.setSampleRate(sampleRate)
      this.nativeAnalyzer.setPitchLock(this.options.pitchLock)
      this.nativeAnalyzer.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(sampleRate))
      this.nativeInitialized = true
      console.log(`Oscilloscope: Using native DSP with AudioWorklet (${sampleRate}Hz)`)
    } else if (!this.nativeReady()) {
      warnNativeUnavailableOnce('Oscilloscope')
    }
  }

  private updateSampleRateIfNeeded(): void {
    if (!this.nativeReady()) return
    const currentRate = this.dataSource.getSampleRate()
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.lastSampleRate = currentRate
      this.nativeAnalyzer.setSampleRate(currentRate)
      this.nativeAnalyzer.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(currentRate))
      console.log(`Oscilloscope: Sample rate updated to ${currentRate}Hz`)
    }
  }

  setOptions(options: Partial<OscilloscopeOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    if (dataSource && dataSource !== this.dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
      this.reset()
    }

    if (this.nativeReady() && options.pitchLock !== undefined) {
      this.nativeAnalyzer.setPitchLock(options.pitchLock)
    }

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
    this.staticLayerKey = ''
    this.invalidate()
  }

  private ensureRenderBuffer(size: number): Float32Array {
    if (this.renderBuffer.length !== size) {
      this.renderBuffer = new Float32Array(size)
    }
    return this.renderBuffer
  }

  private projectSampleY(sample: number, height: number): number {
    // Match Astra's pre-port amplitude: samples are drawn 1.8x taller than raw so
    // the trace fills the tile (Prism's port had dropped this visual gain).
    return ((1 - sample * OSCILLOSCOPE_VISUAL_GAIN) / 2) * height
  }

  private concatMonoChunks(chunks: Float32Array[]): Float32Array {
    if (chunks.length === 1) return chunks[0]

    let totalLength = 0
    for (const chunk of chunks) {
      totalLength += chunk.length
    }

    if (this.pushScratch.length < totalLength) {
      this.pushScratch = new Float32Array(totalLength)
    }

    const out = this.pushScratch.length === totalLength
      ? this.pushScratch
      : this.pushScratch.subarray(0, totalLength)

    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }

    return out
  }

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1

    if (width <= 0 || height <= 0) return

    this.renderStaticLayer()

    if (!this.nativeReady()) {
      warnNativeUnavailableOnce('Oscilloscope')
      return
    }

    this.updateSampleRateIfNeeded()

    if (!this.dataSource.isPlaying()) {
      return
    }

    const pendingSamples = this.dataSource.getPendingOscilloscopeSamples()
    if (pendingSamples.length > 0) {
      const merged = this.concatMonoChunks(pendingSamples)
      this.nativeAnalyzer.pushSamples(merged)
      this.samplesReceived += merged.length
    }

    if (options.pitchLock && this.samplesReceived < Oscilloscope.WARMUP_SAMPLES) {
      return
    }

    const result = this.nativeAnalyzer.processContinuous()
    if (!result) {
      return
    }

    const samplesToShow = result.samplesToShow
    let triggerIndex = result.triggerIndex

    if (!options.pitchLock) {
      const writePos = result.writePos
      triggerIndex = writePos - samplesToShow
      while (triggerIndex < 0) triggerIndex += OSCILLOSCOPE_BUFFER_SIZE
    }

    const renderData = this.ensureRenderBuffer(samplesToShow)
    const sampleCount = this.nativeAnalyzer.fillSamples(triggerIndex, renderData)
    if (sampleCount < 2) {
      return
    }

    const sliceWidth = width / sampleCount
    const centerY = height / 2

    if (options.underfillEnabled) {
      ctx.beginPath()
      ctx.moveTo(0, centerY)
      for (let i = 0; i < sampleCount; i += 1) {
        const x = i * sliceWidth
        const y = this.projectSampleY(renderData[i], height)
        ctx.lineTo(x, y)
      }
      ctx.lineTo((sampleCount - 1) * sliceWidth, centerY)
      ctx.closePath()
      const peakAlpha = 0.28
      const shoulderAlpha = peakAlpha * 0.74
      const centerlineAlpha = 0.09
      const fillGradient = ctx.createLinearGradient(0, 0, 0, height)
      fillGradient.addColorStop(0, options.underfillColor || highContrastUnderfillColor(options.lineColor, peakAlpha))
      fillGradient.addColorStop(0.44, options.underfillColor || highContrastUnderfillColor(options.lineColor, peakAlpha * 0.94))
      fillGradient.addColorStop(0.48, options.underfillColor || highContrastUnderfillColor(options.lineColor, shoulderAlpha))
      fillGradient.addColorStop(0.5, options.underfillColor || highContrastUnderfillColor(options.lineColor, centerlineAlpha))
      fillGradient.addColorStop(0.52, options.underfillColor || highContrastUnderfillColor(options.lineColor, shoulderAlpha))
      fillGradient.addColorStop(0.56, options.underfillColor || highContrastUnderfillColor(options.lineColor, peakAlpha * 0.94))
      fillGradient.addColorStop(1, options.underfillColor || highContrastUnderfillColor(options.lineColor, peakAlpha))
      ctx.fillStyle = fillGradient
      ctx.fill()
    }

    ctx.lineWidth = options.lineWidth * dpr
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(0, this.projectSampleY(renderData[0], height))
    for (let i = 1; i < sampleCount; i += 1) {
      const x = i * sliceWidth
      const y = this.projectSampleY(renderData[i], height)
      ctx.lineTo(x, y)
    }
    ctx.stroke()
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
      options.gridMajorColor,
      options.gridMinorColor,
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
      this.drawGrid(this.staticLayerCtx)
    }

    this.staticLayerKey = key
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const { canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1

    ctx.strokeStyle = options.gridMajorColor
    ctx.lineWidth = dpr

    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(width / 2, 0)
    ctx.lineTo(width / 2, height)
    ctx.stroke()

    ctx.strokeStyle = options.gridMinorColor || multiplyColorAlpha(options.gridMajorColor, 0.5)
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

  reset(): void {
    this.samplesReceived = 0

    if (this.nativeReady()) {
      this.nativeAnalyzer.reset()
    }

    this.invalidate()
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()

    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }

    if (this.nativeReady()) {
      this.nativeAnalyzer.reset()
    }

    this.samplesReceived = 0
    this.lastSampleRate = 0
  }
}
