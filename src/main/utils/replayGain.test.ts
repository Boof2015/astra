import assert from 'node:assert/strict'
import test from 'node:test'
import type { IAudioMetadata } from 'music-metadata'
import {
  extractReplayGainDb,
  normalizeR128GainDb,
  normalizeReplayGainDb
} from './replayGain.ts'

function createMetadata(options: {
  codec?: string
  common?: Record<string, unknown>
  format?: Record<string, unknown>
  nativeTags?: Array<{ id: string; value: unknown }>
} = {}): IAudioMetadata {
  return {
    common: options.common ?? {},
    format: {
      codec: options.codec ?? 'Opus',
      ...options.format
    },
    native: {
      vorbis: options.nativeTags ?? []
    }
  } as unknown as IAudioMetadata
}

test('normalizes conventional ReplayGain representations', () => {
  assert.equal(normalizeReplayGainDb('-7.25 dB'), -7.25)
  assert.equal(normalizeReplayGainDb('-7,25 dB'), -7.25)
  assert.equal(normalizeReplayGainDb({ dB: -7.25, ratio: 0.1 }), -7.25)
  assert.equal(normalizeReplayGainDb(['invalid', '+1.5 dB']), 1.5)
})

test('normalizes signed 16-bit R128 Q7.8 gain values', () => {
  assert.equal(normalizeR128GainDb('-3430'), -13.3984375)
  assert.equal(normalizeR128GainDb('+256'), 1)
  assert.equal(normalizeR128GainDb(-3382), -13.2109375)
  assert.equal(normalizeR128GainDb('-32768'), -128)
  assert.equal(normalizeR128GainDb('+32767'), 32767 / 256)
})

test('rejects malformed and out-of-range R128 gain values', () => {
  for (const value of [
    '',
    ' -3430',
    '-3430 ',
    '-13.4',
    '1e3',
    '32768',
    '-32769',
    '+032767',
    Number.NaN,
    1.5
  ]) {
    assert.equal(normalizeR128GainDb(value), null, String(value))
  }
})

test('extracts Opus R128 track and album gain tags', () => {
  const replayGain = extractReplayGainDb(createMetadata({
    nativeTags: [
      { id: 'R128_TRACK_GAIN', value: '-3382' },
      { id: 'R128_ALBUM_GAIN', value: '-3430' }
    ]
  }))

  assert.deepEqual(replayGain, {
    trackGainDb: -13.2109375,
    albumGainDb: -13.3984375
  })
})

test('keeps the same Opus R128 album gain across tracks with different track gain', () => {
  const trackGainTags = ['-3382', '-3713', '-3653']
  const gains = trackGainTags.map((trackGain) => extractReplayGainDb(createMetadata({
    nativeTags: [
      { id: 'R128_TRACK_GAIN', value: trackGain },
      { id: 'R128_ALBUM_GAIN', value: '-3430' }
    ]
  })))

  assert.deepEqual(gains.map((gain) => gain.trackGainDb), [
    -13.2109375,
    -14.50390625,
    -14.26953125
  ])
  assert.deepEqual(gains.map((gain) => gain.albumGainDb), [
    -13.3984375,
    -13.3984375,
    -13.3984375
  ])
})

test('prefers conventional ReplayGain values over Opus R128 values', () => {
  const replayGain = extractReplayGainDb(createMetadata({
    nativeTags: [
      { id: 'REPLAYGAIN_TRACK_GAIN', value: '-4.5 dB' },
      { id: 'REPLAYGAIN_ALBUM_GAIN', value: '-5.5 dB' },
      { id: 'R128_TRACK_GAIN', value: '-3382' },
      { id: 'R128_ALBUM_GAIN', value: '-3430' }
    ]
  }))

  assert.deepEqual(replayGain, {
    trackGainDb: -4.5,
    albumGainDb: -5.5
  })
})

test('does not interpret R128 fixed-point tags on non-Opus audio', () => {
  const replayGain = extractReplayGainDb(createMetadata({
    codec: 'FLAC',
    nativeTags: [
      { id: 'R128_TRACK_GAIN', value: '-3382' },
      { id: 'R128_ALBUM_GAIN', value: '-3430' }
    ]
  }))

  assert.deepEqual(replayGain, {
    trackGainDb: null,
    albumGainDb: null
  })
})

test('retains native ReplayGain fallback for numeric Vorbis comments', () => {
  const replayGain = extractReplayGainDb(createMetadata({
    codec: 'FLAC',
    nativeTags: [
      { id: 'REPLAYGAIN_TRACK_GAIN', value: '-12.49' },
      { id: 'REPLAYGAIN_ALBUM_GAIN', value: '-13.94' }
    ]
  }))

  assert.deepEqual(replayGain, {
    trackGainDb: -12.49,
    albumGainDb: -13.94
  })
})
