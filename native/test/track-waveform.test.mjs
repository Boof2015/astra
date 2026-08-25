import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { extractWaveformPeaks } from '../../src/renderer/audio/waveformExtractor.ts'

const require = createRequire(import.meta.url)
const nativeWaveform = require('../build/Release/track_waveform.node')
const TOLERANCE = 1e-6

function makeAudioBuffer(channels) {
  return {
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    getChannelData: (channelIndex) => channels[channelIndex],
  }
}

function interleave(channels) {
  const frameCount = channels[0]?.length ?? 0
  const output = new Float32Array(frameCount * channels.length)
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      output[(frameIndex * channels.length) + channelIndex] = channels[channelIndex][frameIndex]
    }
  }
  return output
}

function assertParity(channels, resolution = 512) {
  const expected = extractWaveformPeaks(makeAudioBuffer(channels), resolution)
  const actual = nativeWaveform.analyzeInterleaved(
    interleave(channels),
    channels.length,
    resolution,
  )
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(Number.isFinite(actual[index]))
    assert.ok(actual[index] >= 0 && actual[index] <= 1)
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= TOLERANCE,
      `bin ${index}: native=${actual[index]} renderer=${expected[index]}`,
    )
  }
}

test('native waveform matches renderer RMS semantics across channel layouts and signals', () => {
  const frames = 4099
  const mono = Float32Array.from({ length: frames }, (_, index) => (
    Math.sin(index * 0.031) * (index < frames / 2 ? 0.25 : 0.8)
  ))
  const right = Float32Array.from({ length: frames }, (_, index) => Math.cos(index * 0.017) * 0.45)
  const surround = Array.from({ length: 6 }, (_, channelIndex) => (
    Float32Array.from({ length: frames }, (_, index) => (
      Math.sin((index + channelIndex * 11) * (0.009 + channelIndex * 0.003))
      * (0.15 + channelIndex * 0.1)
    ))
  ))

  assertParity([mono])
  assertParity([mono, right])
  assertParity(surround)
  assertParity([new Float32Array(frames)])
  assertParity([new Float32Array(frames).fill(-0.375)])
})

test('native waveform preserves short, non-divisible, and long-track stride behavior', () => {
  assertParity([Float32Array.of(1, -1, 0.5)], 8)
  assertParity([Float32Array.of(1, 1, 0.5, 0.5, 9)], 2)

  const frames = 8 * 8192
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    left[index] = index % 2 === 0 ? ((index / 8192) + 1) / 8 : 100
    right[index] = index % 2 === 0 ? 0.125 : -100
  }
  assertParity([left, right], 8)
})

test('native binding rejects malformed PCM dimensions and options', () => {
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Uint8Array(8), 2), /Float32Array/)
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Float32Array(3), 2), /complete interleaved frames/)
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Float32Array(4), 0), /1 to 32/)
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Float32Array(4), 33), /1 to 32/)
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Float32Array(4), 1, 0), /1 to 16384/)
  assert.throws(() => nativeWaveform.analyzeInterleaved(new Float32Array(4), 1, 16385), /1 to 16384/)
})

test('native binding analyzes only the supplied zero-copy Float32 view', () => {
  const backing = new Float32Array(1028)
  backing.fill(100)
  const validView = new Float32Array(backing.buffer, 2 * Float32Array.BYTES_PER_ELEMENT, 1024)
  validView.fill(1, 0, 512)
  validView.fill(0.5, 512)

  const waveform = nativeWaveform.analyzeInterleaved(validView, 1, 512)
  assert.deepEqual(Array.from(waveform.slice(0, 256)), Array(256).fill(1))
  for (const value of waveform.slice(256)) assert.ok(Math.abs(value - 0.5) <= TOLERANCE)
  assert.equal(backing[0], 100)
  assert.equal(backing.at(-1), 100)
})

test('native async binding retains and analyzes the supplied view off the calling stack', async () => {
  const backing = new Float32Array(1028)
  backing.fill(100)
  const validView = new Float32Array(backing.buffer, 2 * Float32Array.BYTES_PER_ELEMENT, 1024)
  validView.fill(1, 0, 512)
  validView.fill(0.5, 512)

  let settled = false
  const pending = nativeWaveform.analyzeInterleavedAsync(validView, 1, 512)
    .then((waveform) => {
      settled = true
      return waveform
    })
  assert.equal(settled, false)

  const waveform = await pending
  assert.deepEqual(Array.from(waveform.slice(0, 256)), Array(256).fill(1))
  for (const value of waveform.slice(256)) assert.ok(Math.abs(value - 0.5) <= TOLERANCE)
  assert.equal(backing[0], 100)
  assert.equal(backing.at(-1), 100)
})
