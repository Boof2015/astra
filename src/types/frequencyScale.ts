export type FrequencyScaleMode = 'log' | 'mel' | 'linear'
export type FrequencyRangeMode = 'extended' | 'audible'

export interface FrequencyBounds {
  minFrequency: number
  maxFrequency: number
}

export interface FrequencyGuide {
  frequencyHz: number
  normalizedPosition: number
  kind: 'major' | 'minor'
  label?: string
}

export const FREQUENCY_SCALE_MODES: readonly FrequencyScaleMode[] = [
  'log',
  'mel',
  'linear',
]

export const DEFAULT_FREQUENCY_SCALE_MODE: FrequencyScaleMode = 'log'
export const DEFAULT_FREQUENCY_RANGE_MODE: FrequencyRangeMode = 'audible'

export const FREQUENCY_RANGE_MODES: readonly FrequencyRangeMode[] = [
  'extended',
  'audible',
]

const SLANEY_F_SP = 200 / 3
const SLANEY_MIN_LOG_HZ = 1000
const SLANEY_MIN_LOG_MEL = SLANEY_MIN_LOG_HZ / SLANEY_F_SP
const SLANEY_LOG_STEP = Math.log(6.4) / 27

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function resolvePositiveFrequency(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveFrequencyBounds(
  minFrequency: number,
  maxFrequency: number,
): { minFrequency: number; maxFrequency: number } {
  const min = resolvePositiveFrequency(minFrequency, 1)
  const max = resolvePositiveFrequency(maxFrequency, min)
  return {
    minFrequency: min,
    maxFrequency: Math.max(min, max),
  }
}

function hzToMelSlaney(frequencyHz: number): number {
  return frequencyHz < SLANEY_MIN_LOG_HZ
    ? frequencyHz / SLANEY_F_SP
    : SLANEY_MIN_LOG_MEL + (Math.log(frequencyHz / SLANEY_MIN_LOG_HZ) / SLANEY_LOG_STEP)
}

function melToHzSlaney(mel: number): number {
  return mel < SLANEY_MIN_LOG_MEL
    ? mel * SLANEY_F_SP
    : SLANEY_MIN_LOG_HZ * Math.exp(SLANEY_LOG_STEP * (mel - SLANEY_MIN_LOG_MEL))
}

export function isFrequencyScaleMode(value: unknown): value is FrequencyScaleMode {
  return typeof value === 'string' && FREQUENCY_SCALE_MODES.includes(value as FrequencyScaleMode)
}

export function normalizeFrequencyScaleMode(value: unknown): FrequencyScaleMode {
  return isFrequencyScaleMode(value) ? value : DEFAULT_FREQUENCY_SCALE_MODE
}

export function isFrequencyRangeMode(value: unknown): value is FrequencyRangeMode {
  return typeof value === 'string' && FREQUENCY_RANGE_MODES.includes(value as FrequencyRangeMode)
}

export function normalizeFrequencyRangeMode(
  value: unknown,
  fallback: FrequencyRangeMode = DEFAULT_FREQUENCY_RANGE_MODE,
): FrequencyRangeMode {
  return isFrequencyRangeMode(value) ? value : fallback
}

export function nominalFrequencyBoundsForRange(mode: FrequencyRangeMode): FrequencyBounds {
  return mode === 'audible'
    ? { minFrequency: 20, maxFrequency: 20000 }
    : { minFrequency: 10, maxFrequency: 24000 }
}

export function frequencyBoundsForRange(
  mode: FrequencyRangeMode,
  sampleRate: number,
): FrequencyBounds {
  const nominal = nominalFrequencyBoundsForRange(mode)
  return clampFrequencyRangeToNyquist(
    sampleRate,
    nominal.minFrequency,
    nominal.maxFrequency,
  )
}

export function frequencyRangeLabel(mode: FrequencyRangeMode): string {
  return mode === 'audible' ? 'Audible' : 'Extended'
}

export function clampFrequencyRangeToNyquist(
  sampleRate: number,
  minFrequency: number,
  maxFrequency: number,
): { minFrequency: number; maxFrequency: number } {
  const nyquist = Math.max(2, Number.isFinite(sampleRate) ? sampleRate : 0) / 2
  const requestedMin = resolvePositiveFrequency(minFrequency, 1)
  const requestedMax = resolvePositiveFrequency(maxFrequency, nyquist)
  const min = Math.min(requestedMin, nyquist)
  return {
    minFrequency: min,
    maxFrequency: Math.max(min, Math.min(requestedMax, nyquist)),
  }
}

export function frequencyAtNormalizedPosition(
  position: number,
  minFrequency: number,
  maxFrequency: number,
  scaleMode: FrequencyScaleMode,
): number {
  const t = clamp01(position)
  const range = resolveFrequencyBounds(minFrequency, maxFrequency)
  if (range.maxFrequency <= range.minFrequency) return range.minFrequency

  if (scaleMode === 'linear') {
    return range.minFrequency + t * (range.maxFrequency - range.minFrequency)
  }
  if (scaleMode === 'mel') {
    const melMin = hzToMelSlaney(range.minFrequency)
    const melMax = hzToMelSlaney(range.maxFrequency)
    return melToHzSlaney(melMin + t * (melMax - melMin))
  }

  const logMin = Math.log10(range.minFrequency)
  const logMax = Math.log10(range.maxFrequency)
  return 10 ** (logMin + t * (logMax - logMin))
}

export function normalizedPositionAtFrequency(
  frequencyHz: number,
  minFrequency: number,
  maxFrequency: number,
  scaleMode: FrequencyScaleMode,
): number {
  const range = resolveFrequencyBounds(minFrequency, maxFrequency)
  if (range.maxFrequency <= range.minFrequency) return 0
  const frequency = Math.max(range.minFrequency, Math.min(range.maxFrequency, frequencyHz))

  if (scaleMode === 'linear') {
    return (frequency - range.minFrequency) / (range.maxFrequency - range.minFrequency)
  }
  if (scaleMode === 'mel') {
    const melMin = hzToMelSlaney(range.minFrequency)
    const melMax = hzToMelSlaney(range.maxFrequency)
    return (hzToMelSlaney(frequency) - melMin) / (melMax - melMin)
  }

  const logMin = Math.log10(range.minFrequency)
  const logMax = Math.log10(range.maxFrequency)
  return (Math.log10(frequency) - logMin) / (logMax - logMin)
}

export function formatFrequencyGuideLabel(frequencyHz: number): string {
  if (frequencyHz >= 1000) {
    const kilohertz = frequencyHz / 1000
    return `${Number.isInteger(kilohertz) ? kilohertz.toFixed(0) : kilohertz.toFixed(1)}k`
  }
  return `${Math.round(frequencyHz)}`
}

export function buildFrequencyGuides(
  minFrequency: number,
  maxFrequency: number,
  scaleMode: FrequencyScaleMode,
  pixelSpan: number,
): FrequencyGuide[] {
  const range = resolveFrequencyBounds(minFrequency, maxFrequency)
  if (range.maxFrequency <= range.minFrequency || pixelSpan <= 0) return []

  const candidates: FrequencyGuide[] = []
  const firstExponent = Math.floor(Math.log10(range.minFrequency))
  const lastExponent = Math.ceil(Math.log10(range.maxFrequency))

  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const decade = 10 ** exponent
    for (let multiplier = 1; multiplier <= 9; multiplier += 1) {
      const frequencyHz = multiplier * decade
      if (frequencyHz <= range.minFrequency || frequencyHz >= range.maxFrequency) continue
      const major = multiplier === 1 || multiplier === 2 || multiplier === 5
      candidates.push({
        frequencyHz,
        normalizedPosition: normalizedPositionAtFrequency(
          frequencyHz,
          range.minFrequency,
          range.maxFrequency,
          scaleMode,
        ),
        kind: major ? 'major' : 'minor',
        ...(major ? { label: formatFrequencyGuideLabel(frequencyHz) } : {}),
      })
    }
  }

  candidates.sort((left, right) => left.normalizedPosition - right.normalizedPosition)
  const minimumSpacing = candidates.reduce((minimum, guide, index) => {
    if (index === 0) return minimum
    const previous = candidates[index - 1]
    return Math.min(
      minimum,
      (guide.normalizedPosition - previous.normalizedPosition) * pixelSpan,
    )
  }, Number.POSITIVE_INFINITY)
  const includeMinorGuides = minimumSpacing >= 8

  return includeMinorGuides
    ? candidates
    : candidates.filter((guide) => guide.kind === 'major')
}
