import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { spectrum } = require('../build/Release/visualizer_dsp.node')
const SAMPLE_RATE = 48000

function tone(frequencyHz, length, amplitude = 1) {
  return Float32Array.from(
    { length },
    (_, index) => Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE) * amplitude,
  )
}

function mixedTone(tones, length) {
  return Float32Array.from({ length }, (_, index) => tones.reduce(
    (sample, item) => sample + Math.sin((2 * Math.PI * item.frequencyHz * index) / SAMPLE_RATE) * item.amplitude,
    0,
  ))
}

function configure(fftSize, overrides = {}) {
  spectrum.setFFTSize(fftSize)
  spectrum.setSampleRate(SAMPLE_RATE)
  spectrum.setSmoothing(0)
  spectrum.reset()
  spectrum.configureBars({
    barCount: 80,
    minFrequency: 20,
    maxFrequency: 20000,
    minDecibels: -100,
    maxDecibels: 0,
    tiltDbPerOctave: 0,
    heatmapTiltDbPerOctave: 0,
    tiltReferenceHz: 1000,
    heatmapSmoothing: 0,
    showPeaks: false,
    ...overrides,
  })
}

function strongestBar(frame) {
  let best = 0
  for (let index = 1; index < frame.length / 3; index += 1) {
    if (frame[index * 3] > frame[best * 3]) best = index
  }
  return best
}

function expectedLogBand(frequencyHz, count, minFrequency = 20, maxFrequency = 20000) {
  const normalized = Math.log(frequencyHz / minFrequency) / Math.log(maxFrequency / minFrequency)
  return Math.min(count - 1, Math.max(0, Math.floor(normalized * count)))
}

test('adaptive bars use equal logarithmic boundaries and place tones for every FFT size', () => {
  for (const fftSize of [1024, 2048, 4096, 8192, 16384]) {
    configure(fftSize)
    for (const frequencyHz of [375, 1500, 6000, 15000]) {
      spectrum.reset()
      spectrum.pushSamples(tone(frequencyHz, fftSize))
      const frame = spectrum.getBarFrame(0)
      const count = frame.length / 3
      assert.ok(Math.abs(strongestBar(frame) - expectedLogBand(frequencyHz, count)) <= 1,
        `FFT ${fftSize}, tone ${frequencyHz} Hz`)
    }
  }
})

test('adaptive bars use the strongest FFT bin rather than averaging a band', () => {
  const fftSize = 4096
  configure(fftSize, { barCount: 1, minFrequency: 900, maxFrequency: 1300 })
  spectrum.pushSamples(mixedTone([
    { frequencyHz: 1007.8125, amplitude: 0.5 },
    { frequencyHz: 1195.3125, amplitude: 0.02 },
  ], fftSize))
  const frame = spectrum.getBarFrame(0)
  assert.equal(frame.length, 3)
  assert.ok(frame[0] > 0.92 && frame[0] < 0.96, `expected about -6 dB, got normalized ${frame[0]}`)
})

test('bar count clamps to visible FFT bins and output remains finite and normalized', () => {
  configure(1024, { barCount: 512, maxFrequency: 999999 })
  spectrum.pushSamples(tone(1000, 1024))
  const frame = spectrum.getBarFrame(0)
  assert.equal(frame.length / 3, 511)
  for (const value of frame) {
    assert.ok(Number.isFinite(value))
    assert.ok(value >= 0 && value <= 1)
  }
})

test('heat smoothing and heat tilt are native and configuration resets their state', () => {
  const fftSize = 4096
  configure(fftSize, {
    barCount: 1,
    minFrequency: 900,
    maxFrequency: 1100,
    heatmapSmoothing: 0.5,
  })
  spectrum.pushSamples(tone(1007.8125, fftSize, 0.01))
  const quietHeat = spectrum.getBarFrame(0)[1]
  spectrum.pushSamples(tone(1007.8125, fftSize, 0.1))
  const smoothedHeat = spectrum.getBarFrame(16)[1]

  spectrum.configureBars({
    barCount: 1,
    minFrequency: 900,
    maxFrequency: 1100,
    minDecibels: -100,
    maxDecibels: 0,
    tiltDbPerOctave: 0,
    heatmapTiltDbPerOctave: 0,
    tiltReferenceHz: 1000,
    heatmapSmoothing: 0,
    showPeaks: false,
  })
  const resetHeat = spectrum.getBarFrame(32)[1]
  assert.ok(smoothedHeat > quietHeat)
  assert.ok(resetHeat > smoothedHeat, 'configuration reset should bypass prior heat smoothing state')

  configure(fftSize, { barCount: 40, heatmapTiltDbPerOctave: 6 })
  spectrum.pushSamples(mixedTone([
    { frequencyHz: 375, amplitude: 0.1 },
    { frequencyHz: 6000, amplitude: 0.1 },
  ], fftSize))
  const tilted = spectrum.getBarFrame(0)
  const lowIndex = expectedLogBand(375, tilted.length / 3)
  const highIndex = expectedLogBand(6000, tilted.length / 3)
  assert.ok(tilted[highIndex * 3 + 1] > tilted[lowIndex * 3 + 1])
})

test('bar peaks hold for 750 ms then fall at 18 dB per second deterministically', () => {
  const fftSize = 4096
  configure(fftSize, {
    barCount: 1,
    minFrequency: 900,
    maxFrequency: 1100,
    showPeaks: true,
  })
  spectrum.pushSamples(tone(1007.8125, fftSize))
  const initialPeak = spectrum.getBarFrame(0)[2]

  spectrum.pushSamples(new Float32Array(fftSize))
  const heldAt500 = spectrum.getBarFrame(500)[2]
  const heldAt750 = spectrum.getBarFrame(750)[2]
  const decayedAt1250 = spectrum.getBarFrame(1250)[2]

  assert.ok(Math.abs(heldAt500 - initialPeak) < 1e-4)
  assert.ok(Math.abs(heldAt750 - initialPeak) < 1e-4)
  assert.ok(Math.abs(decayedAt1250 - (initialPeak - 0.09)) < 0.01,
    `expected 9 dB decay after 500 ms, got ${initialPeak - decayedAt1250}`)
})
