import { strict as assert } from 'node:assert'
import test from 'node:test'
import { resolvePipelineResampler } from './audioPipelineModel.ts'

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
