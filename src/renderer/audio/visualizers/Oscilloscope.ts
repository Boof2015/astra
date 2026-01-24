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

  // Fallback JS state (used when native not available)
  private lastTrigger: number = 0
  private filteredBuffer: Float32Array = new Float32Array(0)

  constructor(canvas: HTMLCanvasElement, options: OscilloscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx
    this.options = { ...defaultOptions, ...options }

    // Initialize native module if available
    this.initNative()
  }

  private initNative(): void {
    if (isNativeAvailable() && !this.nativeInitialized) {
      nativeOscilloscope.setSampleRate(48000) // Standard sample rate
      nativeOscilloscope.setPitchLock(this.options.pitchLock)
      nativeOscilloscope.setDisplaySamples(4096)
      nativeOscilloscope.setFilterFrequency(200) // Lowpass for trigger detection
      this.nativeInitialized = true
      console.log('Oscilloscope: Using native DSP')
    } else if (!isNativeAvailable()) {
      console.log('Oscilloscope: Using JavaScript fallback')
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

  /**
   * Bidirectional IIR lowpass filter for zero phase delay (JS fallback)
   */
  private lowpass(data: Float32Array): Float32Array {
    const len = data.length
    if (this.filteredBuffer.length !== len) {
      this.filteredBuffer = new Float32Array(len)
    }

    // IIR lowpass: alpha ~0.05 gives good bass extraction
    const alpha = 0.05

    // Forward pass
    this.filteredBuffer[0] = data[0]
    for (let i = 1; i < len; i++) {
      this.filteredBuffer[i] = alpha * data[i] + (1 - alpha) * this.filteredBuffer[i - 1]
    }

    // Backward pass for zero phase delay
    for (let i = len - 2; i >= 0; i--) {
      this.filteredBuffer[i] = alpha * this.filteredBuffer[i] + (1 - alpha) * this.filteredBuffer[i + 1]
    }

    return this.filteredBuffer
  }

  /**
   * Find trigger point - rising zero-crossing on lowpass filtered signal (JS fallback)
   */
  private findTriggerJS(data: Float32Array): number {
    const filtered = this.lowpass(data)
    const searchEnd = Math.floor(data.length / 2)

    // Find ALL rising zero-crossings
    const crossings: number[] = []
    for (let i = 1; i < searchEnd; i++) {
      if (filtered[i - 1] < 0 && filtered[i] >= 0) {
        crossings.push(i)
      }
    }

    if (crossings.length === 0) {
      return this.lastTrigger
    }

    // If this is the first frame, just use the first crossing
    if (this.lastTrigger === 0) {
      this.lastTrigger = crossings[0]
      return this.lastTrigger
    }

    // Find the crossing closest to our last trigger position
    let bestCrossing = crossings[0]
    let bestDist = Math.abs(crossings[0] - this.lastTrigger)

    for (const crossing of crossings) {
      const dist = Math.abs(crossing - this.lastTrigger)
      if (dist < bestDist) {
        bestDist = dist
        bestCrossing = crossing
      }
    }

    // Moderate smoothing (70/30)
    this.lastTrigger = Math.round(this.lastTrigger * 0.7 + bestCrossing * 0.3)

    return this.lastTrigger
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    const timeDomainData = audioEngine.getFloatTimeDomainData()
    const bufferLength = timeDomainData.length

    if (bufferLength === 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    ctx.clearRect(0, 0, width, height)

    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    if (options.showGrid) {
      this.drawGrid()
    }

    // Find trigger point and samples to show
    let startIndex = 0
    let samplesToShow = Math.min(4096, bufferLength)

    if (options.pitchLock) {
      if (isNativeAvailable()) {
        // Use native pitch-locked trigger detection
        const result = nativeOscilloscope.process(timeDomainData)
        if (result) {
          startIndex = result.triggerIndex
          samplesToShow = Math.min(result.samplesToShow, bufferLength - startIndex)
        }
      } else {
        // Use JavaScript fallback
        startIndex = this.findTriggerJS(timeDomainData)
        samplesToShow = Math.min(4096, bufferLength - startIndex)
      }
    }

    // Draw waveform
    ctx.lineWidth = options.lineWidth
    ctx.strokeStyle = options.lineColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const sliceWidth = width / samplesToShow

    for (let i = 0; i < samplesToShow; i++) {
      // Calculate precise index relative to trigger
      // dataIndex can be fractional
      const dataIndex = startIndex + i

      if (dataIndex >= bufferLength - 1) break

      // Linear Interpolation for sub-sample precision
      const idx = Math.floor(dataIndex)
      const frac = dataIndex - idx
      const y0 = timeDomainData[idx]
      const y1 = timeDomainData[idx + 1]
      const sample = y0 + (y1 - y0) * frac

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
    this.lastTrigger = 0
    this.filteredBuffer = new Float32Array(0)

    // Reset native module state
    if (isNativeAvailable()) {
      nativeOscilloscope.reset()
    }
  }
}
