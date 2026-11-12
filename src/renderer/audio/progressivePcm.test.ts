import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  LOCAL_PROGRESSIVE_PLANAR_MIN_FRAMES,
  deinterleaveProgressivePcm,
  shouldUsePlanarLocalProgressiveChunk,
} from './progressivePcm.ts'

test('progressive PCM deinterleaving preserves channel order and zero-fills short input', () => {
  const result = deinterleaveProgressivePcm(
    Float32Array.from([1, 10, 2, 20, 3]),
    2,
    3,
  )

  assert.deepEqual(Array.from(result[0]), [1, 2, 3])
  assert.deepEqual(Array.from(result[1]), [10, 20, 0])
  assert.equal(shouldUsePlanarLocalProgressiveChunk(LOCAL_PROGRESSIVE_PLANAR_MIN_FRAMES - 1), false)
  assert.equal(shouldUsePlanarLocalProgressiveChunk(LOCAL_PROGRESSIVE_PLANAR_MIN_FRAMES), true)
})

type WorkletPort = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: unknown) => void
}

type WorkletProcessorInstance = {
  port: WorkletPort
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
  chunks?: unknown[]
  currentFrame?: number
  totalFrames?: number
}

type WorkletProcessorConstructor = new (options: {
  outputChannelCount: number[]
  processorOptions?: { discardConsumedChunks?: boolean }
}) => WorkletProcessorInstance

function loadRemoteStreamProcessor(clock = { frame: 0 }): WorkletProcessorConstructor {
  const processors = new Map<string, WorkletProcessorConstructor>()
  class TestAudioWorkletProcessor {
    port: WorkletPort = {
      onmessage: null,
      postMessage: () => undefined,
    }
  }

  const source = readFileSync(new URL('../public/oscilloscope-worklet.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    AudioWorkletProcessor: TestAudioWorkletProcessor,
    registerProcessor: (name: string, processor: WorkletProcessorConstructor) => processors.set(name, processor),
    Float32Array,
    Array,
    Boolean,
    Math,
    Number,
    Object,
    sampleRate: 48_000,
    get currentFrame() { return clock.frame },
  })

  const processor = processors.get('remote-stream-player')
  assert.ok(processor)
  return processor
}

function renderWorkletChunk(payload: Record<string, unknown>): number[][] {
  const RemoteStreamProcessor = loadRemoteStreamProcessor()
  const processor = new RemoteStreamProcessor({ outputChannelCount: [3] })
  assert.ok(processor.port.onmessage)
  processor.port.onmessage({ data: { type: 'append-chunk', frameCount: 4, ...payload } })
  processor.port.onmessage({ data: { type: 'set-playing', playing: true } })

  const output = [
    new Float32Array(4),
    new Float32Array(4),
    new Float32Array(4),
  ]
  assert.equal(processor.process([], [output]), true)
  return output.map((channel) => Array.from(channel))
}

