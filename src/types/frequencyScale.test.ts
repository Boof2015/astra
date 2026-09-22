import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFrequencyGuides, frequencyAtNormalizedPosition, frequencyBoundsForRange, normalizedPositionAtFrequency, FREQUENCY_SCALE_MODES } from './frequencyScale.ts'

test('all scale mappings are monotonic, invertible and respect the source Nyquist limit', () => {
  for (const rate of [32000, 44100, 48000, 96000, 192000]) {
    for (const range of ['audible', 'extended'] as const) {
      const { minFrequency: min, maxFrequency: max } = frequencyBoundsForRange(range, rate)
      assert.ok(max <= rate / 2)
      assert.equal(min, range === 'audible' ? 20 : 10)
      for (const scale of FREQUENCY_SCALE_MODES) {
        let previous = 0
        for (let i = 0; i <= 100; i++) {
          const frequency = frequencyAtNormalizedPosition(i / 100, min, max, scale)
          assert.ok(frequency > previous)
          assert.ok(Math.abs(normalizedPositionAtFrequency(frequency, min, max, scale) - i / 100) < 1e-10)
          previous = frequency
        }
        for (const guide of buildFrequencyGuides(min, max, scale, 800)) {
          assert.ok(Math.abs(frequencyAtNormalizedPosition(guide.normalizedPosition, min, max, scale) - guide.frequencyHz) < 1e-7)
        }
      }
    }
  }
})

test('log guides include decade subdivisions only when the canvas can fit them', () => {
  const small = buildFrequencyGuides(20, 20000, 'log', 200)
  const large = buildFrequencyGuides(20, 20000, 'log', 2400)
  assert.ok(small.every(g => g.kind === 'major'))
  assert.ok(large.some(g => g.frequencyHz === 300 && g.kind === 'minor'))
  assert.ok(large.some(g => g.frequencyHz === 1000 && g.label === '1k'))
})
