import assert from 'node:assert/strict'
import test from 'node:test'
import { AdaptiveNormalization } from './adaptiveNormalization.ts'

const rate = 48000
function tone(seconds: number, amplitude: number, frequency = 1000): Float32Array[] {
  const channel = Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate))
  return [channel, channel]
}

test('first-buffer loud audio is attenuated; silence and a quiet intro cannot turn up provisional gain', () => {
  const estimator = new AdaptiveNormalization(rate)
  assert.equal(estimator.gain(-14).gainDb, -6)
  estimator.ingest(tone(0.8, 0), 0)
  estimator.ingest(tone(0.8, 0.002), rate * 0.8)
  assert.equal(estimator.gain(-14).gainDb, -6)
  estimator.ingest(tone(0.8, 0.9), rate * 1.6)
  assert.ok(estimator.gain(-14).gainDb < -12, 'loud buffered audio reduces gain before it plays')
  const loudGain = estimator.gain(-14).gainDb
  estimator.ingest(tone(8, 0.03), rate * 2.4)
  assert.equal(estimator.gain(-14).gainDb, loudGain, 'a quieter section does not cause gain pumping')
})

test('seeking back or replacing quality never counts the same timeline windows again', () => {
  const estimator = new AdaptiveNormalization(rate)
  estimator.ingest(tone(2, 0.5), 0)
  const gain = estimator.gain(-14).gainDb
  estimator.ingest(tone(2, 0.99), 0)
  assert.equal(estimator.measuredSeconds, 2)
  assert.equal(estimator.gain(-14).gainDb, gain)
  estimator.ingest(tone(0.8, 0.5), rate * 10)
  assert.equal(estimator.measuredSeconds, 2.8)
  // This reread overlaps the old and newly available portions of the track.
  estimator.ingest(tone(2, 0.5), rate)
  assert.equal(estimator.measuredSeconds, 3.6)
})

test('chunk boundaries do not lose samples or restart filters', () => {
  const audio = tone(3.2, 0.8)
  const whole = new AdaptiveNormalization(rate)
  whole.ingest(audio, 0)
  const chunks = new AdaptiveNormalization(rate)
  for (let offset = 0; offset < audio[0].length; offset += 1987) {
    chunks.ingest(audio.map(channel => channel.subarray(offset, offset + 1987)), offset)
  }
  assert.equal(chunks.measuredSeconds, whole.measuredSeconds)
  assert.ok(Math.abs(chunks.gain(-14).gainDb - whole.gain(-14).gainDb) < 1e-8)
})

test('an unaligned seek discards only its leading partial window and preserves earlier evidence', () => {
  const estimator = new AdaptiveNormalization(rate)
  estimator.ingest(tone(0.8, 0.8), 0)
  const previous = estimator.gain(-14).gainDb
  estimator.ingest(tone(0.1, 0.8), rate * 4.05)
  estimator.ingest(tone(0.65, 0.8), rate * 4.15)
  assert.equal(estimator.measuredSeconds, 1.2)
  assert.ok(Math.abs(estimator.gain(-14).gainDb - previous) < 0.01)
})

test('absolute and relative gates prevent silence from diluting loudness', () => {
  const withSilence = new AdaptiveNormalization(rate)
  withSilence.ingest(tone(8, 0), 0)
  withSilence.ingest(tone(0.8, 0.8), rate * 8)
  const loud = new AdaptiveNormalization(rate)
  loud.ingest(tone(0.8, 0.8), 0)
  assert.equal(withSilence.gain(-14).gainDb, loud.gain(-14).gainDb)
  assert.ok(Number.isFinite(withSilence.gain(-70).gainDb))
  assert.equal(withSilence.gain(-70).gainDb, -18, 'respect the existing normalization gain bounds')
  assert.ok(withSilence.gain(0).gainDb <= 0, 'provisional analysis never boosts')
})
