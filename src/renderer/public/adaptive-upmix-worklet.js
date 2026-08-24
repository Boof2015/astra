/*
 * Astra Adaptive stereo upmixer AudioWorklet.
 *
 * Message protocol:
 *   in : { type: 'init', wasmBytes, roles, overrides? }
 *   in : { type: 'reset' }
 *   in : { type: 'set-overrides', overrides }
 *   out: { type: 'ready', latencyFrames, fftSize }
 *   out: { type: 'error', message }
 */

const ADAPTIVE_RENDER_QUANTUM = 128
const ADAPTIVE_ROLE_CODES = {
  FL: 1,
  FR: 2,
  FC: 3,
  LFE: 4,
  SL: 5,
  SR: 6,
  BL: 7,
  BR: 8,
  TFL: 9,
  TFR: 9,
  TBL: 9,
  TBR: 9,
}

class AdaptiveUpmixProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = options?.processorOptions ?? {}
    this.roles = Array.isArray(processorOptions.roles) ? processorOptions.roles.slice() : ['FL', 'FR']
    this.overrides = Array.isArray(processorOptions.overrides)
      ? processorOptions.overrides.slice()
      : this.roles.map(() => -1)
    this.state = 'idle'
    this.wasm = null
    this.heapF32 = null
    this.inputPointer = 0
    this.outputPointer = 0
    this.latencyFrames = 0
    this.rawDelayLeft = new Float32Array(1)
    this.rawDelayRight = new Float32Array(1)
    this.rawDelayWrite = 0
    this.port.onmessage = (event) => {
      const data = event.data ?? {}
      if (data.type === 'init') void this.initialize(data.wasmBytes)
      else if (data.type === 'reset') this.reset()
      else if (data.type === 'set-overrides') {
        this.overrides = Array.isArray(data.overrides) ? data.overrides.slice() : this.roles.map(() => -1)
      }
    }
  }

  async initialize(wasmBytes) {
    if (this.state === 'loading' || this.state === 'ready') return
    this.state = 'loading'
    try {
      const stub = () => 0
      const { instance } = await WebAssembly.instantiate(wasmBytes, {
        wasi_snapshot_preview1: {
          proc_exit: stub,
          fd_close: stub,
          fd_write: stub,
          fd_seek: stub,
        },
      })
      const exports = instance.exports
      exports._initialize()
      const heapI32 = new Int32Array(exports.memory.buffer)
      const rolesPointer = exports.adaptive_roles_ptr() / 4
      for (let index = 0; index < this.roles.length; index++) {
        heapI32[rolesPointer + index] = ADAPTIVE_ROLE_CODES[this.roles[index]] ?? 0
      }
      const latencyFrames = exports.adaptive_init(sampleRate, this.roles.length, 0)
      if (!latencyFrames) throw new Error(`Unsupported Adaptive configuration at ${sampleRate} Hz`)
      this.wasm = exports
      this.heapF32 = new Float32Array(exports.memory.buffer)
      this.inputPointer = exports.adaptive_input_ptr() / 4
      this.outputPointer = exports.adaptive_output_ptr() / 4
      this.latencyFrames = latencyFrames
      this.rawDelayLeft = new Float32Array(Math.max(1, latencyFrames))
      this.rawDelayRight = new Float32Array(Math.max(1, latencyFrames))
      this.rawDelayWrite = 0
      this.state = 'ready'
      this.port.postMessage({
        type: 'ready',
        latencyFrames,
        fftSize: exports.adaptive_fft_size(),
      })
    } catch (error) {
      this.state = 'error'
      this.port.postMessage({
        type: 'error',
        message: String(error && error.message ? error.message : error),
      })
    }
  }

  reset() {
    if (this.state === 'ready') this.wasm.adaptive_reset()
    this.rawDelayLeft.fill(0)
    this.rawDelayRight.fill(0)
    this.rawDelayWrite = 0
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? []
    const output = outputs[0]
    if (!output || output.length !== this.roles.length) return true
    const frames = output[0]?.length ?? 0
    const left = input[0]
    const right = input[1]

    if (this.state !== 'ready' || frames < 1 || frames > ADAPTIVE_RENDER_QUANTUM) {
      this.renderFallback(left, right, output, frames)
      return true
    }

    try {
      const heap = this.heapF32
      for (let frame = 0; frame < frames; frame++) {
        heap[this.inputPointer + frame * 2] = left?.[frame] ?? 0
        heap[this.inputPointer + frame * 2 + 1] = right?.[frame] ?? left?.[frame] ?? 0
      }
      if (!this.wasm.adaptive_process(frames)) throw new Error('Adaptive processing failed')

      for (let frame = 0; frame < frames; frame++) {
        const inLeft = left?.[frame] ?? 0
        const inRight = right?.[frame] ?? inLeft
        const rawLeft = this.rawDelayLeft[this.rawDelayWrite]
        const rawRight = this.rawDelayRight[this.rawDelayWrite]
        this.rawDelayLeft[this.rawDelayWrite] = inLeft
        this.rawDelayRight[this.rawDelayWrite] = inRight
        this.rawDelayWrite = (this.rawDelayWrite + 1) % this.rawDelayLeft.length

        for (let channel = 0; channel < output.length; channel++) {
          const override = this.overrides[channel] ?? -1
          output[channel][frame] = override === -2
            ? 0
            : override === 0
              ? rawLeft
              : override === 1
                ? rawRight
                : heap[this.outputPointer + frame * output.length + channel]
        }
      }
    } catch (error) {
      this.state = 'error'
      this.port.postMessage({
        type: 'error',
        message: String(error && error.message ? error.message : error),
      })
      this.renderFallback(left, right, output, frames)
    }
    return true
  }

  renderFallback(left, right, output, frames) {
    for (let channel = 0; channel < output.length; channel++) output[channel].fill(0)
    const leftIndex = this.roles.indexOf('FL')
    const rightIndex = this.roles.indexOf('FR')
    for (let frame = 0; frame < frames; frame++) {
      if (leftIndex >= 0) output[leftIndex][frame] = left?.[frame] ?? 0
      if (rightIndex >= 0) output[rightIndex][frame] = right?.[frame] ?? left?.[frame] ?? 0
    }
  }
}

registerProcessor('adaptive-upmix-processor', AdaptiveUpmixProcessor)
