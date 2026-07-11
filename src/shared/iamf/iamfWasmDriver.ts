// Environment-agnostic driver for iamf-decoder.wasm (built by
// scripts/build/build-iamf-wasm.sh from libiamf v1.1.0 — see the contract in
// native/iamf-wasm/iamf_wrapper.c). Runs in the renderer decode worker and in
// node tests; no DOM or node APIs.
//
// Output is Astra's STANDARD_LAYOUTS[12] channel order. libiamf emits
// BS.2051-J order (SL/SR before BL/BR), so indices 4<->6 and 5<->7 swap here
// and ONLY here.

import { collectIamfStreamStats } from './obuWalker'

export const IAMF_CHANNELS = 12

/** astra channel index -> libiamf interleaved index. */
const IAMF_INDEX_FOR_ASTRA_CHANNEL = [0, 1, 2, 3, 6, 7, 4, 5, 8, 9, 10, 11]

const INT32_MIN = -2147483648
const INV_INT32_SCALE = 1 / 2147483648

const IAMF_ERROR_NAMES: Record<number, string> = {
  [-1]: 'IAMF_ERR_BAD_ARG',
  [-2]: 'IAMF_ERR_BUFFER_TOO_SMALL',
  [-3]: 'IAMF_ERR_INTERNAL',
  [-4]: 'IAMF_ERR_INVALID_PACKET',
  [-5]: 'IAMF_ERR_INVALID_STATE',
  [-6]: 'IAMF_ERR_UNIMPLEMENTED',
  [-7]: 'IAMF_ERR_ALLOC_FAIL',
}

export function iamfErrorName(code: number): string {
  return IAMF_ERROR_NAMES[code] ?? `IAMF_ERR_${code}`
}

export interface IamfWasmExports {
  memory: WebAssembly.Memory
  _initialize: () => void
  malloc: (size: number) => number
  free: (ptr: number) => void
  iamf_open: (ptr: number, size: number) => number
  iamf_channels: () => number
  iamf_max_frame: () => number
  iamf_pcm_ptr: () => number
  iamf_decode_next: () => number
  iamf_sample_rate: () => number
  iamf_loudness_q78: () => number
  iamf_close: () => void
}

export async function instantiateIamfDecoder(
  wasmBytes: ArrayBuffer | Uint8Array
): Promise<IamfWasmExports> {
  const stub = (): number => 0
  const { instance } = await WebAssembly.instantiate(wasmBytes as BufferSource, {
    env: {
      // Heap views are recreated after every wasm call, so growth needs no action.
      emscripten_notify_memory_growth: stub,
    },
    wasi_snapshot_preview1: {
      proc_exit: stub,
      fd_close: stub,
      fd_read: stub,
      fd_write: stub,
      fd_seek: stub,
    },
  })
  const exports = instance.exports as unknown as IamfWasmExports
  exports._initialize()
  return exports
}

export interface IamfDecodeOptions {
  /** Invoked periodically so a hosting worker can drain its message queue. */
  yieldToHost?: () => Promise<void>
  /** Return true to abort; decode rejects with an 'IAMF decode cancelled' error. */
  shouldCancel?: () => boolean
  onProgress?: (decodedFrames: number, estimatedTotalFrames: number | null) => void
}

export interface IamfDecodeResult {
  sampleRate: number
  frames: number
  channels: number
  /** 12 planar channels in Astra STANDARD_LAYOUTS[12] order. */
  channelData: Float32Array[]
  /** Integrated loudness from the mix presentation metadata, if present. */
  loudnessLufs: number | null
}

/** Roughly how many decoded frames between yield/cancel/progress checks. */
const CONTROL_CHECK_INTERVAL_FRAMES = 48000 * 2

export class IamfDecodeError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = 'IamfDecodeError'
    this.code = code
  }
}

/**
 * Decodes a complete standalone OBU stream to planar float PCM. The wasm
 * instance handles one decode at a time; callers serialize.
 */
