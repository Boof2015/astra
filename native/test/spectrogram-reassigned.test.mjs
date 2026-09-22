import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { spectrogram } = require('../build/Release/visualizer_dsp.node')
const defaults = {
  fftSize: 2048, sampleRate: 48000, rowCount: 601,
  minFrequency: 20, maxFrequency: 20000,
  minDecibels: -100, maxDecibels: 0,
  tiltDbPerOctave: 0, contrast: 1, scrollSpeed: 2,
  clarityMode: 'reassigned', scaleMode: 'log', orientation: 'horizontal',
}
function configure(overrides = {}) {
  const config = { ...defaults, ...overrides }
  spectrogram.configure(config)
  spectrogram.reset()
  return config
}
function tone(hz, config, amplitude = 0.1, length = config.fftSize * 2, offset = 0) {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * (i + offset) / config.sampleRate))
}
function finalColumn(result, plane = 'display') {
  return result[plane].slice((result.columnCount - 1) * result.rowCount)
}
function peakRow(column) {
  return column.indexOf(Math.max(...column))
}
function expectedRow(hz, config) {
  const mel = hz => hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27)
  const transform = config.scaleMode === 'linear' ? x => x : config.scaleMode === 'mel' ? mel : Math.log
  const fraction = (transform(hz) - transform(config.minFrequency))
    / (transform(Math.min(config.maxFrequency, config.sampleRate / 2)) - transform(config.minFrequency))
  return (config.orientation === 'vertical' ? fraction : 1 - fraction) * (config.rowCount - 1)
}
function near(actual, expected, tolerance, context) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${context}: expected ${expected}, got ${actual}`)
}
function assertNormalized(result) {
  assert.equal(result.display.length, result.columnCount * result.rowCount)
  assert.equal(result.heat.length, result.display.length)
  for (const value of [...result.display, ...result.heat]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
}

test('Reassigned tones match Log, Mel and Linear grids in both orientations and frequency ranges', () => {
  for (const [sampleRate, fftSize] of [[32000, 2048], [48000, 4096], [192000, 8192]]) {
    for (const scaleMode of ['log', 'mel', 'linear']) {
      for (const orientation of ['horizontal', 'vertical']) {
        for (const [minFrequency, maxFrequency] of [[20, 20000], [10, 24000]]) {
          const config = configure({ sampleRate, fftSize, scaleMode, orientation, minFrequency, maxFrequency })
          for (const hz of [440.3, 5234.5, 15000]) {
            spectrogram.reset()
            const result = spectrogram.process(tone(hz, config))
            near(peakRow(finalColumn(result)), expectedRow(hz, config), 1,
              `${sampleRate} Hz / ${scaleMode} / ${orientation} / ${maxFrequency} / tone ${hz}`)
            assertNormalized(result)
          }
        }
      }
    }
  }
})

test('Reassigned preserves calibrated power across FFT sizes and between-bin tones', () => {
  for (const fftSize of [1024, 4096, 8192]) {
    for (const bin of [37, 37.37]) {
      for (const amplitude of [0.5, 0.1, 0.001]) {
        const config = configure({ fftSize, rowCount: 1, minDecibels: -120, maxDecibels: 12 })
        const hz = bin * config.sampleRate / fftSize
        const result = spectrogram.process(tone(hz, config, amplitude))
        const measuredDb = Math.pow(finalColumn(result)[0], 1 / 1.1) * 132 - 120
        near(measuredDb, 20 * Math.log10(amplitude), 0.3, `FFT ${fftSize}, bin ${bin}, amplitude ${amplitude}`)
      }
    }
  }
})

test('Reassigned retains a quiet partial beside a strong tone with a narrow trace', () => {
  const config = configure({ fftSize: 8192, rowCount: 1601, scaleMode: 'linear', minFrequency: 700, maxFrequency: 1300 })
  const strong = tone(1000.3, config, 0.3)
  const quiet = tone(1045.7, config, 0.003)
  const result = spectrogram.process(Float32Array.from(strong, (value, index) => value + quiet[index]))
  const column = finalColumn(result)
  const row = Math.round(expectedRow(1045.7, config))
  const localPeak = Math.max(...column.slice(row - 1, row + 2))
  assert.ok(localPeak > 0.3, `quiet partial should remain visible, got ${localPeak}`)
  assert.ok(column[Math.round(expectedRow(1025, config))] < localPeak * 0.4, 'resolved tones should have a clear gap')
  const peak = peakRow(column)
  assert.ok(column[peak + 5] < column[peak] * 0.3, 'tone should not retain a wide standard-spectrum smear')
})

test('Reassigned is invariant to input chunk boundaries and stays silent after reset', () => {
  const config = configure()
  const samples = tone(1783.2, config, 0.1, 15001)
  const whole = spectrogram.process(samples)
  spectrogram.reset()
  const display = [], heat = []
  for (let offset = 0; offset < samples.length; offset += 137) {
    const result = spectrogram.process(samples.subarray(offset, offset + 137))
    display.push(...result.display)
    heat.push(...result.heat)
  }
  assert.deepEqual(display, Array.from(whole.display))
  assert.deepEqual(heat, Array.from(whole.heat))
  spectrogram.reset()
  const silent = spectrogram.process(new Float32Array(config.fftSize * 2))
  assertNormalized(silent)
  assert.ok(silent.display.every(value => value === 0))
  assert.ok(silent.heat.every(value => value === 0))
})

test('Reassigned refreshes phase history after mode, hop and mapping changes', () => {
  let config = configure({ clarityMode: 'sharper' })
  let offset = 0
  const feed = () => {
    const samples = tone(1876.5, config, 0.1, config.fftSize * 2, offset)
    offset += samples.length
    return spectrogram.process(samples)
  }
  feed()
  for (const update of [
    { clarityMode: 'reassigned' }, { scrollSpeed: 0.5 }, { scrollSpeed: 4 },
    { scaleMode: 'mel', orientation: 'vertical', rowCount: 333 }, { fftSize: 8192 },
  ]) {
    config = { ...config, ...update }
    spectrogram.configure(config)
    const result = feed()
    assert.ok(result.display.slice(0, config.rowCount).every(value => value === 0), 'first changed frame establishes fresh phase history')
    near(peakRow(finalColumn(result)), expectedRow(1876.5, config), 1, JSON.stringify(update))
    assertNormalized(result)
  }
  // Reconfiguring unchanged options must not continually suppress the first column.
  spectrogram.configure(config)
  assert.ok(feed().display.slice(0, config.rowCount).some(value => value > 0))
  config = { ...config, clarityMode: 'sharper' }
  spectrogram.configure(config)
  assertNormalized(feed())
})
