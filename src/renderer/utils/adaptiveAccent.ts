/**
 * "Adaptive" cover-art accent: Astra's take on Material 3's colour extraction.
 *
 *   1. 5-bit RGB histogram of the (already downsampled) artwork — the only pass
 *      over pixels.
 *   2. Wu quantization over the histogram's moment tables for starting clusters.
 *   3. Weighted k-means in OKLab over the distinct histogram colours.
 *   4. M3-style scoring: hue-neighbourhood population share plus a chroma bonus,
 *      with near-greys and specks filtered out.
 *   5. Re-tone the winner for the theme: keep its hue and (floored) chroma, set
 *      lightness for the theme, gamut-map, and guarantee contrast with the text
 *      that sits on accent fills.
 *
 * OKLab/OKLCH stands in for M3's CAM16/HCT: the same kind of perceptual hue and
 * chroma for a fraction of the maths, and colours are only converted per
 * distinct histogram bin and per cluster, never per pixel. Pure module — no DOM.
 */

export interface AdaptiveAccentTarget {
  isLight: boolean
  /** The text colour drawn on accent fills; the accent must contrast with it. */
  onAccent: string
}

export interface AdaptiveAccentResult {
  hex: string
  /** True when the artwork had no usable colour and a grey was produced. */
  neutral: boolean
}

export interface Oklab {
  L: number
  a: number
  b: number
}

export interface WeightedColor {
  lab: Oklab
  population: number
}

const MIN_ALPHA = 48
const HISTOGRAM_BITS = 5
const HISTOGRAM_SIDE = 1 << HISTOGRAM_BITS
const MAX_CLUSTERS = 16
const KMEANS_MAX_ITERATIONS = 6

// Scoring runs in CAM16-like chroma units so Material 3's weights carry over.
// OKLCH chroma × ~360 lands close to CAM16 chroma across the sRGB hues.
const CHROMA_UNITS = 360
const CHROMA_CUTOFF = 5
const CHROMA_TARGET = 48
const MIN_EXCITED_PROPORTION = 0.01
const HUE_WINDOW_BEFORE = 14
const HUE_WINDOW_AFTER = 15

// Toning, in OKLCH. Faithful to the cover's chroma, but never duller than the floor.
const CHROMA_FLOOR = 0.09
// Each theme has a preferred accent lightness and a band it may drift within.
// Hues whose sRGB gamut is narrow at the preferred lightness (deep blues and
// violets on dark themes) move toward where they can keep their colour.
const DARK_THEME_LIGHTNESS = { preferred: 0.74, min: 0.64, max: 0.8 }
const LIGHT_THEME_LIGHTNESS = { preferred: 0.5, min: 0.42, max: 0.56 }
/** Chroma a candidate must gain to justify each unit of lightness drift. */
const LIGHTNESS_DRIFT_COST = 0.5
const MIN_ON_ACCENT_CONTRAST = 4.5

// ── Colour maths ─────────────────────────────────────────

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(Math.max(0, Math.min(1, c)) * 255)
}

export function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

