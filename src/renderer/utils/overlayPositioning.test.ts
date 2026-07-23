import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampFixedOverlayPosition,
  viewportPointToAppLayout,
  viewportRectToAppLayout,
  viewportSizeToAppLayout
} from './overlayPositioning.ts'

test('viewport points convert to app layout coordinates at every supported scale extreme', () => {
  assert.deepEqual(viewportPointToAppLayout({ x: 400, y: 240 }, 0.8), { x: 500, y: 300 })
  assert.deepEqual(viewportPointToAppLayout({ x: 400, y: 240 }, 1), { x: 400, y: 240 })
  assert.deepEqual(viewportPointToAppLayout({ x: 400, y: 250 }, 1.25), { x: 320, y: 200 })
})

test('viewport sizes and rectangles use the same app layout coordinate space', () => {
  assert.deepEqual(viewportSizeToAppLayout({ width: 1000, height: 800 }, 1.25), {
    width: 800,
    height: 640
  })
  assert.deepEqual(viewportRectToAppLayout({
    x: 200,
    y: 100,
    width: 125,
    height: 50,
    right: 325,
    bottom: 150
  }, 1.25), {
    x: 160,
    y: 80,
    width: 100,
    height: 40,
    right: 260,
    bottom: 120
  })
})

test('invalid UI scales safely fall back to unscaled viewport coordinates', () => {
  assert.deepEqual(viewportPointToAppLayout({ x: 120, y: 80 }, 0), { x: 120, y: 80 })
  assert.deepEqual(viewportPointToAppLayout({ x: 120, y: 80 }, Number.NaN), { x: 120, y: 80 })
})

test('fixed overlays clamp to the bottom-right edge at every supported scale extreme', () => {
  const cases = [
    { uiScale: 0.8, expected: { left: 1022, top: 692 } },
    { uiScale: 1, expected: { left: 772, top: 492 } },
    { uiScale: 1.25, expected: { left: 572, top: 332 } }
  ]

  for (const { uiScale, expected } of cases) {
    const viewport = viewportSizeToAppLayout({ width: 1000, height: 800 }, uiScale)
    const anchor = viewportPointToAppLayout({ x: 995, y: 795 }, uiScale)

    assert.deepEqual(clampFixedOverlayPosition({
      anchor,
      overlay: { width: 220, height: 300 },
      viewport,
      edgePadding: 8
    }), expected)
  }
})

test('fixed overlays clamp to top-left padding when the pointer is outside the viewport', () => {
  assert.deepEqual(clampFixedOverlayPosition({
    anchor: { x: -10, y: -20 },
    overlay: { width: 220, height: 300 },
    viewport: { width: 1000, height: 800 },
    edgePadding: 8
  }), {
    left: 8,
    top: 8
  })
})
