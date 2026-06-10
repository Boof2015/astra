import type { CoverArtAccentMethod } from '../stores/themeStore'

const SAMPLE_SIZE = 128
const MIN_ALPHA = 24
const VIBRANT_MIN_ALPHA = 48
const DOMINANT_BUCKET_SIZE = 24

type Rgb = { r: number; g: number; b: number }

interface AccentNormalizationOptions {
  saturationFloor: number
  saturationCeiling: number
  lightnessFloor: number
  lightnessCeiling: number
}

interface AccentBucket {
  count: number
  sumR: number
  sumG: number
  sumB: number
  saturationSum: number
  luminanceSum: number
  chromaSum: number
}

interface PixelAnalysis {
  r: number
  g: number
  b: number
  max: number
  min: number
  saturation: number
  luminance: number
  chroma: number
}

interface BucketExtractionOptions {
  minAlpha: number
  normalizeColor: (color: Rgb) => Rgb
  isPixelAccepted: (pixel: PixelAnalysis) => boolean
  scoreBucket: (bucket: AccentBucket) => number
  fallback: () => string | null
}

const DEFAULT_NORMALIZATION: AccentNormalizationOptions = {
  saturationFloor: 0.32,
  saturationCeiling: 0.9,
  lightnessFloor: 0.33,
  lightnessCeiling: 0.68,
}

const VIBRANT_NORMALIZATION: AccentNormalizationOptions = {
  saturationFloor: 0.5,
  saturationCeiling: 0.98,
  lightnessFloor: 0.38,
  lightnessCeiling: 0.62,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampByte(value: number): number {
  return clamp(Math.round(value), 0, 255)
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (value: number) => clampByte(value).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const nr = clampByte(r) / 255
  const ng = clampByte(g) / 255
  const nb = clampByte(b) / 255

  const max = Math.max(nr, ng, nb)
  const min = Math.min(nr, ng, nb)
  const delta = max - min

  let h = 0
  if (delta > 0) {
    if (max === nr) {
      h = ((ng - nb) / delta) % 6
    } else if (max === ng) {
      h = (nb - nr) / delta + 2
    } else {
      h = (nr - ng) / delta + 4
    }
    h /= 6
    if (h < 0) h += 1
  }

  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs((2 * l) - 1))

  return { h, s, l }
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t
  if (value < 0) value += 1
  if (value > 1) value -= 1

  if (value < (1 / 6)) return p + ((q - p) * 6 * value)
  if (value < (1 / 2)) return q
  if (value < (2 / 3)) return p + ((q - p) * ((2 / 3) - value) * 6)
  return p
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  const hue = ((h % 1) + 1) % 1
  const sat = clamp(s, 0, 1)
  const light = clamp(l, 0, 1)

  if (sat === 0) {
    const gray = clampByte(light * 255)
    return { r: gray, g: gray, b: gray }
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - (light * sat)
  const p = (2 * light) - q

  return {
    r: clampByte(hueToRgb(p, q, hue + (1 / 3)) * 255),
    g: clampByte(hueToRgb(p, q, hue) * 255),
    b: clampByte(hueToRgb(p, q, hue - (1 / 3)) * 255),
  }
}

function normalizeAccentColor(color: Rgb, options: AccentNormalizationOptions): Rgb {
  const hsl = rgbToHsl(color)

  const normalized = {
    h: hsl.h,
    s: clamp(Math.max(hsl.s, options.saturationFloor), 0, options.saturationCeiling),
    l: clamp(hsl.l, options.lightnessFloor, options.lightnessCeiling),
  }

  return hslToRgb(normalized)
}

function analyzePixel(r: number, g: number, b: number): PixelAnalysis {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)

  return {
    r,
    g,
    b,
    max,
    min,
    saturation: max === 0 ? 0 : (max - min) / max,
    luminance: (max + min) / (2 * 255),
    chroma: (max - min) / 255,
  }
}

function scoreDominantBucket(bucket: AccentBucket): number {
  if (bucket.count <= 0) return -1

  const avgSaturation = bucket.saturationSum / bucket.count
  const avgLuminance = bucket.luminanceSum / bucket.count
  const midToneWeight = 1 - Math.min(1, Math.abs(avgLuminance - 0.52) / 0.52)

  return bucket.count * (1 + (avgSaturation * 0.9)) * (0.55 + (midToneWeight * 0.45))
}

function scoreVibrantBucket(bucket: AccentBucket): number {
  if (bucket.count <= 0) return -1

  const avgSaturation = bucket.saturationSum / bucket.count
  const avgLuminance = bucket.luminanceSum / bucket.count
  const avgChroma = bucket.chromaSum / bucket.count
  const midToneWeight = 1 - Math.min(1, Math.abs(avgLuminance - 0.52) / 0.52)

  return Math.pow(bucket.count, 0.55)
    * (0.45 + (avgSaturation * 1.6) + (avgChroma * 0.9))
    * (0.75 + (midToneWeight * 0.35))
}

