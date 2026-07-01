export interface CanvasResizeState {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  dpr: number
}

const DEFAULT_PIXEL_RATIO = 1

function normalizePositiveNumber(value: unknown, fallback = DEFAULT_PIXEL_RATIO): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function getComputedStyleForElement(element: Element): CSSStyleDeclaration | null {
  const ownerWindow = element.ownerDocument?.defaultView
  if (ownerWindow?.getComputedStyle) {
    return ownerWindow.getComputedStyle(element)
  }
  if (typeof window !== 'undefined' && window.getComputedStyle) {
    return window.getComputedStyle(element)
  }
  return null
}

function parsePositiveCssPixelValue(value: string | null | undefined): number | null {
  if (!value) return null
  const numeric = Number.parseFloat(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

export function getDevicePixelRatio(): number {
  if (typeof window === 'undefined') return DEFAULT_PIXEL_RATIO
  return normalizePositiveNumber(window.devicePixelRatio)
}

export function getElementUIScale(element: Element | null): number {
  if (!element) return DEFAULT_PIXEL_RATIO

  const computedStyle = getComputedStyleForElement(element)
  const rawScale = computedStyle?.getPropertyValue('--ui-scale')
  return normalizePositiveNumber(rawScale)
}

export function getEffectiveCanvasPixelRatio(element: Element | null): number {
  return getDevicePixelRatio() * getElementUIScale(element)
}

function measureUntransformedCssSize(element: HTMLElement, axis: 'width' | 'height'): number {
  const clientSize = axis === 'width' ? element.clientWidth : element.clientHeight
  if (Number.isFinite(clientSize) && clientSize > 0) {
    return Math.floor(clientSize)
  }

  const offsetSize = axis === 'width' ? element.offsetWidth : element.offsetHeight
  if (Number.isFinite(offsetSize) && offsetSize > 0) {
    return Math.floor(offsetSize)
  }

  return 1
}

export function measureCanvasResizeState(container: HTMLElement): CanvasResizeState {
  const cssWidth = Math.max(1, measureUntransformedCssSize(container, 'width'))
  const cssHeight = Math.max(1, measureUntransformedCssSize(container, 'height'))
  const dpr = getEffectiveCanvasPixelRatio(container)

  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * dpr)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * dpr)),
    dpr,
  }
}

function getCanvasCssSize(canvas: HTMLCanvasElement, axis: 'width' | 'height'): number | null {
  const inlineSize = parsePositiveCssPixelValue(axis === 'width' ? canvas.style.width : canvas.style.height)
  if (inlineSize !== null) return inlineSize

  const computedStyle = getComputedStyleForElement(canvas)
  const computedSize = parsePositiveCssPixelValue(axis === 'width' ? computedStyle?.width : computedStyle?.height)
  if (computedSize !== null) return computedSize

  const clientSize = axis === 'width' ? canvas.clientWidth : canvas.clientHeight
  return Number.isFinite(clientSize) && clientSize > 0 ? clientSize : null
}

export function getCanvasBackingPixelRatio(canvas: HTMLCanvasElement): number {
  const cssWidth = getCanvasCssSize(canvas, 'width')
  if (cssWidth !== null && canvas.width > 0) {
    const ratio = canvas.width / cssWidth
    if (Number.isFinite(ratio) && ratio > 0) return ratio
  }

  const cssHeight = getCanvasCssSize(canvas, 'height')
  if (cssHeight !== null && canvas.height > 0) {
    const ratio = canvas.height / cssHeight
    if (Number.isFinite(ratio) && ratio > 0) return ratio
  }

  return getEffectiveCanvasPixelRatio(canvas)
}
