import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  copyCompleteFloat32PcmToChannels,
  validateCompleteFloat32Pcm,
  type CompleteFloat32Pcm,
} from './completePcm.ts'

function makePcm(samples: number[], channels: number, frames: number): CompleteFloat32Pcm {
  return {
    sampleRate: 48_000,
    channels,
    frames,
    pcmByteLength: samples.length * Float32Array.BYTES_PER_ELEMENT,
    interleavedPcm: Float32Array.from(samples).buffer,
  }
}

test('complete PCM copy preserves every interleaved channel and frame', () => {
  const pcm = makePcm([
    1, 10, 100,
    2, 20, 200,
    3, 30, 300,
  ], 3, 3)
  const destinations = Array.from({ length: pcm.channels }, () => new Float32Array(pcm.frames))

  copyCompleteFloat32PcmToChannels(pcm, destinations)

  assert.deepEqual(destinations.map((channel) => Array.from(channel)), [
    [1, 2, 3],
    [10, 20, 30],
    [100, 200, 300],
  ])
})

test('complete PCM copy handles mono without changing samples', () => {
  const pcm = makePcm([0.25, -0.5, 0.75], 1, 3)
  const destination = new Float32Array(3)

  copyCompleteFloat32PcmToChannels(pcm, [destination])

  assert.deepEqual(Array.from(destination), [0.25, -0.5, 0.75])
})

test('complete PCM validation rejects partial frames and stale frame metadata', () => {
  const partialFrame = makePcm([1, 2, 3], 2, 2)
  assert.throws(
    () => validateCompleteFloat32Pcm(partialFrame),
    /size mismatch: expected 16 bytes.*received 12/,
  )

  const staleFrameCount = makePcm([1, 2, 3, 4], 2, 1)
  assert.throws(
    () => validateCompleteFloat32Pcm(staleFrameCount),
    /size mismatch: expected 8 bytes.*received 16/,
  )
})

test('complete PCM copy ignores spare backing-buffer capacity', () => {
  const backing = new Float32Array([1, 10, 2, 20, 999, 999])
  const pcm: CompleteFloat32Pcm = {
    sampleRate: 48_000,
    channels: 2,
    frames: 2,
    pcmByteLength: 4 * Float32Array.BYTES_PER_ELEMENT,
    interleavedPcm: backing.buffer,
  }
  const destinations = [new Float32Array(2), new Float32Array(2)]

  copyCompleteFloat32PcmToChannels(pcm, destinations)

  assert.deepEqual(destinations.map((channel) => Array.from(channel)), [[1, 2], [10, 20]])
})

test('complete PCM validation rejects a valid prefix longer than its backing buffer', () => {
  const pcm = makePcm([1, 2, 3, 4], 2, 2)
  assert.throws(
    () => validateCompleteFloat32Pcm({
      ...pcm,
      frames: 3,
      pcmByteLength: 6 * Float32Array.BYTES_PER_ELEMENT,
    }),
    /valid length 24 exceeds its 16-byte buffer/,
  )
})

test('complete PCM validation rejects unsafe dimensions and destination mismatches', () => {
  const pcm = makePcm([1, 2, 3, 4], 2, 2)
  assert.throws(
    () => validateCompleteFloat32Pcm({ ...pcm, channels: 0 }),
    /channel count/,
  )
  assert.throws(
    () => validateCompleteFloat32Pcm({ ...pcm, frames: Number.MAX_SAFE_INTEGER }),
    /dimensions exceed/,
  )
  assert.throws(
    () => copyCompleteFloat32PcmToChannels(pcm, [new Float32Array(2)]),
    /destination has 1 channels/,
  )
  assert.throws(
    () => copyCompleteFloat32PcmToChannels(pcm, [new Float32Array(1), new Float32Array(2)]),
    /destination has 1 frames/,
  )
})
