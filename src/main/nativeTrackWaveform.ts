import { join } from 'path'

export const STATIC_TRACK_WAVEFORM_RESOLUTION = 512
const STATIC_TRACK_WAVEFORM_BYTES = STATIC_TRACK_WAVEFORM_RESOLUTION * Float32Array.BYTES_PER_ELEMENT

interface NativeTrackWaveformAddon {
  analyzeInterleavedAsync(
    samples: Float32Array,
    channelCount: number,
    resolution?: number,
  ): Promise<Float32Array>
}

let nativeAddon: NativeTrackWaveformAddon | null | undefined
let nativeAddonError: string | null = null
let analysisWarningLogged = false

function resolveAddonPath(): string {
  return process.env.NODE_ENV === 'development' || typeof process.resourcesPath !== 'string'
    ? join(__dirname, '../../native/build/Release/track_waveform.node')
    : join(process.resourcesPath, 'native/track_waveform.node')
}

function getNativeAddon(): NativeTrackWaveformAddon | null {
  if (nativeAddon !== undefined) return nativeAddon

  try {
    const loaded = require(resolveAddonPath()) as Partial<NativeTrackWaveformAddon>
    if (typeof loaded?.analyzeInterleavedAsync !== 'function') {
      throw new Error('Native asynchronous static waveform export is missing.')
    }
    nativeAddon = loaded as NativeTrackWaveformAddon
  } catch (error) {
    nativeAddon = null
    nativeAddonError = error instanceof Error ? error.message : String(error)
    console.warn('[audio-waveform] native static waveform analysis is unavailable:', nativeAddonError)
  }

  return nativeAddon
}

export function warmNativeStaticTrackWaveformAddon(): void {
  getNativeAddon()
}

function isValidCanonicalWaveform(value: unknown): value is Float32Array {
  if (!(value instanceof Float32Array) || value.byteLength !== STATIC_TRACK_WAVEFORM_BYTES) {
    return false
  }
  for (const sample of value) {
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) return false
  }
  return true
}

/**
 * Queues the lightweight native analyzer over the valid prefix of Astra's
 * existing FFmpeg output allocation. The addon's AsyncWorker retains the
 * zero-copy Float32Array view until completion; only the canonical 2 KiB
 * result is copied into a standalone buffer.
 */
export async function analyzeNativeStaticTrackWaveformAsync(
  pcm: Buffer,
  pcmByteLength: number,
  channelCount: number,
): Promise<ArrayBuffer | null> {
  const addon = getNativeAddon()
  if (!addon) return null
  if (
    !Number.isSafeInteger(pcmByteLength)
    || pcmByteLength <= 0
    || pcmByteLength > pcm.byteLength
    || pcmByteLength % Float32Array.BYTES_PER_ELEMENT !== 0
    || pcm.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0
  ) return null

  try {
    const samples = new Float32Array(
      pcm.buffer,
      pcm.byteOffset,
      pcmByteLength / Float32Array.BYTES_PER_ELEMENT,
    )
    const waveform = await addon.analyzeInterleavedAsync(
      samples,
      channelCount,
      STATIC_TRACK_WAVEFORM_RESOLUTION,
    )
    if (!isValidCanonicalWaveform(waveform)) {
      throw new Error('Native analyzer returned an invalid canonical waveform.')
    }
    return waveform.buffer.slice(
      waveform.byteOffset,
      waveform.byteOffset + waveform.byteLength,
    ) as ArrayBuffer
  } catch (error) {
    nativeAddonError = error instanceof Error ? error.message : String(error)
    if (!analysisWarningLogged) {
      analysisWarningLogged = true
      console.warn('[audio-waveform] native static waveform analysis failed:', nativeAddonError)
    }
    return null
  }
}

export function getNativeStaticTrackWaveformError(): string | null {
  return nativeAddonError
}

export function getNativeStaticTrackWaveformFailureKind(): 'unavailable' | 'analysis_failed' {
  return nativeAddon === null ? 'unavailable' : 'analysis_failed'
}
