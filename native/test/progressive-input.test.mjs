import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { playback } = require('../build/Release/visualizer_dsp.node')
const defaults = { sampleRate: 48000, channels: 2, sampleFormat: 's16', capacityFrames: 8, duration: 1 }
const input = (options = {}) => playback.createProgressiveInput({ ...defaults, ...options })

test('progressive input validates sizes/formats without touching an output device', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, 0.5, 2 ** 54]) {
    assert.throws(() => input({ capacityFrames: bad }), /capacity/)
    assert.throws(() => input({ sampleRate: bad }), /sample rate/)
  }
  for (const options of [{ channels: 9 }, { sampleFormat: 'f64' }, { duration: NaN },
    { startFrame: Number.MAX_SAFE_INTEGER }, { gain: { mode: 'off', gainDb: NaN } },
    { capacityFrames: 32 * 1024 * 1024 }]) assert.throws(() => input(options))
  assert.throws(() => playback.createProgressiveInput(null))
})

test('append reports complete accepted frames, respects view offsets and stays bounded', () => {
  for (const [sampleFormat, bytesPerSample] of [['s16', 2], ['s24', 3], ['s32', 4], ['f32', 4]]) {
    const handle = input({ sampleFormat, capacityFrames: 3, startFrame: 100 })
    const stride = bytesPerSample * 2
    const bytes = new Uint8Array(stride * 6 + 2)
    assert.equal(handle.append(bytes.subarray(1, 1 + stride * 2)), 2)
    assert.equal(handle.append(bytes.subarray(1, 1 + stride * 4)), 1)
    assert.equal(handle.append(bytes.subarray(1, 1 + stride)), 0)
    assert.equal(handle.status().publishedFrame, 103)
    assert.equal(handle.status().retainedFrame, 100)
    assert.equal(handle.status().bytesPerFrame, stride)
    assert.throws(() => handle.append(new Float32Array(8)), /Uint8Array/)
    assert.throws(() => handle.append(new Uint8Array(1)), /complete frames/)
    assert.equal(handle.finish(), true)
    assert.equal(handle.append(new Uint8Array(stride)), 0)
    handle.cancel()
    assert.equal(handle.status().state, 'cancelled')
    assert.equal(handle.finish(), false)
  }
})

test('handles attach once, expose identity, replace seeks, and cancel old/next inputs', async () => {
  const first = input()
  first.append(new Uint8Array(16))
  first.finish()
  const loaded = first.load()
  assert.equal(loaded.progressiveSessionId, first.status().sessionId)
  assert.equal(loaded.buffering, false)
  assert.equal(loaded.playbackState, 'stopped')
  assert.throws(() => first.load(), /attached once/)
  assert.throws(() => playback.seek(1), /replacement decoder input/)
  // A complete local successor is supported by the mixed-source gapless route.
  assert.doesNotThrow(() => playback.preloadNextTrack(new Uint8Array(16), 48000, 2, 's16', 1))
  assert.equal(playback.getPlaybackSnapshot().progressiveSessionId, first.status().sessionId)
  playback.clearNextTrack()
  assert.equal(first.status().state, 'ended')
  const next = input()
  next.append(new Uint8Array(16))
  next.finish()
  next.preloadNext()
  const replacement = input({ startFrame: 48000 * 5 })
  replacement.append(new Uint8Array(16))
  replacement.finish()
  const sought = await replacement.seek(first.status().sessionId)
  assert.equal(sought.progressiveSessionId, replacement.status().sessionId)
  assert.equal(sought.currentTime, 5)
  assert.equal(sought.playbackState, 'stopped')
  assert.equal(first.status().state, 'cancelled')
  assert.equal(next.status().state, 'ended')
  const stale = input()
  await assert.rejects(stale.seek(first.status().sessionId), /current track/)
  assert.equal(playback.getPlaybackSnapshot().progressiveSessionId, replacement.status().sessionId)
  playback.clearNextTrack()
  assert.equal(next.status().state, 'cancelled')
  playback.stop()
  assert.equal(replacement.status().state, 'cancelled')
  const local = playback.loadTrack(new Uint8Array(16), 48000, 2, 's16', 1)
  assert.equal(local.progressiveSessionId, undefined)
})

test('engine ownership survives collection of the producer handle', { skip: typeof global.gc !== 'function' }, async () => {
  let handle = input({ capacityFrames: 48000 })
  handle.append(new Uint8Array(16))
  handle.finish()
  const id = handle.load().progressiveSessionId
  const weak = new WeakRef(handle)
  handle = null
  for (let iteration = 0; iteration < 4; iteration++) {
    await new Promise(resolve => setImmediate(resolve))
    global.gc()
  }
  assert.equal(weak.deref(), undefined)
  assert.equal(playback.getPlaybackSnapshot().progressiveSessionId, id)
  playback.stop()
  playback.loadTrack(new Uint8Array(16), 48000, 2, 's16', 1)
})
