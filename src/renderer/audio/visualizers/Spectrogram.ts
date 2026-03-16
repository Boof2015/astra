import { audioEngine } from '../AudioEngine'
import {
  DEFAULT_SPECTROGRAM_CLARITY_MODE,
  DEFAULT_SPECTROGRAM_SCALE_MODE,
  DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  clampSpectrogramScrollSpeed,
  isSpectrogramClarityMode,
  isSpectrogramScaleMode,
  type SpectrogramClarityMode,
  type SpectrogramScaleMode,
} from '../../../types/spectrogram'

export interface SpectrogramDataSource {
  getPendingSpectrogramSamples: () => Float32Array[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface SpectrogramOptions {
  fftSize?: number
  minFrequency?: number
  maxFrequency?: number
  minDecibels?: number
  maxDecibels?: number
  scrollSpeed?: number
  clarityMode?: SpectrogramClarityMode
  scaleMode?: SpectrogramScaleMode
  colorScheme?: 'heat' | 'mono'
  lineColor?: string
  dataSource?: SpectrogramDataSource
}

type ResolvedSpectrogramOptions = Required<Omit<SpectrogramOptions, 'dataSource'>>

interface SpectrogramClarityProfile {
  gamma: number      // contrast curve exponent
  sharpness: number  // local peak suppression exponent (0 = off, higher = thinner lines)
  tiltDb: number     // dB/octave frequency compensation
}

const defaultOptions: ResolvedSpectrogramOptions = {
  fftSize: 4096,
  minFrequency: 20,
  maxFrequency: 20000,
  minDecibels: -90,
  maxDecibels: -12,
  scrollSpeed: DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  clarityMode: DEFAULT_SPECTROGRAM_CLARITY_MODE,
  scaleMode: DEFAULT_SPECTROGRAM_SCALE_MODE,
  colorScheme: 'heat',
  lineColor: '#38bdf8',
}

const defaultSpectrogramDataSource: SpectrogramDataSource = {
  getPendingSpectrogramSamples: () => audioEngine.flushPendingSpectrogramSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

function getClarityProfile(mode: SpectrogramClarityMode): SpectrogramClarityProfile {
  switch (mode) {
    case 'classic':
      return { gamma: 1.8, sharpness: 0, tiltDb: 2.0 }
    case 'sharp':
      return { gamma: 2.0, sharpness: 2.5, tiltDb: 2.0 }
    case 'sharper':
      return { gamma: 2.2, sharpness: 5.0, tiltDb: 2.0 }
  }
}

function resolveClarityMode(value: unknown, fallback: SpectrogramClarityMode): SpectrogramClarityMode {
  return isSpectrogramClarityMode(value) ? value : fallback
}

function resolveScaleMode(value: unknown, fallback: SpectrogramScaleMode): SpectrogramScaleMode {
  return isSpectrogramScaleMode(value) ? value : fallback
}

function resolveOptions(base: ResolvedSpectrogramOptions, overrides: Partial<SpectrogramOptions>): ResolvedSpectrogramOptions {
  return {
    fftSize: typeof overrides.fftSize === 'number' ? overrides.fftSize : base.fftSize,
    minFrequency: typeof overrides.minFrequency === 'number' ? overrides.minFrequency : base.minFrequency,
    maxFrequency: typeof overrides.maxFrequency === 'number' ? overrides.maxFrequency : base.maxFrequency,
    minDecibels: typeof overrides.minDecibels === 'number' ? overrides.minDecibels : base.minDecibels,
    maxDecibels: typeof overrides.maxDecibels === 'number' ? overrides.maxDecibels : base.maxDecibels,
    scrollSpeed: overrides.scrollSpeed === undefined
      ? base.scrollSpeed
      : clampSpectrogramScrollSpeed(overrides.scrollSpeed),
    clarityMode: resolveClarityMode(overrides.clarityMode, base.clarityMode),
    scaleMode: resolveScaleMode(overrides.scaleMode, base.scaleMode),
    colorScheme: overrides.colorScheme ?? base.colorScheme,
    lineColor: overrides.lineColor ?? base.lineColor,
  }
}

const SLANEY_F_SP = 200 / 3
const SLANEY_MIN_LOG_HZ = 1000
const SLANEY_MIN_LOG_MEL = SLANEY_MIN_LOG_HZ / SLANEY_F_SP
const SLANEY_LOG_STEP = Math.log(6.4) / 27

function hzToMelSlaney(frequencyHz: number): number {
  if (frequencyHz < SLANEY_MIN_LOG_HZ) {
    return frequencyHz / SLANEY_F_SP
  }
  return SLANEY_MIN_LOG_MEL + (Math.log(frequencyHz / SLANEY_MIN_LOG_HZ) / SLANEY_LOG_STEP)
}

function melToHzSlaney(mel: number): number {
  if (mel < SLANEY_MIN_LOG_MEL) {
    return mel * SLANEY_F_SP
  }
  return SLANEY_MIN_LOG_HZ * Math.exp(SLANEY_LOG_STEP * (mel - SLANEY_MIN_LOG_MEL))
}

function frequencyFromScale(
  scaleMode: SpectrogramScaleMode,
  minFrequency: number,
  maxFrequency: number,
  normalizedPosition: number
): number {
  switch (scaleMode) {
    case 'linear':
      return minFrequency + (normalizedPosition * (maxFrequency - minFrequency))
    case 'log': {
      const logMin = Math.log10(minFrequency)
      const logMax = Math.log10(maxFrequency)
      return 10 ** (logMin + (normalizedPosition * (logMax - logMin)))
    }
    case 'mel': {
      const melMin = hzToMelSlaney(minFrequency)
      const melMax = hzToMelSlaney(maxFrequency)
      return melToHzSlaney(melMin + (normalizedPosition * (melMax - melMin)))
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n <= 1) return

  let j = 0
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1
    while (j & bit) {
      j ^= bit
      bit >>= 1
    }
    j ^= bit

    if (i < j) {
      let tmp = re[i]
      re[i] = re[j]
      re[j] = tmp
      tmp = im[i]
      im[i] = im[j]
      im[j] = tmp
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1
    const angle = -2 * Math.PI / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)

    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0

      for (let k = 0; k < halfLen; k += 1) {
        const evenIdx = i + k
        const oddIdx = i + k + halfLen

        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx]
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx]

        re[oddIdx] = re[evenIdx] - tRe
        im[oddIdx] = im[evenIdx] - tIm
        re[evenIdx] += tRe
        im[evenIdx] += tIm

        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

const hannWindowCache = new Map<number, Float32Array>()

function getHannWindow(size: number): Float32Array {
  let window = hannWindowCache.get(size)
  if (window) return window

  window = new Float32Array(size)
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  }
  hannWindowCache.set(size, window)
  return window
}

type ColorStop = {
  at: number
  color: [number, number, number]
}

const HEAT_STOPS: readonly ColorStop[] = [
  { at: 0, color: [0, 0, 0] },
  { at: 0.14, color: [15, 7, 33] },
  { at: 0.32, color: [61, 11, 94] },
  { at: 0.54, color: [163, 26, 121] },
  { at: 0.74, color: [255, 82, 87] },
  { at: 0.9, color: [255, 166, 63] },
  { at: 1, color: [255, 241, 209] },
]

function lerpChannel(start: number, end: number, amount: number): number {
  return Math.round(start + ((end - start) * amount))
}

function buildHeatLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 3)

  for (let index = 0; index < 256; index += 1) {
    const t = index / 255
    let start = HEAT_STOPS[0]
    let end = HEAT_STOPS[HEAT_STOPS.length - 1]

    for (let stopIndex = 0; stopIndex < HEAT_STOPS.length - 1; stopIndex += 1) {
      const nextStop = HEAT_STOPS[stopIndex + 1]
      if (t <= nextStop.at) {
        start = HEAT_STOPS[stopIndex]
        end = nextStop
        break
      }
    }

    const span = Math.max(1e-6, end.at - start.at)
    const amount = Math.max(0, Math.min(1, (t - start.at) / span))
    lut[index * 3] = lerpChannel(start.color[0], end.color[0], amount)
    lut[index * 3 + 1] = lerpChannel(start.color[1], end.color[1], amount)
    lut[index * 3 + 2] = lerpChannel(start.color[2], end.color[2], amount)
  }

  return lut
}

const HEAT_LUT = buildHeatLUT()

function parseHexColor(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  return [
    Number.parseInt(normalized.substring(0, 2), 16) || 56,
    Number.parseInt(normalized.substring(2, 4), 16) || 189,
    Number.parseInt(normalized.substring(4, 6), 16) || 248,
  ]
}

// Zero-pad FFT for finer frequency resolution (visual interpolation)
const FFT_PAD_FACTOR = 4

export class Spectrogram {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedSpectrogramOptions
  private dataSource: SpectrogramDataSource
  private animationId: number | null = null
  private isRunning = false

