import assert from 'node:assert/strict'
import test from 'node:test'
import { fillNotchSpectrum, notchOscilloscopeGain, notchOscilloscopeY, smoothNotchSpectrum } from './notchVisualizer.ts'
import { getNormalizedOscilloscopeDisplaySamples } from '../../audio/native/oscilloscopeDisplaySamples.ts'

test('scope uses the main time window and amplitude at ordinary and high sample rates', () => {
  for (const rate of [44100, 48000, 96000, 192000]) {
    const duration = getNormalizedOscilloscopeDisplaySamples(rate) / rate
    assert.ok(duration > 0.042 && duration < 0.047)
  }
  assert.equal(notchOscilloscopeY(0, 20), 10)
  assert.ok(Math.abs(notchOscilloscopeY(0.5, 20) - 1) < 1e-6)
})

test('spectrum interpolates shared bass bins instead of drawing stair steps', () => {
  const data = Float32Array.from({ length: 2048 }, (_, i) => -80 + i)
  const output = new Float32Array(323)
  fillNotchSpectrum(data, 48000, output)
  for (let i = 1; i < 12; i++) assert.ok(output[i] > output[i - 1])
})

test('large scope peaks stay inside the strip with gradual gain recovery', () => {
  const samples = new Float32Array([0, 0.95, -0.87])
  const gain = notchOscilloscopeGain(samples, 1.8, 16)
  for (const sample of samples) {
    const y = notchOscilloscopeY(sample, 20, gain)
    assert.ok(y >= 0.99 && y <= 19.01)
  }
  const recovering = notchOscilloscopeGain(new Float32Array([0.1]), gain, 16)
  assert.ok(recovering > gain && recovering < gain + 0.1)
})

test('a narrow treble peak survives compression into a retina-width spectrum', () => {
  const data = new Float32Array(2048).fill(-100)
  data[1505] = -20
  const output = new Float32Array(323)
  fillNotchSpectrum(data, 48000, output)
  assert.ok(Math.max(...output) > 0.85)
  assert.equal(output[0], 0)
})

test('spectrum silence and invalid bins settle to a finite baseline', () => {
  const data = new Float32Array(2048).fill(-120)
  data[7] = NaN; data[40] = -Infinity
  const output = new Float32Array(323)
  fillNotchSpectrum(data, 48000, output)
  assert.ok(output.every(value => value === 0))
})

test('spectrum motion is consistent at 60 and 120 Hz, with a slower release', () => {
  const target = new Float32Array([1]), sixty = new Float32Array(1), oneTwenty = new Float32Array(1)
  for (let i = 0; i < 6; i++) smoothNotchSpectrum(sixty, target, 1000 / 60)
  for (let i = 0; i < 12; i++) smoothNotchSpectrum(oneTwenty, target, 1000 / 120)
  assert.ok(Math.abs(sixty[0] - oneTwenty[0]) < 1e-6)
  assert.ok(sixty[0] > 0.85 && sixty[0] < 1)
  const falling = new Float32Array([1])
  smoothNotchSpectrum(falling, new Float32Array(1), 100)
  assert.ok(falling[0] > 0.5)
  assert.ok(1 - falling[0] < sixty[0])
})
