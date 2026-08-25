import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WAVEFORM_BAR_STAGGER_MS,
  getWaveformBarScale,
  getWaveformBaselineStrength,
  getWaveformTransitionDurationMs,
  interpolateWaveformBarHeight,
} from './waveformTransition'

test('waveform bars use a restrained left-to-right stagger', () => {
  const firstBar = getWaveformBarScale('enter', 18, 0, 32)
  const middleBar = getWaveformBarScale('enter', 18, 16, 32)
  const finalBar = getWaveformBarScale('enter', 18, 31, 32)

  assert.ok(firstBar > middleBar)
  assert.equal(finalBar, 0)
  assert.ok(WAVEFORM_BAR_STAGGER_MS < 50)
})

test('enter and exit motion reaches exact stable endpoints', () => {
  for (const phase of ['enter', 'exit', 'handoff'] as const) {
    const totalMs = getWaveformTransitionDurationMs(phase)
    for (let index = 0; index < 24; index += 1) {
      const startScale = getWaveformBarScale(phase, 0, index, 24, 0.625)
      const endScale = getWaveformBarScale(phase, totalMs, index, 24, 0.625)
      assert.equal(startScale, phase === 'exit' ? 0.625 : 0)
      assert.equal(endScale, phase === 'exit' ? 0 : 1)
    }
  }
})

test('baseline replaces collapsing bars and recedes beneath entering bars', () => {
  const exitDuration = getWaveformTransitionDurationMs('exit')
  const enterDuration = getWaveformTransitionDurationMs('enter')

  assert.equal(getWaveformBaselineStrength('exit', 0), 0)
  assert.equal(getWaveformBaselineStrength('exit', exitDuration), 1)
  assert.equal(getWaveformBaselineStrength('enter', 0), 1)
  assert.equal(getWaveformBaselineStrength('enter', enterDuration), 0)
  assert.equal(getWaveformBaselineStrength('handoff', 0), 0)
  assert.equal(
    getWaveformBaselineStrength('handoff', getWaveformTransitionDurationMs('handoff')),
    0,
  )
})

test('interrupted exit scales remain finite and bounded by their captured height', () => {
  for (let elapsedMs = -20; elapsedMs < 220; elapsedMs += 3) {
    const scale = getWaveformBarScale('exit', elapsedMs, 7, 16, 0.42)
    assert.ok(Number.isFinite(scale))
    assert.ok(scale >= 0 && scale <= 0.42)
  }
})

test('ready waveform handoffs interpolate directly without collapsing positive bars', () => {
  for (let step = 0; step <= 20; step += 1) {
    const height = interpolateWaveformBarHeight(0.8, 0.3, step / 20)
    assert.ok(height >= 0.3 && height <= 0.8)
  }
  assert.equal(interpolateWaveformBarHeight(0.8, 0.3, 0), 0.8)
  assert.equal(interpolateWaveformBarHeight(0.8, 0.3, 1), 0.3)
})
