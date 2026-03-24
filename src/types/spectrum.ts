export const DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE = 2.0
export const MIN_SPECTRUM_TILT_DB_PER_OCTAVE = -2.0
export const MAX_SPECTRUM_TILT_DB_PER_OCTAVE = 8.0
export const SPECTRUM_TILT_STEP = 0.1

export const DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = 2.0
export const MIN_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = -2.0
export const MAX_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = 8.0
export const SPECTRUM_HEATMAP_TILT_STEP = 0.1

export function clampSpectrumTiltDbPerOctave(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE
  }

  const snapped = Math.round(numeric / SPECTRUM_TILT_STEP) * SPECTRUM_TILT_STEP
  const rounded = Math.round(snapped * 10) / 10
  return Math.min(
    MAX_SPECTRUM_TILT_DB_PER_OCTAVE,
    Math.max(MIN_SPECTRUM_TILT_DB_PER_OCTAVE, rounded)
  )
}

export function clampSpectrumHeatmapTiltDbPerOctave(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE
  }

  const snapped = Math.round(numeric / SPECTRUM_HEATMAP_TILT_STEP) * SPECTRUM_HEATMAP_TILT_STEP
  const rounded = Math.round(snapped * 10) / 10
  return Math.min(
    MAX_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE,
    Math.max(MIN_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE, rounded)
  )
}
