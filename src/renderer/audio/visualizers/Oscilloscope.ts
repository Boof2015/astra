import { audioEngine } from '../AudioEngine'
import {
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  isNativeAvailable,
  warnNativeUnavailableOnce
} from '../native/index'
import { getNormalizedOscilloscopeDisplaySamples } from '../native/oscilloscopeDisplaySamples'
import { createMonoSilenceChunk, isPlaybackAnalyzerActive } from '../visualizerSilence'
import { getCanvasBackingPixelRatio } from '../../utils/canvasSizing'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'

export interface OscilloscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridColor?: string
  pitchLock?: boolean
  underfillEnabled?: boolean
  frameScheduler?: FrameScheduler
}

const defaultOptions: Required<Omit<OscilloscopeOptions, 'frameScheduler'>> = {
  lineColor: '#00ffff',
  lineWidth: 2,
  backgroundColor: 'transparent',
  showGrid: true,
  gridColor: 'rgba(255, 255, 255, 0.1)',
  pitchLock: true,
  underfillEnabled: false
}

function parseRgbChannels(color: string): string | null {
  const normalized = color.trim()

  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1)
    const expanded = hex.length === 3
      ? hex.split('').map((ch) => `${ch}${ch}`).join('')
      : hex

    if (expanded.length === 6) {
      const r = Number.parseInt(expanded.slice(0, 2), 16)
      const g = Number.parseInt(expanded.slice(2, 4), 16)
      const b = Number.parseInt(expanded.slice(4, 6), 16)
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return `${r}, ${g}, ${b}`
      }
    }
  }

  const rgbMatch = /^rgba?\((.*)\)$/i.exec(normalized)
  if (!rgbMatch) return null

  const tokens = rgbMatch[1]
    ?.split(',')
    .map((token) => token.trim())
    .filter(Boolean) ?? []
  if (tokens.length < 3) return null

  const r = Number.parseFloat(tokens[0])
  const g = Number.parseFloat(tokens[1])
  const b = Number.parseFloat(tokens[2])
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null

  return `${Math.max(0, Math.min(255, Math.round(r)))}, ${Math.max(0, Math.min(255, Math.round(g)))}, ${Math.max(0, Math.min(255, Math.round(b)))}`
}

