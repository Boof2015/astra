import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isAtmosJocStream, parseFfprobeAudioMetadata } from './ffprobeMetadata.ts'

const sample = JSON.parse(readFileSync(new URL('./__fixtures__/eac3-atmos-ffprobe.json', import.meta.url), 'utf8'))

test('sanitized reporter output identifies Atmos while keeping the six-channel compatibility layout', () => {
  const result = parseFfprobeAudioMetadata(JSON.stringify(sample))!
  assert.equal(result.codec, 'eac3')
  assert.equal(result.codecProfile, 'Dolby Digital Plus + Dolby Atmos')
  assert.equal(result.channels, 6)
  assert.equal(result.isAtmosJoc, true)
})

test('ordinary E-AC-3 and old probes without profiles are not assumed to be Atmos', () => {
  const ordinary = structuredClone(sample)
  delete ordinary.streams[0].profile
  const result = parseFfprobeAudioMetadata(JSON.stringify(ordinary))!
  assert.equal(result.isAtmosJoc, false)
  assert.equal(result.codecProfile, null)
  assert.equal(result.channels, 6)
})

test('AAC remains non-Atmos; existing JOC and dby1 detection is retained', () => {
  assert.equal(parseFfprobeAudioMetadata(JSON.stringify({ streams: [{ codec_name: 'aac', profile: 'LC', channels: 2 }] }))?.isAtmosJoc, false)
  assert.equal(isAtmosJocStream('E-AC-3', null, ['dby1']), true)
  assert.equal(isAtmosJocStream('eac3', 'JOC'), true)
  assert.equal(isAtmosJocStream('aac', null, ['Atmos']), false)
})

test('malformed, empty, and non-audio probe output cannot overwrite cached metadata', () => {
  for (const value of ['invalid json', 'null', '{}', '{"streams":{}}', '{"streams":[null,{}]}', '{"streams":[{"codec_type":"video","codec_name":"mjpeg"}]}']) {
    assert.equal(parseFfprobeAudioMetadata(value), null, value)
  }
  const result = parseFfprobeAudioMetadata('{"streams":[{"codec_name":"aac","channels":"bad","tags":null}]}')!
  assert.equal(result.channels, null)
})
