import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const WASM_URL = new URL('../public/adaptive-upmixer.wasm', import.meta.url)
const BLOCK = 128
const CHANNELS = 6

interface AdaptiveExports {
  memory: WebAssembly.Memory
  _initialize: () => void
  adaptive_roles_ptr: () => number
  adaptive_input_ptr: () => number
  adaptive_output_ptr: () => number
  adaptive_init: (sampleRate: number, channels: number, algorithm: number) => number
  adaptive_process: (frames: number) => number
  adaptive_reset: () => void
  adaptive_latency_frames: () => number
  adaptive_fft_size: () => number
}

function instantiate(sampleRate = 48000, algorithm = 0): AdaptiveExports {
  const stub = () => 0
  const module = new WebAssembly.Module(readFileSync(WASM_URL))
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: { proc_exit: stub, fd_close: stub, fd_write: stub, fd_seek: stub },
  })
  const exports = instance.exports as unknown as AdaptiveExports
  exports._initialize()
  new Int32Array(exports.memory.buffer, exports.adaptive_roles_ptr(), CHANNELS)
    .set([1, 2, 3, 4, 5, 6])
  assert.equal(exports.adaptive_init(sampleRate, CHANNELS, algorithm), sampleRate > 50000 ? 4096 : 2048)
  return exports
}

function fixture(frames: number): Float32Array {
  const input = new Float32Array(frames * 2)
  let seed = 0x71a29c3d
  for (let frame = 0; frame < frames; frame++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const diffuseLeft = ((seed >>> 8) / 0x1000000 - 0.5) * 0.16
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const diffuseRight = ((seed >>> 8) / 0x1000000 - 0.5) * 0.16
    const center = Math.sin(2 * Math.PI * 733 * frame / 48000) * 0.18
    const transient = frame % 4096 === 0 ? 0.7 : 0
    input[frame * 2] = center + diffuseLeft + transient
    input[frame * 2 + 1] = center + diffuseRight
  }
  return input
}

function renderWasm(input: Float32Array, algorithm = 0): Float32Array {
  const exports = instantiate(48000, algorithm)
  const heap = new Float32Array(exports.memory.buffer)
  const inputPointer = exports.adaptive_input_ptr() / 4
  const outputPointer = exports.adaptive_output_ptr() / 4
  const output = new Float32Array((input.length / 2) * CHANNELS)
  for (let frame = 0; frame < input.length / 2; frame += BLOCK) {
    heap.set(input.subarray(frame * 2, (frame + BLOCK) * 2), inputPointer)
    assert.equal(exports.adaptive_process(BLOCK), 1)
    output.set(heap.subarray(outputPointer, outputPointer + BLOCK * CHANNELS), frame * CHANNELS)
  }
  return output
}

test('committed Adaptive WASM exposes the production transform and silent LFE', () => {
  const exports = instantiate()
  assert.equal(exports.adaptive_fft_size(), 2048)
  assert.equal(exports.adaptive_latency_frames(), 2048)
  const input = fixture(64 * BLOCK)
  const output = renderWasm(input)
  for (let frame = 0; frame < input.length / 2; frame++) {
    assert.equal(output[frame * CHANNELS + 3], 0)
    for (let channel = 0; channel < CHANNELS; channel++) {
      assert.ok(Number.isFinite(output[frame * CHANNELS + channel]))
    }
  }
})

