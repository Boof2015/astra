import { DEFAULT_THEME_ACCENT } from '../../stores/themeStore'
import { colorToRgbChannels, type RgbColor } from '../../utils/color'

export const AMBIENT_SPECTRUM_MIN_FREQ = 20
export const AMBIENT_SPECTRUM_MAX_FREQ = 20000
export const AMBIENT_SPECTRUM_TILT_DB_PER_OCTAVE = 2.4
export const AMBIENT_SPECTRUM_TILT_REFERENCE_HZ = 1000

export type { RgbColor } from '../../utils/color'
export { colorToRgbChannels, parseColorToRgb } from '../../utils/color'

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerp(start: number, end: number, t: number): number {
  return start + ((end - start) * clamp(t, 0, 1))
}

function srgbToLinear(channel: number): number {
  const normalized = clamp(channel / 255, 0, 1)
  if (normalized <= 0.04045) return normalized / 12.92
  return Math.pow((normalized + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(color: RgbColor): number {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

export function saturationFromRgb(color: RgbColor): number {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  if (max <= 0) return 0
  return clamp((max - min) / max, 0, 1)
}

export function neutralHaloColorForLuminance(luminance: number): string {
  const tone = Math.round(lerp(248, 8, clamp((luminance - 0.48) / 0.34, 0, 1)))
  return `rgb(${tone}, ${tone}, ${tone})`
}

export function colorWithAlpha(color: string, alpha: number, fallbackColor: string): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha))
  const channels = colorToRgbChannels(color)
    ?? colorToRgbChannels(fallbackColor)
    ?? colorToRgbChannels(DEFAULT_THEME_ACCENT)

  if (!channels) {
    return `rgba(0, 0, 0, ${safeAlpha})`
  }

  return `rgba(${channels}, ${safeAlpha})`
}

export function frequencyAtX(
  x: number,
  width: number,
  minFrequency: number,
  maxFrequency: number
): number {
  const t = width <= 0 ? 0 : x / width
  const safeMin = Math.max(1, minFrequency)
  const safeMax = Math.max(safeMin + 1, maxFrequency)
  const logMin = Math.log10(safeMin)
  const logMax = Math.log10(safeMax)
  return Math.pow(10, logMin + t * (logMax - logMin))
}

export function tiltOffsetAtFrequency(frequency: number): number {
  const safeFreq = Math.max(1, frequency)
  return AMBIENT_SPECTRUM_TILT_DB_PER_OCTAVE * Math.log2(safeFreq / AMBIENT_SPECTRUM_TILT_REFERENCE_HZ)
}

export function applyTilt(db: number, frequency: number): number {
  return db + tiltOffsetAtFrequency(frequency)
}