function extractAverageColor(pixels: Uint8ClampedArray): string | null {
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let totalWeight = 0

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (alpha < MIN_ALPHA) continue

    const weight = alpha / 255
    totalWeight += weight
    sumR += pixels[i] * weight
    sumG += pixels[i + 1] * weight
    sumB += pixels[i + 2] * weight
  }

  if (totalWeight <= 0) return null

  const averaged = normalizeAccentColor({
    r: sumR / totalWeight,
    g: sumG / totalWeight,
    b: sumB / totalWeight,
  }, DEFAULT_NORMALIZATION)

  return rgbToHex(averaged)
}

function extractBucketedColor(
  pixels: Uint8ClampedArray,
  options: BucketExtractionOptions
): string | null {
  const buckets = new Map<string, AccentBucket>()

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (alpha < options.minAlpha) continue

    const pixel = analyzePixel(pixels[i], pixels[i + 1], pixels[i + 2])
    if (!options.isPixelAccepted(pixel)) continue

    const bucketR = Math.round(pixel.r / DOMINANT_BUCKET_SIZE)
    const bucketG = Math.round(pixel.g / DOMINANT_BUCKET_SIZE)
    const bucketB = Math.round(pixel.b / DOMINANT_BUCKET_SIZE)
    const key = `${bucketR}-${bucketG}-${bucketB}`

    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      existing.sumR += pixel.r
      existing.sumG += pixel.g
      existing.sumB += pixel.b
      existing.saturationSum += pixel.saturation
      existing.luminanceSum += pixel.luminance
      existing.chromaSum += pixel.chroma
      continue
    }

    buckets.set(key, {
      count: 1,
      sumR: pixel.r,
      sumG: pixel.g,
      sumB: pixel.b,
      saturationSum: pixel.saturation,
      luminanceSum: pixel.luminance,
      chromaSum: pixel.chroma,
    })
  }

  if (buckets.size === 0) {
    return options.fallback()
  }

  let winningBucket: AccentBucket | null = null
  let bestScore = -1

  for (const bucket of buckets.values()) {
    const score = options.scoreBucket(bucket)
    if (score <= bestScore) continue
    bestScore = score
    winningBucket = bucket
  }

  if (!winningBucket || winningBucket.count <= 0) {
    return options.fallback()
  }

  const accent = options.normalizeColor({
    r: winningBucket.sumR / winningBucket.count,
    g: winningBucket.sumG / winningBucket.count,
    b: winningBucket.sumB / winningBucket.count,
  })

  return rgbToHex(accent)
}

function extractDominantColor(pixels: Uint8ClampedArray): string | null {
  return extractBucketedColor(pixels, {
    minAlpha: MIN_ALPHA,
    normalizeColor: (color) => normalizeAccentColor(color, DEFAULT_NORMALIZATION),
    isPixelAccepted: (pixel) => {
      if (pixel.max < 24 || pixel.min > 240) return false
      return pixel.saturation >= 0.08
    },
    scoreBucket: scoreDominantBucket,
    fallback: () => extractAverageColor(pixels),
  })
}

function extractVibrantColor(pixels: Uint8ClampedArray): string | null {
  return extractBucketedColor(pixels, {
    minAlpha: VIBRANT_MIN_ALPHA,
    normalizeColor: (color) => normalizeAccentColor(color, VIBRANT_NORMALIZATION),
    isPixelAccepted: (pixel) => {
      if (pixel.saturation < 0.16) return false
      if (pixel.luminance < 0.10) return false
      if (pixel.luminance > 0.93 && pixel.saturation < 0.35) return false
      return true
    },
    scoreBucket: scoreVibrantBucket,
    fallback: () => extractDominantColor(pixels),
  })
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false

    const finish = (next: () => void) => {
      if (settled) return
      settled = true
      next()
    }

    image.decoding = 'async'
    // astra-artwork:// responses are cross-origin to the page; without CORS
    // the canvas would taint and getImageData would throw. Harmless for the
    // data: URLs used by remote-source artwork.
    image.crossOrigin = 'anonymous'
    image.onload = () => finish(() => resolve(image))
    image.onerror = () => finish(() => reject(new Error('Failed to decode artwork image')))
    image.src = source

    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish(() => resolve(image))
    }
  })
}

function sampleArtworkPixels(image: HTMLImageElement): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  try {
    context.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  } catch {
    return null
  }
}

export async function extractArtworkAccent(
  artworkDataUrl: string,
  method: CoverArtAccentMethod
): Promise<string | null> {
  if (!artworkDataUrl || typeof artworkDataUrl !== 'string') return null

  try {
    const image = await loadImage(artworkDataUrl)
    const pixels = sampleArtworkPixels(image)
    if (!pixels) return null

    if (method === 'average') {
      return extractAverageColor(pixels)
    }

    if (method === 'vibrant') {
      return extractVibrantColor(pixels)
    }

    return extractDominantColor(pixels)
  } catch {
    return null
  }
}
