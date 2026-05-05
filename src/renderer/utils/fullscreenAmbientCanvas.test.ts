import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FULLSCREEN_AMBIENT_CANVAS_MAX_DPR,
  FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS,
  isSameFullscreenAmbientCanvasSize,
  resolveFullscreenAmbientCanvasSize,
} from './fullscreenAmbientCanvas.ts'

test('fullscreen ambient canvas preserves normal device pixel ratios below the cap', () => {
  const size = resolveFullscreenAmbientCanvasSize(1280, 720, 1.25)

  assert.equal(size.cssWidth, 1280)
  assert.equal(size.cssHeight, 720)
  assert.equal(size.dpr, 1.25)
  assert.equal(size.pixelWidth, 1600)
  assert.equal(size.pixelHeight, 900)
})

test('fullscreen ambient canvas caps retina backing stores on large displays', () => {
  const size = resolveFullscreenAmbientCanvasSize(3840, 2160, 2)

  assert.ok(size.dpr < FULLSCREEN_AMBIENT_CANVAS_MAX_DPR)
  assert.ok(size.dpr > 1)
  assert.ok(size.pixelWidth * size.pixelHeight <= FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS)
})

test('fullscreen ambient canvas can scale below one backing pixel per css pixel on huge displays', () => {
  const size = resolveFullscreenAmbientCanvasSize(6016, 3384, 2)

  assert.ok(size.dpr < 1)
  assert.ok(size.pixelWidth * size.pixelHeight <= FULLSCREEN_AMBIENT_CANVAS_MAX_PIXELS)
})

test('fullscreen ambient canvas detects repeated same-size resizes', () => {
  const first = resolveFullscreenAmbientCanvasSize(3840, 2160, 2)
  const second = resolveFullscreenAmbientCanvasSize(3840, 2160, 2)
  const different = resolveFullscreenAmbientCanvasSize(3841, 2160, 2)

  assert.equal(isSameFullscreenAmbientCanvasSize(first, second), true)
  assert.equal(isSameFullscreenAmbientCanvasSize(first, different), false)
})
