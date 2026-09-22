import type { VectorscopeMode } from './Vectorscope'
import { multiplyColorAlpha } from '../../utils/color'
import {
  formatVectorscopeReferenceDbfs,
  normalizeVectorscopeZoomDb,
  vectorscopeZoomDbToGain,
} from '../../../types/vectorscope'

const INV_SQRT2 = Math.SQRT1_2
const COS45 = Math.SQRT1_2
const PHASE_RISK_FILL_ALPHA = 0.08

export interface VectorscopeLayout {
  centerX: number
  centerY: number
  radius: number
}

export interface VectorscopePoint {
  dx: number
  dy: number
}

/**
 * Compute the center point and calibrated outer-reference radius for a mode.
 * Folded modes only need the positive-Mid half of their geometry.
 */
export function getVectorscopeLayout(
  width: number,
  height: number,
  mode: VectorscopeMode,
): VectorscopeLayout {
  const centerX = width / 2
  const isFolded = mode === 'polar-unipolar' || mode === 'linear-unipolar'

  if (isFolded) {
    const margin = height * 0.04
    const availableHeight = height - margin
    const halfWidth = width / 2
    const widthLimited = halfWidth < availableHeight
    const radius = Math.min(halfWidth, availableHeight) * 0.88
    const centerY = widthLimited
      ? (height + radius) / 2
      : availableHeight
    return { centerX, centerY, radius }
  }

  const radius = Math.min(width, height) / 2 * 0.9
  return { centerX, centerY: height / 2, radius }
}

/** Opposite-sign instantaneous channel samples are Side-dominant. */
export function isVectorscopePhaseRisk(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && left * right < 0
}

/**
 * Project raw L/R samples into normalized coordinates.
 *
 * XY uses raw channel amplitude. Linear modes use peak-normalized M/S, whose
 * exact legal per-channel boundary is |Mid| + |Side| = 1. Polar modes retain
 * Prism's classic amplitude-compressed radial presentation so quiet stereo
 * detail remains readable instead of collapsing toward the origin. Folded
 * modes rotate negative-Mid points through the origin instead of dropping
 * half of the waveform.
 */
export function transformPoint(
  left: number,
  right: number,
  mode: VectorscopeMode,
  zoomDb: number = 0,
): VectorscopePoint {
  const point = { dx: 0, dy: 0 }
  transformPointInto(left, right, mode, vectorscopeZoomDbToGain(zoomDb), point)
  return point
}

/** Project into reusable storage with a gain already calculated for this zoom. */
export function transformPointInto(
  left: number,
  right: number,
  mode: VectorscopeMode,
  gain: number,
  point: VectorscopePoint,
): void {
  if (mode === 'lissajous') {
    point.dx = right * gain
    point.dy = left * gain
    return
  }

  const isFolded = mode === 'polar-unipolar' || mode === 'linear-unipolar'
  const isPolar = mode === 'polar-unipolar' || mode === 'polar-bipolar'
  if (isPolar) {
    // Preserve the original Polar presentation: an orthonormal M/S rotation
    // followed by strong radial expansion. Apply zoom before the curve so the
    // unit circle remains the selected radial reference.
    let mid = (left + right) * INV_SQRT2
    let side = (right - left) * INV_SQRT2
    if (isFolded && mid < 0) {
      mid = -mid
      side = -side
    }

    const amplitude = Math.hypot(mid, side)
    if (amplitude < 1e-12) {
      point.dx = 0
      point.dy = 0
      return
    }

    const shapedAmplitude = Math.pow(amplitude * gain, 0.35)
    point.dx = side / amplitude * shapedAmplitude
    point.dy = mid / amplitude * shapedAmplitude
    return
  }

  let mid = (left + right) / 2
  let side = (right - left) / 2
  if (isFolded && mid < 0) {
    mid = -mid
    side = -side
  }
  point.dx = side * gain
  point.dy = mid * gain
}