/** OKLab → linear sRGB; channels may fall outside [0, 1] for out-of-gamut colours. */
function oklabToLinearRgb({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

function oklch(L: number, chroma: number, hueDegrees: number): Oklab {
  const radians = (hueDegrees * Math.PI) / 180
  return { L, a: chroma * Math.cos(radians), b: chroma * Math.sin(radians) }
}

export function chromaOf({ a, b }: Oklab): number {
  return Math.hypot(a, b)
}

export function hueOf({ a, b }: Oklab): number {
  const degrees = (Math.atan2(b, a) * 180) / Math.PI
  return degrees < 0 ? degrees + 360 : degrees
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const epsilon = 1e-4
  return r >= -epsilon && r <= 1 + epsilon && g >= -epsilon && g <= 1 + epsilon && b >= -epsilon && b <= 1 + epsilon
}

function linearToHex([r, g, b]: [number, number, number]): string {
  const toHex = (value: number) => linearToSrgb(value).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function relativeLuminanceOfLinear([r, g, b]: [number, number, number]): number {
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b)
}

function luminanceOfHex(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return relativeLuminanceOfLinear([
    srgbToLinear((value >> 16) & 255),
    srgbToLinear((value >> 8) & 255),
    srgbToLinear(value & 255)
  ])
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// ── 1. Histogram ─────────────────────────────────────────

export interface ColorHistogram {
  /** Per 5-bit bin: pixel count, RGB sums and the sum of squared channels. */
  counts: Uint32Array
  sumR: Float64Array
  sumG: Float64Array
  sumB: Float64Array
  sumSquares: Float64Array
  total: number
}

export function buildHistogram(pixels: ArrayLike<number>): ColorHistogram {
  const size = HISTOGRAM_SIDE ** 3
  const histogram: ColorHistogram = {
    counts: new Uint32Array(size),
    sumR: new Float64Array(size),
    sumG: new Float64Array(size),
    sumB: new Float64Array(size),
    sumSquares: new Float64Array(size),
    total: 0
  }
  const shift = 8 - HISTOGRAM_BITS
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < MIN_ALPHA) continue
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const bin = ((r >> shift) << (HISTOGRAM_BITS * 2)) | ((g >> shift) << HISTOGRAM_BITS) | (b >> shift)
    histogram.counts[bin] += 1
    histogram.sumR[bin] += r
    histogram.sumG[bin] += g
    histogram.sumB[bin] += b
    histogram.sumSquares[bin] += r * r + g * g + b * b
    histogram.total += 1
  }
  return histogram
}

// ── 2. Wu quantization ───────────────────────────────────

const WU_SIDE = HISTOGRAM_SIDE + 1

interface WuBox {
  r0: number; r1: number
  g0: number; g1: number
  b0: number; b1: number
  vol: number
}

type Axis = 0 | 1 | 2

function wuIndex(r: number, g: number, b: number): number {
  return r * WU_SIDE * WU_SIDE + g * WU_SIDE + b
}

interface WuMoments {
  weights: Float64Array
  momentsR: Float64Array
  momentsG: Float64Array
  momentsB: Float64Array
  moments: Float64Array
}

function buildWuMoments(histogram: ColorHistogram): WuMoments {
  const size = WU_SIDE ** 3
  const table: WuMoments = {
    weights: new Float64Array(size),
    momentsR: new Float64Array(size),
    momentsG: new Float64Array(size),
    momentsB: new Float64Array(size),
    moments: new Float64Array(size)
  }
  const mask = HISTOGRAM_SIDE - 1
  for (let bin = 0; bin < histogram.counts.length; bin++) {
    if (histogram.counts[bin] === 0) continue
    const index = wuIndex(((bin >> (HISTOGRAM_BITS * 2)) & mask) + 1, ((bin >> HISTOGRAM_BITS) & mask) + 1, (bin & mask) + 1)
    table.weights[index] += histogram.counts[bin]
    table.momentsR[index] += histogram.sumR[bin]
    table.momentsG[index] += histogram.sumG[bin]
    table.momentsB[index] += histogram.sumB[bin]
    table.moments[index] += histogram.sumSquares[bin]
  }

  // Turn the tables into 3-D cumulative sums so any box's totals are 8 lookups.
  const area = new Float64Array(WU_SIDE)
  const areaR = new Float64Array(WU_SIDE)
  const areaG = new Float64Array(WU_SIDE)
  const areaB = new Float64Array(WU_SIDE)
  const area2 = new Float64Array(WU_SIDE)
  for (let r = 1; r < WU_SIDE; r++) {
    area.fill(0); areaR.fill(0); areaG.fill(0); areaB.fill(0); area2.fill(0)
    for (let g = 1; g < WU_SIDE; g++) {
      let line = 0
      let lineR = 0
      let lineG = 0
      let lineB = 0
      let line2 = 0
      for (let b = 1; b < WU_SIDE; b++) {
        const index = wuIndex(r, g, b)
        line += table.weights[index]
        lineR += table.momentsR[index]
        lineG += table.momentsG[index]
        lineB += table.momentsB[index]
        line2 += table.moments[index]
        area[b] += line
        areaR[b] += lineR
        areaG[b] += lineG
        areaB[b] += lineB
        area2[b] += line2
        const previous = wuIndex(r - 1, g, b)
        table.weights[index] = table.weights[previous] + area[b]
        table.momentsR[index] = table.momentsR[previous] + areaR[b]
        table.momentsG[index] = table.momentsG[previous] + areaG[b]
        table.momentsB[index] = table.momentsB[previous] + areaB[b]
        table.moments[index] = table.moments[previous] + area2[b]
      }
    }
  }
  return table
}

function boxVolume(box: WuBox, moment: Float64Array): number {
  return (
    moment[wuIndex(box.r1, box.g1, box.b1)]
    - moment[wuIndex(box.r1, box.g1, box.b0)]
    - moment[wuIndex(box.r1, box.g0, box.b1)]
    + moment[wuIndex(box.r1, box.g0, box.b0)]
    - moment[wuIndex(box.r0, box.g1, box.b1)]
    + moment[wuIndex(box.r0, box.g1, box.b0)]
    + moment[wuIndex(box.r0, box.g0, box.b1)]
    - moment[wuIndex(box.r0, box.g0, box.b0)]
  )
}

function boxBottom(box: WuBox, axis: Axis, moment: Float64Array): number {
  if (axis === 0) {
    return -moment[wuIndex(box.r0, box.g1, box.b1)] + moment[wuIndex(box.r0, box.g1, box.b0)]
      + moment[wuIndex(box.r0, box.g0, box.b1)] - moment[wuIndex(box.r0, box.g0, box.b0)]
  }
  if (axis === 1) {
    return -moment[wuIndex(box.r1, box.g0, box.b1)] + moment[wuIndex(box.r1, box.g0, box.b0)]
      + moment[wuIndex(box.r0, box.g0, box.b1)] - moment[wuIndex(box.r0, box.g0, box.b0)]
  }
  return -moment[wuIndex(box.r1, box.g1, box.b0)] + moment[wuIndex(box.r1, box.g0, box.b0)]
    + moment[wuIndex(box.r0, box.g1, box.b0)] - moment[wuIndex(box.r0, box.g0, box.b0)]
}

function boxTop(box: WuBox, axis: Axis, position: number, moment: Float64Array): number {
  if (axis === 0) {
    return moment[wuIndex(position, box.g1, box.b1)] - moment[wuIndex(position, box.g1, box.b0)]
      - moment[wuIndex(position, box.g0, box.b1)] + moment[wuIndex(position, box.g0, box.b0)]
  }
  if (axis === 1) {
    return moment[wuIndex(box.r1, position, box.b1)] - moment[wuIndex(box.r1, position, box.b0)]
      - moment[wuIndex(box.r0, position, box.b1)] + moment[wuIndex(box.r0, position, box.b0)]
  }
  return moment[wuIndex(box.r1, box.g1, position)] - moment[wuIndex(box.r1, box.g0, position)]
    - moment[wuIndex(box.r0, box.g1, position)] + moment[wuIndex(box.r0, box.g0, position)]
}

function boxVariance(box: WuBox, table: WuMoments): number {
  const dr = boxVolume(box, table.momentsR)
  const dg = boxVolume(box, table.momentsG)
  const db = boxVolume(box, table.momentsB)
  const weight = boxVolume(box, table.weights)
  if (weight <= 0) return 0
  return boxVolume(box, table.moments) - (dr * dr + dg * dg + db * db) / weight
}

function maximizeSplit(
  box: WuBox,
  axis: Axis,
  first: number,
  last: number,
  whole: [number, number, number, number],
  table: WuMoments
): { cut: number; score: number } {
  const bottomR = boxBottom(box, axis, table.momentsR)
  const bottomG = boxBottom(box, axis, table.momentsG)
  const bottomB = boxBottom(box, axis, table.momentsB)
  const bottomW = boxBottom(box, axis, table.weights)
  let best = 0
  let cut = -1
  for (let position = first; position < last; position++) {
    let halfR = bottomR + boxTop(box, axis, position, table.momentsR)
    let halfG = bottomG + boxTop(box, axis, position, table.momentsG)
    let halfB = bottomB + boxTop(box, axis, position, table.momentsB)
    let halfW = bottomW + boxTop(box, axis, position, table.weights)
    if (halfW === 0) continue
    let score = (halfR * halfR + halfG * halfG + halfB * halfB) / halfW
    halfR = whole[0] - halfR
    halfG = whole[1] - halfG
    halfB = whole[2] - halfB
    halfW = whole[3] - halfW
    if (halfW === 0) continue
    score += (halfR * halfR + halfG * halfG + halfB * halfB) / halfW
    if (score > best) {
      best = score
      cut = position
    }
  }
  return { cut, score: best }
}

function volumeOf(box: WuBox): number {
  return (box.r1 - box.r0) * (box.g1 - box.g0) * (box.b1 - box.b0)
}

function splitBox(one: WuBox, two: WuBox, table: WuMoments): boolean {
  const whole: [number, number, number, number] = [
    boxVolume(one, table.momentsR),
    boxVolume(one, table.momentsG),
    boxVolume(one, table.momentsB),
    boxVolume(one, table.weights)
  ]
  const red = maximizeSplit(one, 0, one.r0 + 1, one.r1, whole, table)
  const green = maximizeSplit(one, 1, one.g0 + 1, one.g1, whole, table)
  const blue = maximizeSplit(one, 2, one.b0 + 1, one.b1, whole, table)

  let axis: Axis
  if (red.score >= green.score && red.score >= blue.score) {
    if (red.cut < 0) return false
    axis = 0
  } else if (green.score >= blue.score) {
    axis = 1
  } else {
    axis = 2
  }

  two.r1 = one.r1
  two.g1 = one.g1
  two.b1 = one.b1
  if (axis === 0) {
    one.r1 = red.cut
    two.r0 = one.r1; two.g0 = one.g0; two.b0 = one.b0
  } else if (axis === 1) {
    one.g1 = green.cut
    two.r0 = one.r0; two.g0 = one.g1; two.b0 = one.b0
  } else {
    one.b1 = blue.cut
    two.r0 = one.r0; two.g0 = one.g0; two.b0 = one.b1
  }
  one.vol = volumeOf(one)
  two.vol = volumeOf(two)
  return true
}

/** Wu's variance-minimizing colour quantizer; returns cluster means in sRGB. */
export function quantizeWu(histogram: ColorHistogram, maxColors = MAX_CLUSTERS): Array<{ rgb: [number, number, number]; population: number }> {
  if (histogram.total === 0) return []
  const table = buildWuMoments(histogram)
  const boxes: WuBox[] = Array.from({ length: maxColors }, () => ({ r0: 0, r1: 0, g0: 0, g1: 0, b0: 0, b1: 0, vol: 0 }))
  boxes[0] = { r0: 0, r1: HISTOGRAM_SIDE, g0: 0, g1: HISTOGRAM_SIDE, b0: 0, b1: HISTOGRAM_SIDE, vol: 0 }
  boxes[0].vol = volumeOf(boxes[0])
  const variance = new Float64Array(maxColors)
  let boxCount = maxColors
  let next = 0
  for (let i = 1; i < maxColors; i++) {
    if (splitBox(boxes[next], boxes[i], table)) {
      variance[next] = boxes[next].vol > 1 ? boxVariance(boxes[next], table) : 0
      variance[i] = boxes[i].vol > 1 ? boxVariance(boxes[i], table) : 0
    } else {
      variance[next] = 0
      i--
    }
    next = 0
    let highest = variance[0]
    for (let j = 1; j <= i; j++) {
      if (variance[j] > highest) {
        highest = variance[j]
        next = j
      }
    }
    if (highest <= 0) {
      boxCount = i + 1
      break
    }
  }

  const clusters: Array<{ rgb: [number, number, number]; population: number }> = []
  for (let i = 0; i < boxCount; i++) {
    const weight = boxVolume(boxes[i], table.weights)
    if (weight <= 0) continue
    clusters.push({
      rgb: [
        boxVolume(boxes[i], table.momentsR) / weight,
        boxVolume(boxes[i], table.momentsG) / weight,
        boxVolume(boxes[i], table.momentsB) / weight
      ],
      population: weight
    })
  }
  return clusters
}

// ── 3. OKLab k-means refinement ──────────────────────────

export function refineInOklab(histogram: ColorHistogram, seeds: Array<{ rgb: [number, number, number] }>): WeightedColor[] {
  if (seeds.length === 0) return []
  const points: Oklab[] = []
  const weights: number[] = []
  for (let bin = 0; bin < histogram.counts.length; bin++) {
    const count = histogram.counts[bin]
    if (count === 0) continue
    points.push(rgbToOklab(histogram.sumR[bin] / count, histogram.sumG[bin] / count, histogram.sumB[bin] / count))
    weights.push(count)
  }

  const centroids = seeds.map((seed) => rgbToOklab(seed.rgb[0], seed.rgb[1], seed.rgb[2]))
  const assignment = new Int32Array(points.length).fill(-1)
  const populations = new Float64Array(centroids.length)

  for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration++) {
    let moved = 0
    for (let p = 0; p < points.length; p++) {
      const point = points[p]
      let nearest = 0
      let nearestDistance = Infinity
      for (let c = 0; c < centroids.length; c++) {
        const dL = point.L - centroids[c].L
        const da = point.a - centroids[c].a
        const db = point.b - centroids[c].b
        const distance = dL * dL + da * da + db * db
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = c
        }
      }
      if (assignment[p] !== nearest) {
        assignment[p] = nearest
        moved += 1
      }
    }

    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0 }))
    populations.fill(0)
    for (let p = 0; p < points.length; p++) {
      const cluster = assignment[p]
      const weight = weights[p]
      sums[cluster].L += points[p].L * weight
      sums[cluster].a += points[p].a * weight
      sums[cluster].b += points[p].b * weight
      populations[cluster] += weight
    }
    for (let c = 0; c < centroids.length; c++) {
      if (populations[c] <= 0) continue
      centroids[c] = { L: sums[c].L / populations[c], a: sums[c].a / populations[c], b: sums[c].b / populations[c] }
    }
    if (moved === 0) break
  }

  return centroids
    .map((lab, index) => ({ lab, population: populations[index] }))
    .filter((cluster) => cluster.population > 0)
}

