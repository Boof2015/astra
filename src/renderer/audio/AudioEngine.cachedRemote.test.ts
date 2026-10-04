import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AudioEngine, isSupersededAudioLoadError } from './AudioEngine.ts'
import type { Track } from '../types/audio.ts'
import type { RemoteStreamEvent, RemoteStreamInfo } from '../../types/remoteStream.ts'

test('cached remote seek restarts decoding beyond PCM headroom and preserves paused intent', async () => {
  const engine = new AudioEngine()
  const internals = engine as unknown as {
    _playbackState: 'paused' | 'playing'
    remoteStreamState: unknown
    loadProgressiveStream: (track: Track, options: unknown) => Promise<unknown>
    handleRemoteStreamEvent: (event: RemoteStreamEvent) => void
    remoteStreamNode: unknown
  }
  const track = { path: 'subsonic://7/song', sourceType: 'subsonic', duration: 1800 } as Track
  const requests: unknown[] = []
  const workletMessages: unknown[] = []
  let ended = false
  const state = { sessionId: 42, seekableCache: true, sourceType: 'subsonic', track,
    durationSeconds: 1800, sampleRate: 48000, bufferedFrames: 48000 * 30,
    startFrame: 0, currentFrame: 48000 * 10, playRequested: false, sourceEnded: false }
  internals.remoteStreamState = state
  internals._playbackState = 'paused'
  internals.remoteStreamNode = { port: { postMessage: (value: unknown) => workletMessages.push(value) } }
  internals.loadProgressiveStream = async (loadedTrack, options) => {
    assert.equal(loadedTrack.path, track.path)
    requests.push(options)
  }
  engine.on('ended', () => { ended = true })
  engine.on('error', () => undefined)
  await engine.seek(900)
  assert.equal((requests[0] as { startTimeSeconds: number }).startTimeSeconds, 900)
  assert.equal(internals._playbackState, 'paused')
  internals.handleRemoteStreamEvent({ sessionId: 42, path: track.path, sourceType: 'subsonic',
    type: 'failed', message: 'Offline', decodedFrames: 48000 * 30, decodedSeconds: 30 })
  assert.equal(state.sourceEnded, false)
  assert.equal(ended, false)
  assert.equal(workletMessages.length, 0, 'failure must not signal final EOF to the worklet')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// Exercise the real load/seek/play lifecycle, including the interval with no
// remoteStreamState. Only the browser audio graph and Electron transport are fake.
async function remoteHarness(t: TestContext, playing: boolean) {
  const engine = new AudioEngine()
  const internals = engine as unknown as {
    context: AudioContext
    workletLoaded: boolean
    _normalizationEnabled: boolean
    remoteStreamState: { path: string; playRequested: boolean } | null
    initContext: () => Promise<void>
    createRemoteStreamNode: () => unknown
    disconnectSourceRouting: () => void
    applyChannelRoutingPreferences: () => void
    applyAnalysisRoutingPreferences: () => void
    applyGainState: () => void
    startTimeUpdate: () => void
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: Array<ReturnType<typeof deferred<RemoteStreamInfo>> & {
    path: string; target: number; sessionId: number
  }> = []
  let pending: (typeof requests)[number] | null = null
  let cancellationGate: Promise<void> | null = null
  const cancelledSessions: number[] = []
  const playedTimes: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    startProgressiveStream: (path: string, _rate: number, _channels: number, options: { startTimeSeconds: number }) => {
      assert.equal(pending, null, 'decoder startups must not overlap')
      const request = { ...deferred<RemoteStreamInfo>(), path, target: options.startTimeSeconds,
        sessionId: requests.length + 1 }
      requests.push(request)
      pending = request
      return request.promise.finally(() => { if (pending === request) pending = null })
    },
    cancelPendingProgressiveStream: async () => {
      pending?.reject(new Error('Startup cancelled'))
      await cancellationGate
    },
    cancelProgressiveStream: async (sessionId: number) => { cancelledSessions.push(sessionId) },
    updateProgressiveStreamPosition: () => undefined
  } } })
  internals.context = { sampleRate: 1000, currentTime: 0 } as AudioContext
  internals.workletLoaded = true
  internals._normalizationEnabled = false
  internals.initContext = async () => undefined
  internals.createRemoteStreamNode = () => ({
    port: { onmessage: null, postMessage: () => undefined }, disconnect: () => undefined
  })
  internals.disconnectSourceRouting = () => undefined
  internals.applyChannelRoutingPreferences = () => undefined
  internals.applyAnalysisRoutingPreferences = () => undefined
  internals.applyGainState = () => undefined
  internals.startTimeUpdate = () => undefined
  engine.on('stateChange', (state) => { if (state === 'playing') playedTimes.push(engine.currentTime) })
  t.after(async () => {
    engine.stop()
    await flush()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
  })
  const track = { path: 'subsonic://7/drag', sourceType: 'subsonic', duration: 1800 } as Track
  const complete = (index: number, withPcm = true) => {
    const request = requests[index]
    request.resolve({ sessionId: request.sessionId, path: request.path, sourceType: 'subsonic',
      sampleRate: 1000, channels: 2, durationSeconds: 1800, startTimeSeconds: request.target,
      seekableCache: true,
      initialChunk: withPcm ? { sessionId: request.sessionId, path: request.path, sourceType: 'subsonic',
        sampleRate: 1000, channels: 2, frameCount: 1000, pcmData: new ArrayBuffer(8000),
        decodedFrames: 1000, decodedSeconds: 1 } : null
    })
  }
  const load = engine.loadRemoteStream(track)
  await flush()
  complete(0)
  await load
  if (playing) await engine.play()
  else engine.pause()
  playedTimes.length = 0
  return { engine, internals, track, requests, complete, playedTimes, cancelledSessions,
    setCancellationGate: (gate: Promise<void>) => { cancellationGate = gate } }
}

