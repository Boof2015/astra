export type SpectrogramClarityMode = 'classic' | 'sharp' | 'sharper'
export type SpectrogramScaleMode = 'mel' | 'log' | 'linear'
export type SpectrogramOrientation = 'horizontal' | 'vertical'

export const SPECTROGRAM_CLARITY_MODES: readonly SpectrogramClarityMode[] = [
  'classic',
  'sharp',
  'sharper',
]
export const SPECTROGRAM_SCALE_MODES: readonly SpectrogramScaleMode[] = [
  'mel',
  'log',
  'linear',
]
export const SPECTROGRAM_ORIENTATIONS: readonly SpectrogramOrientation[] = [
  'horizontal',
  'vertical',
]

export const DEFAULT_SPECTROGRAM_CLARITY_MODE: SpectrogramClarityMode = 'sharper'
export const DEFAULT_SPECTROGRAM_SCALE_MODE: SpectrogramScaleMode = 'log'
export const DEFAULT_SPECTROGRAM_ORIENTATION: SpectrogramOrientation = 'horizontal'
export const MIN_SPECTROGRAM_SCROLL_SPEED = 0.5
export const MAX_SPECTROGRAM_SCROLL_SPEED = 4
export const SPECTROGRAM_SCROLL_SPEED_STEP = 0.5
export const DEFAULT_SPECTROGRAM_SCROLL_SPEED = 2

export const MIN_SPECTROGRAM_CONTRAST = 0.5
export const MAX_SPECTROGRAM_CONTRAST = 2.0
export const SPECTROGRAM_CONTRAST_STEP = 0.1
export const DEFAULT_SPECTROGRAM_CONTRAST = 1.0

export const DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE = 4.0
export const MIN_SPECTROGRAM_TILT_DB_PER_OCTAVE = -2.0
export const MAX_SPECTROGRAM_TILT_DB_PER_OCTAVE = 8.0
export const SPECTROGRAM_TILT_STEP = 0.1

export function isSpectrogramClarityMode(value: unknown): value is SpectrogramClarityMode {
  return typeof value === 'string' && SPECTROGRAM_CLARITY_MODES.includes(value as SpectrogramClarityMode)
}

export function isSpectrogramScaleMode(value: unknown): value is SpectrogramScaleMode {
  return typeof value === 'string' && SPECTROGRAM_SCALE_MODES.includes(value as SpectrogramScaleMode)
}

export function isSpectrogramOrientation(value: unknown): value is SpectrogramOrientation {
  return typeof value === 'string' && SPECTROGRAM_ORIENTATIONS.includes(value as SpectrogramOrientation)
}

export function clampSpectrogramScrollSpeed(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTROGRAM_SCROLL_SPEED
  }

  const snapped = Math.round(numeric / SPECTROGRAM_SCROLL_SPEED_STEP) * SPECTROGRAM_SCROLL_SPEED_STEP
  return Math.min(MAX_SPECTROGRAM_SCROLL_SPEED, Math.max(MIN_SPECTROGRAM_SCROLL_SPEED, snapped))
}

export function clampSpectrogramContrast(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTROGRAM_CONTRAST
  }

  const snapped = Math.round(numeric / SPECTROGRAM_CONTRAST_STEP) * SPECTROGRAM_CONTRAST_STEP
  return Math.min(MAX_SPECTROGRAM_CONTRAST, Math.max(MIN_SPECTROGRAM_CONTRAST, snapped))
}

export function clampSpectrogramTiltDbPerOctave(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTROGRAM_TILT_DB_PER_OCTAVE
  }

  const snapped = Math.round(numeric / SPECTROGRAM_TILT_STEP) * SPECTROGRAM_TILT_STEP
  const rounded = Math.round(snapped * 10) / 10
  return Math.min(
    MAX_SPECTROGRAM_TILT_DB_PER_OCTAVE,
    Math.max(MIN_SPECTROGRAM_TILT_DB_PER_OCTAVE, rounded),
  )
}
