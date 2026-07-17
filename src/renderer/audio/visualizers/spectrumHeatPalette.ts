import type { SpectrumHeatPalette } from '../../../types/spectrum'
import { parseColorToRgb, type RgbColor } from '../../utils/color'

export const CLASSIC_SPECTRUM_HEAT_COLORS: [string, string, string] = [
  'rgb(15, 7, 33)',
  'rgb(163, 26, 121)',
  'rgb(255, 241, 209)',
]

function mixRgb(from: RgbColor, toward: RgbColor, towardAmount: number): RgbColor {
  const amount = Math.min(1, Math.max(0, towardAmount))
  return {
    r: Math.round(from.r + ((toward.r - from.r) * amount)),
    g: Math.round(from.g + ((toward.g - from.g) * amount)),
    b: Math.round(from.b + ((toward.b - from.b) * amount)),
  }
}

function toCss(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

export function resolveSpectrumHeatColors(
  palette: SpectrumHeatPalette,
  effectiveAccent: string,
  analyzerBackground: string,
  isLight: boolean,
): [string, string, string] {
  if (palette === 'classic') return [...CLASSIC_SPECTRUM_HEAT_COLORS]

  const accent = parseColorToRgb(effectiveAccent) ?? { r: 56, g: 189, b: 248 }
  const background = parseColorToRgb(analyzerBackground)
    ?? (isLight ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 })
  const highTarget = isLight
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }

  return [
    toCss(mixRgb(accent, background, 0.7)),
    toCss(accent),
    toCss(mixRgb(accent, highTarget, 0.7)),
  ]
}
