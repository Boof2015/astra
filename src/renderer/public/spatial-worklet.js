/*
 * Astra spatial renderer AudioWorklet.
 *
 * Hosts the libspatialaudio-based binaural renderer (spatial-renderer.wasm,
 * built by scripts/build/build-spatial-wasm.sh). Takes an N-channel virtual
 * speaker bus (max 12 channels — fits 7.1.4) and renders binaural stereo via
 * per-speaker HRTF convolution.
 *
 * The WASM bytes arrive over the port (an AudioWorkletGlobalScope has no
 * fetch); until initialization succeeds — or if it ever fails — process()
 * falls back to a plain stereo downmix so playback is never silenced.
 *
 * Message protocol:
 *   in : { type: 'init', wasmBytes: ArrayBuffer,
 *          speakers: [{ azimuthRad, elevationRad, gain, isLfe }] }
 *   in : { type: 'set-speakers', speakers: [...] }
 *   in : { type: 'reset' }                     // clear convolution tails (seek)
 *   out: { type: 'ready', taps, maxSpeakers }  // maxSpeakers = wasm capacity
 *   out: { type: 'unsupported-samplerate', sampleRate }
 *   out: { type: 'error', message }
 */

const SPATIAL_MAX_SPEAKERS = 12
const RENDER_QUANTUM = 128

class SpatialRendererProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.state = 'idle' // idle | loading | ready | error | unsupported-samplerate
    this.wasm = null
    this.heapF32 = null
    this.inputPtrs = []
    this.outputPtrs = []
    this.speakers = []
    this.maxSpeakers = 0
    this.port.onmessage = (event) => {
      const data = event.data ?? {}
      if (data.type === 'init') {
        void this.initialize(data)
        return
      }
      if (data.type === 'set-speakers') {
        this.speakers = Array.isArray(data.speakers) ? data.speakers : []
        if (this.state === 'ready') {
          this.applySpeakers()
        }
        return
      }
      if (data.type === 'reset') {
        if (this.state === 'ready') {
          try {
            this.wasm.spatial_reset()
          } catch {
            // Non-fatal: stale tails decay within ~6 ms anyway.
          }
        }
      }
    }
  }

  async initialize(data) {
    if (this.state === 'loading' || this.state === 'ready') return
    this.state = 'loading'
    this.speakers = Array.isArray(data.speakers) ? data.speakers : this.speakers
    try {
      const stub = () => 0
      const { instance } = await WebAssembly.instantiate(data.wasmBytes, {
        wasi_snapshot_preview1: {
          proc_exit: stub,
          fd_close: stub,
          fd_write: stub,
          fd_seek: stub,
        },
      })
      const exports = instance.exports
      exports._initialize()
      const taps = exports.spatial_init(sampleRate, RENDER_QUANTUM)
      if (!taps) {
        this.state = 'unsupported-samplerate'
        this.port.postMessage({ type: 'unsupported-samplerate', sampleRate })
        return
      }
      this.wasm = exports
      this.heapF32 = new Float32Array(exports.memory.buffer)
      this.inputPtrs = []
      this.outputPtrs = []
      for (let ch = 0; ch < SPATIAL_MAX_SPEAKERS; ch++) {
        // A wasm built with a lower speaker cap returns a null pointer for
        // out-of-range slots; probing keeps a stale binary safe (writing to
        // pointer 0 would corrupt wasm low memory).
        const ptr = exports.spatial_input_ptr(ch)
        if (!ptr) break
        this.inputPtrs.push(ptr / 4)
      }
      this.maxSpeakers = this.inputPtrs.length
      this.outputPtrs.push(exports.spatial_output_ptr(0) / 4)
      this.outputPtrs.push(exports.spatial_output_ptr(1) / 4)
      this.state = 'ready'
      this.applySpeakers()
      this.port.postMessage({ type: 'ready', taps, maxSpeakers: this.maxSpeakers })
    } catch (err) {
      this.state = 'error'
      this.port.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) })
    }
  }

  applySpeakers() {
    try {
      const count = Math.min(this.speakers.length, this.maxSpeakers)
      for (let i = 0; i < count; i++) {
        const sp = this.speakers[i] ?? {}
        const ok = this.wasm.spatial_set_speaker(
          i,
          Number.isFinite(sp.azimuthRad) ? sp.azimuthRad : 0,
          Number.isFinite(sp.elevationRad) ? sp.elevationRad : 0,
          Number.isFinite(sp.gain) ? sp.gain : 1,
          sp.isLfe ? 1 : 0
        )
        if (!ok) {
          // Filter bake failed (angles outside the HRTF's measured range);
          // the renderer keeps the speaker's previous filter.
          console.warn(
            `[spatial-worklet] speaker ${i} filter bake failed ` +
              `(azimuth ${sp.azimuthRad}, elevation ${sp.elevationRad})`
          )
        }
      }
      for (let i = count; i < this.maxSpeakers; i++) {
        this.wasm.spatial_clear_speaker(i)
      }
    } catch (err) {
      this.state = 'error'
      this.port.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) })
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? []
    const output = outputs[0]
    if (!output || output.length < 2) return true
    const outL = output[0]
    const outR = output[1]
    const frames = outL.length

    if (this.state !== 'ready' || frames !== RENDER_QUANTUM) {
      this.renderFallback(input, outL, outR, frames)
      return true
    }

    try {
      const speakerCount = Math.min(
        Math.max(this.speakers.length, input.length),
        this.maxSpeakers
      )
      const heap = this.heapF32
      for (let ch = 0; ch < speakerCount; ch++) {
        const base = this.inputPtrs[ch]
        const channel = input[ch]
        if (channel && channel.length === frames) {
          heap.set(channel, base)
        } else {
          heap.fill(0, base, base + frames)
        }
      }
      this.wasm.spatial_process(speakerCount, frames)
      outL.set(heap.subarray(this.outputPtrs[0], this.outputPtrs[0] + frames))
      outR.set(heap.subarray(this.outputPtrs[1], this.outputPtrs[1] + frames))
    } catch (err) {
      this.state = 'error'
      this.port.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) })
      this.renderFallback(input, outL, outR, frames)
    }
    return true
  }

  // Plain stereo downmix: FL -> L, FR -> R, all other channels -3 dB into
  // both ears. Keeps audio flowing if the renderer is unavailable.
  renderFallback(input, outL, outR, frames) {
    const fl = input[0]
    const fr = input[1]
    for (let n = 0; n < frames; n++) {
      outL[n] = fl ? fl[n] : 0
      outR[n] = fr ? fr[n] : outL[n]
    }
    for (let ch = 2; ch < input.length; ch++) {
      const src = input[ch]
      if (!src) continue
      for (let n = 0; n < frames; n++) {
        const v = src[n] * 0.7071
        outL[n] += v
        outR[n] += v
      }
    }
  }
}

registerProcessor('spatial-renderer-processor', SpatialRendererProcessor)
