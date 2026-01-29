import { audioEngine } from '../AudioEngine'
import { oscilloscope as nativeOscilloscope, isNativeAvailable } from '../native'

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
  private nativeInitialized: boolean = false
  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }

    // Initialize native module
    this.initNative()
  }

  private initNative(): void {
    if (isNativeAvailable() && !this.nativeInitialized) {
      nativeOscilloscope.setSampleRate(48000) // Standard sample rate
      nativeOscilloscope.setPitchLock(this.options.pitchLock)
      nativeOscilloscope.setDisplaySamples(1024) // MiniMeters style: ~2-3 cycles for typical bass
      // Note: Filter is now pitch-adaptive FIR bandpass (auto-configured in native code)
      this.nativeInitialized = true
      console.log('Oscilloscope: Using native DSP with AudioWorklet')
    } else if (!isNativeAvailable()) {
      console.error('Oscilloscope: Native DSP not available!')
    }
  }

  setOptions(options: Partial<OscilloscopeOptions>): void {
    this.options = { ...this.options, ...options }

    // Update native module settings
    if (isNativeAvailable() && options.pitchLock !== undefined) {
      nativeOscilloscope.setPitchLock(options.pitchLock)
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

  resize(): void { }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    ctx.clearRect(0, 0, width, height)

    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    if (options.showGrid) {
      this.drawGrid()
    }

    // Native C++ is being fed continuously by AudioWorklet via AudioEngine
    if (!isNativeAvailable()) {
      console.error('Oscilloscope: Native DSP required')
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Flush ALL pending samples to native C++ (prevents sample loss)
    const pendingSamples = audioEngine.flushPendingOscilloscopeSamples()
    for (const chunk of pendingSamples) {
      nativeOscilloscope.pushSamples(chunk)
    }

    // Process using circular buffer - searches backwards from writePos
    const result = nativeOscilloscope.processContinuous()
    if (!result) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const triggerIndex = result.triggerIndex
    const samplesToShow = result.samplesToShow

    // Get samples from circular buffer for rendering
    const renderData = nativeOscilloscope.getSamples(Math.floor(triggerIndex), samplesToShow)
    if (!renderData || renderData.length === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Draw waveform (data already starts at trigger point)
    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const sliceWidth = width / samplesToShow

    for (let i = 0; i < samplesToShow && i < renderData.length; i++) {
      const sample = renderData[i]
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

    // Reset native module state
    if (isNativeAvailable()) {
      nativeOscilloscope.reset()
    }
  }
}
