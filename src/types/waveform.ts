export const MIN_WAVEFORM_SCROLL_SPEED = 0.5
export const MAX_WAVEFORM_SCROLL_SPEED = 8
export const WAVEFORM_SCROLL_SPEED_STEP = 0.5
export const DEFAULT_WAVEFORM_SCROLL_SPEED = 1
export const MIN_WAVEFORM_GAIN_DB = -12
export const MAX_WAVEFORM_GAIN_DB = 18
export const WAVEFORM_GAIN_DB_STEP = 0.5
export const DEFAULT_WAVEFORM_GAIN_DB = 0

export function clampWaveformScrollSpeed(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WAVEFORM_SCROLL_SPEED
  }

  const snapped = Math.round(numeric / WAVEFORM_SCROLL_SPEED_STEP) * WAVEFORM_SCROLL_SPEED_STEP
  return Math.min(MAX_WAVEFORM_SCROLL_SPEED, Math.max(MIN_WAVEFORM_SCROLL_SPEED, snapped))
}

export function clampWaveformGainDb(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WAVEFORM_GAIN_DB
  }

  const snapped = Math.round(numeric / WAVEFORM_GAIN_DB_STEP) * WAVEFORM_GAIN_DB_STEP
  const rounded = Math.round(snapped * 10) / 10
  return Math.min(MAX_WAVEFORM_GAIN_DB, Math.max(MIN_WAVEFORM_GAIN_DB, rounded))
}

// Added for ported Prism Waveform scope: mono vs stereo (multiband) display.
export type WaveformMode = 'mono' | 'stereo'

export const DEFAULT_WAVEFORM_MODE: WaveformMode = 'mono'

export function isWaveformMode(value: unknown): value is WaveformMode {
  return value === 'mono' || value === 'stereo'
}