test('a local buffer can join the worklet on an exact audio-clock frame and continue into remote PCM', () => {
  const clock = { frame: 0 }
  const Processor = loadRemoteStreamProcessor(clock)
  const processor = new Processor({ outputChannelCount: [1] })
  const send = (data: unknown) => processor.port.onmessage!({ data })
  send({ type: 'set-session', sessionId: -1 })
  send({ type: 'append-chunk', sessionId: -1, frameCount: 4, channelData: [Float32Array.of(5, 6, 7, 8)] })
  send({ type: 'set-source-ended', sessionId: -1, ended: true })
  send({ type: 'stage-next', sessionId: 2 })
  send({ type: 'append-chunk', sessionId: 2, frameCount: 4, channelData: [Float32Array.of(9, 10, 11, 12)] })
  send({ type: 'set-next-ready', sessionId: 2, ready: true })
  send({ type: 'set-playing', playing: true, contextFrame: 4 })
  const before = new Float32Array(2)
  processor.process([], [[before]])
  assert.deepEqual([...before], [0, 0])
  assert.equal(processor.currentFrame, 0, 'waiting for the clock must not consume source samples')
  clock.frame = 2
  const joined = new Float32Array(10)
  processor.process([], [[joined]])
  // The BufferSource supplies the prefix through the same stop frame.
  joined[0] += 3
  joined[1] += 4
  assert.deepEqual([...joined], [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})

test('pausing a scheduled worklet start cancels its clock wait without consuming PCM', () => {
  const clock = { frame: 0 }
  const Processor = loadRemoteStreamProcessor(clock)
  const processor = new Processor({ outputChannelCount: [1] })
  const send = (data: unknown) => processor.port.onmessage!({ data })
  send({ type: 'append-chunk', frameCount: 2, channelData: [Float32Array.of(1, 2)] })
  send({ type: 'set-playing', playing: true, contextFrame: 100 })
  send({ type: 'set-playing', playing: false })
  clock.frame = 120
  processor.process([], [[new Float32Array(2)]])
  assert.equal(processor.currentFrame, 0)
  send({ type: 'set-playing', playing: true })
  const output = new Float32Array(2)
  processor.process([], [[output]])
  assert.deepEqual([...output], [1, 2])
})

test('starvation holds the musical position, resumes queued PCM, and never means EOF', () => {
  const Processor = loadRemoteStreamProcessor()
  const processor = new Processor({ outputChannelCount: [1], processorOptions: { discardConsumedChunks: true } })
  const events: Array<{ type: string; buffering?: boolean }> = []
  processor.port.postMessage = event => events.push(event as { type: string; buffering?: boolean })
  const send = (data: unknown) => processor.port.onmessage!({ data })
  send({ type: 'append-chunk', frameCount: 4, channelData: [Float32Array.of(1, 2, 3, 4)] })
  send({ type: 'set-playing', playing: true })
  processor.process([], [[new Float32Array(8)]])
  assert.equal(processor.currentFrame, 4)
  assert.equal(processor.chunks?.length, 0, 'consumed PCM is released')
  const count = events.length
  for (let index = 0; index < 100; index++) processor.process([], [[new Float32Array(128)]])
  assert.equal(processor.currentFrame, 4, 'silence must not advance the track')
  assert.equal(events.length, count, 'starvation should not flood IPC')
  assert.ok(!events.some(event => event.type === 'ended'))
  send({ type: 'set-playing', playing: false })
  send({ type: 'append-chunk', frameCount: 4, channelData: [Float32Array.of(5, 6, 7, 8)] })
  processor.process([], [[new Float32Array(4)]])
  assert.equal(processor.currentFrame, 4, 'new audio must not override pause')
  send({ type: 'set-playing', playing: true })
  const resumed = new Float32Array(4)
  processor.process([], [[resumed]])
  assert.deepEqual([...resumed], [5, 6, 7, 8])
  send({ type: 'set-source-ended', ended: true })
  assert.equal(events.filter(event => event.type === 'ended').length, 1)
})

test('remote stream worklet renders planar and legacy interleaved chunks identically', () => {
  const interleaved = Float32Array.from([
    1, 10,
    2, 20,
    3, 30,
    4, 40,
  ])
  const planar = deinterleaveProgressivePcm(interleaved, 2, 4)

  const legacyOutput = renderWorkletChunk({
    channelCount: 2,
    interleavedData: interleaved,
  })
  const planarOutput = renderWorkletChunk({ channelData: planar })

  assert.deepEqual(planarOutput, legacyOutput)
  assert.deepEqual(planarOutput, [
    [1, 2, 3, 4],
    [10, 20, 30, 40],
    [1, 2, 3, 4],
  ])
})

function createGaplessHarness() {
  const Processor = loadRemoteStreamProcessor()
  const processor = new Processor({ outputChannelCount: [1], processorOptions: { discardConsumedChunks: true } })
  const events: Array<{ type: string; sessionId?: number }> = []
  processor.port.postMessage = (event) => events.push(event as (typeof events)[number])
  const send = (data: unknown) => processor.port.onmessage!({ data })
  const append = (sessionId: number, samples: number[]) => send({ type: 'append-chunk', sessionId,
    frameCount: samples.length, channelData: [Float32Array.from(samples)] })
  const render = (frames: number) => {
    const output = new Float32Array(frames)
    processor.process([], [[output]])
    return [...output]
  }
  send({ type: 'set-session', sessionId: 1 })
  return { processor, events, send, append, render }
}

for (const boundary of [3, 128, 251]) {
  test(`prepared PCM crosses the exact ${boundary}-frame boundary without missing/duplicating samples`, () => {
    const h = createGaplessHarness()
    const samples = Array.from({ length: boundary + 256 }, (_, index) => index + 1)
    h.append(1, samples.slice(0, boundary))
    h.send({ type: 'stage-next', sessionId: 2 })
    h.append(2, samples.slice(boundary))
    h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
    h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
    h.send({ type: 'set-source-ended', sessionId: 2, ended: true })
    h.send({ type: 'set-playing', playing: true })
    const output: number[] = []
    while (output.length < samples.length) output.push(...h.render(Math.min(128, samples.length - output.length)))
    assert.deepEqual(output, samples)
    assert.equal(h.events.filter((event) => event.type === 'gapless-transition').length, 1)
    assert.deepEqual(h.events.filter((event) => event.type === 'ended').map((event) => event.sessionId), [2])
    assert.equal(h.processor.chunks?.length, 0)
    assert.equal(h.processor.currentFrame, 256)
  })
}

test('prepared track gain takes effect at its first sample without a renderer round trip', () => {
  const h = createGaplessHarness()
  h.append(1, [2, 4, 6])
  h.send({ type: 'set-gain', sessionId: 1, gain: 0.5 })
  h.send({ type: 'stage-next', sessionId: 2 })
  h.append(2, [4, 5, 6])
  h.send({ type: 'set-gain', sessionId: 2, gain: 2 })
  h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
  h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(6), [1, 2, 3, 8, 10, 12])
  h.send({ type: 'set-gain', sessionId: 1, gain: 100 })
  h.append(2, [7])
  assert.deepEqual(h.render(1), [14], 'stale gain changes must not affect the promoted stream')
})

test('a ready successor cannot turn starvation or pause into a track boundary', () => {
  const h = createGaplessHarness()
  h.append(1, [1, 2])
  h.send({ type: 'stage-next', sessionId: 2 })
  h.append(2, [5, 6])
  h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(4), [1, 2, 0, 0])
  assert.equal(h.processor.currentFrame, 2)
  assert.equal(h.events.some((event) => event.type === 'gapless-transition'), false)
  h.send({ type: 'set-playing', playing: false })
  h.append(1, [3, 4])
  h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
  assert.deepEqual(h.render(4), [0, 0, 0, 0])
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(4), [3, 4, 5, 6])
})

