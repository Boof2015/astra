import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chromaOf,
  extractAdaptiveAccent,
  hueOf,
  pickAdaptiveSource,
  rgbToOklab,
  scoreColors,
  toneForTheme
} from './adaptiveAccent'

const DARK = { isLight: false, onAccent: '#050505' }
const LIGHT = { isLight: true, onAccent: '#ffffff' }

type Rgba = [number, number, number, number?]

/** A flat pixel buffer made of runs: [[colour, pixelCount], …]. */
function image(runs: Array<[Rgba, number]>): Uint8ClampedArray {
  const total = runs.reduce((sum, [, count]) => sum + count, 0)
  const pixels = new Uint8ClampedArray(total * 4)
  let offset = 0
  for (const [[r, g, b, a = 255], count] of runs) {
    for (let i = 0; i < count; i++) {
      pixels.set([r, g, b, a], offset)
      offset += 4
    }
  }
  return pixels
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance(hex: string): number {
  const linear = hexToRgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function hueDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360
  return difference > 180 ? 360 - difference : difference
}

function hueOfHex(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return hueOf(rgbToOklab(r, g, b))
}

test('a single-colour cover keeps its own hue', () => {
  const orange: Rgba = [230, 120, 30]
  const source = pickAdaptiveSource(image([[orange, 4096]]))
  assert.ok(source)
  assert.ok(hueDistance(hueOf(source), hueOf(rgbToOklab(230, 120, 30))) < 3)
})

test('large grey areas do not drown out the colour that is there', () => {
  const pixels = image([[[128, 128, 130], 7000], [[20, 20, 22], 2000], [[40, 90, 220], 1000]])
  const result = extractAdaptiveAccent(pixels, DARK)
  assert.equal(result.neutral, false)
  assert.ok(hueDistance(hueOfHex(result.hex), hueOf(rgbToOklab(40, 90, 220))) < 12)
})

test('scoring rewards hue coverage and chroma the way Material 3 does', () => {
  const muted = { lab: rgbToOklab(150, 120, 100), population: 50 }
  const vivid = { lab: rgbToOklab(230, 30, 60), population: 50 }
  const speck = { lab: rgbToOklab(30, 220, 90), population: 0.5 }
  const scored = scoreColors([muted, vivid, speck])
  assert.equal(scored.length, 2, 'a colour under 1% of the image is dropped')
  assert.equal(scored[0].lab, vivid.lab, 'at equal coverage, chroma decides')

  const mostlyMuted = scoreColors([{ ...muted, population: 90 }, { ...vivid, population: 10 }])
  assert.equal(mostlyMuted[0].lab, muted.lab, 'a small vivid area loses to a dominant colourful one')
})

test('greyscale and black-and-white covers give a neutral grey with safe contrast', () => {
  const greys = image([[[0, 0, 0], 3000], [[255, 255, 255], 3000], [[120, 120, 120], 2000]])
  for (const target of [DARK, LIGHT]) {
    const result = extractAdaptiveAccent(greys, target)
    assert.equal(result.neutral, true)
    const [r, g, b] = hexToRgb(result.hex)
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `${result.hex} should be grey`)
    assert.ok(contrast(result.hex, target.onAccent) >= 4.5)
  }
})

test('every hue tones into a valid, readable accent for both themes', () => {
  for (let hue = 0; hue < 360; hue += 5) {
    const radians = (hue * Math.PI) / 180
    const source = { L: 0.6, a: 0.15 * Math.cos(radians), b: 0.15 * Math.sin(radians) }
    for (const target of [DARK, LIGHT]) {
      const hex = toneForTheme(source, target)
      assert.match(hex, /^#[0-9a-f]{6}$/)
      assert.ok(contrast(hex, target.onAccent) >= 4.5, `hue ${hue} ${target.isLight ? 'light' : 'dark'} → ${hex}`)
      assert.ok(hueDistance(hueOfHex(hex), hue) < 8, `hue ${hue} drifted to ${hueOfHex(hex).toFixed(1)} (${hex})`)
    }
  }
})

test('muted colours are lifted to the chroma floor rather than going grey', () => {
  const dusty: Rgba = [140, 120, 110]
  const hex = extractAdaptiveAccent(image([[dusty, 4096]]), DARK).hex
  const [r, g, b] = hexToRgb(hex)
  assert.ok(chromaOf(rgbToOklab(r, g, b)) >= 0.08, `${hex} should keep visible colour`)
})

test('transparent pixels are ignored and results are deterministic', () => {
  const pixels = image([[[255, 0, 0, 0], 5000], [[30, 160, 90], 1000]])
  const first = extractAdaptiveAccent(pixels, DARK)
  assert.ok(hueDistance(hueOfHex(first.hex), hueOf(rgbToOklab(30, 160, 90))) < 12)
  assert.deepEqual(extractAdaptiveAccent(pixels, DARK), first)
  assert.equal(extractAdaptiveAccent(new Uint8ClampedArray(0), DARK).neutral, true)
})