function fillPhaseRiskRegions(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  mode: VectorscopeMode,
  phaseRiskColor: string,
): void {
  const { centerX, centerY, radius } = layout
  ctx.fillStyle = multiplyColorAlpha(phaseRiskColor, PHASE_RISK_FILL_ALPHA)

  if (mode === 'lissajous') {
    ctx.fillRect(centerX - radius, centerY - radius, radius, radius)
    ctx.fillRect(centerX, centerY, radius, radius)
    return
  }

  if (mode === 'polar-unipolar') {
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.arc(centerX, centerY, radius, Math.PI, Math.PI * 1.25, false)
    ctx.closePath()
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.arc(centerX, centerY, radius, Math.PI * 1.75, Math.PI * 2, false)
    ctx.closePath()
    ctx.fill()
    return
  }

  if (mode === 'polar-bipolar') {
    for (const [startAngle, endAngle] of [
      [-Math.PI / 4, Math.PI / 4],
      [Math.PI * 3 / 4, Math.PI * 5 / 4],
    ] as const) {
      ctx.beginPath()
      ctx.moveTo(centerX, centerY)
      ctx.arc(centerX, centerY, radius, startAngle, endAngle, false)
      ctx.closePath()
      ctx.fill()
    }
    return
  }

  const halfRadius = radius / 2
  const sidePolygons = mode === 'linear-unipolar'
    ? [
        [[centerX, centerY], [centerX - radius, centerY], [centerX - halfRadius, centerY - halfRadius]],
        [[centerX, centerY], [centerX + halfRadius, centerY - halfRadius], [centerX + radius, centerY]],
      ]
    : [
        [[centerX, centerY], [centerX - halfRadius, centerY - halfRadius], [centerX - radius, centerY], [centerX - halfRadius, centerY + halfRadius]],
        [[centerX, centerY], [centerX + halfRadius, centerY + halfRadius], [centerX + radius, centerY], [centerX + halfRadius, centerY - halfRadius]],
      ]

  for (const polygon of sidePolygons) {
    ctx.beginPath()
    ctx.moveTo(polygon[0][0], polygon[0][1])
    for (let index = 1; index < polygon.length; index += 1) {
      ctx.lineTo(polygon[index][0], polygon[index][1])
    }
    ctx.closePath()
    ctx.fill()
  }
}

function drawReferenceLabel(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  labelColor: string,
  zoomDb: number,
  dpr: number,
  radial: boolean = false,
): void {
  const { centerX, centerY, radius } = layout
  ctx.fillStyle = labelColor
  ctx.font = `${9 * dpr}px monospace`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  const referenceLabel = formatVectorscopeReferenceDbfs(zoomDb)
  ctx.fillText(
    radial ? referenceLabel.replace(' dBFS', ' dB radial') : referenceLabel,
    centerX + radius - 4 * dpr,
    centerY + radius - 4 * dpr,
  )
}

export function drawLissajousGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridMajorColor: string,
  gridMinorColor: string,
  labelColor: string,
  phaseRiskColor: string,
  zoomDb: number,
  dpr: number,
): void {
  const { centerX, centerY, radius } = layout
  fillPhaseRiskRegions(ctx, layout, 'lissajous', phaseRiskColor)

  ctx.strokeStyle = gridMajorColor
  ctx.lineWidth = dpr
  ctx.strokeRect(centerX - radius, centerY - radius, radius * 2, radius * 2)

  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  ctx.lineTo(centerX, centerY + radius)
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  ctx.strokeStyle = gridMinorColor || multiplyColorAlpha(gridMajorColor, 0.5)
  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY - radius)
  ctx.lineTo(centerX + radius, centerY + radius)
  ctx.moveTo(centerX + radius, centerY - radius)
  ctx.lineTo(centerX - radius, centerY + radius)
  ctx.stroke()

  ctx.fillStyle = labelColor
  ctx.font = `${10 * dpr}px monospace`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText('L', centerX, centerY - radius + 9 * dpr)
  ctx.fillText('R', centerX + radius - 9 * dpr, centerY)
  ctx.fillText('M', centerX + radius * 0.72, centerY - radius * 0.72)
  ctx.fillText('S', centerX - radius * 0.72, centerY - radius * 0.72)
  drawReferenceLabel(ctx, layout, labelColor, zoomDb, dpr)
}

function drawChannelGuides(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  unipolar: boolean,
): void {
  const { centerX, centerY, radius } = layout
  if (unipolar) {
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX - radius * COS45, centerY - radius * COS45)
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX + radius * COS45, centerY - radius * COS45)
    ctx.stroke()
    return
  }

  ctx.beginPath()
  ctx.moveTo(centerX - radius * COS45, centerY - radius * COS45)
  ctx.lineTo(centerX + radius * COS45, centerY + radius * COS45)
  ctx.moveTo(centerX + radius * COS45, centerY - radius * COS45)
  ctx.lineTo(centerX - radius * COS45, centerY + radius * COS45)
  ctx.stroke()
}

