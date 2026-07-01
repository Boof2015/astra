import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MINI_WINDOW_DEFAULT_HEIGHT,
  MINI_WINDOW_DEFAULT_WIDTH,
  MINI_WINDOW_MAX_HEIGHT,
  MINI_WINDOW_MAX_WIDTH,
  MINI_WINDOW_MIN_HEIGHT,
  MINI_WINDOW_MIN_WIDTH,
  normalizeMiniWindowPrefs
} from './miniWindowPrefs.ts'

test('mini window preferences use the compact bounds and visualizer-off default', () => {
  assert.deepEqual(normalizeMiniWindowPrefs(null), {
    width: MINI_WINDOW_DEFAULT_WIDTH,
    height: MINI_WINDOW_DEFAULT_HEIGHT,
    alwaysOnTop: true,
    visualizerMode: 'off'
  })
})

test('mini window preferences clamp undersized and oversized bounds', () => {
  assert.deepEqual(
    normalizeMiniWindowPrefs({ width: 100, height: 80, alwaysOnTop: false }),
    {
      width: MINI_WINDOW_MIN_WIDTH,
      height: MINI_WINDOW_MIN_HEIGHT,
      alwaysOnTop: false,
      visualizerMode: 'off'
    }
  )

  assert.deepEqual(
    normalizeMiniWindowPrefs({ width: 1600, height: 1200, visualizerMode: 'spectrum' }),
    {
      width: MINI_WINDOW_MAX_WIDTH,
      height: MINI_WINDOW_MAX_HEIGHT,
      alwaysOnTop: true,
      visualizerMode: 'spectrum'
    }
  )
})

test('mini window preferences preserve explicit visualizer modes', () => {
  assert.equal(normalizeMiniWindowPrefs({ width: 440, height: 164, visualizerMode: 'oscilloscope' }).visualizerMode, 'oscilloscope')
  assert.equal(normalizeMiniWindowPrefs({ width: 440, height: 164, visualizerMode: 'spectrum' }).visualizerMode, 'spectrum')
})
