import type { EQBand, EQPreset } from '../types/audio'

export const EQ_MIN_GAIN_DB = -12
export const EQ_MAX_GAIN_DB = 12
export const EQ_MAX_BANDS = 20
export const EQ_MIN_FREQUENCY = 20
export const EQ_MAX_FREQUENCY = 20000
export const EQ_MIN_Q = 0.1
export const EQ_MAX_Q = 18
export const EQ_PASS_FILTER_DEFAULT_Q = 0.707
export const EQ_PRESET_VERSION = 1

type SerializableEQBand = Pick<EQBand, 'type' | 'frequency' | 'gain' | 'Q'>

interface RawEQBand {
  type?: unknown
  frequency?: unknown
  gain?: unknown
  Q?: unknown
}

interface RawEQPreset {
  name?: unknown
  preamp?: unknown
  bands?: unknown
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function coerceFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function clampEQGain(value: number): number {
  return clamp(value, EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB)
}

export function clampEQFrequency(value: number): number {
  return clamp(value, EQ_MIN_FREQUENCY, EQ_MAX_FREQUENCY)
}

export function clampEQQ(value: number): number {
  return clamp(value, EQ_MIN_Q, EQ_MAX_Q)
}

export function normalizeEQBandType(value: unknown): EQBand['type'] {
  switch (value) {
    case 'lowshelf':
    case 'peaking':
    case 'highshelf':
    case 'highpass':
    case 'lowpass':
      return value
    default:
      return 'peaking'
  }
}

export function isPassEQBandType(type: EQBand['type']): boolean {
  return type === 'highpass' || type === 'lowpass'
}

export function normalizeEQBand<T extends EQBand>(band: T): T {
  if (!isPassEQBandType(band.type) || band.gain === 0) {
    return band
  }

  return {
    ...band,
    gain: 0,
  }
}

export function createNormalizedEQBand(rawBand: RawEQBand, id: string): EQBand {
  const band: EQBand = {
    id,
    type: normalizeEQBandType(rawBand.type),
    frequency: clampEQFrequency(coerceFiniteNumber(rawBand.frequency, 1000)),
    gain: clampEQGain(coerceFiniteNumber(rawBand.gain, 0)),
    Q: clampEQQ(coerceFiniteNumber(rawBand.Q, 1.0)),
  }

  return normalizeEQBand(band)
}

function serializeEQBand(band: SerializableEQBand): SerializableEQBand {
  const normalized = normalizeEQBand({
    id: '',
    type: normalizeEQBandType(band.type),
    frequency: clampEQFrequency(coerceFiniteNumber(band.frequency, 1000)),
    gain: clampEQGain(coerceFiniteNumber(band.gain, 0)),
    Q: clampEQQ(coerceFiniteNumber(band.Q, 1.0)),
  })

  return {
    type: normalized.type,
    frequency: normalized.frequency,
    gain: normalized.gain,
    Q: normalized.Q,
  }
}

export function parseEQPresetData(value: unknown, createId: () => string): EQPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid preset file')
  }

  const rawPreset = value as RawEQPreset
  if (typeof rawPreset.name !== 'string' || rawPreset.name.trim().length === 0 || !Array.isArray(rawPreset.bands)) {
    throw new Error('Invalid preset file')
  }

  return {
    id: '',
    name: rawPreset.name.trim(),
    preamp: clampEQGain(coerceFiniteNumber(rawPreset.preamp, 0)),
    bands: rawPreset.bands.slice(0, EQ_MAX_BANDS).map((band) => (
      createNormalizedEQBand(
        band && typeof band === 'object' && !Array.isArray(band) ? band as RawEQBand : {},
        createId()
      )
    )),
  }
}

export function parseEQPresetJSON(content: string, createId: () => string): EQPreset {
  return parseEQPresetData(JSON.parse(content), createId)
}

export function serializeEQPresetData(preset: Pick<EQPreset, 'name' | 'preamp' | 'bands'>): {
  version: number
  name: string
  preamp: number
  bands: SerializableEQBand[]
} {
  return {
    version: EQ_PRESET_VERSION,
    name: preset.name,
    preamp: clampEQGain(coerceFiniteNumber(preset.preamp, 0)),
    bands: preset.bands.map(serializeEQBand),
  }
}

export function computeEQFilterMagnitude(band: EQBand, testFreq: number, sampleRate: number): number {
  if (sampleRate <= 0) {
    return 0
  }

  const w0 = (2 * Math.PI * band.frequency) / sampleRate
  const w = (2 * Math.PI * testFreq) / sampleRate
  const A = Math.pow(10, band.gain / 40)
  const sinW0 = Math.sin(w0)
  const cosW0 = Math.cos(w0)
  const alpha = sinW0 / (2 * band.Q)

  let b0: number
  let b1: number
  let b2: number
  let a0: number
  let a1: number
  let a2: number

  switch (band.type) {
    case 'peaking':
      b0 = 1 + alpha * A
      b1 = -2 * cosW0
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW0
      a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * ((A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0)
      b2 = A * ((A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = (A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = -2 * ((A - 1) + (A + 1) * cosW0)
      a2 = (A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * ((A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0)
      b2 = A * ((A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = (A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = 2 * ((A - 1) - (A + 1) * cosW0)
      a2 = (A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
    case 'lowpass':
      b0 = (1 - cosW0) / 2
      b1 = 1 - cosW0
      b2 = (1 - cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'highpass':
      b0 = (1 + cosW0) / 2
      b1 = -(1 + cosW0)
      b2 = (1 + cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
  }

  const cosW = Math.cos(w)
  const sinW = Math.sin(w)
  const cos2W = Math.cos(2 * w)
  const sin2W = Math.sin(2 * w)

  const numReal = b0 / a0 + (b1 / a0) * cosW + (b2 / a0) * cos2W
  const numImag = -(b1 / a0) * sinW - (b2 / a0) * sin2W
  const denReal = 1 + (a1 / a0) * cosW + (a2 / a0) * cos2W
  const denImag = -(a1 / a0) * sinW - (a2 / a0) * sin2W

  const numMag = Math.sqrt(numReal * numReal + numImag * numImag)
  const denMag = Math.sqrt(denReal * denReal + denImag * denImag)

  return 20 * Math.log10(numMag / (denMag + 1e-20))
}

export function computeCombinedEQMagnitude(bands: readonly EQBand[], testFreq: number, sampleRate: number): number {
  let totalDb = 0

  for (const band of bands) {
    totalDb += computeEQFilterMagnitude(band, testFreq, sampleRate)
  }

  return totalDb
}