function drawMsLabels(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  labelColor: string,
  unipolar: boolean,
  channelGuideCoordinate: number,
  dpr: number,
): void {
  const { centerX, centerY, radius } = layout
  ctx.fillStyle = labelColor
  ctx.font = `${10 * dpr}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('M+', centerX, centerY - radius + 9 * dpr)
  ctx.fillText('S−', centerX - radius + 16 * dpr, centerY)
  ctx.fillText('S+', centerX + radius - 16 * dpr, centerY)
  ctx.fillText('L', centerX - radius * channelGuideCoordinate - 9 * dpr, centerY - radius * channelGuideCoordinate - 4 * dpr)
  ctx.fillText('R', centerX + radius * channelGuideCoordinate + 9 * dpr, centerY - radius * channelGuideCoordinate - 4 * dpr)
  if (!unipolar) {
    ctx.fillText('M−', centerX, centerY + radius - 9 * dpr)
  }
}

export function drawPolarGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridMajorColor: string,
  gridMinorColor: string,
  labelColor: string,
  phaseRiskColor: string,
  unipolar: boolean,
  zoomDb: number,
  dpr: number,
): void {
  const { centerX, centerY, radius } = layout
  fillPhaseRiskRegions(ctx, layout, unipolar ? 'polar-unipolar' : 'polar-bipolar', phaseRiskColor)

  for (const ringScale of [0.25, 0.5, 0.75, 1]) {
    ctx.strokeStyle = ringScale === 1 ? gridMajorColor : gridMinorColor
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius * ringScale, unipolar ? Math.PI : 0, unipolar ? 0 : Math.PI * 2, false)
    ctx.stroke()
  }

  ctx.strokeStyle = gridMinorColor
  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  ctx.lineTo(centerX, unipolar ? centerY : centerY + radius)
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  ctx.strokeStyle = gridMajorColor
  drawChannelGuides(ctx, layout, unipolar)
  drawMsLabels(ctx, layout, labelColor, unipolar, COS45, dpr)
  drawReferenceLabel(ctx, layout, labelColor, zoomDb, dpr, true)
}

function drawLinearChannelGuides(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  unipolar: boolean,
): void {
  const { centerX, centerY, radius } = layout
  const halfRadius = radius / 2
  ctx.beginPath()
  if (unipolar) {
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX - halfRadius, centerY - halfRadius)
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX + halfRadius, centerY - halfRadius)
  } else {
    ctx.moveTo(centerX - halfRadius, centerY - halfRadius)
    ctx.lineTo(centerX + halfRadius, centerY + halfRadius)
    ctx.moveTo(centerX + halfRadius, centerY - halfRadius)
    ctx.lineTo(centerX - halfRadius, centerY + halfRadius)
  }
  ctx.stroke()
}

export function drawLinearGrid(
  ctx: CanvasRenderingContext2D,
  layout: VectorscopeLayout,
  gridMajorColor: string,
  gridMinorColor: string,
  labelColor: string,
  phaseRiskColor: string,
  unipolar: boolean,
  zoomDb: number,
  dpr: number,
): void {
  const { centerX, centerY, radius } = layout
  fillPhaseRiskRegions(ctx, layout, unipolar ? 'linear-unipolar' : 'linear-bipolar', phaseRiskColor)

  for (const ringScale of [0.25, 0.5, 0.75, 1]) {
    const ringRadius = radius * ringScale
    ctx.strokeStyle = ringScale === 1 ? gridMajorColor : gridMinorColor
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.moveTo(centerX, centerY - ringRadius)
    ctx.lineTo(centerX + ringRadius, centerY)
    if (!unipolar) ctx.lineTo(centerX, centerY + ringRadius)
    ctx.lineTo(centerX - ringRadius, centerY)
    ctx.closePath()
    ctx.stroke()
  }

  ctx.strokeStyle = gridMinorColor
  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  ctx.lineTo(centerX, unipolar ? centerY : centerY + radius)
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()

  ctx.strokeStyle = gridMajorColor
  drawLinearChannelGuides(ctx, layout, unipolar)
  drawMsLabels(ctx, layout, labelColor, unipolar, 0.5, dpr)
  drawReferenceLabel(ctx, layout, labelColor, zoomDb, dpr)
}

export function drawVectorscopeGridForMode(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gridMajorColor: string,
  gridMinorColor: string,
  labelColor: string,
  mode: VectorscopeMode,
  phaseRiskColor: string = '#8bafbd',
  zoomDb: number = 0,
  dpr: number = 1,
): void {
  const layout = getVectorscopeLayout(width, height, mode)
  const normalizedZoomDb = normalizeVectorscopeZoomDb(zoomDb)

  switch (mode) {
    case 'lissajous':
      drawLissajousGrid(ctx, layout, gridMajorColor, gridMinorColor, labelColor, phaseRiskColor, normalizedZoomDb, dpr)
      break
    case 'polar-unipolar':
    case 'polar-bipolar':
      drawPolarGrid(ctx, layout, gridMajorColor, gridMinorColor, labelColor, phaseRiskColor, mode === 'polar-unipolar', normalizedZoomDb, dpr)
      break
    case 'linear-unipolar':
    case 'linear-bipolar':
      drawLinearGrid(ctx, layout, gridMajorColor, gridMinorColor, labelColor, phaseRiskColor, mode === 'linear-unipolar', normalizedZoomDb, dpr)
      break
  }
}