test('native and committed WASM Adaptive processors remain numerically comparable', (t) => {
  if (process.platform === 'win32') {
    t.skip('native parity helper uses the POSIX C++ command line')
    return
  }
  const repository = resolve(new URL('../../..', import.meta.url).pathname)
  const executable = join(tmpdir(), `astra-adaptive-parity-${process.arch}`)
  const compile = spawnSync(process.env.CXX || 'c++', [
    '-std=c++17', '-O3', '-fno-fast-math',
    join(repository, 'native/src/dsp_utils.cpp'),
    join(repository, 'native/src/adaptive_upmixer.cpp'),
    join(repository, 'native/test/adaptive_upmixer_parity.cpp'),
    '-I', join(repository, 'native/src'),
    '-o', executable,
  ], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)

  const input = fixture(96 * BLOCK)
  for (const algorithm of [1, 2, 0]) {
    const native = spawnSync(executable, [String(algorithm)], {
      input: Buffer.from(input.buffer, input.byteOffset, input.byteLength),
      maxBuffer: 64 * 1024 * 1024,
    })
    assert.equal(native.status, 0, native.stderr.toString())
    const nativeBytes = native.stdout.buffer.slice(
      native.stdout.byteOffset,
      native.stdout.byteOffset + native.stdout.byteLength,
    )
    const nativeOutput = new Float32Array(nativeBytes)
    const wasmOutput = renderWasm(input, algorithm)
    assert.equal(nativeOutput.length, wasmOutput.length)
    let maximumError = 0
    let maximumErrorIndex = 0
    const maximumErrorByChannel = Array.from({ length: CHANNELS }, () => 0)
    let errorEnergy = 0
    let signalEnergy = 0
    for (let index = 0; index < wasmOutput.length; index++) {
      const error = nativeOutput[index] - wasmOutput[index]
      const absoluteError = Math.abs(error)
      if (absoluteError > maximumError) {
        maximumError = absoluteError
        maximumErrorIndex = index
      }
      maximumErrorByChannel[index % CHANNELS] = Math.max(
        maximumErrorByChannel[index % CHANNELS],
        absoluteError,
      )
      errorEnergy += error * error
      signalEnergy += nativeOutput[index] * nativeOutput[index]
    }
    const errorDb = 10 * Math.log10(errorEnergy / signalEnergy + 1e-30)
    assert.ok(maximumError < 2e-5,
      `algorithm ${algorithm} maximum native/WASM error ${maximumError} at sample ` +
      `${maximumErrorIndex}; by channel ${maximumErrorByChannel.join(', ')}; ` +
      `native/wasm ${nativeOutput[maximumErrorIndex]}/${wasmOutput[maximumErrorIndex]}; ` +
      `previous frame ${nativeOutput[maximumErrorIndex - CHANNELS]}/` +
      `${wasmOutput[maximumErrorIndex - CHANNELS]}, next frame ` +
      `${nativeOutput[maximumErrorIndex + CHANNELS]}/${wasmOutput[maximumErrorIndex + CHANNELS]}`)
    assert.ok(errorDb < -90, `algorithm ${algorithm} native/WASM error ${errorDb.toFixed(2)} dB`)
  }
})

test('Adaptive WASM stays inside AudioWorklet render-quantum timing at 48-96 kHz', () => {
  for (const sampleRate of [48000, 96000]) {
    const exports = instantiate(sampleRate)
    const heap = new Float32Array(exports.memory.buffer)
    const inputPointer = exports.adaptive_input_ptr() / 4
    const input = new Float32Array(BLOCK * 2)
    for (let frame = 0; frame < BLOCK; frame++) {
      input[frame * 2] = Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.2
      input[frame * 2 + 1] = Math.sin(2 * Math.PI * 733 * frame / sampleRate) * 0.2
    }
    for (let block = 0; block < 64; block++) {
      heap.set(input, inputPointer)
      exports.adaptive_process(BLOCK)
    }

    const timings: number[] = []
    for (let block = 0; block < 512; block++) {
      heap.set(input, inputPointer)
      const start = performance.now()
      exports.adaptive_process(BLOCK)
      timings.push(performance.now() - start)
    }
    timings.sort((left, right) => left - right)
    const average = timings.reduce((sum, value) => sum + value, 0) / timings.length
    const p99 = timings[Math.floor(timings.length * 0.99)]
    const deadlineMs = BLOCK / sampleRate * 1000
    assert.ok(average < deadlineMs * 0.25,
      `${sampleRate} Hz average ${average.toFixed(3)} ms exceeds 4x headroom`)
    assert.ok(p99 < deadlineMs,
      `${sampleRate} Hz p99 ${p99.toFixed(3)} ms exceeds ${deadlineMs.toFixed(3)} ms quantum`)
  }
})
