import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// Exercises the committed spatial-renderer.wasm artifact directly (the same
// bytes the spatial worklet loads), so these tests fail if the artifact and
// the wrapper source drift apart.

const WASM_URL = new URL('../public/spatial-renderer.wasm', import.meta.url)
const BLOCK = 128

interface SpatialExports {
  memory: WebAssembly.Memory
  _initialize: () => void
  spatial_init: (sampleRate: number, blockSize: number) => number
  spatial_set_speaker: (
    index: number,
    azimuthRad: number,
    elevationRad: number,
    gain: number,
    isLfe: number
  ) => number
  spatial_clear_speaker: (index: number) => void
  spatial_input_ptr: (channel: number) => number
  spatial_output_ptr: (ear: number) => number
  spatial_process: (numChannels: number, frames: number) => number
  spatial_reset: () => void
  spatial_tail_taps: () => number
}

function instantiate(): SpatialExports {
  const bytes = readFileSync(WASM_URL)
  const stub = () => 0
  const module = new WebAssembly.Module(bytes)
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: { proc_exit: stub, fd_close: stub, fd_write: stub, fd_seek: stub },
  })
  const exports = instance.exports as unknown as SpatialExports
  exports._initialize()
  return exports
}

function heapF32(exports: SpatialExports): Float32Array {
  return new Float32Array(exports.memory.buffer)
}

// Mirrors uiDegreesToAmbisonicRadians: UI degrees are clockwise-from-front,
// libspatialaudio azimuth radians are positive-counterclockwise (left).
function uiDegToRad(deg: number): number {
  return (-deg * Math.PI) / 180
}

function writeInput(exports: SpatialExports, channel: number, samples: Float32Array): void {
  heapF32(exports).set(samples, exports.spatial_input_ptr(channel) / 4)
}

function readOutput(exports: SpatialExports, ear: number): Float32Array {
  const base = exports.spatial_output_ptr(ear) / 4
  return heapF32(exports).slice(base, base + BLOCK)
}

function energyOverBlocks(
  exports: SpatialExports,
  numChannels: number,
  fill: (block: number, n: number, channel: number) => number,
  blocks: number
): { left: number; right: number } {
  let left = 0
  let right = 0
  for (let block = 0; block < blocks; block++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const samples = new Float32Array(BLOCK)
      for (let n = 0; n < BLOCK; n++) samples[n] = fill(block, n, ch)
      writeInput(exports, ch, samples)
    }
    assert.equal(exports.spatial_process(numChannels, BLOCK), 1)
    const outL = readOutput(exports, 0)
    const outR = readOutput(exports, 1)
    for (let n = 0; n < BLOCK; n++) {
      left += outL[n] * outL[n]
      right += outR[n] * outR[n]
    }
  }
  return { left, right }
}

const tone = (block: number, n: number) => Math.sin((2 * Math.PI * 440 * (block * BLOCK + n)) / 48000)

test('spatial_init succeeds at MIT HRTF sample rates and fails elsewhere', () => {
  const exports = instantiate()
  for (const rate of [44100, 48000, 88200, 96000]) {
    const taps = exports.spatial_init(rate, BLOCK)
    assert.ok(taps > 0, `expected taps > 0 at ${rate} Hz`)
    assert.equal(exports.spatial_tail_taps(), taps)
  }
  for (const rate of [22050, 176400, 192000]) {
    assert.equal(exports.spatial_init(rate, BLOCK), 0, `expected failure at ${rate} Hz`)
  }
  // A failed init must not brick the instance.
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)
})

test('a speaker on the left produces more left-ear energy, mirrored on the right', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)

  assert.equal(exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0), 1)
  const leftSpeaker = energyOverBlocks(exports, 1, tone, 24)
  assert.ok(
    leftSpeaker.left > leftSpeaker.right * 1.2,
    `left speaker should favor left ear (L=${leftSpeaker.left}, R=${leftSpeaker.right})`
  )

  exports.spatial_init(48000, BLOCK)
  assert.equal(exports.spatial_set_speaker(0, uiDegToRad(30), 0, 1, 0), 1)
  const rightSpeaker = energyOverBlocks(exports, 1, tone, 24)
  assert.ok(
    rightSpeaker.right > rightSpeaker.left * 1.2,
    `right speaker should favor right ear (L=${rightSpeaker.left}, R=${rightSpeaker.right})`
  )

  // Symmetric positions should produce (approximately) mirrored energies.
  const mirrorRatio = leftSpeaker.left / rightSpeaker.right
  assert.ok(mirrorRatio > 0.9 && mirrorRatio < 1.1, `mirror ratio out of range: ${mirrorRatio}`)
})

test('LFE bypasses the HRTF and lands equally in both ears', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)
  assert.equal(exports.spatial_set_speaker(0, 0, 0, 1, 1), 1)
  const { left, right } = energyOverBlocks(exports, 1, (block, n) => tone(block, n), 8)
  assert.ok(left > 0, 'LFE should produce output')
  const ratio = left / right
  assert.ok(ratio > 0.999 && ratio < 1.001, `LFE ears should match exactly (ratio=${ratio})`)
})

test('silence in produces silence out, and tails decay after signal stops', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)
  exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0)

  const silent = energyOverBlocks(exports, 1, () => 0, 4)
  assert.equal(silent.left, 0)
  assert.equal(silent.right, 0)

  // One block of signal, then silence: the convolution tail must decay to
  // nothing (140 taps ≈ 2 blocks at 48 kHz), not ring forever or blow up.
  energyOverBlocks(exports, 1, (block, n) => (block === 0 ? tone(0, n) : 0), 1)
  const decayed = energyOverBlocks(exports, 1, () => 0, 6)
  const lastBlocks = energyOverBlocks(exports, 1, () => 0, 2)
  assert.ok(decayed.left + decayed.right > 0, 'tail should carry some energy right after the signal')
  assert.equal(lastBlocks.left + lastBlocks.right, 0, 'tail should fully decay')
})

test('moving a speaker fades without producing NaN or instability', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)
  exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0)
  energyOverBlocks(exports, 1, tone, 4)

  let maxAbs = 0
  for (let step = 0; step < 36; step++) {
    // Sweep the speaker from -30° around the back to +150° in 5° steps while
    // audio plays, as a drag in the Virtual Speaker Room would.
    exports.spatial_set_speaker(0, uiDegToRad(-30 - step * 5), 0, 1, 0)
    const samples = new Float32Array(BLOCK)
    for (let n = 0; n < BLOCK; n++) samples[n] = tone(step, n)
    writeInput(exports, 0, samples)
    assert.equal(exports.spatial_process(1, BLOCK), 1)
    for (const ear of [0, 1]) {
      for (const v of readOutput(exports, ear)) {
        assert.ok(Number.isFinite(v), 'output must stay finite during drags')
        maxAbs = Math.max(maxAbs, Math.abs(v))
      }
    }
  }
  assert.ok(maxAbs > 0, 'sweep should produce audible output')
  assert.ok(maxAbs < 1.5, `sweep should not blow up (peak=${maxAbs})`)
})

test('spatial_reset clears pending convolution tails', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(48000, BLOCK) > 0)
  exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0)
  energyOverBlocks(exports, 1, tone, 2)
  exports.spatial_reset()
  const after = energyOverBlocks(exports, 1, () => 0, 4)
  assert.equal(after.left + after.right, 0)
})
