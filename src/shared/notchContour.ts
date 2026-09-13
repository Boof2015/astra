import type { NotchSurfaceBounds } from '../types/notch'

export interface NotchContour { topWidth: number; bottomWidth: number; height: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t) }

// Held peek: a compact extension of the hardware outline. Equal upper/lower
// widths remove the flared shoulders and pinched sides of the earlier pose.
export function notchPeekContour(width: number, height: number, proximity: number): NotchContour {
  const amount = clamp(proximity)
  const peekWidth = width + 10 + 4 * amount
  return { topWidth: peekWidth, bottomWidth: peekWidth, height: height + 2 + amount }
}

// The peek supplies the wrap and hold. Opening continues that rounded outline
// with one eased progress, without introducing another flared-corner pose.
export function tweenNotchContour(from: NotchContour, to: NotchContour, progress: number): NotchContour {
  const amount = ease(progress)
  return { topWidth: from.topWidth + (to.topWidth - from.topWidth) * amount,
    bottomWidth: from.bottomWidth + (to.bottomWidth - from.bottomWidth) * amount,
    height: from.height + (to.height - from.height) * amount }
}

// The same sampled curve clips the renderer and defines native mouse acceptance.
// A polygon keeps those boundaries identical, including the tapered shoulders.
export function notchContourBounds(contour: NotchContour, windowWidth: number): NotchSurfaceBounds {
  const { topWidth, bottomWidth, height } = contour
  const width = Math.max(topWidth, bottomWidth)
  const x = (windowWidth - width) / 2
  const top = (windowWidth - topWidth) / 2
  const bottom = (windowWidth - bottomWidth) / 2
  const radius = Math.min(12, height / 2, bottomWidth / 2)
  const side = height - radius
  const points = [{ x: top, y: 0 }, { x: windowWidth - top, y: 0 }]
  const cubic = (a: number, b: number, c: number, d: number, t: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
  for (let i = 1; i <= 16; i++) {
    const t = i / 16
    points.push({ x: cubic(windowWidth - top, windowWidth - top, windowWidth - bottom, windowWidth - bottom, t),
      y: cubic(0, side * 0.35, side * 0.5, side, t) })
  }
  for (let i = 1; i <= 8; i++) {
    const angle = i / 8 * Math.PI / 2
    points.push({ x: windowWidth - bottom - radius + Math.cos(angle) * radius, y: side + Math.sin(angle) * radius })
  }
  const right = points.slice(1)
  for (const point of right.reverse()) points.push({ x: windowWidth - point.x, y: point.y })
  // Avoid serializing a duplicate closing vertex and tiny floating-point overshoots.
  points.pop()
  return { x, y: 0, width, height, points: points.map(point => ({
    x: Math.max(x, Math.min(x + width, point.x)), y: Math.max(0, Math.min(height, point.y)),
  })) }
}
