import assert from 'node:assert/strict'
import test from 'node:test'
import { parseColorToRgb } from '../../utils/color.ts'
import {
  deriveFallbackBackdropMetrics,
  resolveMiniBackdropRenderProfile,
  type BackdropMetrics
} from './miniPlayerBackdropContrast.ts'

function srgbToLinear(channel: number): number {
  const normalized = Math.max(0, Math.min(1, channel / 255))
  if (normalized <= 0.04045) return normalized / 12.92
  return Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function colorLuminance(color: string): number {
  const rgb = parseColorToRgb(color)
  assert.ok(rgb, `Expected a parseable color, received ${color}`)
  return (
    (0.2126 * srgbToLinear(rgb.r)) +
    (0.7152 * srgbToLinear(rgb.g)) +
    (0.0722 * srgbToLinear(rgb.b))
  )
}

function colorDistance(left: string, right: string): number {
  const leftRgb = parseColorToRgb(left)
  const rightRgb = parseColorToRgb(right)
  assert.ok(leftRgb && rightRgb, 'Expected parseable colors for distance comparison')
  const dr = leftRgb.r - rightRgb.r
  const dg = leftRgb.g - rightRgb.g
  const db = leftRgb.b - rightRgb.b
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db))
}

function metrics(overrides: Partial<BackdropMetrics>): BackdropMetrics {
  return {
    luminanceMean: 0.24,
    saturationMean: 0.34,
    luminanceP20: 0.14,
    luminanceP80: 0.34,
    ...overrides
  }
}

test('bright backdrop and bright accent shift the miniplayer stroke darker and use normal blending', () => {
  const accent = '#f4f7fb'
  const profile = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.92,
    saturationMean: 0.05,
    luminanceP20: 0.88,
    luminanceP80: 0.96
  }))

  assert.equal(profile.blendMode, 'normal')
  assert.ok(colorLuminance(profile.strokeColor) < colorLuminance(accent))
  assert.ok(profile.neutralMix > 0.35)
})

test('dark backdrop and dark accent shift the miniplayer stroke lighter', () => {
  const accent = '#0f172a'
  const profile = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.05,
    saturationMean: 0.18,
    luminanceP20: 0.02,
    luminanceP80: 0.08
  }))

  assert.equal(profile.blendMode, 'normal')
  assert.ok(colorLuminance(profile.strokeColor) > colorLuminance(accent))
  assert.ok(profile.neutralMix > 0.35)
})

test('safe backdrop and accent keep the stroke close to the source accent and preserve screen blending', () => {
  const accent = '#38bdf8'
  const profile = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.02,
    saturationMean: 0.34,
    luminanceP20: 0,
    luminanceP80: 0.08
  }))

  assert.equal(profile.blendMode, 'screen')
  assert.ok(colorDistance(profile.strokeColor, accent) < 20)
  assert.ok(profile.neutralMix < 0.12)
})

test('high-variance backdrops reduce neutral mixing while still increasing visibility treatment', () => {
  const accent = '#6c86a0'
  const lowVariance = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.34,
    saturationMean: 0.22,
    luminanceP20: 0.30,
    luminanceP80: 0.38
  }))
  const highVariance = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.34,
    saturationMean: 0.22,
    luminanceP20: 0,
    luminanceP80: 0.70
  }))
  const safeProfile = resolveMiniBackdropRenderProfile(accent, metrics({
    luminanceMean: 0.08,
    saturationMean: 0.34,
    luminanceP20: 0.04,
    luminanceP80: 0.12
  }))

  assert.ok(highVariance.neutralMix < lowVariance.neutralMix)
  assert.ok(highVariance.visibilityBoost > safeProfile.visibilityBoost)
})

test('fallback metrics resolve to a stable, non-null render profile', () => {
  const fallbackMetrics = deriveFallbackBackdropMetrics('not-a-color')
  const profile = resolveMiniBackdropRenderProfile('not-a-color', fallbackMetrics)

  assert.ok(Number.isFinite(profile.backdropLuminance))
  assert.ok(Number.isFinite(profile.contrastFloor))
  assert.ok(Number.isFinite(profile.visibilityBoost))
  assert.match(profile.strokeColor, /^rgb\(/)
  assert.match(profile.fillColor, /^rgb\(/)
  assert.match(profile.haloColor, /^rgb\(/)
})
