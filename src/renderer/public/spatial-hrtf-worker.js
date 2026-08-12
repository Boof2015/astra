/* Off-audio-thread HRTF/SOFA preparation for the spatial AudioWorklet. */

const RENDER_QUANTUM = 128

const ERROR_MESSAGES = {
  1: ['unsupported-samplerate', 'The built-in MIT KEMAR HRTF supports 44.1/48/88.2/96 kHz output.'],
  2: ['invalid-sofa', 'The selected file is not a valid AES69 SOFA HRTF profile.'],
  3: ['unsupported-sofa', 'This SOFA convention is not supported; Astra requires a two-receiver HRTF dataset.'],
  4: ['filter-too-long', 'This profile has an effective HRIR longer than Astra’s 8,192-tap safety limit.'],
  5: ['out-of-memory', 'There was not enough memory to prepare this HRTF profile.'],
  6: ['unsupported-sofa', 'The profile does not cover the requested virtual-speaker positions.'],
}

let wasm = null
let heapU8 = null
let heapF32 = null
let currentConfig = null
let pendingSpeakerUpdate = null
let speakerUpdateScheduled = false

function refreshHeaps() {
  heapU8 = new Uint8Array(wasm.memory.buffer)
  heapF32 = new Float32Array(wasm.memory.buffer)
}

function errorFromWasm(fallback) {
  const code = wasm ? Number(wasm.hrtf_prep_last_error()) : 0
  const mapped = ERROR_MESSAGES[code]
  return {
    code: mapped ? mapped[0] : 'renderer-error',
    message: mapped ? mapped[1] : fallback,
  }
}

async function instantiate(bytes) {
  const stub = () => 0
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth: () => { if (wasm) refreshHeaps() } },
    wasi_snapshot_preview1: {
      proc_exit: stub,
      fd_close: stub,
      fd_write: stub,
      fd_read: stub,
      fd_seek: stub,
    },
  })
  wasm = instance.exports
  wasm._initialize()
  refreshHeaps()
}

function bakeSpeakers(speakers) {
  const filters = []
  const transfer = []
  for (let index = 0; index < speakers.length; index++) {
    const speaker = speakers[index] ?? {}
    const isLfe = Boolean(speaker.isLfe)
    const prepared = {
      index,
      gain: Number.isFinite(speaker.gain) ? speaker.gain : 1,
      isLfe,
    }
    if (!isLfe) {
      const ok = wasm.hrtf_prep_bake(
        Number.isFinite(speaker.azimuthRad) ? speaker.azimuthRad : 0,
        Number.isFinite(speaker.elevationRad) ? speaker.elevationRad : 0
      )
      if (!ok) throw errorFromWasm(`Failed to prepare virtual speaker ${index + 1}.`)
      refreshHeaps()
      const floatsPerEar = currentConfig.fftBins * 2
      const leftBase = wasm.hrtf_prep_filter_ptr(0) / 4
      const rightBase = wasm.hrtf_prep_filter_ptr(1) / 4
      prepared.left = heapF32.slice(leftBase, leftBase + floatsPerEar)
      prepared.right = heapF32.slice(rightBase, rightBase + floatsPerEar)
      transfer.push(prepared.left.buffer, prepared.right.buffer)
    }
    filters.push(prepared)
  }
  return { filters, transfer }
}

async function loadProfile(data) {
  await instantiate(data.wasmBytes)
  let taps = 0
  if (data.profileKind === 'sofa') {
    const profileBytes = data.profileBytes instanceof ArrayBuffer
      ? new Uint8Array(data.profileBytes)
      : new Uint8Array(0)
    const pointer = wasm.malloc(profileBytes.byteLength)
    if (!pointer) throw { code: 'out-of-memory', message: 'There was not enough memory to load the SOFA profile.' }
    refreshHeaps()
    heapU8.set(profileBytes, pointer)
    taps = wasm.hrtf_prep_init_sofa(
      Math.round(Number(data.sampleRate) || 0),
      RENDER_QUANTUM,
      pointer,
      profileBytes.byteLength
    )
    wasm.free(pointer)
  } else {
    taps = wasm.hrtf_prep_init_builtin(Math.round(Number(data.sampleRate) || 0), RENDER_QUANTUM)
  }
  refreshHeaps()
  if (!taps) throw errorFromWasm('Failed to initialize the HRTF preparation engine.')

  currentConfig = {
    sampleRate: Math.round(Number(data.sampleRate) || 0),
    blockSize: RENDER_QUANTUM,
    taps,
    fftSize: Number(wasm.hrtf_prep_fft_size()),
    fftBins: Number(wasm.hrtf_prep_fft_bins()),
    filterLen: Number(wasm.hrtf_prep_filter_len()),
  }
  const { filters, transfer } = bakeSpeakers(Array.isArray(data.speakers) ? data.speakers : [])
  self.postMessage({ type: 'prepared', requestId: data.requestId, config: currentConfig, filters }, transfer)
}

function scheduleSpeakerUpdate() {
  if (speakerUpdateScheduled) return
  speakerUpdateScheduled = true
  setTimeout(() => {
    speakerUpdateScheduled = false
    const data = pendingSpeakerUpdate
    pendingSpeakerUpdate = null
    if (!data || !wasm || !currentConfig) return
    try {
      const { filters, transfer } = bakeSpeakers(Array.isArray(data.speakers) ? data.speakers : [])
      self.postMessage({ type: 'speaker-filters', generation: data.generation, filters }, transfer)
    } catch (error) {
      self.postMessage({
        type: 'speaker-error',
        generation: data.generation,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'renderer-error',
          message: typeof error?.message === 'string' ? error.message : String(error),
        },
      })
    }
    // A message that arrived after this update began replaces the pending
    // request and gets one new task; intermediate drag positions are skipped.
    if (pendingSpeakerUpdate) scheduleSpeakerUpdate()
  }, 0)
}

self.onmessage = (event) => {
  const data = event.data ?? {}
  if (data.type === 'load') {
    void loadProfile(data).catch((error) => {
      self.postMessage({
        type: 'error',
        requestId: data.requestId,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'renderer-error',
          message: typeof error?.message === 'string' ? error.message : String(error),
        },
      })
    })
    return
  }
  if (data.type === 'set-speakers' && wasm && currentConfig) {
    pendingSpeakerUpdate = data
    scheduleSpeakerUpdate()
  }
}