for (const playing of [false, true]) {
  test(`dragging cached audio keeps the final target and ${playing ? 'playing' : 'paused'} intent`, async (t) => {
    const h = await remoteHarness(t, playing)
    const first = h.engine.seek(120)
    await flush()
    assert.equal(h.internals.remoteStreamState, null)
    const moves = [300, 600, 900, 900].map((time) => h.engine.seek(time))
    await flush()
    assert.deepEqual(h.requests.map((request) => request.target), [0, 120, 900])
    h.complete(2)
    await Promise.all([first, ...moves])
    assert.equal(h.engine.currentTime, 900)
    assert.equal(h.engine.playbackState, playing ? 'playing' : 'paused')
    assert.deepEqual(h.playedTimes, playing ? [900] : [])
    assert.equal(h.engine.getRemoteStreamSessionId(), 3)
  })
}

test('drag cancellation finishes before opening the final decoder', async (t) => {
  const h = await remoteHarness(t, true)
  const gate = deferred<void>()
  h.setCancellationGate(gate.promise)
  const first = h.engine.seek(120)
  await flush()
  const second = h.engine.seek(600)
  await flush()
  const final = h.engine.seek(900)
  assert.equal(h.requests.length, 2)
  gate.resolve()
  await flush()
  assert.equal(h.requests[2].target, 900)
  h.complete(2)
  await Promise.all([first, second, final])
  assert.equal(h.engine.currentTime, 900)
})

test('dragging during context setup opens only the final target', async (t) => {
  const h = await remoteHarness(t, true)
  const gate = deferred<void>()
  h.internals.initContext = () => gate.promise
  const first = h.engine.seek(120)
  const moves = [300, 600, 900].map((time) => h.engine.seek(time))
  gate.resolve()
  await flush()
  assert.deepEqual(h.requests.map((request) => request.target), [0, 900])
  h.complete(1)
  await Promise.all([first, ...moves])
  assert.equal(h.engine.currentTime, 900)
  assert.deepEqual(h.playedTimes, [900])
})

test('dragging again while waiting for PCM moves to the latest target', async (t) => {
  const h = await remoteHarness(t, true)
  const first = h.engine.seek(120)
  await flush()
  h.complete(1, false)
  await flush()
  assert.equal(h.internals.remoteStreamState?.playRequested, true)
  const final = h.engine.seek(900)
  await flush()
  h.complete(2)
  await Promise.all([first, final])
  assert.deepEqual(h.playedTimes, [900])
  assert.equal(h.engine.currentTime, 900)
})

for (const withPcm of [false, true]) {
  test(`pause during a seek is retained ${withPcm ? 'during startup' : 'while waiting for PCM'}`, async (t) => {
    const h = await remoteHarness(t, true)
    const seek = h.engine.seek(120)
    await flush()
    if (!withPcm) {
      h.complete(1, false)
      await flush()
    }
    h.engine.pause()
    if (withPcm) h.complete(1)
    await seek
    assert.equal(h.engine.playbackState, 'paused')
    assert.deepEqual(h.playedTimes, [])
    assert.equal(h.engine.currentTime, 120)
  })
}

test('resuming during decoder replacement plays the final seek target', async (t) => {
  const h = await remoteHarness(t, false)
  const seek = h.engine.seek(120)
  await flush()
  const play = h.engine.play()
  const final = h.engine.seek(900)
  await flush()
  h.complete(2)
  await Promise.all([seek, play, final])
  assert.equal(h.engine.playbackState, 'playing')
  assert.equal(h.engine.currentTime, 900)
})

test('switching tracks during a drag cannot reinstall or resume the old track', async (t) => {
  const h = await remoteHarness(t, true)
  const seek = h.engine.seek(120)
  const obsolete = assert.rejects(seek, isSupersededAudioLoadError)
  await flush()
  const replacement = { ...h.track, path: 'subsonic://7/next' }
  const load = h.engine.loadRemoteStream(replacement)
  await flush()
  h.complete(2)
  await Promise.all([load, obsolete])
  assert.equal(h.internals.remoteStreamState?.path, replacement.path)
  assert.deepEqual(h.playedTimes, [])
  await h.engine.play()
  assert.equal(h.engine.currentTime, 0)
})

test('stopping during a seek cancels startup and cannot resume playback', async (t) => {
  const h = await remoteHarness(t, true)
  const seek = h.engine.seek(120)
  const obsolete = assert.rejects(seek, isSupersededAudioLoadError)
  await flush()
  h.engine.stop()
  await obsolete
  assert.equal(h.engine.playbackState, 'stopped')
  assert.equal(h.engine.getRemoteStreamSessionId(), null)
  assert.deepEqual(h.playedTimes, [])
})
