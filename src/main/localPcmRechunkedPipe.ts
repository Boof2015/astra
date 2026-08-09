// 8,192 f32 samples per channel form a 64 KiB stereo packet, matching the
// effective Windows libuv read ceiling without buffering a multi-MiB packet
// before FFmpeg can emit its first PCM bytes.
export const LOCAL_PCM_RECHUNK_SAMPLES_PER_CHANNEL = 8_192

const PCM_FLOAT_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT

/**
 * Builds the complete FFmpeg output tail for either the unchanged stdout pipe
 * or the diagnostics-only rechunked variant. Keep these options immediately
 * before the output URL so they apply to the raw PCM output, not the input.
 */
export function buildLocalPcmPipeOutputArgs(rechunked: boolean): string[] {
  if (!rechunked) return ['pipe:1']
  return [
    '-bsf:a',
    `pcm_rechunk=n=${LOCAL_PCM_RECHUNK_SAMPLES_PER_CHANNEL}:p=0`,
    '-avioflags',
    'direct',
    'pipe:1'
  ]
}

/** Maximum bytes in a full rechunked f32le packet for a channel count. */
export function localPcmRechunkPacketBytes(channels: number): number {
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) {
    throw new RangeError('Local PCM rechunk channel count must be an integer from 1 through 8.')
  }
  return LOCAL_PCM_RECHUNK_SAMPLES_PER_CHANNEL * channels * PCM_FLOAT_BYTES_PER_SAMPLE
}