function highContrastUnderfillColor(accentColor: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha))
  const channels = parseRgbChannels(accentColor)
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
  private options: Required<Omit<OscilloscopeOptions, 'frameScheduler'>>
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized: boolean = false
  private samplesReceived: number = 0
  private lastSampleRate: number = 0
  private unsubscribeTrackChange: (() => void) | null = null
  private unsubscribePlaybackState: (() => void) | null = null
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private staticLayerKey = ''
  private static readonly WARMUP_SAMPLES = 4096 // Need ~4K samples before pitch detection is reliable

  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    const { frameScheduler, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.nativeInitialized && isPlaybackAnalyzerActive(audioEngine.playbackState),
      onFrame: this.drawFrame,
    })
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx

    // Initialize native module
    this.initNative()

    // Subscribe to track changes to reset state for fresh pitch detection
    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.reset()
    })
    this.unsubscribePlaybackState = audioEngine.on('stateChange', () => {
      this.invalidate()
    })
  }

  private initNative(): void {
    if (isNativeAvailable() && !this.nativeInitialized) {
      // Get actual sample rate from AudioEngine (defaults to 48000 if context not ready)
      const sampleRate = audioEngine.getSampleRate()
      this.lastSampleRate = sampleRate
      nativeOscilloscope.setSampleRate(sampleRate)
      nativeOscilloscope.setPitchLock(this.options.pitchLock)
      nativeOscilloscope.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(sampleRate))
      // Note: Filter is now pitch-adaptive FIR bandpass (auto-configured in native code)
      this.nativeInitialized = true
      console.log(`Oscilloscope: Using native DSP with AudioWorklet (${sampleRate}Hz)`)
    } else if (!isNativeAvailable()) {
      warnNativeUnavailableOnce('Oscilloscope')
    }
  }

  // Update sample rate if AudioContext changes (called from draw loop)
  private updateSampleRateIfNeeded(): void {
    if (!isNativeAvailable()) return
    const currentRate = audioEngine.getSampleRate()
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.lastSampleRate = currentRate
      nativeOscilloscope.setSampleRate(currentRate)
      nativeOscilloscope.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(currentRate))
      console.log(`Oscilloscope: Sample rate updated to ${currentRate}Hz`)
    }
  }

  setOptions(options: Partial<OscilloscopeOptions>): void {
    const { frameScheduler: _frameScheduler, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }

    // Update native module settings
    if (isNativeAvailable() && options.pitchLock !== undefined) {
      nativeOscilloscope.setPitchLock(options.pitchLock)
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

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = getCanvasBackingPixelRatio(canvas)

    if (width <= 0 || height <= 0) return

    this.renderStaticLayer()

    // Native C++ is being fed continuously by AudioWorklet via AudioEngine
    if (!isNativeAvailable()) {
      warnNativeUnavailableOnce('Oscilloscope')
      return
    }

    // Check if sample rate needs updating (AudioContext may have initialized after us)
    this.updateSampleRateIfNeeded()

    const playbackState = audioEngine.playbackState
    const isPlaying = playbackState === 'playing'
    const isActive = isPlaybackAnalyzerActive(playbackState)

    if (!isActive) {
      audioEngine.flushPendingOscilloscopeSamples()
      return
    }

    // Flush ALL pending samples to native C++ while playing. While paused, discard
    // stale queued audio and advance the scope with zeros so it renders silence.
    const pendingSamples = isPlaying
      ? audioEngine.flushPendingOscilloscopeSamples()
      : (() => {
          audioEngine.flushPendingOscilloscopeSamples()
          const sampleRate = audioEngine.getSampleRate()
          return [createMonoSilenceChunk(sampleRate, getNormalizedOscilloscopeDisplaySamples(sampleRate))]
        })()
    for (const chunk of pendingSamples) {
      nativeOscilloscope.pushSamples(chunk)
      if (isPlaying) {
        this.samplesReceived += chunk.length
      }
    }

    // Skip pitch-locked processing during warmup period.
    // Bypass mode (pitchLock=false) should render immediately using a moving window.
    if (isPlaying && options.pitchLock && this.samplesReceived < Oscilloscope.WARMUP_SAMPLES) {
      // During warmup, just show a static waveform or grid
      return
    }

    // Process using circular buffer - searches backwards from writePos
    const result = nativeOscilloscope.processContinuous()
    if (!result) {
      return
    }

    const samplesToShow = result.samplesToShow
    let triggerIndex = result.triggerIndex

    // In bypass mode, ignore trigger locking and follow the live write head.
    // This produces free-running oscilloscope motion without touching pitch-lock behavior.
    if (!options.pitchLock) {
      const writePos = result.writePos
      triggerIndex = writePos - samplesToShow
      while (triggerIndex < 0) triggerIndex += OSCILLOSCOPE_BUFFER_SIZE
    }

    // Get samples from circular buffer for rendering
    const renderData = nativeOscilloscope.getSamples(Math.floor(triggerIndex), samplesToShow)
    if (!renderData || renderData.length === 0) {
      return
    }

    // Draw waveform (data already starts at trigger point)
    const sliceWidth = width / samplesToShow
    const centerY = height / 2
    const VISUAL_GAIN = 1.8
    const points: Array<{ x: number; y: number }> = []

    for (let i = 0; i < samplesToShow && i < renderData.length; i++) {
      const sample = renderData[i]
      const y = ((1 - sample * VISUAL_GAIN) / 2) * height
      const x = i * sliceWidth
      points.push({ x, y })
    }

    if (points.length < 2) {
      return
    }

    if (options.underfillEnabled) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, centerY)
      for (const point of points) {
        ctx.lineTo(point.x, point.y)
      }
      ctx.lineTo(points[points.length - 1].x, centerY)
      ctx.closePath()
      const peakAlpha = 0.28
      const shoulderAlpha = peakAlpha * 0.74
      const centerlineAlpha = 0.09
      const fillGradient = ctx.createLinearGradient(0, 0, 0, height)
      fillGradient.addColorStop(0, highContrastUnderfillColor(options.lineColor, peakAlpha))
      fillGradient.addColorStop(0.44, highContrastUnderfillColor(options.lineColor, peakAlpha * 0.94))
      fillGradient.addColorStop(0.48, highContrastUnderfillColor(options.lineColor, shoulderAlpha))
      fillGradient.addColorStop(0.5, highContrastUnderfillColor(options.lineColor, centerlineAlpha))
      fillGradient.addColorStop(0.52, highContrastUnderfillColor(options.lineColor, shoulderAlpha))
      fillGradient.addColorStop(0.56, highContrastUnderfillColor(options.lineColor, peakAlpha * 0.94))
      fillGradient.addColorStop(1, highContrastUnderfillColor(options.lineColor, peakAlpha))
      ctx.fillStyle = fillGradient
      ctx.fill()
    }

    ctx.lineWidth = options.lineWidth * dpr
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y)
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
      options.gridColor,
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
    const dpr = getCanvasBackingPixelRatio(canvas)

    ctx.strokeStyle = options.gridColor
    ctx.lineWidth = dpr

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

  // Reset state for new track (call on track change to re-enable fast pitch convergence)
  reset(): void {
    // Reset JS warmup state
    this.samplesReceived = 0

    // Reset native state (clears buffers, resets pitch tracking, re-enables fast smoothing)
    if (isNativeAvailable()) {
      nativeOscilloscope.reset()
    }

    this.invalidate()
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()

    // Unsubscribe from track change events
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
      nativeOscilloscope.reset()
    }

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.staticLayerCanvas.width = 0
    this.staticLayerCanvas.height = 0
    this.canvas.width = 0
    this.canvas.height = 0
    this.staticLayerKey = ''

    // Reset warmup state
    this.samplesReceived = 0
    this.lastSampleRate = 0
  }
}