// ── 4. Scoring ───────────────────────────────────────────

export interface ScoredColor extends WeightedColor {
  score: number
}

/**
 * Material 3's scoring: a colour earns points for how much of the image sits
 * within ±15° of its hue (so a hue spread across many shades counts together)
 * and for chroma, with a steeper reward above the target. Near-greys and
 * colours covering ≤1% of the image are dropped. Unlike M3, greys don't vote in
 * the hue histogram, since their hue angle is noise.
 */
export function scoreColors(colors: WeightedColor[]): ScoredColor[] {
  const total = colors.reduce((sum, color) => sum + color.population, 0)
  if (total <= 0) return []

  const hueShare = new Float64Array(360)
  for (const color of colors) {
    if (chromaOf(color.lab) * CHROMA_UNITS < CHROMA_CUTOFF) continue
    hueShare[Math.floor(hueOf(color.lab)) % 360] += color.population / total
  }
  const excited = new Float64Array(360)
  for (let hue = 0; hue < 360; hue++) {
    for (let offset = -HUE_WINDOW_BEFORE; offset <= HUE_WINDOW_AFTER; offset++) {
      excited[hue] += hueShare[(hue + offset + 360) % 360]
    }
  }

  const scored: ScoredColor[] = []
  for (const color of colors) {
    const chroma = chromaOf(color.lab) * CHROMA_UNITS
    const proportion = excited[Math.floor(hueOf(color.lab)) % 360]
    if (chroma < CHROMA_CUTOFF || proportion <= MIN_EXCITED_PROPORTION) continue
    const proportionScore = proportion * 100 * 0.7
    const chromaScore = (chroma - CHROMA_TARGET) * (chroma < CHROMA_TARGET ? 0.1 : 0.3)
    scored.push({ ...color, score: proportionScore + chromaScore })
  }
  return scored.sort((a, b) => b.score - a.score)
}

