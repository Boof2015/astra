import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const PREP_WASM_URL = new URL('../public/spatial-hrtf-prep.wasm', import.meta.url)
const RENDER_WASM_URL = new URL('../public/spatial-renderer.wasm', import.meta.url)
const SOFA_FIXTURE_URL = new URL('../../../third_party/libmysofa/share/MIT_KEMAR_normal_pinna.sofa', import.meta.url)
const BLOCK = 128

interface PrepExports {
  memory: WebAssembly.Memory
  _initialize: () => void
  malloc: (bytes: number) => number
  free: (pointer: number) => void
  hrtf_prep_init_builtin: (sampleRate: number, blockSize: number) => number
  hrtf_prep_init_sofa: (sampleRate: number, blockSize: number, pointer: number, byteLength: number) => number
  hrtf_prep_bake: (azimuthRad: number, elevationRad: number) => number
  hrtf_prep_filter_ptr: (ear: number) => number
  hrtf_prep_last_error: () => number
  hrtf_prep_taps: () => number
  hrtf_prep_fft_size: () => number
  hrtf_prep_fft_bins: () => number
  hrtf_prep_filter_len: () => number
  hrtf_prep_reset: () => void
}

interface RendererExports {
  memory: WebAssembly.Memory
  _initialize: () => void
  spatial_init_prebaked: (sampleRate: number, blockSize: number, taps: number, fftSize: number, filterLen: number) => number
  spatial_speaker_filter_ptr: (index: number, ear: number) => number
  spatial_commit_speaker_filter: (index: number, gain: number, isLfe: number) => number
  spatial_input_ptr: (channel: number) => number
  spatial_output_ptr: (ear: number) => number
  spatial_process: (numChannels: number, frames: number) => number
}

interface PreparedConfig {
  taps: number
  fftSize: number
  fftBins: number
  filterLen: number
}

function instantiatePrep(): PrepExports {
  const stub = () => 0
  const module = new WebAssembly.Module(readFileSync(PREP_WASM_URL))
  const instance = new WebAssembly.Instance(module, {
    env: { emscripten_notify_memory_growth: stub },
    wasi_snapshot_preview1: { proc_exit: stub, fd_close: stub, fd_write: stub, fd_read: stub, fd_seek: stub },
  })
  const exports = instance.exports as unknown as PrepExports
  exports._initialize()
  return exports
}

function instantiateRenderer(): RendererExports {
  const stub = () => 0
  const module = new WebAssembly.Module(readFileSync(RENDER_WASM_URL))
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: { proc_exit: stub, fd_close: stub, fd_write: stub, fd_seek: stub },
  })
  const exports = instance.exports as unknown as RendererExports
  exports._initialize()
  return exports
}

function initializeSofa(
  prep: PrepExports,
  sampleRate: number,
  bytes: Uint8Array = readFileSync(SOFA_FIXTURE_URL)
): number {
  const pointer = prep.malloc(bytes.byteLength)
  assert.ok(pointer, 'SOFA allocation should succeed')
  new Uint8Array(prep.memory.buffer).set(bytes, pointer)
  const taps = prep.hrtf_prep_init_sofa(sampleRate, BLOCK, pointer, bytes.byteLength)
  prep.free(pointer)
  return taps
}

function preparedConfig(prep: PrepExports): PreparedConfig {
  return {
    taps: prep.hrtf_prep_taps(),
    fftSize: prep.hrtf_prep_fft_size(),
    fftBins: prep.hrtf_prep_fft_bins(),
    filterLen: prep.hrtf_prep_filter_len(),
  }
}

function bakePair(prep: PrepExports, azimuthRad: number, elevationRad: number): [Float32Array, Float32Array] {
  assert.equal(prep.hrtf_prep_bake(azimuthRad, elevationRad), 1)
  const floatsPerEar = prep.hrtf_prep_fft_bins() * 2
  const heap = new Float32Array(prep.memory.buffer)
  const left = heap.slice(prep.hrtf_prep_filter_ptr(0) / 4, prep.hrtf_prep_filter_ptr(0) / 4 + floatsPerEar)
  const right = heap.slice(prep.hrtf_prep_filter_ptr(1) / 4, prep.hrtf_prep_filter_ptr(1) / 4 + floatsPerEar)
  return [left, right]
}

function spectrumPower(filter: Float32Array): number {
  let power = 0
  for (let index = 0; index < filter.length; index++) power += filter[index] * filter[index]
  return power
}

function commitPair(renderer: RendererExports, pair: [Float32Array, Float32Array]): void {
  const heap = new Float32Array(renderer.memory.buffer)
  for (let ear = 0; ear < 2; ear++) {
    const pointer = renderer.spatial_speaker_filter_ptr(0, ear)
    assert.ok(pointer)
    heap.set(pair[ear], pointer / 4)
  }
  assert.equal(renderer.spatial_commit_speaker_filter(0, 1, 0), 1)
}

