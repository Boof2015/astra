import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_UI_SCALE_PERCENT,
  MAX_UI_SCALE_PERCENT,
  MIN_UI_SCALE_PERCENT,
  UI_SCALE_STEP_PERCENT,
  getNextUIScalePercent
} from './uiStore.ts'

test('getNextUIScalePercent increases and decreases by the configured UI scale step', () => {
  assert.equal(
    getNextUIScalePercent(DEFAULT_UI_SCALE_PERCENT, 'increase'),
    DEFAULT_UI_SCALE_PERCENT + UI_SCALE_STEP_PERCENT
  )
  assert.equal(
    getNextUIScalePercent(DEFAULT_UI_SCALE_PERCENT, 'decrease'),
    DEFAULT_UI_SCALE_PERCENT - UI_SCALE_STEP_PERCENT
  )
})

test('getNextUIScalePercent clamps to the configured UI scale bounds', () => {
  assert.equal(getNextUIScalePercent(MAX_UI_SCALE_PERCENT, 'increase'), MAX_UI_SCALE_PERCENT)
  assert.equal(getNextUIScalePercent(MIN_UI_SCALE_PERCENT, 'decrease'), MIN_UI_SCALE_PERCENT)
})

test('getNextUIScalePercent resets to the default UI scale', () => {
  assert.equal(getNextUIScalePercent(MAX_UI_SCALE_PERCENT, 'reset'), DEFAULT_UI_SCALE_PERCENT)
})