export async function decodeIamfObuStream(
  wasm: IamfWasmExports,
  obuBytes: Uint8Array,
  options: IamfDecodeOptions = {}
): Promise<IamfDecodeResult> {
  const stats = collectIamfStreamStats(obuBytes)
  const estimatedFrames = stats ? stats.totalSamples : null

  const inputPtr = wasm.malloc(obuBytes.length)
  if (!inputPtr) throw new IamfDecodeError('IAMF decoder out of memory (input)')
  new Uint8Array(wasm.memory.buffer).set(obuBytes, inputPtr)

  try {
    const openResult = wasm.iamf_open(inputPtr, obuBytes.length)
    if (openResult !== 0) {
      throw new IamfDecodeError(
        `IAMF decoder rejected the stream (${iamfErrorName(openResult)})`,
        openResult
      )
    }

    const channels = wasm.iamf_channels()
    if (channels !== IAMF_CHANNELS) {
      throw new IamfDecodeError(`IAMF decoder reported ${channels} channels, expected ${IAMF_CHANNELS}`)
    }

    let capacity = Math.max(estimatedFrames ?? 0, wasm.iamf_max_frame() * 16)
    let channelData = allocatePlanar(capacity)
    let frames = 0
    let framesSinceControlCheck = 0

    for (;;) {
      const produced = wasm.iamf_decode_next()
      if (produced === 0) break
      if (produced < 0) {
        throw new IamfDecodeError(
          `IAMF decode failed at frame ${frames} (${iamfErrorName(produced)})`,
          produced
        )
      }

      if (frames + produced > capacity) {
        capacity = Math.max(frames + produced, Math.ceil(capacity * 1.5))
        channelData = reallocatePlanar(channelData, frames, capacity)
      }

      // Fresh view every call: ALLOW_MEMORY_GROWTH detaches old buffers.
      const pcm = new Int32Array(wasm.memory.buffer, wasm.iamf_pcm_ptr(), produced * IAMF_CHANNELS)
      for (let c = 0; c < IAMF_CHANNELS; c++) {
        const src = IAMF_INDEX_FOR_ASTRA_CHANNEL[c]
        const dst = channelData[c]
        for (let i = 0; i < produced; i++) {
          dst[frames + i] = pcm[i * IAMF_CHANNELS + src] * INV_INT32_SCALE
        }
      }
      frames += produced
      framesSinceControlCheck += produced

      if (framesSinceControlCheck >= CONTROL_CHECK_INTERVAL_FRAMES) {
        framesSinceControlCheck = 0
        options.onProgress?.(frames, estimatedFrames)
        if (options.shouldCancel?.()) throw new IamfDecodeError('IAMF decode cancelled')
        if (options.yieldToHost) await options.yieldToHost()
      }
    }

    if (frames === 0) throw new IamfDecodeError('IAMF stream contained no audio frames')

    const sampleRate = wasm.iamf_sample_rate()
    if (!sampleRate) throw new IamfDecodeError('IAMF decoder reported no sample rate')

    const loudnessQ78 = wasm.iamf_loudness_q78()
    const loudnessLufs = loudnessQ78 === INT32_MIN ? null : loudnessQ78 / 256

    return {
      sampleRate,
      frames,
      channels: IAMF_CHANNELS,
      // Views trimmed to the decoded length; the backing buffer may carry the
      // (tiny) estimate overshoot from trimmed frames.
      channelData: channelData.map((data) => data.subarray(0, frames)),
      loudnessLufs,
    }
  } finally {
    wasm.iamf_close()
    wasm.free(inputPtr)
  }
}

function allocatePlanar(capacity: number): Float32Array[] {
  return Array.from({ length: IAMF_CHANNELS }, () => new Float32Array(Math.max(1, capacity)))
}

function reallocatePlanar(channelData: Float32Array[], frames: number, capacity: number): Float32Array[] {
  return channelData.map((data) => {
    const grown = new Float32Array(capacity)
    grown.set(data.subarray(0, frames))
    return grown
  })
}
