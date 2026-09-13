import assert from 'node:assert/strict'
import test from 'node:test'
import { notchContourBounds, notchPeekContour, tweenNotchContour } from './notchContour.ts'

const concealed = { topWidth: 183, bottomWidth: 183, height: 31 }
const preview = { topWidth: 249, bottomWidth: 249, height: 56 }

test('held peek follows a compact rounded hardware outline without flared shoulders', () => {
  for (const proximity of [0, 0.25, 0.5, 0.75, 1]) {
    const peek = notchPeekContour(185, 32, proximity)
    assert.equal(peek.topWidth, peek.bottomWidth)
    assert.ok(peek.topWidth >= 195 && peek.topWidth <= 199)
    assert.ok(peek.height >= 34 && peek.height <= 35)
    assert.deepEqual(tweenNotchContour(concealed, peek, 1), peek)
    assert.deepEqual(tweenNotchContour(peek, preview, 0), peek)
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const entering = tweenNotchContour(concealed, peek, progress)
      assert.equal(entering.topWidth, entering.bottomWidth)
      const retargeted = tweenNotchContour(entering, notchPeekContour(185, 32, 1), 0.5)
      assert.equal(retargeted.topWidth, retargeted.bottomWidth)
    }
  }
})

test('held peek opens directly into the preview without an intermediate corner flare', () => {
  const peek = notchPeekContour(185, 32, 0.5)
  assert.deepEqual(tweenNotchContour(concealed, preview, 0), concealed)
  for (let i = 0; i <= 100; i++) {
    const contour = tweenNotchContour(peek, preview, i / 100)
    assert.equal(contour.topWidth, contour.bottomWidth)
    const widthProgress = (contour.topWidth - peek.topWidth) / (preview.topWidth - peek.topWidth)
    const heightProgress = (contour.height - peek.height) / (preview.height - peek.height)
    assert.ok(Math.abs(widthProgress - heightProgress) < 1e-10)
  }
  assert.deepEqual(tweenNotchContour(peek, preview, 1), preview)
})

test('an interrupted reveal retreats from the painted shape without a geometry jump', () => {
  const interrupted = tweenNotchContour(concealed, preview, 0.42)
  assert.deepEqual(tweenNotchContour(interrupted, concealed, 0), interrupted)
  const closing = tweenNotchContour(interrupted, concealed, 0.1)
  assert.ok(closing.topWidth < interrupted.topWidth)
  assert.equal(closing.topWidth, closing.bottomWidth)
  assert.ok(closing.height < interrupted.height)
  assert.deepEqual(tweenNotchContour(interrupted, concealed, 1), concealed)
  assert.deepEqual(tweenNotchContour(closing, preview, 0), closing)
})

test('all intermediate contours form a symmetric, bounded outline for rendering and native hit testing', () => {
  for (const target of [preview, { topWidth: 440, bottomWidth: 440, height: 256 }, notchPeekContour(185, 32, 1)]) {
    for (let i = 0; i <= 100; i++) {
      const contour = tweenNotchContour(concealed, target, i / 100)
      const bounds = notchContourBounds(contour, 440)
      assert.ok(bounds.points.length >= 3 && bounds.points.length <= 64)
      assert.equal(bounds.points[0].y, 0)
      assert.equal(bounds.points[1].y, 0)
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 440)
      for (const point of bounds.points) {
        assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width)
        assert.ok(point.y >= 0 && point.y <= contour.height)
        assert.ok(bounds.points.some(other => Math.abs(other.x - (440 - point.x)) < 1e-8 && other.y === point.y))
      }
    }
  }
})
