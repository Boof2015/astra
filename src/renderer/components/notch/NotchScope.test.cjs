const assert = require('node:assert/strict')
const test = require('node:test')
const { buildSync } = require('esbuild')
const { runInNewContext } = require('node:vm')
const { join } = require('node:path')

const source = buildSync({ entryPoints: [join(__dirname, 'NotchScope.tsx')], bundle: true,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], write: false,
}).outputFiles[0].text

function setup(props = {}) {
  const config = {}, points = [], frames = new Map(), cleanups = []
  let receiver, nextFrame = 0, unsubscribed = false
  const samples = new Float32Array(2048)
  samples[13] = 0.5 // A transient between points the old renderer selected.
  const scope = {
    setSampleRate: value => { config.rate = value }, setDisplaySamples: value => { config.display = value },
    setPitchLock() {}, reset() {}, pushSamples() {},
    processContinuous: () => ({ triggerIndex: 123.625, writePos: 9000, samplesToShow: samples.length }),
    getSamples: (start, count) => { config.start = start; config.count = count; return samples },
  }
  const spectrum = { reset() {}, setSampleRate() {}, setFFTSize: size => { config.fft = size }, setSmoothing() {},
    process: () => new Float32Array(2048).fill(-30) }
  const ctx = { scale() {}, clearRect() { points.length = 0 }, beginPath() {}, stroke() {}, fill() {}, closePath() {},
    createLinearGradient: () => ({ addColorStop() {} }), moveTo: (x, y) => points.push([x, y]), lineTo: (x, y) => points.push([x, y]) }
  const canvas = { getContext: () => ctx }
  const module = { exports: {} }
  runInNewContext(source, { module, exports: module.exports, console, Float32Array,
    require: id => id === 'react' ? { useEffect: fn => { cleanups.push(fn()) }, useRef: () => ({ current: canvas }) }
      : { jsx() {} },
    window: { devicePixelRatio: 2, visualizerAPI: { oscilloscope: scope, spectrum }, electronAPI: { notch: {
      onVisualizerChunk: fn => { receiver = fn; return () => { unsubscribed = true } },
    } } }, performance: { now: () => 0 },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame }, cancelAnimationFrame: id => frames.delete(id),
  })
  module.exports.default({ mode: 'oscilloscope', active: true, frozen: false, color: '#38bdf8', width: 161, height: 20, ...props })
  return { config, points, frames, canvas,
    receive: () => receiver?.({ sampleRate: 48000, fftSize: 4096, pitchLock: true, leftChunks: [new Float32Array(4096)], monoChunks: [new Float32Array(4096)], reset: false }),
    flush: () => { const current = [...frames.values()]; frames.clear(); current.forEach(fn => fn(16.7)) },
    subscribed: () => Boolean(receiver), cleanup: () => cleanups.forEach(fn => fn?.()), unsubscribed: () => unsubscribed,
  }
}

test('notch renders all scope samples with the shared window and fractional trigger', () => {
  const qa = setup()
  qa.receive(); qa.flush()
  assert.equal(qa.config.display, 2048)
  assert.equal(qa.config.start, 123.625)
  assert.equal(qa.points.length, 2048)
  assert.ok(Math.abs(qa.points[13][1] - 1) < 1e-6)
  assert.equal(qa.points.at(-1)[0], 161)
  qa.cleanup()
})

test('hidden/frozen and paused visualizers do not subscribe or animate', () => {
  for (const props of [{ frozen: true }, { active: false }]) {
    const qa = setup(props)
    assert.equal(qa.subscribed(), false)
    assert.equal(qa.frames.size, 0)
    qa.cleanup()
  }
})

test('spectrum keeps animating between chunks and cancels on dismissal', () => {
  const qa = setup({ mode: 'spectrum' })
  qa.receive(); qa.flush()
  assert.equal(qa.config.fft, 4096)
  assert.ok(qa.points.length > 322)
  assert.equal(qa.frames.size, 1)
  qa.cleanup()
  assert.equal(qa.frames.size, 0)
  assert.equal(qa.unsubscribed(), true)
})
