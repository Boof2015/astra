import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAudioController, normalizeNativeAudioOutputStatus, type NativeAudioAddonPlayback, type NativeAudioControllerOptions } from './nativeAudioController.ts'
import type { NativeProgressiveInput, NativeProgressiveInputOptions } from '../types/nativeProgressive.ts'
import type { NativeAudioEvent, NativeAudioPlaybackSnapshot } from '../types/nativeAudio.ts'
import type { NativePcmDecoderOptions } from './nativePcmDecoder.ts'

function harness(overrides: NativeAudioControllerOptions = {}) {
  const inputs: NativeProgressiveInput[] = []
  const leases: { path: string; released: boolean }[] = []
  const decoders: NativePcmDecoderOptions[] = []
  const events: NativeAudioEvent[] = []
  let current: NativeProgressiveInput | null = null
  let next: NativeProgressiveInput | null = null
  let state: NativeAudioPlaybackSnapshot['playbackState'] = 'stopped'
  let localLoads = 0
  let localDecodes = 0
  let buffering = false
  const snapshot = (): NativeAudioPlaybackSnapshot => ({
    progressiveSessionId: current?.status().sessionId, buffering, playbackState: state,
    currentTime: (current?.status().startFrame ?? 0) / 48000, duration: 60,
    sampleRate: 48000, channels: 2, sampleFormat: 's16', deviceId: 'test', deviceLabel: 'test',
    outputStatus: normalizeNativeAudioOutputStatus(null)
  })
  const caps = { activeBackend: 'coreaudio', bitPerfectAvailable: true, processedExclusiveAvailable: true, devices: [] }
  const playback = {
    getCapabilities: () => caps, getPlaybackSnapshot: snapshot, setVisualizerTapDemand() {}, flushVisualizerSamples: () => null,
    drainEvents: () => events.splice(0),
    createProgressiveInput: (options: NativeProgressiveInputOptions) => {
      let published = options.startFrame ?? 0
      let inputState: 'open' | 'ended' | 'cancelled' = 'open'
      const id = inputs.length + 1
      const input: NativeProgressiveInput = {
        append: bytes => { const frames = bytes.length / 4; published += frames; return frames },
        finish: () => { inputState = 'ended'; return true }, cancel: () => { inputState = 'cancelled' },
        status: () => ({ sessionId: id, startFrame: options.startFrame ?? 0, retainedFrame: options.startFrame ?? 0,
          publishedFrame: published, capacityFrames: options.capacityFrames, sampleRate: 48000, bytesPerFrame: 4, state: inputState }),
        load: () => { current?.cancel(); next?.cancel(); current = input; next = null; state = 'stopped'; return snapshot() },
        preloadNext: () => { assert.equal(next, null); next = input },
        seek: async expected => {
          assert.equal(current?.status().sessionId, expected)
          assert.notEqual(inputState, 'cancelled')
          current?.cancel(); current = input
          return snapshot()
        }
      }
      inputs.push(input)
      return input
    },
    clearNextTrack: () => { next?.cancel(); next = null },
    loadTrack: () => { localLoads++; current?.cancel(); current = null; return snapshot() },
    preloadNextTrack() {},
    setCurrentTrackGain: snapshot,
    promoteNextTrack: () => { current?.cancel(); current = next; next = null; state = 'stopped'; return snapshot() },
    play: async () => { state = 'playing'; return snapshot() },
    pause: () => { state = 'paused'; return snapshot() },
    stop: () => { current?.cancel(); next?.cancel(); next = null; state = 'stopped'; return snapshot() },
    seek: () => { assert.fail('Remote seek must replace its decoder') }
  } as unknown as NativeAudioAddonPlayback
  const controller = createNativeAudioController({ playback }, {
    eventPolling: false,
    resolveBinary: async binary => binary,
    runProbe: async () => JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', channels: 2, sample_fmt: 's16', duration: '60' }] }),
    runDecode: async () => { localDecodes++; return Buffer.alloc(4) },
    acquireRemoteSource: async path => {
      const lease = { path, released: false }
      leases.push(lease)
      return { url: 'http://cache/internal', duration: 60, release: () => { lease.released = true },
        finished: async () => {}, progress: async () => ({ loadedBytes: 100, totalBytes: 100, complete: true, error: null }) }
    },
    startRemoteDecoder: options => {
      decoders.push(options)
      options.input.append(Buffer.alloc(40000 * 4))
      return { ready: Promise.resolve(), done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
    },
    ...overrides
  })
  return { controller, playback, inputs, leases, decoders,
    local: () => ({ localLoads, localDecodes }),
    setBuffering: (value: boolean) => { buffering = value },
    transition: () => {
      assert.ok(next)
      current = next; next = null
      events.push({ type: 'gaplessTransition', playbackSequence: 0, progressiveSessionId: current.status().sessionId })
    }
  }
}

const a = 'subsonic://server/track/a'
const b = 'subsonic://server/track/b'

for (const currentProvider of ['subsonic', 'jellyfin']) {
  for (const nextProvider of ['subsonic', 'jellyfin']) {
    const a = `${currentProvider}://7/a`
    const b = `${nextProvider}://7/b`
    test(`${currentProvider} to ${nextProvider}: leases survive decode/seek and promotion follows audible identity`, async () => {
      const h = harness()
      await h.controller.loadTrack(a)
      await h.controller.play()
      const next = await h.controller.preloadNextTrack(b)
      await h.controller.pause()
      const seek = await h.controller.seek(17)
      assert.equal(seek.playbackState, 'paused')
      assert.equal(seek.currentTime, 17)
      assert.deepEqual(h.leases.map(x => x.released), [true, false, false])
      assert.equal(h.inputs[1].status().state, 'open', 'seeking must preserve prepared next')
      assert.ok(h.decoders[2].args.includes('17'))
      assert.equal(h.decoders[2].args.includes(a), false, 'FFmpeg receives only the internal cache URL')
      const observed: NativeAudioEvent[] = []
      h.controller.onEvent(event => observed.push(event))
      h.transition()
      const snapshot = await h.controller.getPlaybackSnapshot()
      assert.equal(snapshot.playbackSequence, next.playbackSequence)
      assert.equal(snapshot.progressiveSessionId, h.inputs[1].status().sessionId)
      assert.equal(observed.filter(x => x.type === 'gaplessTransition').length, 1)
      assert.deepEqual(h.leases.map(x => x.released), [true, false, true])
      const report = await h.controller.getNativeAudioDiagnosticReport()
      assert.equal(report.track?.path, b)
      assert.ok(!report.text.includes('http://cache'))
      await h.controller.stop()
      assert.ok(h.leases.every(x => x.released))
      assert.equal((await h.controller.getBufferMemoryStats()).totalBytes, 0)
      assert.deepEqual(h.local(), { localLoads: 0, localDecodes: 0 })
    })

  }
}

test('pending-decode cancellation leaves attached playback alone; stop cancels it and local loading stays complete', async () => {
  const h = harness()
  await h.controller.loadTrack(a)
  await h.controller.preloadNextTrack(b)
  await h.controller.cancelPendingDecode()
  assert.ok(h.inputs.every(x => x.status().state === 'open'))
  assert.ok(h.leases.every(x => !x.released))
  await h.controller.clearNextTrack()
  assert.equal(h.inputs[1].status().state, 'cancelled')
  assert.equal(h.leases[0].released, false)
  await h.controller.loadTrack('/local.flac')
  assert.ok(h.leases.every(x => x.released))
  assert.deepEqual(h.local(), { localLoads: 1, localDecodes: 1 })
})

test('a stale acquisition releases its lease without replacing a newer local load', async () => {
  let deliver!: () => void
  let released = false
  const h = harness({ acquireRemoteSource: async () => {
    await new Promise<void>(resolve => { deliver = resolve })
    return { url: 'internal', duration: 60, release: () => { released = true }, finished: async () => {},
      progress: async () => ({ loadedBytes: 0, totalBytes: null, complete: false, error: null }) }
  } })
  const stale = h.controller.loadTrack(a)
  await new Promise(resolve => setImmediate(resolve))
  await h.controller.loadTrack('/new.flac')
  deliver()
  await assert.rejects(stale, { name: 'SupersededNativeAudioLoadError' })
  assert.equal(released, true)
  assert.equal(h.inputs.length, 0)
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, '/new.flac')
})

