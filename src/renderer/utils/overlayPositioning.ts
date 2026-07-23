export interface OverlayPoint {
  x: number
  y: number
}

export interface OverlaySize {
  width: number
  height: number
}

export interface OverlayRect extends OverlayPoint, OverlaySize {
  right: number
  bottom: number
}

export interface FixedOverlayPositionOptions {
  anchor: OverlayPoint
  overlay: OverlaySize
  viewport: OverlaySize
  edgePadding: number
}

const DEFAULT_UI_SCALE = 1

export function normalizeUIScaleFactor(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_UI_SCALE
}

export function viewportPointToAppLayout(point: OverlayPoint, uiScale: unknown): OverlayPoint {
  const scale = normalizeUIScaleFactor(uiScale)
  return {
    x: point.x / scale,
    y: point.y / scale
  }
}

export function viewportSizeToAppLayout(size: OverlaySize, uiScale: unknown): OverlaySize {
  const scale = normalizeUIScaleFactor(uiScale)
  return {
    width: size.width / scale,
    height: size.height / scale
  }
}

export function viewportRectToAppLayout(rect: OverlayRect, uiScale: unknown): OverlayRect {
  const point = viewportPointToAppLayout(rect, uiScale)
  const size = viewportSizeToAppLayout(rect, uiScale)
  const scale = normalizeUIScaleFactor(uiScale)
  return {
    ...point,
    ...size,
    right: rect.right / scale,
    bottom: rect.bottom / scale
  }
}

export function clampFixedOverlayPosition({
  anchor,
  overlay,
  viewport,
  edgePadding
}: FixedOverlayPositionOptions): { left: number; top: number } {
  const padding = Math.max(0, edgePadding)
  const maxLeft = Math.max(padding, viewport.width - overlay.width - padding)
  const maxTop = Math.max(padding, viewport.height - overlay.height - padding)

  return {
    left: Math.min(Math.max(padding, anchor.x), maxLeft),
    top: Math.min(Math.max(padding, anchor.y), maxTop)
  }
}
