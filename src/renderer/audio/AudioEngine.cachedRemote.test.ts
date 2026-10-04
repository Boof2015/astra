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
    remoteStreamNode: AudioWorkletNode | null
    connectSourceWithRouting: () => void
    connectSourceToAnalysisTap: () => void
    disconnectSourceRouting: () => void
    applyChannelRoutingPreferences: () => void
    applyAnalysisRoutingPreferences: () => void
    applyGainState: () => void
    startTimeUpdate: () => void
    handleRemoteStreamEvent: (event: RemoteStreamEvent) => void
    promoteRemoteStream: (previousSessionId: number, sessionId: number) => void
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  const requests: Array<ReturnType<typeof deferred<RemoteStreamInfo>> & {
    path: string; target: number; sessionId: number; slot: 'current' | 'next'; preserveNext?: boolean
  }> = []
  const pending = new Map<string, (typeof requests)[number]>()
  let cancellationGate: Promise<void> | null = null
  const cancelledSessions: number[] = []
  const playedTimes: number[] = []
  const workletMessages: Array<{ type: string; sessionId?: number; nextSessionId?: number }> = []
  const activatedSessions: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    startProgressiveStream: (path: string, _rate: number, _channels: number, options: { startTimeSeconds: number; slot?: 'current' | 'next'; preserveNext?: boolean }) => {
      const slot = options.slot ?? 'current'
      assert.equal(pending.has(slot), false, 'decoder startups in the same slot must not overlap')
      if (slot === 'current' && !options.preserveNext) pending.get('next')?.reject(new Error('Startup cancelled'))
      const request = { ...deferred<RemoteStreamInfo>(), path, target: options.startTimeSeconds,
        sessionId: requests.length + 1, slot, preserveNext: options.preserveNext }
      requests.push(request)
      pending.set(slot, request)
      return request.promise.finally(() => { if (pending.get(slot) === request) pending.delete(slot) })
    },
    cancelPendingProgressiveStream: async (slot = 'current') => {
      pending.get(slot)?.reject(new Error('Startup cancelled'))
      await cancellationGate
    },
    cancelProgressiveStream: async (sessionId: number) => { cancelledSessions.push(sessionId) },
    updateProgressiveStreamPosition: () => undefined,
    activateProgressiveStream: (sessionId: number) => { activatedSessions.push(sessionId) }
  } } })
  internals.context = { sampleRate: 1000, currentTime: 0 } as AudioContext
  internals.workletLoaded = true
  internals._normalizationEnabled = false
  internals.initContext = async () => undefined
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    port = { onmessage: null, postMessage: (message: (typeof workletMessages)[number]) => workletMessages.push(message) }
    disconnect() {}
  } })
  internals.connectSourceWithRouting = () => undefined
  internals.connectSourceToAnalysisTap = () => undefined
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
    if (originalWorkletNode) Object.defineProperty(globalThis, 'AudioWorkletNode', originalWorkletNode)
    else delete (globalThis as Record<string, unknown>).AudioWorkletNode
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
  return { engine, internals, track, requests, complete, playedTimes, cancelledSessions, workletMessages, activatedSessions,
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

test('prepared remote playback stays separate until the audio-thread handoff', async (t) => {
  const h = await remoteHarness(t, true)
  const nextTrack = { ...h.track, path: 'subsonic://7/next' }
  const transitions: unknown[] = []
  h.engine.on('gaplessTransition', (event) => transitions.push(event))
  const prepare = h.engine.preBufferNextRemoteTrack(nextTrack, null)
  await flush()
  assert.equal(h.requests[1].slot, 'next')
  h.complete(1)
  await prepare
  assert.equal(h.engine.getRemoteStreamSessionId(), 1)
  assert.equal(h.engine.hasNextBuffered, true)
  assert.equal(h.engine.nextBufferedTrackPath, nextTrack.path)
  assert.equal(h.engine.playbackState, 'playing')
  assert.deepEqual(transitions, [])
  assert.ok(h.workletMessages.some((message) => message.type === 'append-chunk' && message.sessionId === 2))
  h.internals.promoteRemoteStream(1, 2)
  assert.equal(h.engine.getRemoteStreamSessionId(), 2)
  assert.equal(h.internals.remoteStreamState?.path, nextTrack.path)
  assert.equal(h.engine.hasNextBuffered, false)
  assert.deepEqual(h.cancelledSessions, [1])
  assert.deepEqual(h.activatedSessions, [2])
  assert.deepEqual(transitions, [{ trackPath: nextTrack.path }])
})

test('failed preparation releases only the next session and leaves current playback usable', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  h.internals.handleRemoteStreamEvent({ type: 'failed', sessionId: 2, path: 'subsonic://7/next',
    sourceType: 'subsonic', message: 'Offline', decodedFrames: 1000, decodedSeconds: 1 })
  assert.equal(h.engine.getRemoteStreamSessionId(), 1)
  assert.equal(h.engine.playbackState, 'playing')
  assert.equal(h.engine.hasNextBuffered, false)
  assert.deepEqual(h.cancelledSessions, [2])
})