// ── 5. Theme toning ──────────────────────────────────────

/** Largest in-gamut chroma ≤ `chroma` at this lightness and hue. */
function maxChroma(L: number, chroma: number, hue: number): number {
  if (inGamut(oklabToLinearRgb(oklch(L, chroma, hue)))) return chroma
  let low = 0
  let high = chroma
  for (let step = 0; step < 18; step++) {
    const middle = (low + high) / 2
    if (inGamut(oklabToLinearRgb(oklch(L, middle, hue)))) low = middle
    else high = middle
  }
  return low
}

function gamutMapped(L: number, chroma: number, hue: number): [number, number, number] {
  return oklabToLinearRgb(oklch(L, maxChroma(L, chroma, hue), hue))
}

/** The lightness in the theme's band that best keeps `chroma`, preferring the band's centre. */
function chooseLightness(chroma: number, hue: number, band: { preferred: number; min: number; max: number }): number {
  if (chroma <= 0) return band.preferred
  let best = band.preferred
  let bestScore = -Infinity
  for (let L = band.min; L <= band.max + 1e-9; L += 0.01) {
    const score = maxChroma(L, chroma, hue) - Math.abs(L - band.preferred) * LIGHTNESS_DRIFT_COST
    if (score > bestScore) {
      bestScore = score
      best = L
    }
  }
  return best
}

