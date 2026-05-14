export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface KWeightingCoeffs {
  pre: BiquadCoeffs
  rlb: BiquadCoeffs
}

interface BiquadState {
  x1: number
  x2: number
  y1: number
  y2: number
}

interface KWeightingChannelState {
  pre: BiquadState
  rlb: BiquadState
}

export interface LoudnessAnalysis {
  loudnessLufs: number
  peakLinear: number
  sampleRate: number
  frameCount: number
}

export interface StaticNormalizationGainOptions {
  targetLufs: number
  loudnessLufs: number
  peakLinear: number
  minGainDb: number
  maxGainDb: number
  peakCeilingLinear: number
}

export interface StaticNormalizationGain {
  gainDb: number
  linearGain: number
  peakLimited: boolean
}

const LOUDNESS_OFFSET_LU = -0.691
const SILENCE_ENERGY_FLOOR = 1e-20

const PRE_FILTER_GAIN_DB = 3.999843853973347
const PRE_FILTER_FREQUENCY_HZ = 1681.974450955533
const PRE_FILTER_Q = 0.7071752369554196
const RLB_FILTER_FREQUENCY_HZ = 38.13547087602444
const RLB_FILTER_Q = 0.5003270373238773

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(linear, 1e-10))
}

function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 }
}

function createKWeightingChannelState(): KWeightingChannelState {
  return {
    pre: createBiquadState(),
    rlb: createBiquadState()
  }
}

function applyBiquad(coeffs: BiquadCoeffs, state: BiquadState, input: number): number {
  const output = coeffs.b0 * input + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1 - coeffs.a2 * state.y2
  state.x2 = state.x1
  state.x1 = input
  state.y2 = state.y1
  state.y1 = output
  return output
}

function createHighShelfCoeffs(sampleRate: number): BiquadCoeffs {
  const k = Math.tan(Math.PI * PRE_FILTER_FREQUENCY_HZ / sampleRate)
  const vH = Math.pow(10, PRE_FILTER_GAIN_DB / 20)
  const vB = Math.sqrt(vH)
  const kSquared = k * k
  const normalizer = 1 + (k / PRE_FILTER_Q) + kSquared

  return {
    b0: (vH + (vB * k / PRE_FILTER_Q) + kSquared) / normalizer,
    b1: (2 * (kSquared - vH)) / normalizer,
    b2: (vH - (vB * k / PRE_FILTER_Q) + kSquared) / normalizer,
    a1: (2 * (kSquared - 1)) / normalizer,
    a2: (1 - (k / PRE_FILTER_Q) + kSquared) / normalizer
  }
}

function createHighPassCoeffs(sampleRate: number): BiquadCoeffs {
  const k = Math.tan(Math.PI * RLB_FILTER_FREQUENCY_HZ / sampleRate)
  const kSquared = k * k
  const normalizer = 1 + (k / RLB_FILTER_Q) + kSquared

  return {
    b0: 1 / normalizer,
    b1: -2 / normalizer,
    b2: 1 / normalizer,
    a1: (2 * (kSquared - 1)) / normalizer,
    a2: (1 - (k / RLB_FILTER_Q) + kSquared) / normalizer
  }
}

export function getKWeightingCoeffs(sampleRate: number): KWeightingCoeffs {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  return {
    pre: createHighShelfCoeffs(safeSampleRate),
    rlb: createHighPassCoeffs(safeSampleRate)
  }
}

function getSharedFrameCount(channels: readonly Float32Array[]): number {
  if (channels.length === 0) return 0
  let frameCount = Number.POSITIVE_INFINITY
  for (const channel of channels) {
    frameCount = Math.min(frameCount, channel.length)
  }
  return Number.isFinite(frameCount) ? Math.max(0, frameCount) : 0
}

export function calculatePeakLinear(channels: readonly Float32Array[]): number {
  let peak = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index++) {
      peak = Math.max(peak, Math.abs(channel[index] ?? 0))
    }
  }
  return peak
}

export function calculateUnweightedRmsDb(channels: readonly Float32Array[]): number {
  const frameCount = getSharedFrameCount(channels)
  if (frameCount === 0 || channels.length === 0) return -Infinity

  let sumSquares = 0
  for (const channel of channels) {
    for (let index = 0; index < frameCount; index++) {
      const sample = channel[index] ?? 0
      sumSquares += sample * sample
    }
  }

  const rms = Math.sqrt(sumSquares / (frameCount * channels.length))
  return linearToDb(rms)
}

export function analyzeKWeightedChannelData(
  channels: readonly Float32Array[],
  sampleRate: number
): LoudnessAnalysis {
  const frameCount = getSharedFrameCount(channels)
  const peakLinear = calculatePeakLinear(channels)
  if (frameCount === 0 || channels.length === 0) {
    return {
      loudnessLufs: -Infinity,
      peakLinear,
      sampleRate,
      frameCount: 0
    }
  }

  const coeffs = getKWeightingCoeffs(sampleRate)
  const states = Array.from({ length: channels.length }, () => createKWeightingChannelState())
  let weightedSumSquares = 0

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const state = states[channelIndex]
      const sample = channels[channelIndex][frameIndex] ?? 0
      const preFiltered = applyBiquad(coeffs.pre, state.pre, sample)
      const weighted = applyBiquad(coeffs.rlb, state.rlb, preFiltered)
      weightedSumSquares += weighted * weighted
    }
  }

  const meanWeightedSquare = weightedSumSquares / frameCount
  return {
    loudnessLufs: LOUDNESS_OFFSET_LU + 10 * Math.log10(Math.max(meanWeightedSquare, SILENCE_ENERGY_FLOOR)),
    peakLinear,
    sampleRate,
    frameCount
  }
}

