import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  ANALYZER_SILENCE_FRAME_RATE,
  AnalyzerSilenceClock,
  DEFAULT_ANALYZER_SILENCE_SAMPLE_RATE,
  MAX_ANALYZER_SILENCE_SAMPLES,
  MIN_ANALYZER_SILENCE_SAMPLES,
  createMonoSilenceChunk,
  createMonoSilenceChunkWithSampleCount,
  createMultichannelSilenceChunk,
  createStereoSilenceChunk,
  isPlaybackAnalyzerActive,
  resolveAnalyzerSilenceSampleCount,
} from './visualizerSilence.ts'

test('resolveAnalyzerSilenceSampleCount derives stable frame-sized chunks', () => {
  assert.equal(resolveAnalyzerSilenceSampleCount(48000), Math.round(48000 / ANALYZER_SILENCE_FRAME_RATE))
  assert.equal(
    resolveAnalyzerSilenceSampleCount(Number.NaN),
    Math.round(DEFAULT_ANALYZER_SILENCE_SAMPLE_RATE / ANALYZER_SILENCE_FRAME_RATE)
  )
  assert.equal(resolveAnalyzerSilenceSampleCount(48000, 4096), 4096)
  assert.equal(resolveAnalyzerSilenceSampleCount(192000, 100000), MAX_ANALYZER_SILENCE_SAMPLES)
  assert.equal(resolveAnalyzerSilenceSampleCount(1000), MIN_ANALYZER_SILENCE_SAMPLES)
  assert.equal(createMonoSilenceChunkWithSampleCount(400).length, 400)
})

test('silence chunk helpers create zero-filled mono, stereo, and multichannel buffers', () => {
  const mono = createMonoSilenceChunk(48000, 256)
  assert.equal(mono.length, Math.round(48000 / ANALYZER_SILENCE_FRAME_RATE))
  assert.equal(mono.every((sample) => sample === 0), true)

  const stereo = createStereoSilenceChunk(48000, 1024)
  assert.equal(stereo.left.length, 1024)
  assert.equal(stereo.right.length, 1024)
  assert.notEqual(stereo.left, stereo.right)

  const multichannel = createMultichannelSilenceChunk(48000, 6, 512)
  assert.equal(multichannel.channels.length, 6)
  assert.equal(multichannel.channels.every((channel) => channel.length === Math.round(48000 / ANALYZER_SILENCE_FRAME_RATE)), true)
})

test('paused playback remains analyzer-active', () => {
  assert.equal(isPlaybackAnalyzerActive('playing'), true)
  assert.equal(isPlaybackAnalyzerActive('paused'), true)
  assert.equal(isPlaybackAnalyzerActive('loading'), false)
  assert.equal(isPlaybackAnalyzerActive('stopped'), false)
})

test('AnalyzerSilenceClock scales silence by elapsed time', () => {
  const clock = new AnalyzerSilenceClock()

  assert.equal(clock.nextSampleCount(48000, 1000), Math.round(48000 / ANALYZER_SILENCE_FRAME_RATE))
  assert.equal(clock.nextSampleCount(48000, 1008.333), 400)
  assert.equal(clock.nextSampleCount(48000, 1025), 800)

  clock.reset()
  assert.equal(clock.nextSampleCount(96000, 2000), Math.round(96000 / ANALYZER_SILENCE_FRAME_RATE))
})
