import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMiniVisualizerDemand } from './miniVisualizerDemand.ts'

test('independent consumers combine channel demand without another queue drain', () => {
  assert.deepEqual(resolveMiniVisualizerDemand('spectrum', 'oscilloscope', true), { miniSpectrum: true, miniOscilloscope: true })
  assert.deepEqual(resolveMiniVisualizerDemand('oscilloscope', 'spectrum', true), { miniSpectrum: true, miniOscilloscope: true })
  assert.deepEqual(resolveMiniVisualizerDemand('off', 'spectrum', true), { miniSpectrum: true, miniOscilloscope: false })
  assert.deepEqual(resolveMiniVisualizerDemand('spectrum', 'off', true), { miniSpectrum: true, miniOscilloscope: false })
})
test('no stream is demanded while paused, disabled, or both consumers are hidden', () => {
  assert.deepEqual(resolveMiniVisualizerDemand('spectrum', 'oscilloscope', false), { miniSpectrum: false, miniOscilloscope: false })
  assert.deepEqual(resolveMiniVisualizerDemand('off', 'off', true), { miniSpectrum: false, miniOscilloscope: false })
})
