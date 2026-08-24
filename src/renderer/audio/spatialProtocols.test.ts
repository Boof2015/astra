import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const WORKER_URL = new URL('../public/spatial-hrtf-worker.js', import.meta.url)
const WORKLET_URL = new URL('../public/spatial-worklet.js', import.meta.url)

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('HRTF worker coalesces queued speaker drags to the latest generation', async () => {
  const messages: Array<Record<string, unknown>> = []
  const scheduled: Array<() => void> = []
  let bakeCount = 0
  const memory = new WebAssembly.Memory({ initial: 2 })
  const wasmExports = {
    memory,
    _initialize: () => undefined,
    malloc: (_bytes: number) => 4096,
    free: (_pointer: number) => undefined,
    hrtf_prep_init_builtin: () => 128,
    hrtf_prep_init_sofa: () => 128,
    hrtf_prep_bake: () => { bakeCount++; return 1 },
    hrtf_prep_filter_ptr: (ear: number) => ear === 0 ? 8192 : 12288,
    hrtf_prep_last_error: () => 0,
    hrtf_prep_fft_size: () => 16,
    hrtf_prep_fft_bins: () => 9,
    hrtf_prep_filter_len: () => 8,
  }
  const workerSelf: Record<string, unknown> = {
    postMessage: (message: Record<string, unknown>) => messages.push(message),
  }
  const context = vm.createContext({
    self: workerSelf,
    WebAssembly: { instantiate: async () => ({ instance: { exports: wasmExports } }) },
    ArrayBuffer,
    Uint8Array,
    Float32Array,
    Number,
    Math,
    String,
    setTimeout: (callback: () => void) => { scheduled.push(callback); return scheduled.length },
  })
  vm.runInContext(readFileSync(WORKER_URL, 'utf8'), context)
  const onmessage = workerSelf.onmessage as (event: { data: Record<string, unknown> }) => void
  onmessage({
    data: {
      type: 'load',
      requestId: 1,
      wasmBytes: new ArrayBuffer(1),
      profileKind: 'builtin',
      sampleRate: 48000,
      speakers: [{ azimuthRad: 0, elevationRad: 0 }],
    },
  })
  await nextTurn()
  assert.equal(messages[0]?.type, 'prepared')
  const loadBakeCount = bakeCount

  for (const generation of [10, 11, 12]) {
    onmessage({
      data: {
        type: 'set-speakers',
        generation,
        speakers: [{ azimuthRad: generation / 100, elevationRad: 0 }],
      },
    })
  }
  assert.equal(scheduled.length, 1)
  scheduled.shift()!()
  assert.equal(bakeCount, loadBakeCount + 1)
  const updates = messages.filter((message) => message.type === 'speaker-filters')
  assert.deepEqual(updates.map((message) => message.generation), [12])
})

test('worklet accepts pre-baked spectra and commits later filter updates', async () => {
  const messages: Array<Record<string, unknown>> = []
  const memory = new WebAssembly.Memory({ initial: 2 })
  const initCalls: number[][] = []
  let commits = 0
  const wasmExports = {
    memory,
    _initialize: () => undefined,
    spatial_init_prebaked: (...args: number[]) => { initCalls.push(args); return args[2] },
    spatial_input_ptr: (channel: number) => channel < 2 ? 256 + channel * 1024 : 0,
    spatial_output_ptr: (ear: number) => 4096 + ear * 1024,
    spatial_speaker_filter_ptr: (_index: number, ear: number) => 8192 + ear * 4096,
    spatial_commit_speaker_filter: () => { commits++; return 1 },
    spatial_clear_speaker: () => undefined,
    spatial_reset: () => undefined,
    spatial_process: () => 1,
  }
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    }
  }
  let Processor: (new () => FakeAudioWorkletProcessor) | null = null
  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name: string, implementation: new () => FakeAudioWorkletProcessor) => { Processor = implementation },
    WebAssembly: { instantiate: async () => ({ instance: { exports: wasmExports } }) },
    ArrayBuffer,
    Float32Array,
    Number,
    Math,
    String,
    sampleRate: 48000,
    console,
  })
  vm.runInContext(readFileSync(WORKLET_URL, 'utf8'), context)
  assert.ok(Processor)
  const ProcessorClass = Processor as unknown as new () => FakeAudioWorkletProcessor
  const processor = new ProcessorClass()
  const bins = 9
  const filters = [{
    index: 0,
    gain: 1,
    isLfe: false,
    left: new Float32Array(bins * 2).fill(0.25),
    right: new Float32Array(bins * 2).fill(0.5),
  }]
  processor.port.onmessage!({
    data: {
      type: 'init-prebaked',
      wasmBytes: new ArrayBuffer(1),
      config: { taps: 512, fftSize: 16, filterLen: 8 },
      filters,
    },
  })
  await nextTurn()

  assert.deepEqual(initCalls, [[48000, 128, 512, 16, 8]])
  assert.equal(commits, 1)
  assert.equal(messages.at(-1)?.type, 'ready')
  assert.equal(messages.at(-1)?.taps, 512)
  const heap = new Float32Array(memory.buffer)
  assert.deepEqual([...heap.slice(8192 / 4, 8192 / 4 + bins * 2)], [...filters[0].left])
  assert.deepEqual([...heap.slice(12288 / 4, 12288 / 4 + bins * 2)], [...filters[0].right])

  const updated = [{
    ...filters[0],
    left: new Float32Array(bins * 2).fill(0.75),
    right: new Float32Array(bins * 2).fill(1),
  }]
  processor.port.onmessage!({ data: { type: 'set-speaker-filters', filters: updated } })
  assert.equal(commits, 2)
  assert.deepEqual([...heap.slice(8192 / 4, 8192 / 4 + bins * 2)], [...updated[0].left])
})
