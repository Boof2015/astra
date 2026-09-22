import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine } from './AudioEngine.ts'
import type { NativeAudioVisualizerTapDemand } from '../../types/nativeAudio.ts'

type Internals = {
  playbackOutputMode: 'standard' | 'exclusive' | 'bitperfect'
  _playbackState: 'playing'
  visualizerConsumerDemand: Map<string, Record<string, boolean>>
  pollNativeScopeData: () => void
  queueVisualizerSamples: (channels: Float32Array[]) => void
  normalizeBitPerfectVisualizerSamples: (channels: Float32Array[]) => Float32Array[] | null
  getNativeVisualizerTapDemand: () => NativeAudioVisualizerTapDemand
}

test('native scopes share one drain and one normalization pass, with balanced mono and unsliced oscilloscope PCM', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const left = new Float32Array(800).fill(0.8)
  const right = new Float32Array(800).fill(-0.4)
  let flushes = 0
  let frames = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    nativeAudioAPI: { flushVisualizerChunks: () => { flushes++; return [{ channels: [left, right] }] } },
    requestAnimationFrame: () => { frames++; return 1 },
  } })
  try {
    const engine = new AudioEngine()
    const internals = engine as unknown as Internals
    internals.playbackOutputMode = 'exclusive'
    internals._playbackState = 'playing'
    internals.visualizerConsumerDemand.set('all', {
      oscilloscope: true, spectrum: true, spectrumStereo: true, spectrogram: true,
      vectorscope: true, lufsmeter: true, vumeter: true, waveform: true, waveformStereo: true,
    })
    let normalizations = 0
    internals.normalizeBitPerfectVisualizerSamples = () => { normalizations++; return null }
    internals.pollNativeScopeData()
    assert.equal(flushes, 1)
    assert.equal(frames, 1, 'continue at display refresh cadence')
    assert.equal(normalizations, 1)
    assert.deepEqual(engine.flushPendingOscilloscopeSamples(), [left])
    const mono = engine.flushPendingSpectrumSamples()[0]
    assert.ok(Math.abs(mono[0] - 0.2) < 1e-6, 'mono must be (L + R) / 2')
    assert.equal(engine.flushPendingSpectrogramSamples()[0], mono)
    assert.equal(engine.flushPendingVectorscopeSamples()[0].right, right)
    assert.equal(engine.flushPendingSpectrumStereoSamples()[0].left, left)
    assert.equal(engine.flushPendingVUMeterSamples()[0].channels[1], right)
    assert.equal(engine.flushPendingWaveformSamples()[0], left)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('spectrum-only and Side-only demand retain stereo capture, mono sources stay unity gain', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as Internals
  internals.normalizeBitPerfectVisualizerSamples = () => null
  for (const scope of ['spectrum', 'spectrumStereo']) {
    internals.visualizerConsumerDemand.clear()
    internals.visualizerConsumerDemand.set('single', { [scope]: true })
    assert.equal(internals.getNativeVisualizerTapDemand().spectrum, true)
  }
  internals.visualizerConsumerDemand.set('single', { spectrum: true })
  internals.queueVisualizerSamples([Float32Array.of(0.4, -0.6)])
  assert.deepEqual(Array.from(engine.flushPendingSpectrumSamples()[0]), Array.from(Float32Array.of(0.4, -0.6)))
})

test('mini scopes share the feed and mono waveform demand captures only the left channel', () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as Internals
  internals.normalizeBitPerfectVisualizerSamples = () => null
  internals.visualizerConsumerDemand.set('mini', { miniSpectrum: true, miniOscilloscope: true, spectrum: true })
  const left = Float32Array.of(0.2, 0.4)
  const right = Float32Array.of(0.6, 0.8)
  internals.queueVisualizerSamples([left, right])
  const mini = engine.flushPendingMiniVisualizerChunks()[0]
  assert.equal(mini.left, left)
  assert.equal(mini.mono, engine.flushPendingSpectrumSamples()[0])
  assert.deepEqual(Array.from(mini.mono), Array.from(Float32Array.of(0.4, 0.6)))
  internals.visualizerConsumerDemand.clear()
  internals.visualizerConsumerDemand.set('waveform', { waveform: true })
  assert.deepEqual(internals.getNativeVisualizerTapDemand(), { oscilloscope: true, spectrum: false, vectorscope: false, vumeter: false })
})