  private fftRe: Float32Array
  private fftIm: Float32Array
  private sampleBuffer: Float32Array
  private sampleBufferPos = 0

  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D

  private rowCenterBins = new Float32Array(0)
  private rowBandStartBins = new Float32Array(0)
  private rowBandEndBins = new Float32Array(0)
  private columnValues = new Float32Array(0)
  private rawColumnValues = new Float32Array(0)
  private columnImageData: ImageData | null = null

  private lastWidth = 0
  private lastHeight = 0
  private lastFftSize = 0
  private lastSampleRate = 0
  private lastMinFrequency = 0
  private lastMaxFrequency = 0
  private lastScaleMode: SpectrogramScaleMode | null = null

  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: SpectrogramOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, ...optionOverrides } = options
    this.options = resolveOptions(defaultOptions, optionOverrides)
    this.dataSource = dataSource ?? defaultSpectrogramDataSource

    const windowSize = this.options.fftSize
    const paddedSize = windowSize * FFT_PAD_FACTOR
    this.fftRe = new Float32Array(paddedSize)
    this.fftIm = new Float32Array(paddedSize)
    this.sampleBuffer = new Float32Array(windowSize)

    this.waterfallCanvas = document.createElement('canvas')
    this.waterfallCanvas.width = canvas.width
    this.waterfallCanvas.height = canvas.height
    const waterfallCtx = this.waterfallCanvas.getContext('2d')
    if (!waterfallCtx) throw new Error('Could not get waterfall 2D context')
    this.waterfallCtx = waterfallCtx

