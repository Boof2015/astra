import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLocalPcmPipeOutputArgs,
  localPcmRechunkPacketBytes
} from './localPcmRechunkedPipe.ts'

test('keeps the default stdout output arguments byte-for-byte unchanged', () => {
  assert.deepEqual(buildLocalPcmPipeOutputArgs(false), ['pipe:1'])
})

test('builds output-scoped rechunk arguments without tail padding', () => {
  assert.deepEqual(buildLocalPcmPipeOutputArgs(true), [
    '-bsf:a',
    'pcm_rechunk=n=8192:p=0',
    '-avioflags',
    'direct',
    'pipe:1'
  ])
})

test('targets the 64 KiB stereo read ceiling with bounded multichannel packets', () => {
  assert.equal(localPcmRechunkPacketBytes(1), 32 * 1024)
  assert.equal(localPcmRechunkPacketBytes(2), 64 * 1024)
  assert.equal(localPcmRechunkPacketBytes(8), 256 * 1024)
})

test('rejects unsupported rechunk channel counts', () => {
  for (const channels of [0, 1.5, 9, Number.NaN]) {
    assert.throws(() => localPcmRechunkPacketBytes(channels), /integer from 1 through 8/)
  }
})
