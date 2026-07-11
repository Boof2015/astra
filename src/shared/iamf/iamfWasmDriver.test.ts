import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeIamfObuStream,
  instantiateIamfDecoder,
  type IamfWasmExports,
} from './iamfWasmDriver.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const WASM_PATH = join(import.meta.dirname, '../../renderer/public/iamf-decoder.wasm')

interface ReferenceWav {
  channels: number
  sampleRate: number
  frames: number
  /** Interleaved samples normalized to [-1, 1). */
  samples: Float32Array
}

function readReferenceWav(path: string): ReferenceWav {
  const bytes = readFileSync(path)
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF')
  assert.equal(bytes.toString('latin1', 8, 12), 'WAVE')
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let samples: Float32Array | null = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4)
      bits = bytes.readUInt16LE(body + 14)
    } else if (id === 'data') {
      assert.equal(bits, 16, 'reference renders are 16-bit PCM')
      const count = Math.floor(size / 2)
      samples = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        samples[i] = bytes.readInt16LE(body + i * 2) / 32768
      }
    }
    offset = body + size + (size & 1)
  }
  assert.ok(samples && channels > 0 && sampleRate > 0)
  return { channels, sampleRate, frames: samples.length / channels, samples }
}

function rms(data: Float32Array): number {
  let sum = 0
  for (const v of data) sum += v * v
  return Math.sqrt(sum / Math.max(1, data.length))
}

function rmsDiffAgainstReference(
  decoded: Float32Array,
  reference: ReferenceWav,
  referenceChannel: number,
  frames: number
): number {
  let sum = 0
  for (let i = 0; i < frames; i++) {
    const d = decoded[i] - reference.samples[i * reference.channels + referenceChannel]
    sum += d * d
  }
  return Math.sqrt(sum / Math.max(1, frames))
}

let wasmPromise: Promise<IamfWasmExports> | null = null
function loadWasm(): Promise<IamfWasmExports> {
  wasmPromise ??= instantiateIamfDecoder(readFileSync(WASM_PATH))
  return wasmPromise
}

test('decodes the stereo Opus vector and matches the reference render', async () => {
  const wasm = await loadWasm()
  const vector = new Uint8Array(readFileSync(join(FIXTURES, 'test_000020.iamf')))
  const progress: number[] = []
  const result = await decodeIamfObuStream(wasm, vector, {
    onProgress: (frames) => progress.push(frames),
  })

  assert.equal(result.sampleRate, 48000)
  assert.equal(result.channels, 12)
  assert.equal(result.channelData.length, 12)
  assert.ok(result.loudnessLufs !== null && result.loudnessLufs < -10, 'loudness metadata present')

  const reference = readReferenceWav(
    join(FIXTURES, 'test_000020_rendered_id_42_sub_mix_0_layout_0.wav')
  )
  assert.equal(reference.channels, 2)
  assert.equal(result.frames, reference.frames)

  // Stereo content renders to L/R; the reference stereo render must match
  // closely (same reference decoder produced it).
  for (const channel of [0, 1]) {
    const signal = rms(result.channelData[channel])
    assert.ok(signal > 0.001, `channel ${channel} carries signal`)
    const diff = rmsDiffAgainstReference(result.channelData[channel], reference, channel, result.frames)
    assert.ok(
      diff < signal * 0.05,
      `channel ${channel} diverges from reference render (diff ${diff}, signal ${signal})`
    )
  }
  // All other 7.1.4 speakers stay silent for a stereo source.
  for (let channel = 2; channel < 12; channel++) {
    assert.ok(rms(result.channelData[channel]) < 1e-5, `channel ${channel} must be silent`)
  }
})

test('decode is repeatable on the same wasm instance', async () => {
  const wasm = await loadWasm()
  const vector = new Uint8Array(readFileSync(join(FIXTURES, 'test_000020.iamf')))
  const first = await decodeIamfObuStream(wasm, vector)
  const second = await decodeIamfObuStream(wasm, vector)
  assert.equal(first.frames, second.frames)
  assert.deepEqual(Array.from(first.channelData[0].slice(0, 32)), Array.from(second.channelData[0].slice(0, 32)))
})

test('rejects garbage input with a decode error', async () => {
  const wasm = await loadWasm()
  await assert.rejects(
    () => decodeIamfObuStream(wasm, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    /IAMF/
  )
})

// Deep per-channel 7.1.4 compare against libiamf's SOUND_SYSTEM_J reference
// render. Needs the full libiamf tests/ directory (26 MB render), so it only
// runs when IAMF_VECTORS_DIR points at one; the committed stereo vector
// covers the pipeline in CI.
test('7.1.4 vector matches the layout_3 reference per channel', { skip: !process.env.IAMF_VECTORS_DIR }, async () => {
  const dir = process.env.IAMF_VECTORS_DIR as string
  const vectorPath = join(dir, 'test_000050.iamf')
  const renderName = readdirSync(dir).find(
    (name) => name.startsWith('test_000050_rendered') && name.endsWith('_layout_3.wav')
  )
  assert.ok(existsSync(vectorPath) && renderName, 'test_000050 vector + layout_3 render present')

  const wasm = await loadWasm()
  const result = await decodeIamfObuStream(wasm, new Uint8Array(readFileSync(vectorPath)))
  const reference = readReferenceWav(join(dir, renderName as string))
  assert.equal(reference.channels, 12)
  assert.equal(result.frames, reference.frames)

  // The reference WAV is in libiamf's BS.2051-J order; our output is Astra
  // order — the mapping below mirrors IAMF_INDEX_FOR_ASTRA_CHANNEL. The
  // renders come from iamf-tools' reference renderer, and test_000050 is a
  // scalable stream whose surrounds/heights are demixed with recon gain
  // (implementation latitude), so sample-exact equality is not achievable —
  // the assertion is CHANNEL IDENTITY: each decoded channel must correlate
  // best, and strongly, with exactly its mapped reference channel. That is
  // what proves the SL/SR<->BL/BR swap.
  const referenceIndexForAstraChannel = [0, 1, 2, 3, 6, 7, 4, 5, 8, 9, 10, 11]
  const stride = 7 // sample sparsely; correlation over ~150k points is plenty
  for (let channel = 0; channel < 12; channel++) {
    const decoded = result.channelData[channel]
    let bestReference = -1
    let bestCorrelation = -1
    const correlations: number[] = []
    for (let rc = 0; rc < 12; rc++) {
      let dot = 0
      let dd = 0
      let rr = 0
      for (let i = 0; i < result.frames; i += stride) {
        const d = decoded[i]
        const r = reference.samples[i * reference.channels + rc]
        dot += d * r
        dd += d * d
        rr += r * r
      }
      const correlation = dot / Math.sqrt((dd || 1e-30) * (rr || 1e-30))
      correlations.push(correlation)
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestReference = rc
      }
    }
    assert.equal(
      bestReference,
      referenceIndexForAstraChannel[channel],
      `channel ${channel} correlates with the wrong reference channel (${JSON.stringify(correlations.map((c) => c.toFixed(2)))})`
    )
    assert.ok(bestCorrelation > 0.8, `channel ${channel} correlation too weak (${bestCorrelation})`)
  }
})
