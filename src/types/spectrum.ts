export type SpectrumDisplayMode = 'curve' | 'bars'
export type SpectrumHeatPalette = 'classic' | 'accent'

export const DEFAULT_SPECTRUM_DISPLAY_MODE: SpectrumDisplayMode = 'curve'
export const DEFAULT_SPECTRUM_HEAT_PALETTE: SpectrumHeatPalette = 'classic'

export const DEFAULT_SPECTRUM_BAR_DENSITY = 10
export const MIN_SPECTRUM_BAR_DENSITY = 4
export const MAX_SPECTRUM_BAR_DENSITY = 24
export const DEFAULT_SPECTRUM_BAR_GAP_PERCENT = 25
export const MIN_SPECTRUM_BAR_GAP_PERCENT = 0
export const MAX_SPECTRUM_BAR_GAP_PERCENT = 70
export const DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX = 2
export const MIN_SPECTRUM_BAR_CORNER_RADIUS_PX = 0
export const MAX_SPECTRUM_BAR_CORNER_RADIUS_PX = 12
export const DEFAULT_SPECTRUM_SHOW_BAR_PEAKS = false

export function isSpectrumDisplayMode(value: unknown): value is SpectrumDisplayMode {
  return value === 'curve' || value === 'bars'
}

export function isSpectrumHeatPalette(value: unknown): value is SpectrumHeatPalette {
  return value === 'classic' || value === 'accent'
}

function clampRounded(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

export function clampSpectrumBarDensity(value: unknown): number {
  return clampRounded(
    value,
    DEFAULT_SPECTRUM_BAR_DENSITY,
    MIN_SPECTRUM_BAR_DENSITY,
    MAX_SPECTRUM_BAR_DENSITY,
  )
}

export function clampSpectrumBarGapPercent(value: unknown): number {
  return clampRounded(
    value,
    DEFAULT_SPECTRUM_BAR_GAP_PERCENT,
    MIN_SPECTRUM_BAR_GAP_PERCENT,
    MAX_SPECTRUM_BAR_GAP_PERCENT,
  )
}

export function clampSpectrumBarCornerRadiusPx(value: unknown): number {
  return clampRounded(
    value,
    DEFAULT_SPECTRUM_BAR_CORNER_RADIUS_PX,
    MIN_SPECTRUM_BAR_CORNER_RADIUS_PX,
    MAX_SPECTRUM_BAR_CORNER_RADIUS_PX,
  )
}

export const DEFAULT_SPECTRUM_TILT_DB_PER_OCTAVE = 2.0
export const MIN_SPECTRUM_TILT_DB_PER_OCTAVE = -2.0
export const MAX_SPECTRUM_TILT_DB_PER_OCTAVE = 8.0
export const SPECTRUM_TILT_STEP = 0.1

export const DEFAULT_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = 2.0
export const MIN_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = -2.0
export const MAX_SPECTRUM_HEATMAP_TILT_DB_PER_OCTAVE = 8.0
export const SPECTRUM_HEATMAP_TILT_STEP = 0.1

export type SpectrumPeakInfoMode = 'off' | 'on' | 'following'

export interface SpectrumPitchInfo {
  note: string
  octave: number
  cents: number
}

export interface SpectrumPeakInfo {
  db: number
  frequencyHz: number
  normalizedX: number
  normalizedY: number
  key: string
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export const DEFAULT_SPECTRUM_PEAK_INFO_MODE: SpectrumPeakInfoMode = 'off'

export function isSpectrumPeakInfoMode(value: unknown): value is SpectrumPeakInfoMode {
  return value === 'off' || value === 'on' || value === 'following'
}

export function normalizeSpectrumPeakInfoMode(value: unknown): SpectrumPeakInfoMode {
  return isSpectrumPeakInfoMode(value) ? value : DEFAULT_SPECTRUM_PEAK_INFO_MODE
}

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

export function resolveSpectrumPitchInfo(frequencyHz: number): SpectrumPitchInfo | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return null
  }

  const midiNote = 69 + (12 * Math.log2(frequencyHz / 440))
  const nearestMidiNote = Math.round(midiNote)
  const cents = Math.round((midiNote - nearestMidiNote) * 100)
  const noteIndex = ((nearestMidiNote % 12) + 12) % 12
  const octave = Math.floor(nearestMidiNote / 12) - 1

  return {
    note: NOTE_NAMES[noteIndex],
    octave,
    cents,
  }
}

export function formatSpectrumPitchInfo(pitchInfo: SpectrumPitchInfo | null): string {
  if (!pitchInfo) {
    return '--'
  }

  const centsLabel = pitchInfo.cents > 0
    ? `+${pitchInfo.cents}c`
    : `${pitchInfo.cents}c`

  return `${pitchInfo.note}${pitchInfo.octave} ${centsLabel}`
}
