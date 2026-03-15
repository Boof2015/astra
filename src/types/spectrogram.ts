export type SpectrogramClarityMode = 'classic' | 'sharp' | 'sharper'
export type SpectrogramScaleMode = 'mel' | 'log' | 'linear'

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

export const DEFAULT_SPECTROGRAM_CLARITY_MODE: SpectrogramClarityMode = 'sharper'
export const DEFAULT_SPECTROGRAM_SCALE_MODE: SpectrogramScaleMode = 'log'
export const MIN_SPECTROGRAM_SCROLL_SPEED = 0.5
export const MAX_SPECTROGRAM_SCROLL_SPEED = 4
export const SPECTROGRAM_SCROLL_SPEED_STEP = 0.5
export const DEFAULT_SPECTROGRAM_SCROLL_SPEED = 2

export function isSpectrogramClarityMode(value: unknown): value is SpectrogramClarityMode {
  return typeof value === 'string' && SPECTROGRAM_CLARITY_MODES.includes(value as SpectrogramClarityMode)
}

export function isSpectrogramScaleMode(value: unknown): value is SpectrogramScaleMode {
  return typeof value === 'string' && SPECTROGRAM_SCALE_MODES.includes(value as SpectrogramScaleMode)
}

export function clampSpectrogramScrollSpeed(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTROGRAM_SCROLL_SPEED
  }

  const snapped = Math.round(numeric / SPECTROGRAM_SCROLL_SPEED_STEP) * SPECTROGRAM_SCROLL_SPEED_STEP
  return Math.min(MAX_SPECTROGRAM_SCROLL_SPEED, Math.max(MIN_SPECTROGRAM_SCROLL_SPEED, snapped))
}
