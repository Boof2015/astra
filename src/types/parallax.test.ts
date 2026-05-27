import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildParallaxClockSample,
  decodeParallaxAudioPacket,
  encodeParallaxAudioPacket,
  mapHostTimeToSinkTimeMs,
  selectBestParallaxClockSample,
  type ParallaxAudioChunk
} from './parallax.ts'

test('Parallax clock sample estimates RTT and host-minus-sink offset', () => {
  const sample = buildParallaxClockSample({
    sinkSentAtMs: 1000,
    hostReceivedAtMs: 1055,
    hostSentAtMs: 1060
  }, 1010)

  assert.equal(sample.rttMs, 10)
  assert.equal(sample.offsetMs, 52.5)
  assert.equal(mapHostTimeToSinkTimeMs(2052.5, sample.offsetMs), 2000)
})

test('Parallax best clock sample prefers lowest RTT and latest tie', () => {
  const samples = [
    { sinkSentAtMs: 0, sinkReceivedAtMs: 20, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 20, offsetMs: 91 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 8, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 8, offsetMs: 97 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 9, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 8, offsetMs: 96.5 }
  ]

  assert.equal(selectBestParallaxClockSample(samples), samples[2])
})

test('Parallax audio packet round-trips chunk metadata and PCM bytes', () => {
  const pcm = new Float32Array([0, 0.5, -0.25, 1])
  const chunk: ParallaxAudioChunk = {
    streamId: 'stream-1',
    sampleRate: 48000,
    channels: 2,
    startFrame: 128,
    frameCount: 2,
    pcmData: pcm.buffer
  }

  const packet = new Uint8Array(encodeParallaxAudioPacket(chunk))
  const decoded = decodeParallaxAudioPacket(packet)

  assert.ok(decoded)
  assert.equal(decoded.bytesRead, packet.byteLength)
  assert.equal(decoded.chunk.sampleRate, 48000)
  assert.equal(decoded.chunk.channels, 2)
  assert.equal(decoded.chunk.startFrame, 128)
  assert.equal(decoded.chunk.frameCount, 2)
  assert.deepEqual(Array.from(new Float32Array(decoded.chunk.pcmData)), Array.from(pcm))
})

test('Parallax audio packet waits for complete frame', () => {
  const pcm = new Float32Array([0, 1])
  const packet = new Uint8Array(encodeParallaxAudioPacket({
    streamId: 'stream-1',
    sampleRate: 44100,
    channels: 1,
    startFrame: 0,
    frameCount: 2,
    pcmData: pcm.buffer
  }))

  assert.equal(decodeParallaxAudioPacket(packet.slice(0, packet.byteLength - 1)), null)
})
