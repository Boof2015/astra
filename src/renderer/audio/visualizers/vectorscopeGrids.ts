import type { VectorscopeMode } from '../../stores/visualizerSettingsStore'

const INV_SQRT2 = 1 / Math.sqrt(2)
const COS45 = Math.SQRT2 / 2 // 0.7071...

export interface VectorscopeLayout {
  centerX: number
  centerY: number
  radius: number
}

/**
 * Compute the center point and radius for a vectorscope mode.
 *
 * Unipolar modes place the center at the bottom of the canvas so the
 * semicircle/triangle fills the full vertical space.
 * Bipolar and Lissajous center in the canvas.
 */
export function getVectorscopeLayout(
  width: number,
  height: number,
  mode: VectorscopeMode
): VectorscopeLayout {
  const centerX = width / 2
  const isUnipolar = mode === 'polar-unipolar' || mode === 'linear-unipolar'

  if (isUnipolar) {
    // Center near the bottom; radius fills upward
    const margin = height * 0.04
    const centerY = height - margin
    const radius = Math.min(width / 2, height - margin) * 0.88
    return { centerX, centerY, radius }
  }

  // Bipolar / Lissajous: centered
  const radius = Math.min(width, height) / 2 * 0.9
  return { centerX, centerY: height / 2, radius }
}

/**
 * Transform raw L/R sample values into display coordinates based on mode.
 * Returns null for points filtered out by unipolar modes (mid < 0).
 *
 * dx/dy are in normalized space: positive dx = right, positive dy = up.
 * Caller maps to canvas: canvasX = centerX + dx * scale, canvasY = centerY - dy * scale.
 *
 * Polar modes apply sqrt amplitude scaling so points follow the circular
 * contours instead of forming diamond/linear patterns.
 */
export function transformPoint(
  L: number,
  R: number,
  mode: VectorscopeMode
): { dx: number; dy: number } | null {
  if (mode === 'lissajous') {
    return { dx: R, dy: L }
  }

  // M/S transform (45° rotation), normalized to preserve amplitude range
  const mid = (L + R) * INV_SQRT2
  const side = (R - L) * INV_SQRT2

  // Unipolar: filter out negative mid (anti-phase / lower half)
  const isUnipolar = mode === 'polar-unipolar' || mode === 'linear-unipolar'
  if (isUnipolar && mid < 0) {
    return null
  }

  const isPolar = mode === 'polar-unipolar' || mode === 'polar-bipolar'
  if (isPolar) {
    // Amplitude-compressed radial scaling: pushes points toward circular contours.
    // Power < 1 compresses dynamic range — lower = more circular.
    // 0.5 = sqrt (mild), 0.33 = cube root (moderate), 0.25 = fourth root (strong)
    const ampSq = mid * mid + side * side
    if (ampSq < 1e-12) {
      return { dx: 0, dy: 0 }
    }
    const amp = Math.sqrt(ampSq)
    const scaledAmp = Math.pow(amp, 0.35)
    const factor = scaledAmp / amp
    return { dx: side * factor, dy: mid * factor }
  }

  // Linear modes: direct M/S Cartesian mapping
  return { dx: side, dy: mid }
}

/**
 * Draw the Lissajous grid: crosshairs + box boundary.
 */