export function toneForTheme(source: Oklab | null, target: AdaptiveAccentTarget): string {
  const chroma = source ? Math.max(chromaOf(source), CHROMA_FLOOR) : 0
  const hue = source ? hueOf(source) : 0
  const onAccentLuminance = luminanceOfHex(target.onAccent) ?? (target.isLight ? 1 : 0)
  // Dark themes put dark text on the accent (so lighten to gain contrast);
  // the light theme puts light text on it (so darken).
  const direction = onAccentLuminance > 0.5 ? -1 : 1
  let L = chooseLightness(chroma, hue, target.isLight ? LIGHT_THEME_LIGHTNESS : DARK_THEME_LIGHTNESS)
  let rgb = gamutMapped(L, chroma, hue)
  while (contrast(relativeLuminanceOfLinear(rgb), onAccentLuminance) < MIN_ON_ACCENT_CONTRAST && L > 0.05 && L < 0.98) {
    L += direction * 0.02
    rgb = gamutMapped(L, chroma, hue)
  }
  return linearToHex(rgb)
}

// ── Entry point ──────────────────────────────────────────

export function pickAdaptiveSource(pixels: ArrayLike<number>): Oklab | null {
  const histogram = buildHistogram(pixels)
  const clusters = refineInOklab(histogram, quantizeWu(histogram))
  return scoreColors(clusters)[0]?.lab ?? null
}

export function extractAdaptiveAccent(pixels: ArrayLike<number>, target: AdaptiveAccentTarget): AdaptiveAccentResult {
  const source = pickAdaptiveSource(pixels)
  return { hex: toneForTheme(source, target), neutral: source === null }
}
