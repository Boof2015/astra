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
  gamma: number
  tiltDb: number
  floor: number
  hopDivisor: number
  baseRadiusRows: number
  peakRadiusRows: number
  bodyBlend: number
  peakBlend: number
  peakProminenceDb: number
  backgroundBlend: number
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
      return {
        gamma: 0.8,
        tiltDb: 4.5,
        floor: 0.02,
        hopDivisor: 2,
        baseRadiusRows: 2.2,
        peakRadiusRows: 1.1,
        bodyBlend: 0.92,
        peakBlend: 0.22,
        peakProminenceDb: 0.3,
        backgroundBlend: 0.34,
      }
    case 'sharp':
      return {
        gamma: 0.8,
        tiltDb: 4.5,
        floor: 0.02,
        hopDivisor: 2,
        baseRadiusRows: 1.15,
        peakRadiusRows: 0.5,
        bodyBlend: 0.36,
        peakBlend: 0.78,
        peakProminenceDb: 0.7,
        backgroundBlend: 0.2,
      }
    case 'sharper':
      return {
        gamma: 0.8,
        tiltDb: 4.5,
        floor: 0.02,
        hopDivisor: 4,
        baseRadiusRows: 0.4,
        peakRadiusRows: 0.28,
        bodyBlend: 0.14,
        peakBlend: 0.92,
        peakProminenceDb: 0.9,
        backgroundBlend: 0.14,
      }
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