test('clearing pending preparation cancels it without replacing current playback', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  const cancelled = assert.rejects(prepare, isSupersededAudioLoadError)
  await flush()
  h.engine.clearNextBuffer()
  await cancelled
  assert.equal(h.engine.getRemoteStreamSessionId(), 1)
  assert.equal(h.engine.playbackState, 'playing')
})

test('a pause racing with the handoff notification stays paused after promotion', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  h.engine.pause()
  h.internals.promoteRemoteStream(1, 2)
  assert.equal(h.engine.playbackState, 'paused')
  assert.equal(h.internals.remoteStreamState?.playRequested, false)
  await h.engine.play()
  assert.equal(h.engine.playbackState, 'playing')
})

for (const playing of [false, true]) {
  test(`seeking near EOF retains the ready successor and ${playing ? 'playing' : 'paused'} intent`, async (t) => {
    const h = await remoteHarness(t, playing)
    const node = h.internals.remoteStreamNode
    const nextTrack = { ...h.track, path: 'subsonic://7/next' }
    const prepare = h.engine.preBufferNextRemoteTrack(nextTrack, null)
    await flush()
    h.complete(1)
    await prepare
    const seek = h.engine.seek(1799.9)
    await flush()
    assert.equal(h.engine.canPreBufferRemoteTrack(nextTrack), true, 'queue scheduling stays eligible during seek startup')
    assert.equal(h.engine.hasNextBuffered, true)
    assert.equal(h.requests[2].preserveNext, true)
    h.complete(2)
    await seek
    h.internals.promoteRemoteStream(1, 2)
    assert.equal(h.engine.getRemoteStreamSessionId(), 3)
    assert.equal(h.engine.currentTime, 1799.9)
    assert.equal(h.engine.hasNextBuffered, true)
    assert.equal(h.engine.playbackState, playing ? 'playing' : 'paused')
    assert.equal(h.internals.remoteStreamNode, node, 'staged PCM remains in the same worklet')
    assert.deepEqual(h.cancelledSessions, [1])
    assert.ok(h.workletMessages.some(message => message.type === 'reset-current' && message.nextSessionId === 2))
    h.internals.promoteRemoteStream(3, 2)
    assert.equal(h.engine.getRemoteStreamSessionId(), 2)
    assert.equal(h.engine.currentTime, 0)
    assert.equal(h.engine.playbackState, playing ? 'playing' : 'paused')
  })
}

test('dragging preserves successor startup even when it completes between current decoders', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  const first = h.engine.seek(120)
  await flush()
  const last = h.engine.seek(1799.9)
  await flush()
  assert.equal(h.internals.remoteStreamState, null)
  h.complete(1)
  await prepare
  assert.equal(h.engine.hasNextBuffered, true)
  h.complete(3)
  await Promise.all([first, last])
  assert.equal(h.engine.currentTime, 1799.9)
  assert.equal(h.engine.hasNextBuffered, true)
  assert.deepEqual(h.cancelledSessions, [1])
  h.internals.promoteRemoteStream(4, 2)
  assert.equal(h.engine.getRemoteStreamSessionId(), 2)
})

test('a queue edit during a seek releases the old successor without resurrecting it', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  const seek = h.engine.seek(1799.9)
  await flush()
  h.engine.clearNextBuffer()
  h.complete(2)
  await seek
  assert.equal(h.engine.hasNextBuffered, false)
  assert.ok(h.cancelledSessions.includes(2))
  assert.equal(h.engine.getRemoteStreamSessionId(), 3)
})

