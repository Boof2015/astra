import assert from 'node:assert/strict'
import test from 'node:test'
import { formatParallaxTrimMs, stepParallaxTrimMs } from './parallaxHelpers.ts'

test('Parallax trim formatter uses one zero-value label', () => {
  assert.equal(formatParallaxTrimMs(0), 'On time')
  assert.equal(formatParallaxTrimMs(0.4), 'On time')
  assert.equal(formatParallaxTrimMs(1), '+1 ms')
  assert.equal(formatParallaxTrimMs(-5), '-5 ms')
})

test('Parallax trim steps accumulate from the optimistic desired value and clamp', () => {
  const afterRapidClicks = [1, 1, 5].reduce(stepParallaxTrimMs, 0)
  assert.equal(afterRapidClicks, 7)
  assert.equal(stepParallaxTrimMs(499, 5), 500)
  assert.equal(stepParallaxTrimMs(-499, -5), -500)
})