    this.ctx.imageSmoothingEnabled = false
    this.waterfallCtx.imageSmoothingEnabled = false

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetDisplay()
    })
  }

  private resetDisplay(): void {
    this.sampleBufferPos = 0
    this.waterfallCtx.clearRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height)
  }

  setOptions(options: Partial<SpectrogramOptions>): void {
    const { dataSource, ...optionUpdates } = options
    const previousOptions = this.options
    this.options = resolveOptions(previousOptions, optionUpdates)

    if (dataSource) {
      this.dataSource = dataSource
    }

    if (this.options.fftSize !== previousOptions.fftSize) {
      const windowSize = this.options.fftSize
      const paddedSize = windowSize * FFT_PAD_FACTOR
      this.fftRe = new Float32Array(paddedSize)
      this.fftIm = new Float32Array(paddedSize)
      this.sampleBuffer = new Float32Array(windowSize)
      this.sampleBufferPos = 0
      this.lastFftSize = 0
      this.resetDisplay()
    } else if (this.options.scaleMode !== previousOptions.scaleMode) {
      this.resetDisplay()
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
    this.lastWidth = 0
    this.lastHeight = 0
  }

  private ensureColumnBuffers(height: number): void {
    if (height <= 0) return
    if (this.columnValues.length === height && this.columnImageData && this.columnImageData.height === height) {
      return
    }

    this.columnValues = new Float32Array(height)
    this.rawColumnValues = new Float32Array(height)
    this.columnImageData = new ImageData(1, height)
  }

  private shiftAndPaintColumn(values: Float32Array): void {
    const width = this.waterfallCanvas.width
    const height = this.waterfallCanvas.height
    if (width <= 0 || height <= 0 || !this.columnImageData) return

    this.paintColumnImage(values)

    // Shift existing content left by 1 pixel
    this.waterfallCtx.drawImage(this.waterfallCanvas, -1, 0)

    // Paint new column at right edge
    this.waterfallCtx.putImageData(this.columnImageData, width - 1, 0)
  }

  private ensureBandMapping(): void {
    const { canvas, options } = this
    const width = canvas.width
    const height = canvas.height
    const fftSize = options.fftSize
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const nyquist = sampleRate / 2
    const minFrequency = Math.max(1, Math.min(options.minFrequency, nyquist))
    const maxFrequency = Math.max(minFrequency + 1, Math.min(options.maxFrequency, nyquist))

    if (
      width === this.lastWidth
      && height === this.lastHeight
      && fftSize === this.lastFftSize
      && sampleRate === this.lastSampleRate
      && minFrequency === this.lastMinFrequency
      && maxFrequency === this.lastMaxFrequency
      && options.scaleMode === this.lastScaleMode
    ) {
      return
    }

    this.lastWidth = width
    this.lastHeight = height
    this.lastFftSize = fftSize
    this.lastSampleRate = sampleRate
    this.lastMinFrequency = minFrequency
    this.lastMaxFrequency = maxFrequency
    this.lastScaleMode = options.scaleMode

    const numBins = (fftSize * FFT_PAD_FACTOR) / 2
    const rowSpan = Math.max(1, height - 1)
    const binWidth = nyquist / numBins

    this.rowCenterBins = new Float32Array(height)
    this.rowBandStartBins = new Float32Array(height)
    this.rowBandEndBins = new Float32Array(height)
    for (let row = 0; row < height; row += 1) {
      const normalizedPosition = 1 - (row / rowSpan)
      const centerFrequency = frequencyFromScale(
        options.scaleMode,
        minFrequency,
        maxFrequency,
        normalizedPosition
      )
      const upperEdgeNormalized = row === 0
        ? 1
        : 1 - ((row - 0.5) / rowSpan)
      const lowerEdgeNormalized = row === height - 1
        ? 0
        : 1 - ((row + 0.5) / rowSpan)
      const upperEdgeFrequency = frequencyFromScale(
        options.scaleMode,
        minFrequency,
        maxFrequency,
        upperEdgeNormalized
      )
      const lowerEdgeFrequency = frequencyFromScale(
        options.scaleMode,
        minFrequency,
        maxFrequency,
        lowerEdgeNormalized
      )

      this.rowCenterBins[row] = Math.max(0, Math.min(numBins - 1, centerFrequency / binWidth))
      this.rowBandStartBins[row] = Math.max(0, Math.min(numBins, lowerEdgeFrequency / binWidth))
      this.rowBandEndBins[row] = Math.max(0, Math.min(numBins, upperEdgeFrequency / binWidth))
    }

    this.ensureColumnBuffers(height)
  }

  private processFFT(samples: Float32Array): Float32Array {
    const windowSize = samples.length
    const paddedSize = windowSize * FFT_PAD_FACTOR
    const window = getHannWindow(windowSize)

    // Apply window to audio samples
    for (let index = 0; index < windowSize; index += 1) {
      this.fftRe[index] = samples[index] * window[index]
    }
    // Zero-pad the rest for finer frequency interpolation
    for (let index = windowSize; index < paddedSize; index += 1) {
      this.fftRe[index] = 0
    }
    this.fftIm.fill(0)

    fft(this.fftRe, this.fftIm)

    const numBins = paddedSize / 2
    const magnitudes = new Float32Array(numBins)
    const scale = 2 / windowSize  // normalize by window size, not padded size

    for (let index = 0; index < numBins; index += 1) {
      const re = this.fftRe[index]
      const im = this.fftIm[index]
      const magnitude = Math.sqrt((re * re) + (im * im)) * scale
      magnitudes[index] = 20 * Math.log10(Math.max(magnitude, 1e-10))
    }

    return magnitudes
  }

  private paintColumnImage(values: Float32Array): void {
    if (!this.columnImageData) return

    const imageData = this.columnImageData.data
    const [tintR, tintG, tintB] = this.options.colorScheme === 'mono'
      ? parseHexColor(this.options.lineColor)
      : [0, 0, 0]

    for (let row = 0; row < values.length; row += 1) {
      const intensity = Math.max(0, Math.min(1, values[row]))
      const lutIndex = Math.round(intensity * 255)
      const dataIndex = row * 4

      if (this.options.colorScheme === 'heat') {
        imageData[dataIndex] = HEAT_LUT[lutIndex * 3]
        imageData[dataIndex + 1] = HEAT_LUT[(lutIndex * 3) + 1]
        imageData[dataIndex + 2] = HEAT_LUT[(lutIndex * 3) + 2]
      } else {
        imageData[dataIndex] = Math.round(tintR * intensity)
        imageData[dataIndex + 1] = Math.round(tintG * intensity)
        imageData[dataIndex + 2] = Math.round(tintB * intensity)
      }

      imageData[dataIndex + 3] = 255
    }
  }

  private drawColumn(magnitudes: Float32Array): Float32Array {
    const height = this.waterfallCanvas.height
    if (height <= 0) return this.columnValues

    this.ensureColumnBuffers(height)
    const values = this.columnValues
    const raw = this.rawColumnValues
    const numBins = magnitudes.length

    const clarity = getClarityProfile(this.options.clarityMode)
    const minDecibels = this.options.minDecibels
    const dbRange = Math.max(1e-6, this.options.maxDecibels - minDecibels)

    // Compute bin width for frequency-based tilt
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const binWidth = (sampleRate / 2) / numBins
    const TILT_REFERENCE_HZ = 1000

    // Pass 1: sub-bin interpolation + tilt → raw normalized values (no gamma yet)
    for (let row = 0; row < height; row += 1) {
      const centerBin = this.rowCenterBins[row]

      // Sub-bin interpolation in dB domain
      const binLo = Math.floor(centerBin)
      const binHi = Math.min(binLo + 1, numBins - 1)
      const frac = centerBin - binLo
      const db = magnitudes[binLo] * (1 - frac) + magnitudes[binHi] * frac

      // Frequency-based tilt — dB per octave from reference, scale-mode independent
      const centerFreq = Math.max(1, centerBin * binWidth)
      const tiltAmount = clarity.tiltDb * Math.log2(centerFreq / TILT_REFERENCE_HZ)
      raw[row] = clamp01(((db + tiltAmount) - minDecibels) / dbRange)
    }

    // Pass 2: local peak suppression — thin spectral lines for sharp/sharper modes
    const sharpness = clarity.sharpness
    if (sharpness > 0) {
      // Hann mainlobe = 4 original bins = 4 * FFT_PAD_FACTOR padded bins
      const mainlobePaddedBins = 4 * FFT_PAD_FACTOR
      // Target visual line width in pixels — suppression scales to achieve this
      const TARGET_LINE_WIDTH = 3

      for (let row = 0; row < height; row += 1) {
        // Adaptive window: mainlobe width in pixel rows at this frequency
        const bandWidthPerRow = Math.max(0.1, this.rowBandEndBins[row] - this.rowBandStartBins[row])
        const mainlobePixels = mainlobePaddedBins / bandWidthPerRow
        const halfWin = Math.max(2, Math.min(50, Math.round(mainlobePixels / 2)))

        // Scale suppression by how wide the mainlobe is vs target width
        // At low freqs (mainlobe=26px, target=3px): 8.7x stronger suppression
        // At high freqs (mainlobe=2px, target=3px): 1x base suppression
        const scaleFactor = Math.max(1, mainlobePixels / TARGET_LINE_WIDTH)
        const effectiveSharpness = sharpness * scaleFactor

        // Find local peak in neighborhood
        let localMax = raw[row]
        for (let d = 1; d <= halfWin; d += 1) {
          if (row - d >= 0 && raw[row - d] > localMax) localMax = raw[row - d]
          if (row + d < height && raw[row + d] > localMax) localMax = raw[row + d]
        }

        // Suppress off-peak values: peak stays bright, slopes get crushed
        if (localMax > 1e-6) {
          const ratio = raw[row] / localMax
          raw[row] *= Math.pow(ratio, effectiveSharpness)
        }
      }
    }

    // Pass 3: apply gamma
    for (let row = 0; row < height; row += 1) {
      values[row] = Math.pow(raw[row], clarity.gamma)
    }

    return values
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const width = this.canvas.width
    const height = this.canvas.height
    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    // Re-set after external resize resets context state
    this.ctx.imageSmoothingEnabled = false

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

      // Anchor right edge — newest columns stay, old data crops naturally
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

      this.lastWidth = 0
    }

    this.ensureBandMapping()

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingSpectrogramSamples()
      // Freeze waterfall in place instead of blanking
      this.ctx.clearRect(0, 0, width, height)
      this.ctx.drawImage(this.waterfallCanvas, 0, 0)
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const pendingSamples = this.dataSource.getPendingSpectrogramSamples()
    const fftSize = this.options.fftSize

    // Scroll speed solely controls temporal resolution (hop divisor)
    const BASE_HOP_DIVISOR = 8
    const effectiveHopDivisor = Math.max(2, Math.min(64, Math.round(BASE_HOP_DIVISOR * this.options.scrollSpeed)))
    const hopSize = Math.max(1, Math.floor(fftSize / effectiveHopDivisor))
    const overlapSamples = fftSize - hopSize

    for (const chunk of pendingSamples) {
      for (let index = 0; index < chunk.length; index += 1) {
        this.sampleBuffer[this.sampleBufferPos] = chunk[index]
        this.sampleBufferPos += 1

        if (this.sampleBufferPos >= fftSize) {
          const magnitudes = this.processFFT(this.sampleBuffer)
          const values = this.drawColumn(magnitudes)
          // Each FFT hop = exactly 1 pixel column. No accumulation, no duplication.
          this.shiftAndPaintColumn(values)

          this.sampleBuffer.copyWithin(0, hopSize)
          this.sampleBufferPos = overlapSamples
        }
      }
    }

    this.ctx.clearRect(0, 0, width, height)
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
