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

function loadRemoteStreamProcessor(): WorkletProcessorConstructor {
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
