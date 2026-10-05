import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
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
async function remoteHarness(t: TestContext, playing: boolean, sourceType: 'local' | 'subsonic' | 'jellyfin' = 'subsonic', renderAudio = false) {
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
  const realApplyGainState = internals.applyGainState.bind(engine)
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  const requests: Array<ReturnType<typeof deferred<RemoteStreamInfo>> & {
    path: string; target: number; sampleRate: number; sessionId: number; slot: 'current' | 'next'; preserveNext?: boolean
  }> = []
  const pending = new Map<string, (typeof requests)[number]>()
  let cancellationGate: Promise<void> | null = null
  const cancelledSessions: number[] = []
  const playedTimes: number[] = []
  const workletMessages: Array<{ type: string; sessionId?: number; nextSessionId?: number }> = []
  const activatedSessions: number[] = []
  const reportedSessions: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    startProgressiveStream: (path: string, _rate: number, _channels: number, options: { startTimeSeconds: number; slot?: 'current' | 'next'; preserveNext?: boolean }) => {
      const slot = options.slot ?? 'current'
      assert.equal(pending.has(slot), false, 'decoder startups in the same slot must not overlap')
      if (slot === 'current' && !options.preserveNext) pending.get('next')?.reject(new Error('Startup cancelled'))
      const request = { ...deferred<RemoteStreamInfo>(), path, target: options.startTimeSeconds, sampleRate: _rate,
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
    updateProgressiveStreamPosition: (sessionId: number) => { reportedSessions.push(sessionId) },
    activateProgressiveStream: (sessionId: number) => { activatedSessions.push(sessionId) }
  } } })
  internals.context = { sampleRate: 1000, currentTime: 0 } as AudioContext
  internals.workletLoaded = true
  internals._normalizationEnabled = false
  internals.initContext = async () => undefined
  type Processor = { port: { onmessage: (event: { data: unknown }) => void; postMessage: (data: unknown) => void };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }
  let ProcessorClass: (new (options: unknown) => Processor) | undefined
  let renderFrame = 0
  if (renderAudio) {
    runInNewContext(readFileSync(new URL('../public/oscilloscope-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => undefined } },
      registerProcessor: (name: string, ctor: typeof ProcessorClass) => { if (name === 'remote-stream-player') ProcessorClass = ctor },
      Float32Array, sampleRate: 1000, get currentFrame() { return renderFrame }
    })
  }
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    processor?: Processor
    port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (message: (typeof workletMessages)[number]) => {
      workletMessages.push(message)
      this.processor?.port.onmessage({ data: message })
    } }
    constructor(_context: unknown, options: unknown) {
      if (ProcessorClass) {
        this.processor = new ProcessorClass(options)
        this.processor.port.postMessage = data => { queueMicrotask(() => this.port.onmessage?.({ data })) }
      }
    }
    render(frames: number) {
      const output = [new Float32Array(frames), new Float32Array(frames)]
      this.processor!.process([], [output])
      renderFrame += frames
      return output
    }
    connect() {}
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
  const track = { path: sourceType === 'local' ? '/music/local.flac' : `${sourceType}://7/drag`, sourceType, duration: 1800 } as Track
  const complete = (index: number, withPcm = true) => {
    const request = requests[index]
    const requestSource = request.path.startsWith('jellyfin://') ? 'jellyfin' : request.path.startsWith('subsonic://') ? 'subsonic' : 'local'
    request.resolve({ sessionId: request.sessionId, path: request.path, sourceType: requestSource,
      sampleRate: request.sampleRate, channels: 2, durationSeconds: 1800, startTimeSeconds: request.target,
      seekableCache: requestSource !== 'local',
      initialChunk: withPcm ? { sessionId: request.sessionId, path: request.path, sourceType: requestSource,
        sampleRate: request.sampleRate, channels: 2, frameCount: request.sampleRate, pcmData: new ArrayBuffer(request.sampleRate * 8),
        decodedFrames: request.sampleRate, decodedSeconds: 1 } : null
    })
  }
  const load = engine.loadRemoteStream(track)
  await flush()
  complete(0)
  await load
  if (playing) await engine.play()
  else engine.pause()
  playedTimes.length = 0
  return { engine, internals, track, requests, complete, playedTimes, cancelledSessions, workletMessages, activatedSessions, reportedSessions,
    restoreGain: () => { internals.applyGainState = realApplyGainState },
    setCancellationGate: (gate: Promise<void>) => { cancellationGate = gate } }
}

