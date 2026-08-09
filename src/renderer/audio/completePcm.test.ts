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

test('complete PCM detailed copy timings preserve samples and report channel phases', () => {
  const pcm = makePcm([
    1, 10,
    2, 20,
    3, 30,
  ], 2, 3)
  const destinations = [new Float32Array(3), new Float32Array(3)]
  const clockValues = [
    100, // setup start
    103, // setup end
    104, // all-channel copy start
    105, // channel 0 start
    109, // channel 0 end
    110, // channel 1 start
    117, // channel 1 end
    119, // all-channel copy end
  ]

  const timings = copyCompleteFloat32PcmToChannels(pcm, destinations, {
    now: () => clockValues.shift() ?? Number.NaN,
  })

  assert.deepEqual(destinations.map((channel) => Array.from(channel)), [
    [1, 2, 3],
    [10, 20, 30],
  ])
  assert.deepEqual(timings, {
    pcmCopySetupMs: 3,
    pcmChannelCopyTotalMs: 15,
    pcmChannelCopyMaxMs: 7,
    pcmChannelCopyByChannelMs: [4, 7],
  })
  assert.equal(clockValues.length, 0)
})

test('complete PCM detailed copy timings retain the mono bulk-copy path', () => {
  const pcm = makePcm([0.25, -0.5, 0.75], 1, 3)
  const destination = new Float32Array(3)
  const clockValues = [10, 11, 12, 13, 15, 16]

  const timings = copyCompleteFloat32PcmToChannels(pcm, [destination], {
    now: () => clockValues.shift() ?? Number.NaN,
  })

  assert.deepEqual(Array.from(destination), [0.25, -0.5, 0.75])
  assert.deepEqual(timings, {
    pcmCopySetupMs: 1,
    pcmChannelCopyTotalMs: 4,
    pcmChannelCopyMaxMs: 2,
    pcmChannelCopyByChannelMs: [2],
  })
  assert.equal(clockValues.length, 0)
})

test('complete PCM detailed copy timings clamp invalid or backwards clock deltas', () => {
  const pcm = makePcm([1, 10], 2, 1)
  const clockValues = [10, 9, 8, Number.NaN, 7, 12, 11, 10]

  const timings = copyCompleteFloat32PcmToChannels(
    pcm,
    [new Float32Array(1), new Float32Array(1)],
    { now: () => clockValues.shift() ?? Number.NaN },
  )

  assert.deepEqual(timings, {
    pcmCopySetupMs: 0,
    pcmChannelCopyTotalMs: 2,
    pcmChannelCopyMaxMs: 0,
    pcmChannelCopyByChannelMs: [0, 0],
  })
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
