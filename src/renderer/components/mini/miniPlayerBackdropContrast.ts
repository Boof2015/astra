import { parseColorToRgb, type RgbColor } from '../../utils/color.ts'

export interface BackdropMetrics {
  luminanceMean: number
  saturationMean: number
  luminanceP20: number
  luminanceP80: number
}

export interface MiniBackdropRenderProfile {
  backdropLuminance: number
  contrastFloor: number
  visibilityBoost: number
  blendMode: 'screen' | 'normal'
  haloColor: string
  strokeColor: string
  fillColor: string
}

export interface MiniBackdropResolvedProfile extends MiniBackdropRenderProfile {
  neutralMix: number
}

const DEFAULT_ACCENT_RGB: RgbColor = { r: 56, g: 189, b: 248 }
const LIGHT_NEUTRAL_RGB: RgbColor = { r: 246, g: 248, b: 252 }
const DARK_NEUTRAL_RGB: RgbColor = { r: 20, g: 24, b: 30 }
const DEFAULT_BACKDROP_METRICS: BackdropMetrics = {
  luminanceMean: 0.24,
  saturationMean: 0.34,
  luminanceP20: 0.14,
  luminanceP80: 0.34
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function srgbToLinear(channel: number): number {
  const normalized = clamp(channel / 255, 0, 1)
  if (normalized <= 0.04045) return normalized / 12.92
  return Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function relativeLuminance(color: RgbColor): number {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function saturationFromRgb(color: RgbColor): number {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  if (max <= 0) return 0
  return clamp((max - min) / max, 0, 1)
}

function neutralHaloColorForLuminance(luminance: number): string {
  const tone = Math.round(248 + ((8 - 248) * clamp((luminance - 0.48) / 0.34, 0, 1)))
  return `rgb(${tone}, ${tone}, ${tone})`
}

function mixRgb(
  base: RgbColor,
  tint: RgbColor,
  amount: number
): RgbColor {
  const safeAmount = clamp(amount, 0, 1)
  const mixChannel = (from: number, to: number) => Math.round((from * (1 - safeAmount)) + (to * safeAmount))
  return {
    r: mixChannel(base.r, tint.r),
    g: mixChannel(base.g, tint.g),
    b: mixChannel(base.b, tint.b)
  }
}

function toCssRgb(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

function applyBackdropScrimCompensation(value: number): number {
  return clamp((value * 0.68) + 0.12, 0, 1)
}

export function deriveFallbackBackdropMetrics(lineColor: string): BackdropMetrics {
  const parsed = parseColorToRgb(lineColor)
  if (!parsed) {
    return DEFAULT_BACKDROP_METRICS
  }

  const lineLuminance = relativeLuminance(parsed)
  const mean = clamp((lineLuminance * 0.44) + 0.12, 0.14, 0.58)

  return {
    luminanceMean: mean,
    saturationMean: clamp(saturationFromRgb(parsed) * 0.66, 0.08, 0.72),
    luminanceP20: clamp(mean - 0.10, 0, 1),
    luminanceP80: clamp(mean + 0.10, 0, 1)
  }
}

export function resolveMiniBackdropRenderProfile(
  lineColor: string,
  backdropMetrics: BackdropMetrics
): MiniBackdropResolvedProfile {
  const accent = parseColorToRgb(lineColor) ?? DEFAULT_ACCENT_RGB
  const lineLuminance = relativeLuminance(accent)
  const lineSaturation = saturationFromRgb(accent)

  const backdropLuminance = applyBackdropScrimCompensation(backdropMetrics.luminanceMean)
  const luminanceP20 = applyBackdropScrimCompensation(backdropMetrics.luminanceP20)
  const luminanceP80 = applyBackdropScrimCompensation(backdropMetrics.luminanceP80)
  const backdropSaturation = clamp(backdropMetrics.saturationMean, 0, 1)

  const contrastFloor = Math.min(
    Math.abs(lineLuminance - luminanceP20),
    Math.abs(lineLuminance - luminanceP80)
  )
  const meanContrast = Math.abs(lineLuminance - backdropLuminance)
  const luminanceSpread = Math.max(0, luminanceP80 - luminanceP20)
  const neutralTarget = backdropLuminance < 0.5 ? LIGHT_NEUTRAL_RGB : DARK_NEUTRAL_RGB

  let neutralMix = clamp((0.28 - contrastFloor) / 0.22, 0, 1)
  if (luminanceSpread >= 0.38) {
    neutralMix *= 0.65
  }

  const contrastRisk = clamp(1 - (contrastFloor / 0.28), 0, 1)
  const meanContrastRisk = clamp(1 - (meanContrast / 0.42), 0, 1)
  const spreadRisk = clamp((luminanceSpread - 0.18) / 0.26, 0, 1)
  const desaturationRisk = clamp(1 - (backdropSaturation / 0.32), 0, 1)
  const lineDesaturationRisk = clamp(1 - (lineSaturation / 0.24), 0, 1)

  const visibilityBoost = clamp(
    (Math.max(contrastRisk, neutralMix, spreadRisk) * 0.58) +
    (meanContrastRisk * 0.12) +
    (spreadRisk * 0.16) +
    (desaturationRisk * 0.09) +
    (lineDesaturationRisk * 0.05),
    0,
    1
  )

  const strokeColor = toCssRgb(mixRgb(accent, neutralTarget, neutralMix * 0.78))
  const fillColor = toCssRgb(mixRgb(accent, neutralTarget, neutralMix * 0.48))
  const blendMode: 'screen' | 'normal' = (contrastFloor < 0.18 || neutralMix > 0.35)
    ? 'normal'
    : 'screen'

  return {
    backdropLuminance,
    contrastFloor,
    visibilityBoost,
    blendMode,
    haloColor: neutralHaloColorForLuminance(backdropLuminance),
    strokeColor,
    fillColor,
    neutralMix
  }
}