export function analyzeRenderedKWeightedChannelData(
  channels: readonly Float32Array[],
  sampleRate: number,
  peakLinear: number = calculatePeakLinear(channels)
): LoudnessAnalysis {
  const frameCount = getSharedFrameCount(channels)
  if (frameCount === 0 || channels.length === 0) {
    return {
      loudnessLufs: -Infinity,
      peakLinear,
      sampleRate,
      frameCount: 0
    }
  }

  let weightedSumSquares = 0
  for (const channel of channels) {
    for (let index = 0; index < frameCount; index++) {
      const sample = channel[index] ?? 0
      weightedSumSquares += sample * sample
    }
  }

  const meanWeightedSquare = weightedSumSquares / frameCount
  return {
    loudnessLufs: LOUDNESS_OFFSET_LU + 10 * Math.log10(Math.max(meanWeightedSquare, SILENCE_ENERGY_FLOOR)),
    peakLinear,
    sampleRate,
    frameCount
  }
}

function getAudioBufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, channelIndex) => (
    buffer.getChannelData(channelIndex)
  ))
}

export function analyzeAudioBufferLoudnessSync(buffer: AudioBuffer): LoudnessAnalysis {
  return analyzeKWeightedChannelData(getAudioBufferChannels(buffer), buffer.sampleRate)
}

function createIIRFilter(context: BaseAudioContext, coeffs: BiquadCoeffs): IIRFilterNode {
  const filter = context.createIIRFilter(
    [coeffs.b0, coeffs.b1, coeffs.b2],
    [1, coeffs.a1, coeffs.a2]
  )
  try {
    filter.channelInterpretation = 'discrete'
  } catch {
    // Some Web Audio implementations do not allow these properties on IIRFilterNode.
  }
  return filter
}

export async function analyzeAudioBufferLoudness(buffer: AudioBuffer): Promise<LoudnessAnalysis> {
  const peakLinear = calculatePeakLinear(getAudioBufferChannels(buffer))
  const OfflineContext = globalThis.OfflineAudioContext
  if (!OfflineContext || buffer.length <= 0 || buffer.numberOfChannels <= 0) {
    return analyzeAudioBufferLoudnessSync(buffer)
  }

  try {
    const offlineContext = new OfflineContext(
      buffer.numberOfChannels,
      buffer.length,
      buffer.sampleRate
    )
    const coeffs = getKWeightingCoeffs(buffer.sampleRate)
    const source = offlineContext.createBufferSource()
    const preFilter = createIIRFilter(offlineContext, coeffs.pre)
    const rlbFilter = createIIRFilter(offlineContext, coeffs.rlb)

    source.buffer = buffer
    source.connect(preFilter)
    preFilter.connect(rlbFilter)
    rlbFilter.connect(offlineContext.destination)
    source.start(0)

    const rendered = await offlineContext.startRendering()
    return analyzeRenderedKWeightedChannelData(
      getAudioBufferChannels(rendered),
      rendered.sampleRate,
      peakLinear
    )
  } catch (error) {
    console.warn('Offline loudness analysis failed; falling back to JS K-weighting.', error)
    return analyzeAudioBufferLoudnessSync(buffer)
  }
}

export function resolveStaticNormalizationGain(
  options: StaticNormalizationGainOptions
): StaticNormalizationGain {
  if (!Number.isFinite(options.loudnessLufs)) {
    return {
      gainDb: 0,
      linearGain: 1,
      peakLimited: false
    }
  }

  const loudnessGainDb = options.targetLufs - options.loudnessLufs
  let gainDb = clamp(loudnessGainDb, options.minGainDb, options.maxGainDb)
  let peakLimited = false

  if (
    Number.isFinite(options.peakLinear)
    && options.peakLinear > 0
    && Number.isFinite(options.peakCeilingLinear)
    && options.peakCeilingLinear > 0
  ) {
    const peakSafeGainDb = linearToDb(options.peakCeilingLinear / options.peakLinear)
    if (gainDb > peakSafeGainDb) {
      gainDb = Math.max(options.minGainDb, peakSafeGainDb)
      peakLimited = true
    }
  }

  return {
    gainDb,
    linearGain: dbToLinear(gainDb),
    peakLimited
  }
}

export class ProgressiveKWeightedLoudnessAnalyzer {
  private readonly sampleRate: number
  private readonly coeffs: KWeightingCoeffs
  private states: KWeightingChannelState[] = []
  private weightedSumSquares = 0
  private frameCount = 0
  private peakLinear = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.coeffs = getKWeightingCoeffs(sampleRate)
  }

  ingest(channels: readonly Float32Array[]): void {
    const frameCount = getSharedFrameCount(channels)
    if (frameCount === 0 || channels.length === 0) return

    while (this.states.length < channels.length) {
      this.states.push(createKWeightingChannelState())
    }

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
        const sample = channels[channelIndex][frameIndex] ?? 0
        this.peakLinear = Math.max(this.peakLinear, Math.abs(sample))
        const state = this.states[channelIndex]
        const preFiltered = applyBiquad(this.coeffs.pre, state.pre, sample)
        const weighted = applyBiquad(this.coeffs.rlb, state.rlb, preFiltered)
        this.weightedSumSquares += weighted * weighted
      }
    }

    this.frameCount += frameCount
  }

  getAnalysis(): LoudnessAnalysis | null {
    if (this.frameCount <= 0) return null

    const meanWeightedSquare = this.weightedSumSquares / this.frameCount
    return {
      loudnessLufs: LOUDNESS_OFFSET_LU + 10 * Math.log10(Math.max(meanWeightedSquare, SILENCE_ENERGY_FLOOR)),
      peakLinear: this.peakLinear,
      sampleRate: this.sampleRate,
      frameCount: this.frameCount
    }
  }
}
