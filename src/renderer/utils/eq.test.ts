import test from 'node:test'
import assert from 'node:assert/strict'
import type { EQBand } from '../types/audio.ts'
import {
  computeEQFilterMagnitude,
  EQ_MAX_BANDS,
  parseEQPresetData,
  serializeEQPresetData,
} from './eq.ts'

function createBand(overrides: Partial<EQBand> = {}): EQBand {
  return {
    id: overrides.id ?? 'band-1',
    type: overrides.type ?? 'peaking',
    frequency: overrides.frequency ?? 1000,
    gain: overrides.gain ?? 0,
    Q: overrides.Q ?? 1,
  }
}

test('lowpass magnitude stays near unity below cutoff and attenuates above it', () => {
  const band = createBand({
    type: 'lowpass',
    frequency: 1000,
    gain: 6,
    Q: Math.SQRT1_2,
  })

  const belowCutoff = computeEQFilterMagnitude(band, 100, 48000)
  const atCutoff = computeEQFilterMagnitude(band, 1000, 48000)
  const aboveCutoff = computeEQFilterMagnitude(band, 10000, 48000)

  assert.ok(Math.abs(belowCutoff) < 0.25)
  assert.ok(atCutoff < -2.5 && atCutoff > -3.5)
  assert.ok(aboveCutoff < -35)
})

test('highpass magnitude stays near unity above cutoff and attenuates below it', () => {
  const band = createBand({
    type: 'highpass',
    frequency: 1000,
    gain: -9,
    Q: Math.SQRT1_2,
  })

  const belowCutoff = computeEQFilterMagnitude(band, 100, 48000)
  const atCutoff = computeEQFilterMagnitude(band, 1000, 48000)
  const aboveCutoff = computeEQFilterMagnitude(band, 10000, 48000)

  assert.ok(belowCutoff < -35)
  assert.ok(atCutoff < -2.5 && atCutoff > -3.5)
  assert.ok(Math.abs(aboveCutoff) < 0.25)
})

test('preset serialization and parsing round-trip HP/LP while normalizing gain', () => {
  const serialized = serializeEQPresetData({
    name: 'Crossover',
    preamp: -1.5,
    bands: [
      createBand({ type: 'highpass', frequency: 90, gain: 5.5, Q: 0.707 }),
      createBand({ type: 'lowpass', frequency: 14000, gain: -4.25, Q: 0.9 }),
      createBand({ type: 'peaking', frequency: 1800, gain: 2.5, Q: 1.2 }),
    ],
  })

  assert.equal(serialized.version, 1)
  assert.deepEqual(
    serialized.bands.map((band) => ({ type: band.type, gain: band.gain })),
    [
      { type: 'highpass', gain: 0 },
      { type: 'lowpass', gain: 0 },
      { type: 'peaking', gain: 2.5 },
    ]
  )

  let nextId = 0
  const parsed = parseEQPresetData(serialized, () => `band-${++nextId}`)

  assert.equal(parsed.name, 'Crossover')
  assert.equal(parsed.preamp, -1.5)
  assert.deepEqual(
    parsed.bands.map(({ id, type, frequency, gain, Q }) => ({ id, type, frequency, gain, Q })),
    [
      { id: 'band-1', type: 'highpass', frequency: 90, gain: 0, Q: 0.707 },
      { id: 'band-2', type: 'lowpass', frequency: 14000, gain: 0, Q: 0.9 },
      { id: 'band-3', type: 'peaking', frequency: 1800, gain: 2.5, Q: 1.2 },
    ]
  )
})

test('legacy peaking and shelf presets still load unchanged', () => {
  let nextId = 0
  const parsed = parseEQPresetData({
    name: 'Legacy',
    preamp: 2,
    bands: [
      { type: 'lowshelf', frequency: 70, gain: 3, Q: 0.8 },
      { type: 'peaking', frequency: 1000, gain: -1.5, Q: 1.1 },
      { type: 'highshelf', frequency: 9000, gain: 2.25, Q: 0.7 },
    ],
  }, () => `legacy-${++nextId}`)

  assert.deepEqual(
    parsed.bands.map(({ id, type, frequency, gain, Q }) => ({ id, type, frequency, gain, Q })),
    [
      { id: 'legacy-1', type: 'lowshelf', frequency: 70, gain: 3, Q: 0.8 },
      { id: 'legacy-2', type: 'peaking', frequency: 1000, gain: -1.5, Q: 1.1 },
      { id: 'legacy-3', type: 'highshelf', frequency: 9000, gain: 2.25, Q: 0.7 },
    ]
  )
})

test('preset parsing preserves the first maximum supported bands', () => {
  let nextId = 0
  const parsed = parseEQPresetData({
    name: 'Twenty Plus',
    preamp: 0,
    bands: Array.from({ length: EQ_MAX_BANDS + 3 }, (_, index) => ({
      type: 'peaking',
      frequency: 100 + index,
      gain: 0,
      Q: 1,
    })),
  }, () => `cap-${++nextId}`)

  assert.equal(parsed.bands.length, EQ_MAX_BANDS)
  assert.equal(nextId, EQ_MAX_BANDS)
  assert.equal(parsed.bands[0].id, 'cap-1')
  assert.equal(parsed.bands[0].frequency, 100)
  assert.equal(parsed.bands.at(-1)?.id, `cap-${EQ_MAX_BANDS}`)
  assert.equal(parsed.bands.at(-1)?.frequency, 100 + EQ_MAX_BANDS - 1)
})
