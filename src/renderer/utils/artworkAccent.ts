import type { CoverArtAccentMethod } from '../stores/themeStore'

const SAMPLE_SIZE = 64
const MIN_ALPHA = 24
const DOMINANT_BUCKET_SIZE = 24

type Rgb = { r: number; g: number; b: number }

interface DominantBucket {
  count: number
  sumR: number
  sumG: number
  sumB: number
  saturationSum: number
  luminanceSum: number
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

function normalizeAccentColor(color: Rgb): Rgb {
  const hsl = rgbToHsl(color)

  const saturationFloor = 0.32
  const saturationCeiling = 0.9
  const lightnessFloor = 0.33
  const lightnessCeiling = 0.68

  const normalized = {
    h: hsl.h,
    s: clamp(Math.max(hsl.s, saturationFloor), 0, saturationCeiling),
    l: clamp(hsl.l, lightnessFloor, lightnessCeiling),
  }

  return hslToRgb(normalized)
}

function scoreDominantBucket(bucket: DominantBucket): number {
  if (bucket.count <= 0) return -1

  const avgSaturation = bucket.saturationSum / bucket.count
  const avgLuminance = bucket.luminanceSum / bucket.count
  const midToneWeight = 1 - Math.min(1, Math.abs(avgLuminance - 0.52) / 0.52)

  return bucket.count * (1 + (avgSaturation * 0.9)) * (0.55 + (midToneWeight * 0.45))
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
  })

  return rgbToHex(averaged)
}

function extractDominantColor(pixels: Uint8ClampedArray): string | null {
  const buckets = new Map<string, DominantBucket>()

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (alpha < MIN_ALPHA) continue

    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)

    if (max < 24 || min > 240) continue

    const saturation = max === 0 ? 0 : (max - min) / max
    if (saturation < 0.08) continue

    const luminance = (max + min) / (2 * 255)

    const bucketR = Math.round(r / DOMINANT_BUCKET_SIZE)
    const bucketG = Math.round(g / DOMINANT_BUCKET_SIZE)
    const bucketB = Math.round(b / DOMINANT_BUCKET_SIZE)
    const key = `${bucketR}-${bucketG}-${bucketB}`

    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      existing.sumR += r
      existing.sumG += g
      existing.sumB += b
      existing.saturationSum += saturation
      existing.luminanceSum += luminance
      continue
    }

    buckets.set(key, {
      count: 1,
      sumR: r,
      sumG: g,
      sumB: b,
      saturationSum: saturation,
      luminanceSum: luminance,
    })
  }

  if (buckets.size === 0) {
    return extractAverageColor(pixels)
  }

  let winningBucket: DominantBucket | null = null
  let bestScore = -1

  for (const bucket of buckets.values()) {
    const score = scoreDominantBucket(bucket)
    if (score <= bestScore) continue
    bestScore = score
    winningBucket = bucket
  }

  if (!winningBucket || winningBucket.count <= 0) {
    return extractAverageColor(pixels)
  }

  const dominant = normalizeAccentColor({
    r: winningBucket.sumR / winningBucket.count,
    g: winningBucket.sumG / winningBucket.count,
    b: winningBucket.sumB / winningBucket.count,
  })

  return rgbToHex(dominant)
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

    return extractDominantColor(pixels)
  } catch {
    return null
  }
}