for (const sourceType of ['subsonic', 'jellyfin'] as const) {
  for (const playing of [false, true]) {
    test(`${sourceType}: dragging cached audio keeps the final target and ${playing ? 'playing' : 'paused'} intent`, async (t) => {
      const h = await remoteHarness(t, playing, sourceType)
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

}

async function completeLocalHarness(t: TestContext) {
  const h = await remoteHarness(t, true)
  h.engine.stop()
  await flush()
  h.cancelledSessions.length = 0
  h.workletMessages.length = 0
  const sampleRate = 48000
  const channels = [Float32Array.from({ length: sampleRate * 40 }, (_, frame) => frame),
    Float32Array.from({ length: sampleRate * 40 }, (_, frame) => -frame)]
  const buffer = { sampleRate, numberOfChannels: 2, length: channels[0].length,
    duration: 40, getChannelData: (channel: number) => channels[channel] } as AudioBuffer
  const stoppedAt: Array<number | undefined> = []
  const source = { buffer, onended: null, disconnect() {}, stop: (time?: number) => { stoppedAt.push(time) } }
  const params = [0, 1].map(() => ({ value: 2, cancelled: [] as number[], scheduled: [] as number[][],
    cancelScheduledValues(time: number) { this.cancelled.push(time); this.scheduled = this.scheduled.filter(x => x[1] < time) },
    setValueAtTime(value: number, time: number) { this.scheduled.push([value, time]) } }))
  const internals = h.engine as unknown as {
    audioBuffer: AudioBuffer | null; sourceNode: unknown; startTime: number; _playbackState: string;
    currentBufferTrackPath: string; _normalizationGainDb: number; _normalizationMode: string;
    normalizationGainNode: unknown; analysisNormalizationGainNode: unknown;
    remoteStreamState: { sessionId: number; startFrame: number; sourceType: string; completeBuffer?: AudioBuffer } | null
  }
  Object.assign(internals, { audioBuffer: buffer, sourceNode: source, startTime: 0, _playbackState: 'playing',
    currentBufferTrackPath: '/music/local.flac', _normalizationGainDb: 20 * Math.log10(2), _normalizationMode: 'normalization',
    normalizationGainNode: { gain: params[0] }, analysisNormalizationGainNode: { gain: params[1] } })
  h.internals.context = { sampleRate, currentTime: 10 } as AudioContext
  h.restoreGain()
  const track = { path: '/music/local.flac', sourceType: 'local', channels: 2, duration: 40 } as Track
  return { ...h, local: internals, buffer, source, stoppedAt, params, localTrack: track }
}

test('complete local PCM joins remote preparation on one clock boundary without decoding the local file again', async t => {
  const h = await completeLocalHarness(t)
  const next = { ...h.track, channels: 2 }
  assert.equal(h.engine.canPreBufferRemoteTrack(next), true)
  const prepare = h.engine.preBufferNextRemoteTrack(next, null, { currentTrack: h.localTrack })
  await flush()
  h.complete(1)
  await prepare
  const current = h.local.remoteStreamState!
  assert.ok(current.sessionId < 0)
  assert.equal(current.completeBuffer, h.buffer)
  assert.equal(h.engine.getAudioBuffer(), h.buffer)
  assert.equal(h.engine.currentTime, 10, 'the future audio join must not move the visible playhead early')
  assert.equal(h.stoppedAt[0], 10.1)
  const messages = h.workletMessages as Array<{ type: string; sessionId?: number; contextFrame?: number; frameCount?: number; channelData?: Float32Array[] }>
  assert.ok(messages.some(message => message.type === 'set-playing' && message.contextFrame === 484800))
  const localChunks = messages.filter(message => message.type === 'append-chunk' && message.sessionId === current.sessionId)
  assert.equal(localChunks[0].channelData![0][0], 484800)
  assert.equal(localChunks[0].channelData![1][0], -484800)
  assert.ok(localChunks.reduce((frames, chunk) => frames + chunk.frameCount!, 0) <= 8 * 48000)
  assert.equal(h.params[0].value, 2, 'the local DSP history keeps its existing bus gain')
  assert.deepEqual(h.params[0].scheduled, [])
  const gains = h.workletMessages as Array<{ type: string; sessionId?: number; gain?: number }>
  assert.equal(gains.find(message => message.type === 'set-gain' && message.sessionId === current.sessionId)?.gain, 1)
  assert.equal(gains.find(message => message.type === 'set-gain' && message.sessionId === 2)?.gain, 0.5)
  assert.deepEqual(h.requests.slice(1).map(request => request.path), [next.path])

  const oldId = current.sessionId
  await h.engine.seek(20)
  assert.equal(h.engine.currentTime, 20)
  assert.equal(h.engine.hasNextBuffered, true)
  assert.equal(h.requests.length, 2, 'seeking the complete local adapter needs no decoder IPC')
  h.internals.promoteRemoteStream(oldId, 2)
  assert.equal(h.local.remoteStreamState?.sourceType, 'local', 'an obsolete pre-seek handoff cannot promote')
  h.internals.promoteRemoteStream(current.sessionId, 2)
  assert.equal(h.engine.getAudioBuffer(), null, 'the completed local buffer is released after handoff')
  assert.equal(h.engine.getRemoteStreamSessionId(), 2)
  h.engine.clearNextBuffer()
  assert.equal(h.params[0].scheduled.at(-1)?.[0], 2, 'queue cleanup preserves the inherited bus gain')
  assert.deepEqual(h.cancelledSessions, [], 'synthetic local identities never reach main-process cancellation')
})

test('pause before the local clock join preserves the actual position and keeps the remote successor', async t => {
  const h = await completeLocalHarness(t)
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  await flush(); h.complete(1); await prepare
  h.engine.pause()
  assert.equal(h.engine.currentTime, 10)
  assert.equal(h.engine.playbackState, 'paused')
  assert.equal(h.engine.hasNextBuffered, true)
  assert.equal(h.stoppedAt.at(-1), undefined, 'the outgoing BufferSource stops immediately on pause')
  assert.deepEqual(h.params[0].scheduled, [], 'the cancelled clock join cannot change gain later')
  await h.engine.play()
  assert.equal(h.engine.playbackState, 'playing')
  assert.equal(h.engine.currentTime, 10)
})

test('the local clock join transfers routing ownership without resetting its DSP nodes', async t => {
  const h = await completeLocalHarness(t)
  const routing = { inputNode: {} as AudioNode, nodes: [{} as AudioNode] }
  const internals = h.engine as unknown as { sourceRoutingNodes: WeakMap<object, typeof routing> }
  internals.sourceRoutingNodes.set(h.source, routing)
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  await flush(); h.complete(1); await prepare
  assert.equal(internals.sourceRoutingNodes.get(h.internals.remoteStreamNode!), routing)
  assert.equal(internals.sourceRoutingNodes.has(h.source), false)
  const source = h.source as unknown as { onended: () => void }
  source.onended()
  assert.equal(h.local.sourceNode, null)
  assert.equal(internals.sourceRoutingNodes.get(h.internals.remoteStreamNode!), routing,
    'the outgoing source cannot dispose routing that the worklet still uses')
})

test('failed remote preparation leaves the original local source and complete buffer playing', async t => {
  const h = await completeLocalHarness(t)
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  await flush()
  h.requests[1].reject(new Error('Offline'))
  await assert.rejects(prepare, /Offline/)
  assert.equal(h.local.audioBuffer, h.buffer)
  assert.equal(h.local.sourceNode, h.source)
  assert.equal(h.local.remoteStreamState, null)
  assert.deepEqual(h.stoppedAt, [])
})

test('a missed local clock deadline leaves the original source playing and releases remote preparation', async t => {
  const h = await completeLocalHarness(t)
  const read = h.buffer.getChannelData.bind(h.buffer)
  h.buffer.getChannelData = channel => {
    Object.defineProperty(h.internals.context, 'currentTime', { value: 10.2, configurable: true })
    return read(channel)
  }
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  const failure = assert.rejects(prepare, /scheduling window/)
  await flush(); h.complete(1); await failure
  assert.equal(h.local.audioBuffer, h.buffer)
  assert.equal(h.local.sourceNode, h.source)
  assert.equal(h.local.remoteStreamState, null)
  assert.equal(h.internals.remoteStreamNode, null)
  assert.deepEqual(h.stoppedAt, [])
  assert.deepEqual(h.cancelledSessions, [2])
})

test('a queue edit during local preparation cannot install an obsolete remote successor', async t => {
  const h = await completeLocalHarness(t)
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  const obsolete = assert.rejects(prepare, isSupersededAudioLoadError)
  await flush()
  h.engine.clearNextBuffer()
  await obsolete
  assert.equal(h.local.audioBuffer, h.buffer)
  assert.equal(h.local.sourceNode, h.source)
  assert.equal(h.local.remoteStreamState, null)
  assert.deepEqual(h.stoppedAt, [])
})

test('a bridged local continues with bounded lookahead after its remote successor is removed', async t => {
  const h = await completeLocalHarness(t)
  const prepare = h.engine.preBufferNextRemoteTrack(h.track, null, { currentTrack: h.localTrack })
  await flush(); h.complete(1); await prepare
  const state = h.local.remoteStreamState!
  h.engine.clearNextBuffer()
  const offset = h.workletMessages.length
  h.internals.remoteStreamNode!.port.onmessage!({ data: {
    type: 'position', sessionId: state.sessionId, frame: 48000 * 4
  } } as MessageEvent)
  const chunks = h.workletMessages.slice(offset) as Array<{ type: string; frameCount?: number; channelData?: Float32Array[] }>
  const appended = chunks.filter(message => message.type === 'append-chunk')
  assert.equal(appended.reduce((sum, chunk) => sum + chunk.frameCount!, 0), 48000 * 4)
  assert.equal(appended[0].channelData![0][0], state.startFrame + 48000 * 8)
  assert.equal(h.engine.hasNextBuffered, false)
  assert.equal(h.engine.playbackState, 'playing')
  assert.ok(h.reportedSessions.every(id => id > 0), 'synthetic local consumption never reaches decoder IPC')
  h.engine.stop()
  await flush()
  assert.equal(h.engine.getAudioBuffer(), null)
  assert.deepEqual(h.cancelledSessions, [2])
})

test('large local progressive playback applies gain per session before preparing a remote successor', async t => {
  const h = await remoteHarness(t, true, 'local')
  h.restoreGain()
  h.engine.normalizationEnabled = false
  assert.ok(h.workletMessages.some(message => message.type === 'set-gain' && message.sessionId === 1))
  assert.equal(h.engine.canPreBufferRemoteTrack(h.track), false, 'local-only preparation keeps its existing route')
  const remote = { ...h.track, path: 'jellyfin://7/next', sourceType: 'jellyfin' as const }
  assert.equal(h.engine.canPreBufferRemoteTrack(remote), true)
  const prepare = h.engine.preBufferNextRemoteTrack(remote, null)
  await flush(); h.complete(1); await prepare
  h.internals.promoteRemoteStream(1, 2)
  assert.equal(h.internals.remoteStreamState?.path, remote.path)
  assert.deepEqual(h.cancelledSessions, [1])
})

test('remote to local preparation targets the next stream, and the promoted local seek retains its next remote track', async t => {
  const h = await remoteHarness(t, true)
  const local = { ...h.track, path: '/music/local.flac', sourceType: 'local' as const }
  const prepare = h.engine.preBufferNextRemoteTrack(local, null, { loudnessAnalysis: { loudnessLufs: -20, peakLinear: 0.5 } })
  await flush(); h.complete(1); await prepare
  assert.equal(h.internals.remoteStreamState?.path, h.track.path)
  assert.ok(h.workletMessages.some(message => message.type === 'append-chunk' && message.sessionId === 2))
  h.internals.promoteRemoteStream(1, 2)
  assert.equal(h.internals.remoteStreamState?.path, local.path)
  assert.equal((h.engine as unknown as { currentNormalizationAnalysis: { loudnessLufs: number } }).currentNormalizationAnalysis.loudnessLufs, -20)
  const next = h.engine.preBufferNextRemoteTrack(h.track, null)
  await flush(); h.complete(2); await next
  const seek = h.engine.seek(1799.9)
  await flush()
  assert.equal(h.requests[3].path, local.path)
  assert.equal(h.requests[3].preserveNext, true)
  h.complete(3); await seek
  assert.equal(h.engine.hasNextBuffered, true)
  h.internals.promoteRemoteStream(4, 3)
  assert.equal(h.internals.remoteStreamState?.path, h.track.path)
})

for (const discard of [false, true]) {
test(`fully decoded local successor ${discard ? 'can be discarded safely' : 'retains instant seeking and its full waveform'}`, async t => {
  const h = await remoteHarness(t, true)
  h.internals.context.createBuffer = (channels, frames, rate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(frames))
    return { sampleRate: rate, numberOfChannels: channels, length: frames, duration: frames / rate,
      getChannelData: (channel: number) => data[channel] } as AudioBuffer
  }
  const local = { ...h.track, path: '/music/complete.flac', sourceType: 'local' as const, duration: 40, channels: 2 }
  const pcm = Float32Array.from({ length: 40_000 * 2 }, (_, index) => index)
  await h.engine.preBufferNextPcm({ channels: 2, frames: 40_000, sampleRate: 1000,
    interleavedPcm: pcm.buffer, pcmByteLength: pcm.byteLength }, { trackPath: local.path })
  const fullBuffer = h.engine.getNextAudioBuffer()!
  assert.equal(h.engine.stageNextLocalBuffer(local), true)
  const staged = h.workletMessages.filter(message => message.type === 'stage-next').at(-1)!.sessionId!
  assert.ok(staged < 0)
  assert.equal(h.engine.getNextAudioBuffer(), null)
  assert.equal((await h.engine.getBufferMemoryStats()).nextBytes, 40_000 * 2 * 4)
  assert.equal(h.requests.length, 1, 'no local progressive decoder is opened')
  if (discard) {
    h.engine.clearNextBuffer()
    assert.equal(h.engine.hasNextBuffered, false)
    assert.equal((await h.engine.getBufferMemoryStats()).nextBytes, 0)
    assert.deepEqual(h.cancelledSessions, [])
    return
  }
  const events: unknown[] = []
  h.engine.on('gaplessTransition', () => events.push('handoff'))
  h.engine.on('bufferReady', buffer => events.push(buffer))
  h.internals.promoteRemoteStream(1, staged)
  assert.deepEqual(events, ['handoff', fullBuffer], 'full waveform is supplied after queue identity changes')
  assert.equal(h.engine.getAudioBuffer(), fullBuffer)
  assert.equal(h.engine.getRemoteStreamSessionId(), null)
  assert.equal(h.engine.getRemoteBufferedSeconds(), 0)
  assert.deepEqual(h.activatedSessions, [])
  const next = h.engine.preBufferNextRemoteTrack(h.track, null)
  await flush(); h.complete(1); await next
  const decoderCount = h.requests.length
  await h.engine.seek(35)
  assert.equal(h.requests.length, decoderCount, 'seeking beyond PCM lookahead uses the retained local buffer')
  assert.equal(h.engine.currentTime, 35)
  assert.equal(h.engine.hasNextBuffered, true)
  assert.equal(h.engine.getAudioBuffer(), fullBuffer)
  assert.ok(h.cancelledSessions.every(id => id > 0))
  let analyses = 0
  window.electronAPI.analyzeTrackLoudness = async () => {
    analyses++; return { loudnessLufs: -20, peakLinear: 0.5, method: 'ffmpeg-ebur128' }
  }
  h.engine.normalizationEnabled = true
  await flush()
  assert.equal(analyses, 1, 'enabling normalization retains ordinary local loudness analysis')
  const analysis = (h.engine as unknown as { currentNormalizationAnalysis: { frameCount: number } }).currentNormalizationAnalysis
  assert.equal(analysis.frameCount, fullBuffer.length)
})
}

test('production worklet and renderer promotion cross remote to complete local without repeating a sample', async t => {
  const h = await remoteHarness(t, true, 'jellyfin', true)
  h.internals.context.createBuffer = (channels, frames, rate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(frames))
    return { sampleRate: rate, numberOfChannels: channels, length: frames, duration: frames / rate,
      getChannelData: (channel: number) => data[channel] } as AudioBuffer
  }
  const node = h.internals.remoteStreamNode! as AudioWorkletNode & { render: (frames: number) => Float32Array[] }
  node.port.postMessage({ type: 'reset-current' })
  node.port.postMessage({ type: 'set-session', sessionId: 1 })
  node.port.postMessage({ type: 'append-chunk', sessionId: 1, frameCount: 1000,
    channelData: [Float32Array.from({ length: 1000 }, (_, i) => i + 1), Float32Array.from({ length: 1000 }, (_, i) => -i - 1)] })
  node.port.postMessage({ type: 'set-playing', playing: true })
  h.internals.handleRemoteStreamEvent({ type: 'complete', sessionId: 1, sourceType: 'jellyfin', path: h.track.path,
    decodedFrames: 1000, decodedSeconds: 1 })
  const local = { ...h.track, path: '/music/complete.flac', sourceType: 'local' as const, duration: 2, channels: 2 }
  const pcm = Float32Array.from({ length: 4000 }, (_, i) => (1001 + Math.floor(i / 2)) * (i % 2 ? -1 : 1))
  await h.engine.preBufferNextPcm({ channels: 2, frames: 2000, sampleRate: 1000,
    interleavedPcm: pcm.buffer, pcmByteLength: pcm.byteLength }, { trackPath: local.path })
  assert.equal(h.engine.stageNextLocalBuffer(local), true)
  const left: number[] = []
  const right: number[] = []
  while (left.length < 3000) {
    const output = node.render(Math.min(257, 3000 - left.length))
    left.push(...output[0]); right.push(...output[1])
    await flush() // Deliver real worklet messages through the engine's promotion handler.
  }
  assert.deepEqual(left, Array.from({ length: 3000 }, (_, i) => i + 1))
  assert.deepEqual(right, Array.from({ length: 3000 }, (_, i) => -i - 1))
  assert.equal(h.requests.length, 1)
})

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

for (const sourceType of ['subsonic', 'jellyfin'] as const) {
  for (const nextProvider of ['subsonic', 'jellyfin'] as const) {
    test(`${sourceType} to ${nextProvider}: preparation stays separate until the audio-thread handoff`, async (t) => {
      const h = await remoteHarness(t, true, sourceType)
      const nextTrack = { ...h.track, path: `${nextProvider}://7/next`, sourceType: nextProvider }
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

  }
}

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

for (const sourceType of ['subsonic', 'jellyfin'] as const) {
  for (const playing of [false, true]) {
    test(`${sourceType}: seeking near EOF retains the ready successor and ${playing ? 'playing' : 'paused'} intent`, async (t) => {
      const h = await remoteHarness(t, playing, sourceType)
      const node = h.internals.remoteStreamNode
      const nextTrack = { ...h.track, path: `${sourceType}://7/next` }
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
