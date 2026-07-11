import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { detectIamfContainer } from './detect.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

test('detectIamfContainer classifies the fixture containers', () => {
  assert.equal(detectIamfContainer(fixture('test_000020.iamf')), 'obu')
  assert.equal(detectIamfContainer(fixture('test_000020_s.mp4')), 'mp4')
  assert.equal(detectIamfContainer(fixture('test_000020_f.mp4')), 'mp4')
})

test('detectIamfContainer rejects non-IAMF content', () => {
  assert.equal(
    detectIamfContainer(fixture('test_000020_rendered_id_42_sub_mix_0_layout_0.wav')),
    null
  )
  assert.equal(detectIamfContainer(new Uint8Array(0)), null)
  assert.equal(detectIamfContainer(new Uint8Array(64)), null)
  // A plausible-but-empty MP4 (ftyp only) has no IAMF track.
  const ftypOnly = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1])
  assert.equal(detectIamfContainer(ftypOnly), null)
})