test('cleared or replaced preparation cannot leak late PCM into the next track', () => {
  const h = createGaplessHarness()
  h.append(1, [1, 2])
  h.send({ type: 'stage-next', sessionId: 2 })
  h.append(2, [90, 91])
  h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
  h.send({ type: 'clear-next', sessionId: 2 })
  h.send({ type: 'stage-next', sessionId: 3 })
  h.append(2, [92, 93])
  h.send({ type: 'set-source-ended', sessionId: 2, ended: true })
  h.append(3, [3, 4])
  h.send({ type: 'set-next-ready', sessionId: 3, ready: true })
  h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(4), [1, 2, 3, 4])
  assert.deepEqual(h.events.filter((event) => event.type === 'gapless-transition').map((event) => event.sessionId), [3])
})

for (const readyBeforeSeek of [false, true]) {
  test(`replacing current PCM keeps ${readyBeforeSeek ? 'ready' : 'pending'} next PCM gapless at a near-end seek`, () => {
    const h = createGaplessHarness()
    h.append(1, [90, 91, 92])
    h.send({ type: 'stage-next', sessionId: 2 })
    h.append(2, [6, 8])
    h.send({ type: 'set-gain', sessionId: 2, gain: 0.5 })
    if (readyBeforeSeek) h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
    h.send({ type: 'set-playing', playing: true })
    assert.deepEqual(h.render(1), [90])
    h.send({ type: 'reset-current', nextSessionId: 2 })
    h.append(1, [93, 94])
    h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
    h.send({ type: 'set-session', sessionId: 3 })
    h.append(3, [99])
    // Further drag movement replaces only the current stream again.
    h.send({ type: 'reset-current', nextSessionId: 2 })
    h.send({ type: 'set-session', sessionId: 4 })
    h.append(3, [100])
    h.append(4, [1, 2])
    h.append(2, [10, 12])
    h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
    h.send({ type: 'set-source-ended', sessionId: 4, ended: true })
    h.send({ type: 'set-source-ended', sessionId: 2, ended: true })
    assert.deepEqual(h.render(6), [0, 0, 0, 0, 0, 0], 'reset cannot resume a paused seek')
    h.send({ type: 'set-playing', playing: true })
    assert.deepEqual(h.render(6), [1, 2, 3, 4, 5, 6], 'the two-frame tail joins the original successor without silence')
    assert.equal(h.events.some(event => event.type === 'next-invalidated'), false)
    assert.deepEqual(h.events.filter(event => event.type === 'gapless-transition').map(event => event.sessionId), [2])
  })
}

