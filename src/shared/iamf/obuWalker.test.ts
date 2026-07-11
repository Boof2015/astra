import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { collectIamfStreamStats, isIamfObuStream } from './obuWalker.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const vector = new Uint8Array(readFileSync(join(FIXTURES, 'test_000020.iamf')))

test('isIamfObuStream recognizes the sequence header magic', () => {
  assert.equal(isIamfObuStream(vector), true)
  assert.equal(isIamfObuStream(vector.subarray(0, 4)), false)
  assert.equal(isIamfObuStream(new Uint8Array([0xf8, 0x06, 0x6e, 0x6f, 0x70, 0x65])), false)
  // A WAV file must not match.
  const wav = new Uint8Array(
    readFileSync(join(FIXTURES, 'test_000020_rendered_id_42_sub_mix_0_layout_0.wav'))
  )
  assert.equal(isIamfObuStream(wav), false)
})

test('collectIamfStreamStats reads codec config and counts temporal units', () => {
  const stats = collectIamfStreamStats(vector)
  assert.ok(stats)
  assert.equal(stats.codecId, 'Opus')
  assert.equal(stats.sampleRate, 48000)
  // The reference render is 24000 frames at 48 kHz (0.5 s).
  assert.equal(stats.totalSamples, 24000)
  assert.equal(stats.temporalUnits * stats.samplesPerFrame >= stats.totalSamples, true)
  assert.ok(Math.abs((stats.durationSeconds ?? 0) - 0.5) < 1e-9)
})

test('collectIamfStreamStats tolerates truncated input', () => {
  for (const cut of [3, 8, 40, vector.length - 5]) {
    // Must not throw; may return null or a partial count.
    collectIamfStreamStats(vector.subarray(0, cut))
  }
  assert.equal(collectIamfStreamStats(new Uint8Array(0)), null)
})
