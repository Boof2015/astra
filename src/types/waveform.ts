export const MIN_WAVEFORM_SCROLL_SPEED = 0.5
export const MAX_WAVEFORM_SCROLL_SPEED = 8
export const WAVEFORM_SCROLL_SPEED_STEP = 0.5
export const DEFAULT_WAVEFORM_SCROLL_SPEED = 1

export function clampWaveformScrollSpeed(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WAVEFORM_SCROLL_SPEED
  }

  const snapped = Math.round(numeric / WAVEFORM_SCROLL_SPEED_STEP) * WAVEFORM_SCROLL_SPEED_STEP
  return Math.min(MAX_WAVEFORM_SCROLL_SPEED, Math.max(MIN_WAVEFORM_SCROLL_SPEED, snapped))
}
