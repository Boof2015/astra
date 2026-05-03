export const FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS = 12_000_000
export const FULLSCREEN_AMBIENT_CANVAS_MAX_DPR = 1.5

export interface FullscreenAmbientCanvasSize {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  dpr: number
}

function normalizeCssPixelSize(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 0))
}

function normalizeDevicePixelRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(FULLSCREEN_AMBIENT_CANVAS_MAX_DPR, value)
}

export function resolveFullscreenAmbientCanvasSize(
  rawCssWidth: number,
  rawCssHeight: number,
  rawDevicePixelRatio: number
): FullscreenAmbientCanvasSize {
  const cssWidth = normalizeCssPixelSize(rawCssWidth)
  const cssHeight = normalizeCssPixelSize(rawCssHeight)
  const baseDpr = normalizeDevicePixelRatio(rawDevicePixelRatio)
  const cssPixels = cssWidth * cssHeight
  const cappedDpr = cssPixels * baseDpr * baseDpr <= FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS
    ? baseDpr
    : Math.sqrt(FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS / cssPixels)
  const dpr = Math.min(baseDpr, cappedDpr)

  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * dpr)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * dpr)),
    dpr,
  }
}

export function isSameFullscreenAmbientCanvasSize(
  left: FullscreenAmbientCanvasSize,
  right: FullscreenAmbientCanvasSize
): boolean {
  return left.cssWidth === right.cssWidth
    && left.cssHeight === right.cssHeight
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.dpr === right.dpr
}
