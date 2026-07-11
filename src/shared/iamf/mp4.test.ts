import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { extractIamfObuStreamFromMp4, mp4HasIamfTrack, readMp4DurationSeconds } from './mp4.ts'
import { decodeIamfObuStream, instantiateIamfDecoder } from './iamfWasmDriver.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const WASM_PATH = join(import.meta.dirname, '../../renderer/public/iamf-decoder.wasm')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

test('mp4HasIamfTrack detects both MP4 variants and rejects non-MP4', () => {
  assert.equal(mp4HasIamfTrack(fixture('test_000020_s.mp4')), true)
  assert.equal(mp4HasIamfTrack(fixture('test_000020_f.mp4')), true)
  assert.equal(mp4HasIamfTrack(fixture('test_000020.iamf')), false)
})

test('standalone and fragmented MP4 decode identically to the raw OBU stream', async () => {
  const wasm = await instantiateIamfDecoder(readFileSync(WASM_PATH))
  const reference = await decodeIamfObuStream(wasm, fixture('test_000020.iamf'))

  for (const name of ['test_000020_s.mp4', 'test_000020_f.mp4']) {
    const stream = extractIamfObuStreamFromMp4(fixture(name))
    const result = await decodeIamfObuStream(wasm, stream)
    assert.equal(result.sampleRate, reference.sampleRate, name)
    assert.equal(result.frames, reference.frames, name)
    for (const channel of [0, 1]) {
      let maxDiff = 0
      for (let i = 0; i < result.frames; i++) {
        const diff = Math.abs(result.channelData[channel][i] - reference.channelData[channel][i])
        if (diff > maxDiff) maxDiff = diff
      }
      assert.ok(maxDiff < 1e-6, `${name} channel ${channel} differs from OBU decode (max ${maxDiff})`)
    }
  }
})

test('readMp4DurationSeconds reads mvhd from the standalone fixture', () => {
  const duration = readMp4DurationSeconds(fixture('test_000020_s.mp4'))
  assert.ok(duration !== null && Math.abs(duration - 0.5) < 0.05, `duration ${duration}`)
})

test('extractIamfObuStreamFromMp4 rejects MP4s without an IAMF track', () => {
  const ftypOnly = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1])
  assert.throws(() => extractIamfObuStreamFromMp4(ftypOnly), /no IAMF track/)
})
