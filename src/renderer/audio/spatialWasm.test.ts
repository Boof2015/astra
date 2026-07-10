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
  // nothing, not ring forever or blow up. The windowed filters span up to
  // fftSize - blockSize samples, plus one block of limiter look-ahead —
  // 16 blocks of drain is a safe bound for every supported sample rate.
  energyOverBlocks(exports, 1, (block, n) => (block === 0 ? tone(0, n) : 0), 1)
  const decayed = energyOverBlocks(exports, 1, () => 0, 16)
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

test('bass survives the crossover and the response stays roughly flat', () => {
  // Guards the diffuse-field EQ + bass crossover: raw MIT KEMAR filters lose
  // most bass and carry a ~2.6 kHz ear-canal resonance; corrected filters
  // must render a single speaker within a modest window across the band.
  const exports = instantiate()

  const toneGainDb = (freqHz: number): number => {
    exports.spatial_init(44100, BLOCK)
    exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0)
    let energyIn = 0
    let energyOut = 0
    for (let block = 0; block < 40; block++) {
      const samples = new Float32Array(BLOCK)
      for (let n = 0; n < BLOCK; n++) {
        const v = Math.sin((2 * Math.PI * freqHz * (block * BLOCK + n)) / 44100)
        samples[n] = v
        energyIn += v * v
      }
      writeInput(exports, 0, samples)
      exports.spatial_process(1, BLOCK)
      for (const ear of [0, 1]) {
        for (const v of readOutput(exports, ear)) energyOut += v * v
      }
    }
    return 10 * Math.log10(energyOut / energyIn)
  }

  const gains = [60, 250, 1000, 2600, 5000].map(toneGainDb)
  for (const [i, gain] of gains.entries()) {
    assert.ok(gain > -9 && gain < 5, `tone ${i} gain out of window: ${gain.toFixed(2)} dB`)
  }
  const spread = Math.max(...gains) - Math.min(...gains)
  assert.ok(spread < 10, `response spread too wide: ${spread.toFixed(2)} dB`)
})

test('a front-center source renders near unity loudness', () => {
  const exports = instantiate()
  assert.ok(exports.spatial_init(44100, BLOCK) > 0)
  exports.spatial_set_speaker(0, 0, 0, 1, 0)

  let seed = 1234
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x3fffffff - 1
  }
  let energyIn = 0
  let energyLeft = 0
  let energyRight = 0
  for (let block = 0; block < 80; block++) {
    const samples = new Float32Array(BLOCK)
    for (let n = 0; n < BLOCK; n++) {
      const v = rand() * 0.5
      samples[n] = v
      energyIn += v * v
    }
    writeInput(exports, 0, samples)
    exports.spatial_process(1, BLOCK)
    for (const v of readOutput(exports, 0)) energyLeft += v * v
    for (const v of readOutput(exports, 1)) energyRight += v * v
  }
  const leftDb = 10 * Math.log10(energyLeft / energyIn)
  const rightDb = 10 * Math.log10(energyRight / energyIn)
  // Roughly direct-playback loudness minus the -3 dB headroom.
  assert.ok(leftDb > -8 && leftDb < 0, `left ear gain out of window: ${leftDb.toFixed(2)} dB`)
  assert.ok(rightDb > -8 && rightDb < 0, `right ear gain out of window: ${rightDb.toFixed(2)} dB`)
  assert.ok(Math.abs(leftDb - rightDb) < 1, 'front-center must stay centered')
})

test('coherent multichannel bass never exceeds full scale (safety limiter)', () => {
  // Correlated bass across 5 speakers + LFE sums to several times the
  // per-channel amplitude at each ear; without the limiter this hard-clips
  // downstream and reads as static riding on bass peaks.
  const exports = instantiate()
  assert.ok(exports.spatial_init(44100, BLOCK) > 0)
  const layout: Array<[number, number]> = [[-30, 0], [30, 0], [0, 0], [0, 1], [-110, 0], [110, 0]]
  layout.forEach(([deg, isLfe], channel) => {
    exports.spatial_set_speaker(channel, uiDegToRad(deg), 0, 1, isLfe)
  })

  let peak = 0
  let t = 0
  for (let block = 0; block < 120; block++) {
    const samples = new Float32Array(BLOCK)
    for (let n = 0; n < BLOCK; n++) {
      samples[n] = 0.6 * Math.sin((2 * Math.PI * 50 * t) / 44100)
      t++
    }
    for (let ch = 0; ch < layout.length; ch++) writeInput(exports, ch, samples)
    exports.spatial_process(layout.length, BLOCK)
    for (const ear of [0, 1]) {
      for (const v of readOutput(exports, ear)) peak = Math.max(peak, Math.abs(v))
    }
  }
  assert.ok(peak <= 1.0 + 1e-6, `limited output must stay within full scale (peak=${peak})`)
  assert.ok(peak > 0.8, `limiter should ride near the ceiling, not crush (peak=${peak})`)

  // After silence the limiter must release back to (near) unity.
  const silent = new Float32Array(BLOCK)
  for (let block = 0; block < 300; block++) {
    for (let ch = 0; ch < layout.length; ch++) writeInput(exports, ch, silent)
    exports.spatial_process(layout.length, BLOCK)
  }
  let energyIn = 0
  let energyOut = 0
  t = 0
  for (let block = 0; block < 40; block++) {
    const samples = new Float32Array(BLOCK)
    for (let n = 0; n < BLOCK; n++) {
      const v = 0.1 * Math.sin((2 * Math.PI * 500 * t) / 44100)
      samples[n] = v
      energyIn += v * v
      t++
    }
    writeInput(exports, 0, samples)
    for (let ch = 1; ch < layout.length; ch++) writeInput(exports, ch, silent)
    exports.spatial_process(layout.length, BLOCK)
    for (const ear of [0, 1]) {
      for (const v of readOutput(exports, ear)) energyOut += v * v
    }
  }
  const gainDb = 10 * Math.log10(energyOut / energyIn)
  assert.ok(gainDb > -4, `limiter must release after the loud passage (gain=${gainDb.toFixed(2)} dB)`)
})

