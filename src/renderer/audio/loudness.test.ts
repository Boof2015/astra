import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  ProgressiveKWeightedLoudnessAnalyzer,
  analyzeKWeightedChannelData,
  calculateUnweightedRmsDb,
  dbToLinear,
  resolveStaticNormalizationGain
} from './loudness.ts'

const SAMPLE_RATE = 44100
const TARGET_LUFS = -14
const MIN_GAIN_DB = -18
const MAX_GAIN_DB = 6
const PEAK_CEILING = 0.98

function createStereoSine(frequencyHz: number, amplitude: number, seconds = 2): Float32Array[] {
  const frameCount = Math.round(SAMPLE_RATE * seconds)
  const left = new Float32Array(frameCount)
  const right = new Float32Array(frameCount)

  for (let index = 0; index < frameCount; index++) {
    const sample = amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE)
    left[index] = sample
    right[index] = sample
  }

  return [left, right]
}

function createLayeredStereoSignal(seconds = 2): Float32Array[] {
  const frameCount = Math.round(SAMPLE_RATE * seconds)
  const left = new Float32Array(frameCount)
  const right = new Float32Array(frameCount)

  for (let index = 0; index < frameCount; index++) {
    const time = index / SAMPLE_RATE
    const bass = 0.32 * Math.sin(2 * Math.PI * 55 * time)
    const vocal = 0.12 * Math.sin(2 * Math.PI * 1000 * time)
    const transient = index % 997 === 0 ? 0.08 : 0
    left[index] = bass + vocal + transient
    right[index] = bass - vocal + transient
  }

  return [left, right]
}

function resolveGain(loudnessLufs: number, peakLinear: number): number {
  return resolveStaticNormalizationGain({
    targetLufs: TARGET_LUFS,
    loudnessLufs,
    peakLinear,
    minGainDb: MIN_GAIN_DB,
    maxGainDb: MAX_GAIN_DB,
    peakCeilingLinear: PEAK_CEILING
  }).gainDb
}

test('K-weighted normalization attenuates sub-bass less aggressively than plain RMS', () => {
  const channels = createStereoSine(30, 0.7)
  const oldRmsDb = calculateUnweightedRmsDb(channels)
  const analysis = analyzeKWeightedChannelData(channels, SAMPLE_RATE)

  const oldGainDb = TARGET_LUFS - oldRmsDb
  const kWeightedGainDb = resolveGain(analysis.loudnessLufs, analysis.peakLinear)

  assert.ok(
    kWeightedGainDb - oldGainDb > 3,
    `expected K-weighted gain ${kWeightedGainDb} dB to preserve more level than old RMS gain ${oldGainDb} dB`
  )
})

test('midrange material normalizes to the target loudness when peak ceiling is not active', () => {
  const channels = createStereoSine(1000, 0.12)
  const analysis = analyzeKWeightedChannelData(channels, SAMPLE_RATE)
  const gainDb = resolveGain(analysis.loudnessLufs, analysis.peakLinear)

  assert.ok(Math.abs((analysis.loudnessLufs + gainDb) - TARGET_LUFS) < 0.05)
})

test('static gain preserves sample ratios instead of compressing dynamics', () => {
  const channels = createLayeredStereoSignal()
  const analysis = analyzeKWeightedChannelData(channels, SAMPLE_RATE)
  const linearGain = dbToLinear(resolveGain(analysis.loudnessLufs, analysis.peakLinear))
  const quiet = 0.05
  const loud = 0.5

  assert.equal((loud * linearGain) / (quiet * linearGain), loud / quiet)
})

test('peak ceiling caps positive gain before it can exceed full scale', () => {
  const result = resolveStaticNormalizationGain({
    targetLufs: TARGET_LUFS,
    loudnessLufs: -30,
    peakLinear: 1,
    minGainDb: MIN_GAIN_DB,
    maxGainDb: MAX_GAIN_DB,
    peakCeilingLinear: PEAK_CEILING
  })

  assert.equal(result.peakLimited, true)
  assert.ok(result.linearGain <= PEAK_CEILING)
  assert.ok(result.gainDb <= 0)
})

test('progressive K-weighted analysis converges to full-buffer analysis', () => {
  const channels = createLayeredStereoSignal()
  const full = analyzeKWeightedChannelData(channels, SAMPLE_RATE)
  const progressive = new ProgressiveKWeightedLoudnessAnalyzer(SAMPLE_RATE)
  const chunkSize = 2048

  for (let start = 0; start < channels[0].length; start += chunkSize) {
    progressive.ingest(channels.map((channel) => channel.subarray(start, start + chunkSize)))
  }

  const progressiveAnalysis = progressive.getAnalysis()
  assert.ok(progressiveAnalysis)
  assert.ok(Math.abs(progressiveAnalysis.loudnessLufs - full.loudnessLufs) < 1e-6)
  assert.equal(progressiveAnalysis.peakLinear, full.peakLinear)
})