function renderTone(renderer: RendererExports, blocks: number): { left: number; right: number; peak: number } {
  const heap = new Float32Array(renderer.memory.buffer)
  const input = renderer.spatial_input_ptr(0) / 4
  const outputL = renderer.spatial_output_ptr(0) / 4
  const outputR = renderer.spatial_output_ptr(1) / 4
  let left = 0
  let right = 0
  let peak = 0
  for (let block = 0; block < blocks; block++) {
    for (let frame = 0; frame < BLOCK; frame++) {
      heap[input + frame] = Math.sin((2 * Math.PI * 440 * (block * BLOCK + frame)) / 48000)
    }
    assert.equal(renderer.spatial_process(1, BLOCK), 1)
    for (let frame = 0; frame < BLOCK; frame++) {
      const sampleL = heap[outputL + frame]
      const sampleR = heap[outputR + frame]
      assert.ok(Number.isFinite(sampleL) && Number.isFinite(sampleR))
      left += sampleL * sampleL
      right += sampleR * sampleR
      peak = Math.max(peak, Math.abs(sampleL), Math.abs(sampleR))
    }
  }
  return { left, right, peak }
}

test('committed prep WASM loads built-in KEMAR and bakes stable spectra', () => {
  const prep = instantiatePrep()
  assert.ok(prep.hrtf_prep_init_builtin(48000, BLOCK) > 0)
  const config = preparedConfig(prep)
  assert.ok(config.taps > 0 && config.taps <= 8192)
  assert.equal(config.fftBins, config.fftSize / 2 + 1)
  const [left, right] = bakePair(prep, 0, 0)
  assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite))
  assert.ok(spectrumPower(left) > 0 && spectrumPower(right) > 0)
})

test('licensed SOFA fixture loads and resamples to device rates', () => {
  const prep = instantiatePrep()
  const tapCounts = new Set<number>()
  for (const sampleRate of [44100, 48000, 96000, 192000]) {
    const taps = initializeSofa(prep, sampleRate)
    assert.ok(taps > 0 && taps <= 8192, `SOFA should load at ${sampleRate} Hz (error ${prep.hrtf_prep_last_error()})`)
    tapCounts.add(taps)
    const [left, right] = bakePair(prep, Math.PI / 6, Math.PI / 6)
    assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite))
  }
  assert.ok(tapCounts.size > 1, 'resampling should change effective HRIR length')
})

test('SOFA direction and elevation produce distinct filter lookups', () => {
  const prep = instantiatePrep()
  assert.ok(initializeSofa(prep, 48000) > 0)
  const leftward = bakePair(prep, Math.PI / 3, 0)
  const rightward = bakePair(prep, -Math.PI / 3, 0)
  const elevated = bakePair(prep, 0, Math.PI / 4)

  assert.ok(spectrumPower(leftward[0]) > spectrumPower(leftward[1]) * 1.05)
  assert.ok(spectrumPower(rightward[1]) > spectrumPower(rightward[0]) * 1.05)
  let elevationDifference = 0
  for (let index = 0; index < elevated[0].length; index++) {
    elevationDifference += Math.abs(elevated[0][index] - leftward[0][index])
  }
  assert.ok(elevationDifference > 1, 'elevation must select a different response')
})

test('prepared SOFA spectra run through the realtime-only artifact and update safely', () => {
  const prep = instantiatePrep()
  assert.ok(initializeSofa(prep, 48000) > 0)
  const config = preparedConfig(prep)
  const first = bakePair(prep, Math.PI / 6, 0)
  const renderer = instantiateRenderer()
  assert.equal(renderer.spatial_init_prebaked(48000, BLOCK, config.taps, config.fftSize, config.filterLen), config.taps)
  commitPair(renderer, first)
  const before = renderTone(renderer, 20)
  assert.ok(before.left > before.right * 1.05)
  assert.ok(before.peak > 0 && before.peak <= 1)

  const second = bakePair(prep, -Math.PI / 6, 0)
  commitPair(renderer, second)
  const duringFade = renderTone(renderer, 8)
  assert.ok(duringFade.left > 0 && duringFade.right > 0)
  assert.ok(duringFade.peak <= 1)
})

test('invalid and truncated SOFA data fails cleanly and built-in recovery still works', () => {
  const prep = instantiatePrep()
  assert.equal(initializeSofa(prep, 48000, new Uint8Array([1, 2, 3, 4])), 0)
  assert.equal(prep.hrtf_prep_last_error(), 2)

  const fixture = readFileSync(SOFA_FIXTURE_URL)
  assert.equal(initializeSofa(prep, 48000, fixture.subarray(0, 1024)), 0)
  assert.equal(prep.hrtf_prep_last_error(), 2)

  assert.ok(prep.hrtf_prep_init_builtin(48000, BLOCK) > 0)
  const recovered = bakePair(prep, 0, 0)
  assert.ok(spectrumPower(recovered[0]) > 0)
})

test('realtime artifact rejects spectra whose effective HRIR exceeds 8,192 taps', () => {
  const renderer = instantiateRenderer()
  assert.equal(renderer.spatial_init_prebaked(48000, BLOCK, 8193, 16384, 16256), 0)
  assert.ok(renderer.spatial_init_prebaked(48000, BLOCK, 8192, 16384, 16256) > 0)
})
