export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface RgbaColor extends RgbColor {
  a: number
}

export const DEFAULT_VISUALIZER_TINT: RgbColor = { r: 56, g: 189, b: 248 }

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value))
}

function parseRgbToken(value: string): number | null {
  const token = value.trim()
  if (!token) return null

  if (token.endsWith('%')) {
    const percent = Number.parseFloat(token.slice(0, -1))
    if (!Number.isFinite(percent)) return null
    return clampByte((percent / 100) * 255)
  }

  const numeric = Number.parseFloat(token)
  if (!Number.isFinite(numeric)) return null
  return clampByte(numeric)
}

function parseAlphaToken(value: string): number | null {
  const token = value.trim()
  if (!token) return null

  if (token.endsWith('%')) {
    const percent = Number.parseFloat(token.slice(0, -1))
    if (!Number.isFinite(percent)) return null
    return Math.max(0, Math.min(1, percent / 100))
  }

  const numeric = Number.parseFloat(token)
  if (!Number.isFinite(numeric)) return null
  return numeric > 1
    ? Math.max(0, Math.min(1, numeric / 255))
    : Math.max(0, Math.min(1, numeric))
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

export function parseColorToRgba(color: string): RgbaColor | null {
  const normalizedColor = color.trim()

  if (normalizedColor.startsWith('#')) {
    const hex = normalizedColor.slice(1)
    const normalizedHex = hex.length === 3 || hex.length === 4
      ? hex.split('').map((ch) => `${ch}${ch}`).join('')
      : hex

    if (normalizedHex.length !== 6 && normalizedHex.length !== 8) return null

    const r = Number.parseInt(normalizedHex.slice(0, 2), 16)
    const g = Number.parseInt(normalizedHex.slice(2, 4), 16)
    const b = Number.parseInt(normalizedHex.slice(4, 6), 16)
    const a = normalizedHex.length === 8
      ? Number.parseInt(normalizedHex.slice(6, 8), 16) / 255
      : 1
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
    return { r, g, b, a }
  }

  const rgbMatch = /^rgba?\((.*)\)$/i.exec(normalizedColor)
  if (!rgbMatch) return null

  const rawBody = rgbMatch[1]?.trim()
  if (!rawBody) return null

  const [colorPart, alphaPart] = rawBody.includes('/')
    ? rawBody.split('/', 2)
    : [rawBody, undefined]

  const tokens = colorPart.includes(',')
    ? colorPart.split(',').map((token) => token.trim())
    : colorPart.split(/\s+/).filter(Boolean)
  if (tokens.length < 3) return null

  const r = parseRgbToken(tokens[0])
  const g = parseRgbToken(tokens[1])
  const b = parseRgbToken(tokens[2])
  if (r === null || g === null || b === null) return null

  const a = alphaPart
    ? parseAlphaToken(alphaPart)
    : tokens[3]
      ? parseAlphaToken(tokens[3])
      : 1
  if (a === null) return null

  return {
    r: Math.round(r),
    g: Math.round(g),
    b: Math.round(b),
    a,
  }
}

export function colorToRgbChannels(color: string): string | null {
  const rgb = parseColorToRgb(color)
  if (!rgb) return null
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
}

export function resolveColorToRgb(color: string, fallback: RgbColor = DEFAULT_VISUALIZER_TINT): RgbColor {
  return parseColorToRgb(color) ?? fallback
}

export function multiplyColorAlpha(color: string, factor: number): string {
  const parsed = parseColorToRgba(color)
  if (!parsed) return color
  const alpha = Math.max(0, Math.min(1, parsed.a * factor))
  if (alpha >= 0.999) {
    return `rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`
  }
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${Number(alpha.toFixed(3))})`
}