test('a current reset reports when the audio thread has already consumed the successor', () => {
  const h = createGaplessHarness()
  h.append(1, [1, 2])
  h.send({ type: 'stage-next', sessionId: 2 })
  h.append(2, [3, 4, 5])
  h.send({ type: 'set-next-ready', sessionId: 2, ready: true })
  h.send({ type: 'set-source-ended', sessionId: 1, ended: true })
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(3), [1, 2, 3])
  h.send({ type: 'reset-current', nextSessionId: 2 })
  assert.deepEqual(h.events.filter(event => event.type === 'next-invalidated').map(event => event.sessionId), [2])
  h.send({ type: 'set-session', sessionId: 3 })
  h.append(2, [6, 7])
  h.append(3, [10, 11])
  h.send({ type: 'set-playing', playing: true })
  assert.deepEqual(h.render(4), [10, 11, 0, 0], 'the consumed successor cannot reappear mid-track')
})

test('local progressive worklet releases PCM chunks after rendering them', () => {
  const RemoteStreamProcessor = loadRemoteStreamProcessor()
  const processor = new RemoteStreamProcessor({
    outputChannelCount: [2],
    processorOptions: { discardConsumedChunks: true },
  })
  assert.ok(processor.port.onmessage)

  processor.port.onmessage({
    data: {
      type: 'append-chunk',
      frameCount: 4,
      channelData: [
        Float32Array.from([1, 2, 3, 4]),
        Float32Array.from([10, 20, 30, 40]),
      ],
    },
  })
  processor.port.onmessage({ data: { type: 'set-playing', playing: true } })

  const firstOutput = [new Float32Array(4), new Float32Array(4)]
  assert.equal(processor.process([], [firstOutput]), true)
  assert.deepEqual(firstOutput.map((channel) => Array.from(channel)), [
    [1, 2, 3, 4],
    [10, 20, 30, 40],
  ])
  assert.equal(processor.currentFrame, 4)
  assert.equal(processor.totalFrames, 4)
  assert.equal(processor.chunks?.length, 0)

  processor.port.onmessage({
    data: {
      type: 'append-chunk',
      frameCount: 4,
      channelData: [
        Float32Array.from([5, 6, 7, 8]),
        Float32Array.from([50, 60, 70, 80]),
      ],
    },
  })
  const secondOutput = [new Float32Array(4), new Float32Array(4)]
  assert.equal(processor.process([], [secondOutput]), true)
  assert.deepEqual(secondOutput.map((channel) => Array.from(channel)), [
    [5, 6, 7, 8],
    [50, 60, 70, 80],
  ])
  assert.equal(processor.currentFrame, 8)
  assert.equal(processor.totalFrames, 8)
  assert.equal(processor.chunks?.length, 0)
})
