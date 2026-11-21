import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeRemoteNormalization } from './nativeRemoteNormalization.ts'
import { AdaptiveNormalization } from '../shared/audio/adaptiveNormalization.ts'
import type { NativeProgressiveInput } from '../types/nativeProgressive.ts'
import type { NativeAudioSampleFormat, NativeAudioTrackGain } from '../types/nativeAudio.ts'

function fixture(rate = 48000) {
  const gains: { gain: NativeAudioTrackGain; ramp: number }[] = []
  let cancelled = false
  const input = { status: () => ({ sampleRate: rate, state: cancelled ? 'cancelled' : 'open' }),
    setGain: (gain: NativeAudioTrackGain, ramp = 0) => gains.push({ gain, ramp }) } as unknown as NativeProgressiveInput
  return { input, gains, cancel: () => { cancelled = true } }
}

function pcm(format: NativeAudioSampleFormat, rate: number, amplitude = 0.9) {
  const bytes = format === 's16' ? 2 : format === 's24' ? 3 : 4
  const data = Buffer.alloc(rate * bytes * 2)
  const planar = [new Float32Array(rate), new Float32Array(rate)]
  for (let i = 0; i < rate; i++) {
    const value = amplitude * Math.sin(2 * Math.PI * 1000 * i / rate)
    for (let ch = 0; ch < 2; ch++) {
      const at = (i * 2 + ch) * bytes
      if (format === 'f32') { data.writeFloatLE(value, at); planar[ch][i] = data.readFloatLE(at) }
      else {
        data.writeIntLE(Math.round(value * 2 ** (bytes * 8 - 1)), at, bytes)
        planar[ch][i] = data.readIntLE(at, bytes) / 2 ** (bytes * 8 - 1)
      }
    }
  }
  return { data, planar }
}

for (const format of ['s16', 's24', 's32', 'f32'] as const) {
  for (const rate of [44100, 48000, 96000]) {
    test(`native ${format}/${rate} normalization matches Standard's estimator without changing PCM`, () => {
      const f = fixture(rate), audio = pcm(format, rate)
      const before = Buffer.from(audio.data)
      const native = new NativeRemoteNormalization(f.input, 2, format, { mode: 'normalization', gainDb: 0 }, -14, null)
      native.observe(audio.data, 0)
      const standard = new AdaptiveNormalization(rate)
      standard.ingest(audio.planar, 0)
      assert.equal(native.state.gain.gainDb, standard.gain(-14).gainDb)
      assert.ok(native.state.gain.gainDb < -12)
      assert.equal(f.gains.at(-1)!.ramp, 0, 'set gain before playback')
      assert.deepEqual(audio.data, before)
      const measured = native.evidence.estimator.measuredSeconds
      const otherRate = rate === 44100 ? 48000 : 44100
      const next = new NativeRemoteNormalization(fixture(otherRate).input, 2, 's32', native.state.gain, -14, null, native.evidence)
      next.observe(pcm('s32', otherRate).data, 0)
      assert.equal(next.evidence.estimator.measuredSeconds, measured, 'quality resampling cannot double-count coverage')
    })
  }
}

test('gain ramps, late completion and settings preserve the successful Standard policy', () => {
  const f = fixture()
  const native = new NativeRemoteNormalization(f.input, 2, 's16', { mode: 'normalization', gainDb: 0 }, -14, null)
  native.observe(pcm('s16', 48000, 0.001).data, 0)
  assert.equal(native.state.gain.gainDb, -6)
  native.beginAttach(); native.endAttach()
  native.observe(pcm('s16', 48000).data, 48000)
  assert.ok(native.state.gain.gainDb < -12)
  assert.equal(f.gains.at(-1)!.ramp, 0.25)
  native.settle({ loudnessLufs: -16, peakLinear: 0.3 })
  assert.deepEqual(native.state, { gain: { mode: 'normalization', gainDb: 2 }, approximate: false })
  assert.equal(f.gains.at(-1)!.ramp, 3)
  const updates = f.gains.length
  native.setSettings({ mode: 'normalization', gainDb: 0, normalizationTargetLufs: -14 })
  assert.equal(f.gains.length, updates, 'settings refresh must not shorten an ongoing fade')
  native.settle({ loudnessLufs: -5, peakLinear: 1 })
  assert.equal(native.state.gain.gainDb, 2, 'complete result is fixed')
  native.setSettings({ mode: 'off', gainDb: 0 })
  assert.equal(native.state.gain.gainDb, 0)
  native.setSettings({ mode: 'normalization', gainDb: 0, normalizationTargetLufs: -18 })
  assert.equal(native.state.gain.gainDb, -2)
  native.setSettings({ mode: 'replaygain', gainDb: -8 })
  assert.equal(native.state.gain.gainDb, -8)
})

test('a pending native seek applies new evidence only after attachment; obsolete handles do nothing', () => {
  const f = fixture()
  const native = new NativeRemoteNormalization(f.input, 2, 's32', { mode: 'normalization', gainDb: 0 }, -14, null)
  native.beginAttach()
  const count = f.gains.length
  native.settle({ loudnessLufs: -16, peakLinear: 0.3 })
  assert.equal(f.gains.length, count)
  native.endAttach()
  assert.equal(f.gains.at(-1)!.gain.gainDb, 2)
  assert.equal(f.gains.at(-1)!.ramp, 3)
  f.cancel()
  native.setSettings({ mode: 'off', gainDb: 0 })
  assert.equal(f.gains.length, count + 1)
})

test('normalization off and ReplayGain do no adaptive PCM analysis', () => {
  const native = new NativeRemoteNormalization(fixture().input, 2, 's32', { mode: 'off', gainDb: 0 }, undefined, null)
  const audio = pcm('s32', 48000).data
  native.observe(audio, 0)
  assert.equal(native.evidence.estimator.measuredSeconds, 0)
  native.setSettings({ mode: 'replaygain', gainDb: -4, normalizationTargetLufs: -14 })
  native.observe(audio, 48000)
  assert.equal(native.evidence.estimator.measuredSeconds, 0)
  native.setSettings({ mode: 'normalization', gainDb: 0, normalizationTargetLufs: -14 })
  native.observe(audio, 96000)
  assert.ok(native.state.gain.gainDb < -12)
})

test('a completed scan discovered during replacement ramps only after the old gain is attached', () => {
  const original = new NativeRemoteNormalization(fixture().input, 2, 's32', { mode: 'normalization', gainDb: 0 }, -14, null)
  original.observe(pcm('s32', 48000).data, 0)
  const previousGain = original.state.gain.gainDb
  const replacementInput = fixture()
  const replacement = new NativeRemoteNormalization(replacementInput.input, 2, 's32', original.state.gain,
    -14, { loudnessLufs: -16, peakLinear: 0.3 }, original.evidence)
  assert.equal(replacement.state.gain.gainDb, previousGain)
  assert.equal(replacementInput.gains.at(-1)!.ramp, 0)
  replacement.beginAttach()
  replacement.endAttach()
  assert.equal(replacement.state.gain.gainDb, 2)
  assert.equal(replacementInput.gains.at(-1)!.ramp, 3)
})
