import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine } from './AudioEngine.ts'

type Internals = {
  context: AudioContext
  _playbackState: 'playing' | 'paused' | 'stopped'
  audioBuffer: AudioBuffer | null
  nextBuffer: AudioBuffer | null
  sourceNode: AudioBufferSourceNode | null
  nextSourceNode: AudioBufferSourceNode | null
  startTime: number
  pauseTime: number
  currentBufferTrackPath: string
  nextBufferTrackPath: string
  remoteStreamNode: AudioWorkletNode | null
  remoteStreamState: { channels: number; sampleRate: number; startFrame: number; currentFrame: number; durationSeconds: number; playRequested: boolean } | null
  parallaxSinkNode: AudioWorkletNode | null
  parallaxSinkState: { channels: number; sampleRate: number; currentFrame: number; durationSeconds: number } | null
  initContext: () => Promise<void>
  applyChannelRoutingPreferences: () => void
  connectSourceWithRouting: (node: AudioNode, channels: number) => void
  connectSourceToAnalysisTap: () => void
  disconnectSourceRouting: () => void
  scheduleGaplessTransition: () => void
}

function source() {
  return {
    buffer: null as AudioBuffer | null,
    onended: null,
    stopped: false,
    starts: [] as number[],
    start(_when: number, offset: number) { this.starts.push(offset) },
    stop() { this.stopped = true },
    disconnect() {},
  }
}

function setup(state: Internals['_playbackState']) {
  const engine = new AudioEngine()
  const internals = engine as unknown as Internals
  const context = {
    currentTime: 50,
    state: 'running' as AudioContextState,
    sinkId: 'a',
    resumes: 0,
    failSwitch: false,
    sources: [] as ReturnType<typeof source>[],
    async setSinkId(id: string) {
      if (this.failSwitch) throw new Error('Endpoint unavailable')
      this.sinkId = id
    },
    async resume() { this.resumes += 1; this.state = 'running' },
    createBufferSource() {
      const node = source()
      this.sources.push(node)
      return node
    },
  }
  const metrics = { graphUpdates: 0, gaplessSchedules: 0, connections: [] as Array<[AudioNode, number]> }
  internals.context = context as unknown as AudioContext
  internals._playbackState = state
  internals.startTime = 20
  internals.pauseTime = 30
  internals.audioBuffer = { duration: 180, numberOfChannels: 2 } as AudioBuffer
  internals.nextBuffer = { duration: 240, numberOfChannels: 2 } as AudioBuffer
  internals.currentBufferTrackPath = '/current.flac'
  internals.nextBufferTrackPath = '/next.flac'
  internals.initContext = async () => undefined
  internals.applyChannelRoutingPreferences = () => { metrics.graphUpdates += 1 }
  internals.connectSourceWithRouting = (node, channels) => { metrics.connections.push([node, channels]) }
  internals.connectSourceToAnalysisTap = () => undefined
  internals.disconnectSourceRouting = () => undefined
  internals.scheduleGaplessTransition = () => { metrics.gaplessSchedules += 1 }
  return { engine, internals, context, metrics }
}

test('output switching retains the context, current position and gapless buffers during playback', async () => {
  const { engine, internals, context, metrics } = setup('playing')
  const currentBuffer = internals.audioBuffer
  const nextBuffer = internals.nextBuffer
  const oldSource = source()
  const oldNextSource = source()
  internals.sourceNode = oldSource as unknown as AudioBufferSourceNode
  internals.nextSourceNode = oldNextSource as unknown as AudioBufferSourceNode
  await engine.setOutputDevice('b')
  assert.equal(internals.context, context)
  assert.equal(context.sinkId, 'b')
  assert.equal(internals._playbackState, 'playing')
  assert.equal(engine.currentTime, 30)
  assert.equal(internals.audioBuffer, currentBuffer)
  assert.equal(internals.nextBuffer, nextBuffer)
  assert.equal(internals.currentBufferTrackPath, '/current.flac')
  assert.equal(internals.nextBufferTrackPath, '/next.flac')
  assert.deepEqual(context.sources[0].starts, [30])
  assert.equal(oldSource.stopped, true)
  assert.equal(oldNextSource.stopped, true)
  assert.equal(metrics.gaplessSchedules, 1)
})

test('switching a paused or stopped output does not start sources or resume the context', async () => {
  for (const state of ['paused', 'stopped'] as const) {
    const { engine, internals, context, metrics } = setup(state)
    context.state = 'suspended'
    await engine.setOutputDevice('b')
    assert.equal(internals._playbackState, state)
    assert.equal(internals.pauseTime, 30)
    assert.equal(context.resumes, 0)
    assert.equal(context.sources.length, 0)
    assert.equal(metrics.gaplessSchedules, 0)
  }
})

test('a successful route switch resumes a suspended context only when playback intends to play', async () => {
  const { engine, internals, context } = setup('playing')
  context.state = 'suspended'
  await engine.setOutputDevice('b')
  assert.equal(context.resumes, 1)
  assert.equal(internals._playbackState, 'playing')
  assert.equal(engine.currentTime, 30)
})

test('progressive playback reconnects the same stream without seeking or discarding decoded frames', async () => {
  const { engine, internals, context, metrics } = setup('playing')
  internals.audioBuffer = null
  const node = {} as AudioWorkletNode
  const stream = { channels: 6, sampleRate: 48000, startFrame: 0, currentFrame: 480000, durationSeconds: 180, playRequested: true }
  internals.remoteStreamNode = node
  internals.remoteStreamState = stream
  await engine.setOutputDevice('b')
  assert.equal(internals.remoteStreamNode, node)
  assert.equal(internals.remoteStreamState, stream)
  assert.equal(stream.currentFrame, 480000)
  assert.equal(stream.playRequested, true)
  assert.equal(context.sources.length, 0)
  assert.deepEqual(metrics.connections, [[node, 6]])
})

test('Parallax output reconnects the existing sink without resetting its timeline', async () => {
  const { engine, internals, metrics } = setup('playing')
  internals.audioBuffer = null
  const node = {} as AudioWorkletNode
  const stream = { channels: 2, sampleRate: 48000, currentFrame: 960000, durationSeconds: 180 }
  internals.parallaxSinkNode = node
  internals.parallaxSinkState = stream
  await engine.setOutputDevice('b')
  assert.equal(internals.parallaxSinkState, stream)
  assert.equal(engine.currentTime, 20)
  assert.deepEqual(metrics.connections, [[node, 2]])
})

test('a rejected sink switch leaves transport and graph untouched for retry', async () => {
  const { engine, internals, context, metrics } = setup('playing')
  context.failSwitch = true
  await assert.rejects(engine.setOutputDevice('b'), /Endpoint unavailable/)
  assert.equal(context.sinkId, 'a')
  assert.equal(internals._playbackState, 'playing')
  assert.equal(engine.currentTime, 30)
  assert.equal(metrics.graphUpdates, 0)
  assert.equal(context.sources.length, 0)
})