test('the limiter stays clean while engaged (no distortion products)', () => {
  // Regression: the first limiter implementation modulated its gain with
  // per-block kinks, which read as static over the whole mix. While heavily
  // limiting a steady tone, everything that is not the tone must stay far
  // below it.
  const exports = instantiate()
  assert.ok(exports.spatial_init(44100, BLOCK) > 0)
  const layout: Array<[number, number]> = [[-30, 0], [30, 0], [0, 0], [0, 1], [-110, 0], [110, 0]]
  layout.forEach(([deg, isLfe], channel) => {
    exports.spatial_set_speaker(channel, uiDegToRad(deg), 0, 1, isLfe)
  })

  const settleBlocks = 30
  const captureBlocks = 80
  const captured = new Float32Array(captureBlocks * BLOCK)
  let t = 0
  let idx = 0
  for (let block = 0; block < settleBlocks + captureBlocks; block++) {
    const samples = new Float32Array(BLOCK)
    for (let n = 0; n < BLOCK; n++) {
      samples[n] = 0.6 * Math.sin((2 * Math.PI * 60 * t) / 44100)
      t++
    }
    for (let ch = 0; ch < layout.length; ch++) writeInput(exports, ch, samples)
    exports.spatial_process(layout.length, BLOCK)
    if (block >= settleBlocks) {
      for (const v of readOutput(exports, 0)) captured[idx++] = v
    }
  }

  const goertzelPower = (freqHz: number): number => {
    let re = 0
    let im = 0
    const total = captured.length
    for (let n = 0; n < total; n++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (total - 1))
      const phase = (2 * Math.PI * freqHz * n) / 44100
      re += captured[n] * window * Math.cos(phase)
      im -= captured[n] * window * Math.sin(phase)
    }
    return re * re + im * im
  }

  const tonePower = goertzelPower(60)
  assert.ok(tonePower > 0)
  for (const probeHz of [180, 344.5, 689, 1500, 3000, 6000]) {
    const junkDb = 10 * Math.log10(goertzelPower(probeHz) / tonePower)
    assert.ok(junkDb < -40, `limiter distortion at ${probeHz} Hz too high: ${junkDb.toFixed(1)} dB`)
  }
})

test('the renderer is shift-invariant (impulse position must not matter)', () => {
  // Regression for the broadband-static bug: when the baked filters exceed
  // the overlap-add budget (zero-phase EQ/crossover ring), the response
  // becomes dependent on where a sample lands inside the render quantum —
  // heard as block-rate static over the whole mix (-26 dB before the fix).
  // A linear time-invariant renderer answers an impulse identically at any
  // in-block offset, just shifted.
  const exports = instantiate()

  const impulseResponse = (offset: number): Float32Array => {
    exports.spatial_init(44100, BLOCK)
    exports.spatial_set_speaker(0, uiDegToRad(-30), 0, 1, 0)
    const blocks = 16
    const out = new Float32Array(blocks * BLOCK)
    let idx = 0
    for (let block = 0; block < blocks; block++) {
      const samples = new Float32Array(BLOCK)
      if (block === 0) samples[offset] = 1
      writeInput(exports, 0, samples)
      exports.spatial_process(1, BLOCK)
      for (const v of readOutput(exports, 0)) out[idx++] = v
    }
    return out
  }

  const reference = impulseResponse(0)
  for (const offset of [37, 64, 127]) {
    const shifted = impulseResponse(offset)
    let errorEnergy = 0
    let referenceEnergy = 0
    for (let n = 0; n < reference.length - offset; n++) {
      const diff = reference[n] - shifted[n + offset]
      errorEnergy += diff * diff
      referenceEnergy += reference[n] * reference[n]
    }
    const errorDb = 10 * Math.log10(errorEnergy / referenceEnergy)
    assert.ok(errorDb < -80, `response depends on in-block position (offset ${offset}: ${errorDb.toFixed(1)} dB)`)
  }
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