export function drawLissajousGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridColor: string,
  dpr: number
): void {
  const { centerX, centerY, radius } = layout

  ctx.strokeStyle = gridColor
  ctx.lineWidth = dpr

  // Outer box
  ctx.strokeRect(
    centerX - radius,
    centerY - radius,
    radius * 2,
    radius * 2
  )

  // Vertical crosshair
  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  ctx.lineTo(centerX, centerY + radius)
  ctx.stroke()

  // Horizontal crosshair
  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  // Diagonal guides (dimmer)
  const dimColor = gridColor.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.5})`)
  ctx.strokeStyle = dimColor

  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY - radius)
  ctx.lineTo(centerX + radius, centerY + radius)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(centerX + radius, centerY - radius)
  ctx.lineTo(centerX - radius, centerY + radius)
  ctx.stroke()

  // Labels
  ctx.fillStyle = gridColor
  ctx.font = `${10 * dpr}px monospace`
  ctx.textAlign = 'center'
  ctx.fillText('L', centerX, centerY - radius - 6 * dpr)
  ctx.fillText('R', centerX + radius + 12 * dpr, centerY + 4 * dpr)
}

/**
 * Draw the Polar (Scaled) grid: concentric circles + crosshairs.
 */
export function drawPolarGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridColor: string,
  unipolar: boolean,
  dpr: number
): void {
  const { centerX, centerY, radius } = layout

  ctx.strokeStyle = gridColor
  ctx.lineWidth = dpr

  // Concentric circles (or semicircles for unipolar)
  const rings = [0.25, 0.5, 0.75, 1.0]
  for (const scale of rings) {
    ctx.beginPath()
    if (unipolar) {
      ctx.arc(centerX, centerY, radius * scale, Math.PI, 0, false)
    } else {
      ctx.arc(centerX, centerY, radius * scale, 0, Math.PI * 2)
    }
    ctx.stroke()
  }

  // Vertical crosshair (mono axis)
  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  if (unipolar) {
    ctx.lineTo(centerX, centerY)
  } else {
    ctx.lineTo(centerX, centerY + radius)
  }
  ctx.stroke()

  // Horizontal crosshair (side axis)
  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  // Diagonal guides (L and R channel axes) — dimmer
  const dimColor = gridColor.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.5})`)
  ctx.strokeStyle = dimColor

  if (unipolar) {
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX - radius * COS45, centerY - radius * COS45)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX + radius * COS45, centerY - radius * COS45)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(centerX - radius * COS45, centerY - radius * COS45)
    ctx.lineTo(centerX + radius * COS45, centerY + radius * COS45)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(centerX + radius * COS45, centerY - radius * COS45)
    ctx.lineTo(centerX - radius * COS45, centerY + radius * COS45)
    ctx.stroke()
  }

  // Labels
  ctx.fillStyle = gridColor
  ctx.font = `${10 * dpr}px monospace`
  ctx.textAlign = 'center'

  ctx.fillText('+', centerX, centerY - radius - 6 * dpr)
  ctx.fillText('L', centerX - radius * COS45 - 10 * dpr, centerY - radius * COS45 - 4 * dpr)
  ctx.fillText('R', centerX + radius * COS45 + 10 * dpr, centerY - radius * COS45 - 4 * dpr)

  if (!unipolar) {
    ctx.fillText('-', centerX, centerY + radius + 14 * dpr)
  }
}

/**
 * Draw the Linear grid: diamond/triangle guides.
 */
export function drawLinearGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridColor: string,
  unipolar: boolean,
  dpr: number
): void {
  const { centerX, centerY, radius } = layout

  ctx.strokeStyle = gridColor
  ctx.lineWidth = dpr

  const scales = [0.25, 0.5, 0.75, 1.0]
  for (const scale of scales) {
    const r = radius * scale
    ctx.beginPath()
    if (unipolar) {
      ctx.moveTo(centerX, centerY - r)          // top (mono)
      ctx.lineTo(centerX - r, centerY)           // left (L)
      ctx.lineTo(centerX + r, centerY)           // right (R)
      ctx.closePath()
    } else {
      ctx.moveTo(centerX, centerY - r)          // top (mono)
      ctx.lineTo(centerX + r, centerY)           // right (R)
      ctx.lineTo(centerX, centerY + r)           // bottom (anti-phase)
      ctx.lineTo(centerX - r, centerY)           // left (L)
      ctx.closePath()
    }
    ctx.stroke()
  }

  // Vertical crosshair
  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  if (unipolar) {
    ctx.lineTo(centerX, centerY)
  } else {
    ctx.lineTo(centerX, centerY + radius)
  }
  ctx.stroke()

  // Horizontal crosshair
  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  // Labels
  ctx.fillStyle = gridColor
  ctx.font = `${10 * dpr}px monospace`
  ctx.textAlign = 'center'

  ctx.fillText('+', centerX, centerY - radius - 6 * dpr)
  ctx.fillText('L', centerX - radius - 12 * dpr, centerY + 4 * dpr)
  ctx.fillText('R', centerX + radius + 12 * dpr, centerY + 4 * dpr)

  if (!unipolar) {
    ctx.fillText('-', centerX, centerY + radius + 14 * dpr)
  }
}

/**
 * Draw the appropriate grid for a given vectorscope mode.
 */
export function drawVectorscopeGridForMode(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gridColor: string,
  mode: VectorscopeMode,
  dpr: number = 1
): void {
  const layout = getVectorscopeLayout(width, height, mode)

  switch (mode) {
    case 'lissajous':
      drawLissajousGrid(ctx, layout, gridColor, dpr)
      break
    case 'polar-unipolar':
      drawPolarGrid(ctx, layout, gridColor, true, dpr)
      break
    case 'polar-bipolar':
      drawPolarGrid(ctx, layout, gridColor, false, dpr)
      break
    case 'linear-unipolar':
      drawLinearGrid(ctx, layout, gridColor, true, dpr)
      break
    case 'linear-bipolar':
      drawLinearGrid(ctx, layout, gridColor, false, dpr)
      break
  }
}