test('a seek discards a successor already consumed on the audio thread and requests preparation again', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  let invalidations = 0
  h.engine.on('remotePrebufferInvalidated', () => { invalidations += 1 })
  const seek = h.engine.seek(1799.9)
  await flush()
  const node = h.internals.remoteStreamNode!
  node.port.onmessage!({ data: { type: 'gapless-transition', previousSessionId: 1, sessionId: 2 } } as MessageEvent)
  assert.equal(h.engine.getRemoteStreamSessionId(), null, 'the old handoff cannot advance a pending seek')
  node.port.onmessage!({ data: { type: 'next-invalidated', sessionId: 2 } } as MessageEvent)
  assert.equal(h.engine.hasNextBuffered, false)
  assert.equal(invalidations, 1)
  assert.ok(h.cancelledSessions.includes(2))
  h.complete(2)
  await seek
  const replacement = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/new-next' }, null)
  await flush()
  h.complete(3)
  await replacement
  node.port.onmessage!({ data: { type: 'next-invalidated', sessionId: 2 } } as MessageEvent)
  assert.equal(h.engine.hasNextBuffered, true, 'late invalidation cannot clear a newer successor')
  assert.equal(invalidations, 1)
})

test('switching tracks during a seek cancels the preserved successor startup', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  const obsoletePreparation = assert.rejects(prepare, isSupersededAudioLoadError)
  await flush()
  const seek = h.engine.seek(1799.9)
  const obsoleteSeek = assert.rejects(seek, isSupersededAudioLoadError)
  await flush()
  const load = h.engine.loadRemoteStream({ ...h.track, path: 'subsonic://7/replacement' })
  await flush()
  h.complete(3)
  await Promise.all([load, obsoletePreparation, obsoleteSeek])
  assert.equal(h.engine.getRemoteStreamSessionId(), 4)
  assert.equal(h.engine.hasNextBuffered, false)
  assert.equal(h.requests[3].preserveNext, false)
})

test('stopping between seek teardown and decoder startup releases the retained worklet and next session', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  const gate = deferred<void>()
  h.internals.initContext = () => gate.promise
  const seek = h.engine.seek(1799.9)
  const obsolete = assert.rejects(seek, isSupersededAudioLoadError)
  await flush()
  assert.equal(h.internals.remoteStreamState, null)
  assert.equal(h.requests.length, 2)
  h.engine.stop()
  gate.resolve()
  await obsolete
  assert.equal(h.internals.remoteStreamNode, null)
  assert.equal(h.engine.hasNextBuffered, false)
  assert.equal(h.engine.playbackState, 'stopped')
  assert.deepEqual(h.cancelledSessions, [1, 2])
})

test('cached stream gain is applied once and clearing preparation cannot reapply it on the shared bus', () => {
  const engine = new AudioEngine()
  const messages: Array<{ type: string; gain: number; sessionId: number }> = []
  const parameter = () => ({ value: 0.5, cancelScheduledValues: () => undefined,
    setValueAtTime(value: number) { this.value = value } })
  const audible = parameter()
  const analysis = parameter()
  const internals = engine as unknown as {
    remoteStreamState: unknown
    remoteStreamNode: unknown
    context: unknown
    normalizationGainNode: unknown
    analysisNormalizationGainNode: unknown
    applyGainState: (gain: { gainDb: number; linearGain: number; mode: 'replaygain' }) => void
    restoreCurrentNormalizationGainNow: () => void
  }
  internals.context = { currentTime: 0 }
  internals.remoteStreamState = { sessionId: 1, seekableCache: true }
  internals.remoteStreamNode = { port: { postMessage: (message: (typeof messages)[number]) => messages.push(message) } }
  internals.normalizationGainNode = { gain: audible }
  internals.analysisNormalizationGainNode = { gain: analysis }
  internals.applyGainState({ gainDb: -6, linearGain: 0.5, mode: 'replaygain' })
  internals.restoreCurrentNormalizationGainNow()
  assert.equal(messages.at(-1)?.gain, 0.5)
  assert.equal(audible.value, 1)
  assert.equal(analysis.value, 1)
  internals.remoteStreamState = null
  internals.applyGainState({ gainDb: -6, linearGain: 0.5, mode: 'replaygain' })
  assert.equal(audible.value, 0.5, 'ordinary buffer playback retains its existing normalization path')
  assert.equal(analysis.value, 0.5)
})

test('cancelling preparation and pausing at the boundary cannot trigger automatic playback', async (t) => {
  const h = await remoteHarness(t, true)
  const prepare = h.engine.preBufferNextRemoteTrack({ ...h.track, path: 'subsonic://7/next' }, null)
  await flush()
  h.complete(1)
  await prepare
  let ended = false
  h.engine.on('ended', () => { ended = true })
  h.engine.clearNextBuffer()
  h.engine.pause()
  h.internals.promoteRemoteStream(1, 2)
  assert.equal(h.engine.playbackState, 'stopped')
  assert.equal(h.engine.getRemoteStreamSessionId(), null)
  assert.equal(ended, false, 'a user pause must suppress automatic next-track loading')
})
