import { strict as assert } from 'node:assert'
import test from 'node:test'
import { describeRemotePlaybackQuality, resolvePipelineResampler } from './audioPipelineModel.ts'

test('pipeline separates the requested target from measured or unknown delivery', () => {
  assert.equal(describeRemotePlaybackQuality({ requested: 128, requestedCodec: 'mp3', delivered: null }), '128 kbps target · format unverified')
  assert.equal(describeRemotePlaybackQuality({ requested: 128, requestedCodec: 'mp3', delivered: {
    codec: 'flac', sampleRate: 96000, bitDepth: 24, channels: 2, bitrateKbps: null
  } }), 'FLAC · 24-bit · 96 kHz (128 kbps target)')
  assert.equal(describeRemotePlaybackQuality({ requested: 'original', requestedCodec: null, delivered: null }), 'Original requested')
})

test('Exclusive DSP pipeline follows native negotiated rates', () => {
  assert.deepEqual(resolvePipelineResampler({
    playbackOutputMode: 'exclusive',
    trackSampleRate: 96_000,
    standardOutputSampleRate: 96_000,
    nativeSourceSampleRate: 44_100,
    nativeTargetSampleRate: 48_000,
    nativeResamplingActive: true,
  }), {
    sourceSampleRate: 44_100,
    targetSampleRate: 48_000,
  })
})

test('Exclusive DSP pipeline honors activation before both rates arrive', () => {
  assert.deepEqual(resolvePipelineResampler({
    playbackOutputMode: 'exclusive',
    trackSampleRate: 44_100,
    standardOutputSampleRate: 48_000,
    nativeSourceSampleRate: 44_100,
    nativeTargetSampleRate: null,
    nativeResamplingActive: true,
  }), {
    sourceSampleRate: 44_100,
    targetSampleRate: null,
  })
})

test('Bit-Perfect never displays a resampler', () => {
  assert.equal(resolvePipelineResampler({
    playbackOutputMode: 'bitperfect',
    trackSampleRate: 44_100,
    standardOutputSampleRate: 48_000,
    nativeSourceSampleRate: 44_100,
    nativeTargetSampleRate: 48_000,
    nativeResamplingActive: true,
  }), null)
})
