import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const WORKLET_URL = new URL('../public/adaptive-upmix-worklet.js', import.meta.url)

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('Adaptive worklet initializes roles, renders interleaved WASM, and applies overrides', async () => {
  const messages: Array<Record<string, unknown>> = []
  const memory = new WebAssembly.Memory({ initial: 2 })
  const rolesPointer = 256
  const inputPointer = 1024
  const outputPointer = 4096
  let resetCount = 0
  const wasmExports = {
    memory,
    _initialize: () => undefined,
    adaptive_roles_ptr: () => rolesPointer,
    adaptive_input_ptr: () => inputPointer,
    adaptive_output_ptr: () => outputPointer,
    adaptive_init: () => 2,
    adaptive_fft_size: () => 2048,
    adaptive_reset: () => { resetCount += 1 },
    adaptive_process: (frames: number) => {
      const heap = new Float32Array(memory.buffer)
      const inputBase = inputPointer / 4
      const outputBase = outputPointer / 4
      for (let frame = 0; frame < frames; frame++) {
        const left = heap[inputBase + frame * 2]
        const right = heap[inputBase + frame * 2 + 1]
        heap[outputBase + frame * 4] = left * 2
        heap[outputBase + frame * 4 + 1] = right * 2
        heap[outputBase + frame * 4 + 2] = left - right
        heap[outputBase + frame * 4 + 3] = right - left
      }
      return 1
    },
  }
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    }
  }
  let Processor: (new (options: Record<string, unknown>) => FakeAudioWorkletProcessor) | null = null
  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name: string, implementation: new (options: Record<string, unknown>) => FakeAudioWorkletProcessor) => {
      Processor = implementation
    },
    WebAssembly: { instantiate: async () => ({ instance: { exports: wasmExports } }) },
    ArrayBuffer,
    Float32Array,
    Int32Array,
    Number,
    Math,
    String,
    sampleRate: 48000,
  })
  vm.runInContext(readFileSync(WORKLET_URL, 'utf8'), context)
  assert.ok(Processor)
  const ProcessorClass = Processor as unknown as new (options: Record<string, unknown>) => FakeAudioWorkletProcessor & {
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
  }
  const processor = new ProcessorClass({
    processorOptions: { roles: ['FL', 'FR', 'SL', 'SR'], overrides: [-1, -1, 0, -2] },
  })
  processor.port.onmessage!({ data: { type: 'init', wasmBytes: new ArrayBuffer(1) } })
  await nextTurn()
  assert.equal(messages.at(-1)?.type, 'ready')
  assert.deepEqual(
    [...new Int32Array(memory.buffer, rolesPointer, 4)],
    [1, 2, 5, 6],
  )

  const left = new Float32Array([1, 2, 3, 4])
  const right = new Float32Array([5, 6, 7, 8])
  const output = Array.from({ length: 4 }, () => new Float32Array(4))
  assert.equal(processor.process([[left, right]], [output]), true)
  assert.deepEqual([...output[0]], [2, 4, 6, 8])
  assert.deepEqual([...output[1]], [10, 12, 14, 16])
  assert.deepEqual([...output[2]], [0, 0, 1, 2]) // raw L delayed by two frames.
  assert.deepEqual([...output[3]], [0, 0, 0, 0])

  processor.port.onmessage!({ data: { type: 'reset' } })
  assert.equal(resetCount, 1)
})
