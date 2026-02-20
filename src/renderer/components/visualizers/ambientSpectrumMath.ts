import { DEFAULT_THEME_ACCENT } from '../../stores/themeStore'

export const AMBIENT_SPECTRUM_MIN_FREQ = 20
export const AMBIENT_SPECTRUM_MAX_FREQ = 20000
export const AMBIENT_SPECTRUM_TILT_DB_PER_OCTAVE = 2.4
export const AMBIENT_SPECTRUM_TILT_REFERENCE_HZ = 1000

export interface RgbColor {
  r: number
  g: number
  b: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerp(start: number, end: number, t: number): number {
  return start + ((end - start) * clamp(t, 0, 1))
}

function parseRgbToken(value: string): number | null {
  const token = value.trim()
  if (!token) return null

  if (token.endsWith('%')) {
    const percent = Number.parseFloat(token.slice(0, -1))
    if (!Number.isFinite(percent)) return null
    return clamp((percent / 100) * 255, 0, 255)
  }

  const numeric = Number.parseFloat(token)
  if (!Number.isFinite(numeric)) return null
  return clamp(numeric, 0, 255)
}

export function parseColorToRgb(color: string): RgbColor | null {
  const normalizedColor = color.trim()

  if (normalizedColor.startsWith('#')) {
    const hex = normalizedColor.slice(1)
    const normalizedHex = hex.length === 3
      ? hex.split('').map((ch) => `${ch}${ch}`).join('')
      : hex

    if (normalizedHex.length === 6) {
      const r = Number.parseInt(normalizedHex.slice(0, 2), 16)
      const g = Number.parseInt(normalizedHex.slice(2, 4), 16)
      const b = Number.parseInt(normalizedHex.slice(4, 6), 16)
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
      return { r, g, b }
    }
  }

  const rgbMatch = /^rgba?\((.*)\)$/i.exec(normalizedColor)
  if (!rgbMatch) return null

  const rawBody = rgbMatch[1]?.trim()
  if (!rawBody) return null

  const body = rawBody.includes('/')
    ? rawBody.split('/')[0]?.trim() ?? ''
    : rawBody
  if (!body) return null

  const tokens = body.includes(',')
    ? body.split(',').map((token) => token.trim())
    : body.split(/\s+/).filter(Boolean)
  if (tokens.length < 3) return null

  const r = parseRgbToken(tokens[0])
  const g = parseRgbToken(tokens[1])
  const b = parseRgbToken(tokens[2])
  if (r === null || g === null || b === null) return null

  return {
    r: Math.round(r),
    g: Math.round(g),
    b: Math.round(b),
  }
}

export function colorToRgbChannels(color: string): string | null {
  const rgb = parseColorToRgb(color)
  if (!rgb) return null
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
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