function normalizedPositionFromFrequency(
  scaleMode: SpectrogramScaleMode,
  minFrequency: number,
  maxFrequency: number,
  frequency: number
): number {
  const clampedFrequency = Math.max(minFrequency, Math.min(maxFrequency, frequency))
  switch (scaleMode) {
    case 'linear':
      return (clampedFrequency - minFrequency) / Math.max(1e-6, maxFrequency - minFrequency)
    case 'log': {
      const logMin = Math.log10(minFrequency)
      const logMax = Math.log10(maxFrequency)
      return (Math.log10(clampedFrequency) - logMin) / Math.max(1e-6, logMax - logMin)
    }
    case 'mel': {
      const melMin = hzToMelSlaney(minFrequency)
      const melMax = hzToMelSlaney(maxFrequency)
      return (hzToMelSlaney(clampedFrequency) - melMin) / Math.max(1e-6, melMax - melMin)
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function fft(re: Float64Array, im: Float64Array): void {
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

const hannWindowCache = new Map<number, Float64Array>()

function getHannWindow(size: number): Float64Array {
  let window = hannWindowCache.get(size)
  if (window) return window

  window = new Float64Array(size)
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

export class Spectrogram {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedSpectrogramOptions
  private dataSource: SpectrogramDataSource
  private animationId: number | null = null
  private isRunning = false

  private fftRe: Float64Array
  private fftIm: Float64Array
  private sampleBuffer: Float64Array
  private sampleBufferPos = 0

  private waterfallCanvas: HTMLCanvasElement
  private waterfallCtx: CanvasRenderingContext2D

  private rowCenterBins = new Float32Array(0)
  private rowBandStartBins = new Float32Array(0)
  private rowBandEndBins = new Float32Array(0)
  private columnValues = new Float32Array(0)
  private pendingColumnValues = new Float32Array(0)
  private blurBufferA = new Float32Array(0)
  private blurBufferB = new Float32Array(0)
  private powerValues = new Float64Array(0)
  private columnImageData: ImageData | null = null

  private lastWidth = 0
  private lastHeight = 0
  private lastFftSize = 0
  private lastSampleRate = 0
  private lastMinFrequency = 0
  private lastMaxFrequency = 0
  private lastScaleMode: SpectrogramScaleMode | null = null
  private columnAdvanceAccumulator = 0

  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: SpectrogramOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, ...optionOverrides } = options
    this.options = resolveOptions(defaultOptions, optionOverrides)
    this.dataSource = dataSource ?? defaultSpectrogramDataSource

    const fftSize = this.options.fftSize
    this.fftRe = new Float64Array(fftSize)
    this.fftIm = new Float64Array(fftSize)
    this.sampleBuffer = new Float64Array(fftSize)

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
    this.columnAdvanceAccumulator = 0
    this.pendingColumnValues.fill(0)
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
      const fftSize = this.options.fftSize
      this.fftRe = new Float64Array(fftSize)
      this.fftIm = new Float64Array(fftSize)
      this.sampleBuffer = new Float64Array(fftSize)
      this.sampleBufferPos = 0
      this.lastFftSize = 0
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
    this.pendingColumnValues = new Float32Array(height)
    this.blurBufferA = new Float32Array(height)
    this.blurBufferB = new Float32Array(height)
    this.columnImageData = new ImageData(1, height)
  }

  private ensurePowerBuffer(numBins: number): void {
    if (this.powerValues.length === numBins) {
      return
    }

    this.powerValues = new Float64Array(numBins)
  }

  private sampleMagnitudeAtBin(magnitudes: Float32Array, binPosition: number): number {
    const lowerBin = Math.max(0, Math.min(magnitudes.length - 1, Math.floor(binPosition)))
    const upperBin = Math.max(0, Math.min(magnitudes.length - 1, lowerBin + 1))
    const mix = binPosition - lowerBin
    if (upperBin === lowerBin || mix <= 0) {
      return magnitudes[lowerBin]
    }

    // Interpolate in linear amplitude space so sub-bin peaks stay crisp.
    const lowerMagnitude = 10 ** (magnitudes[lowerBin] / 20)
    const upperMagnitude = 10 ** (magnitudes[upperBin] / 20)
    const interpolatedMagnitude = (lowerMagnitude * (1 - mix)) + (upperMagnitude * mix)
    return 20 * Math.log10(Math.max(interpolatedMagnitude, 1e-10))
  }

  private integrateBandPower(startBin: number, endBin: number): number {
    const binCount = this.powerValues.length
    if (binCount === 0) return 0

    const clampedStart = Math.max(0, Math.min(binCount, startBin))
    const clampedEnd = Math.max(clampedStart, Math.min(binCount, endBin))
    if (clampedEnd <= clampedStart) return 0

    const startIndex = Math.max(0, Math.floor(clampedStart))
    const endIndexExclusive = Math.min(binCount, Math.ceil(clampedEnd))
    let totalPower = 0

    for (let binIndex = startIndex; binIndex < endIndexExclusive; binIndex += 1) {
      const overlapStart = Math.max(clampedStart, binIndex)
      const overlapEnd = Math.min(clampedEnd, binIndex + 1)
      if (overlapEnd <= overlapStart) {
        continue
      }
      totalPower += this.powerValues[binIndex] * (overlapEnd - overlapStart)
    }

    return totalPower / Math.max(1e-6, clampedEnd - clampedStart)
  }

  private estimatePeakBinPosition(magnitudes: Float32Array, binIndex: number): number {
    if (binIndex <= 0 || binIndex >= magnitudes.length - 1) {
      return binIndex
    }

    const left = magnitudes[binIndex - 1]
    const center = magnitudes[binIndex]
    const right = magnitudes[binIndex + 1]
    const denominator = left - (2 * center) + right

    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) {
      return binIndex
    }

    const delta = 0.5 * (left - right) / denominator
    return binIndex + Math.max(-0.5, Math.min(0.5, delta))
  }

  private splatIntensity(
    target: Float32Array,
    rowPosition: number,
    radiusRows: number,
    intensity: number
  ): void {
    if (target.length === 0 || intensity <= 0) return

    const lastRow = target.length - 1
    const clampedRowPosition = Math.max(0, Math.min(lastRow, rowPosition))

    if (radiusRows <= 0.6) {
      const lowerRow = Math.floor(clampedRowPosition)
      const upperRow = Math.min(lastRow, lowerRow + 1)
      const mix = clampedRowPosition - lowerRow
      const lowerValue = intensity * (1 - mix)
      if (lowerValue > target[lowerRow]) {
        target[lowerRow] = lowerValue
      }
      if (upperRow !== lowerRow) {
        const upperValue = intensity * mix
        if (upperValue > target[upperRow]) {
          target[upperRow] = upperValue
        }
      }
      return
    }

    const sigma = Math.max(0.45, radiusRows * 0.6)
    const startRow = Math.max(0, Math.floor(clampedRowPosition - (radiusRows * 1.5)))
    const endRow = Math.min(lastRow, Math.ceil(clampedRowPosition + (radiusRows * 1.5)))
    const inverseTwoSigmaSquared = 1 / (2 * sigma * sigma)

    for (let row = startRow; row <= endRow; row += 1) {
      const distance = row - clampedRowPosition
      const value = intensity * Math.exp(-(distance * distance) * inverseTwoSigmaSquared)
      if (value > target[row]) {
        target[row] = value
      }
    }
  }

  private blurRows(source: Float32Array, target: Float32Array, radiusRows: number): void {
    if (source.length !== target.length) {
      target.set(source.subarray(0, Math.min(source.length, target.length)))
      return
    }

    if (radiusRows <= 0.55) {
      target.set(source)
      return
    }

    const sigma = Math.max(0.4, radiusRows * 0.6)
    const kernelRadius = Math.max(1, Math.ceil(radiusRows * 2))
    const weights = new Float64Array((kernelRadius * 2) + 1)

    for (let offset = -kernelRadius; offset <= kernelRadius; offset += 1) {
      weights[offset + kernelRadius] = Math.exp(-(offset * offset) / (2 * sigma * sigma))
    }

    const lastIndex = source.length - 1
    for (let row = 0; row < source.length; row += 1) {
      let weightedSum = 0
      let totalWeight = 0

      for (let offset = -kernelRadius; offset <= kernelRadius; offset += 1) {
        const sampleRow = Math.max(0, Math.min(lastIndex, row + offset))
        const weight = weights[offset + kernelRadius]
        weightedSum += source[sampleRow] * weight
        totalWeight += weight
      }

      target[row] = totalWeight > 0 ? weightedSum / totalWeight : source[row]
    }
  }

  private normalizeMagnitude(
    magnitudeDb: number,
    rowPosition: number,
    rowSpan: number,
    minDecibels: number,
    dbRange: number,
    clarity: SpectrogramClarityProfile
  ): number {
    const tiltAmount = clarity.tiltDb * ((rowSpan - rowPosition) / rowSpan)
    const normalized = ((magnitudeDb + tiltAmount) - minDecibels) / dbRange
    return clamp01(normalized)
  }

  private accumulatePendingColumn(values: Float32Array): void {
    for (let row = 0; row < values.length; row += 1) {
      if (values[row] > this.pendingColumnValues[row]) {
        this.pendingColumnValues[row] = values[row]
      }
    }
  }

  private flushPendingColumns(columnsToDraw: number): void {
    if (!this.columnImageData || columnsToDraw <= 0) return

    this.paintColumnImage(this.pendingColumnValues)
    const width = this.waterfallCanvas.width
    const height = this.waterfallCanvas.height
    const safeColumns = Math.max(1, Math.min(width, columnsToDraw))
    const rightEdge = width - safeColumns

    this.waterfallCtx.drawImage(this.waterfallCanvas, -safeColumns, 0)
    this.waterfallCtx.clearRect(rightEdge, 0, safeColumns, height)

    for (let offset = 0; offset < safeColumns; offset += 1) {
      this.waterfallCtx.putImageData(this.columnImageData, rightEdge + offset, 0)
    }

    this.pendingColumnValues.fill(0)
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

    const numBins = fftSize / 2
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

  private processFFT(samples: Float64Array): Float32Array {
    const size = samples.length
    const window = getHannWindow(size)

    for (let index = 0; index < size; index += 1) {
      this.fftRe[index] = samples[index] * window[index]
      this.fftIm[index] = 0
    }

    fft(this.fftRe, this.fftIm)

    const numBins = size / 2
    const magnitudes = new Float32Array(numBins)
    const scale = 2 / size

    for (let index = 0; index < numBins; index += 1) {
      const re = this.fftRe[index]
      const im = this.fftIm[index]
      const magnitude = Math.sqrt((re * re) + (im * im)) * scale
      magnitudes[index] = 20 * Math.log10(Math.max(magnitude, 1e-10))
    }

    return magnitudes
  }

  private populatePowerValues(magnitudes: Float32Array): void {
    this.ensurePowerBuffer(magnitudes.length)

    for (let index = 0; index < magnitudes.length; index += 1) {
      this.powerValues[index] = 10 ** (magnitudes[index] / 10)
    }
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
    const width = this.waterfallCanvas.width
    const height = this.waterfallCanvas.height
    if (width <= 0 || height <= 0) return this.columnValues

    this.ensureColumnBuffers(height)
    const values = this.columnValues
    values.fill(0)

    const clarity = getClarityProfile(this.options.clarityMode)
    const minDecibels = this.options.minDecibels
    const dbRange = Math.max(1e-6, this.options.maxDecibels - minDecibels)
    const rowSpan = Math.max(1, height - 1)
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    const nyquist = sampleRate / 2
    const minFrequency = Math.max(1, Math.min(this.options.minFrequency, nyquist))
    const maxFrequency = Math.max(minFrequency + 1, Math.min(this.options.maxFrequency, nyquist))
    const binWidth = nyquist / magnitudes.length
    const detailValues = this.blurBufferA
    detailValues.fill(0)
    this.populatePowerValues(magnitudes)

    for (let row = 0; row < height; row += 1) {
      const bandStartBin = this.rowBandStartBins[row]
      const bandEndBin = this.rowBandEndBins[row]
      const bandPower = this.integrateBandPower(bandStartBin, bandEndBin)
      const bodyMagnitudeDb = 10 * Math.log10(Math.max(bandPower, 1e-12))
      const bodyNormalized = this.normalizeMagnitude(
        bodyMagnitudeDb,
        row,
        rowSpan,
        minDecibels,
        dbRange,
        clarity
      )

      values[row] = bodyNormalized
    }

    const blurredBodyValues = this.blurBufferB
    this.blurRows(values, blurredBodyValues, clarity.baseRadiusRows)

    for (let binIndex = 1; binIndex < magnitudes.length - 1; binIndex += 1) {
      const left = magnitudes[binIndex - 1]
      const center = magnitudes[binIndex]
      const right = magnitudes[binIndex + 1]
      if (center < left || center < right) {
        continue
      }

      const prominenceDb = center - Math.max(left, right)
      if (prominenceDb <= 0.01) {
        continue
      }
      const prominenceWeight = clamp01(prominenceDb / Math.max(0.1, clarity.peakProminenceDb))

      const peakBinPosition = this.estimatePeakBinPosition(magnitudes, binIndex)
      const peakFrequency = peakBinPosition * binWidth
      if (peakFrequency < minFrequency || peakFrequency > maxFrequency) {
        continue
      }

      const peakNormalizedPosition = normalizedPositionFromFrequency(
        this.options.scaleMode,
        minFrequency,
        maxFrequency,
        peakFrequency
      )
      const peakRowPosition = rowSpan * (1 - peakNormalizedPosition)
      const peakMagnitudeDb = this.sampleMagnitudeAtBin(magnitudes, peakBinPosition)
      const peakNormalized = this.normalizeMagnitude(
        peakMagnitudeDb,
        peakRowPosition,
        rowSpan,
        minDecibels,
        dbRange,
        clarity
      )
      const peakIntensity = peakNormalized * (0.22 + (0.78 * Math.sqrt(prominenceWeight)))

      if (peakIntensity > 0) {
        this.splatIntensity(detailValues, peakRowPosition, clarity.peakRadiusRows, peakIntensity)
      }
    }

    for (let row = 0; row < values.length; row += 1) {
      const backgroundDb = this.sampleMagnitudeAtBin(magnitudes, this.rowCenterBins[row])
      const background = this.normalizeMagnitude(
        backgroundDb,
        row,
        rowSpan,
        minDecibels,
        dbRange,
        clarity
      ) * clarity.backgroundBlend
      const body = blurredBodyValues[row] * clarity.bodyBlend
      const base = Math.max(body, background)
      const detail = detailValues[row]
      let intensity = detail > 0
        ? Math.max(base, (base * (1 - clarity.peakBlend)) + (detail * clarity.peakBlend))
        : base

      intensity = Math.max(0, intensity - clarity.floor)
      intensity = intensity <= 0 ? 0 : intensity / (1 - clarity.floor)
      values[row] = Math.pow(clamp01(intensity), clarity.gamma)
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
        this.waterfallCtx.drawImage(previousCanvas, 0, 0, width, height)
      }

      this.lastWidth = 0
    }

    this.ensureBandMapping()

    if (!this.dataSource.isPlaying()) {
      this.dataSource.getPendingSpectrogramSamples()
      this.ctx.clearRect(0, 0, width, height)
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    const pendingSamples = this.dataSource.getPendingSpectrogramSamples()
    const fftSize = this.options.fftSize
    const clarity = getClarityProfile(this.options.clarityMode)
    const hopSize = Math.max(32, Math.floor(fftSize / clarity.hopDivisor))
    const overlapSamples = fftSize - hopSize
    const dpr = window.devicePixelRatio || 1
    const baseHopSize = Math.max(32, Math.floor(fftSize / 2))
    const advancePerFrame = this.options.scrollSpeed * dpr * (hopSize / baseHopSize)

    for (const chunk of pendingSamples) {
      for (let index = 0; index < chunk.length; index += 1) {
        this.sampleBuffer[this.sampleBufferPos] = chunk[index]
        this.sampleBufferPos += 1

        if (this.sampleBufferPos >= fftSize) {
          const magnitudes = this.processFFT(this.sampleBuffer)
          const values = this.drawColumn(magnitudes)
          this.accumulatePendingColumn(values)
          this.columnAdvanceAccumulator += advancePerFrame
          const columnsToDraw = Math.floor(this.columnAdvanceAccumulator)
          if (columnsToDraw >= 1) {
            this.flushPendingColumns(columnsToDraw)
            this.columnAdvanceAccumulator -= columnsToDraw
          }

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