test('decoder failure releases a failed cache entry but preserves PCM and never generates ended', async () => {
  const h = harness({ eventPolling: true })
  const events: NativeAudioEvent[] = []
  h.controller.onEvent(event => events.push(event))
  try {
    await h.controller.loadTrack(a)
    await h.controller.play()
    h.decoders[0].onFailure!(new Error('connection interrupted'))
    h.setBuffering(true)
    await new Promise(resolve => setTimeout(resolve, 350))
    const progress = events.find(x => x.type === 'remoteProgress')
    assert.ok(progress?.type === 'remoteProgress' && progress.progress.failed && progress.buffering)
    assert.equal(h.leases[0].released, true)
    assert.equal(h.inputs[0].status().state, 'open')
    assert.equal(events.some(x => x.type === 'ended'), false)
    await h.controller.seek(0)
    assert.equal(h.leases[1].released, false)
  } finally { await h.controller.stop() }
})

test('startup decoder failure remains a real error and releases its lease', async () => {
  const h = harness({ startRemoteDecoder: options => ({ ready: Promise.reject(new Error('broken audio')),
    done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }) })
  await assert.rejects(h.controller.loadTrack(a), /broken audio/)
  assert.equal(h.leases[0].released, true)
  assert.equal(h.inputs[0].status().state, 'cancelled')
})

test('withdrawal credits a handoff acknowledged during pause before releasing next ownership', async () => {
  const h = harness()
  await h.controller.loadTrack(a)
  const next = await h.controller.preloadNextTrack(b)
  const clear = h.playback.clearNextTrack
  h.playback.clearNextTrack = () => { h.transition(); clear() }
  await h.controller.clearNextTrack()
  assert.equal((await h.controller.getPlaybackSnapshot()).playbackSequence, next.playbackSequence)
  assert.deepEqual(h.leases.map(x => x.released), [true, false])
  assert.equal(h.inputs[1].status().state, 'open')
  await h.controller.stop()
})

test('seek preparation that loses a gapless race cannot replace the newly audible track', async () => {
  let resume!: () => void
  let decodes = 0
  const h = harness({ startRemoteDecoder: options => {
    options.input.append(Buffer.alloc(40000 * 4))
    return { ready: ++decodes === 3 ? new Promise<void>(resolve => { resume = resolve }) : Promise.resolve(),
      done: Promise.resolve(), cancel: () => options.input.cancel(), pid: undefined, pendingBytes: 0 }
  } })
  await h.controller.loadTrack(a)
  await h.controller.preloadNextTrack(b)
  const seek = h.controller.seek(59)
  await new Promise(resolve => setImmediate(resolve))
  h.transition()
  await h.controller.getPlaybackSnapshot()
  resume()
  await assert.rejects(seek, { name: 'SupersededNativeAudioLoadError' })
  assert.equal((await h.controller.getNativeAudioDiagnosticReport()).track?.path, b)
  assert.deepEqual(h.leases.map(x => x.released), [true, false, true])
  await h.controller.stop()
})
