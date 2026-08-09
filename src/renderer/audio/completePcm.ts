import type { PcmTransportTimings } from './pcmTransportTimings'

const FLOAT32_BYTES_PER_SAMPLE = 4
const MAX_AUDIO_CHANNELS = 32

/**
 * A complete, interleaved float32 decode of one audio stream.
 *
 * `frames` and `pcmByteLength` authoritatively describe the valid prefix of
 * `interleavedPcm`; its backing buffer may have a small preallocation tail.
 * Keeping the valid length explicit prevents partial frames or stale probe
 * metadata from silently shifting channel order during deinterleaving.
 */
export interface CompleteFloat32Pcm {
  sampleRate: number
  channels: number
  frames: number
  /** Valid PCM prefix; the transferred backing buffer may have spare capacity. */
  pcmByteLength: number
  interleavedPcm: ArrayBuffer
  /** Native probe wall time, when supplied by the decode bridge. */
  probeMs?: number
  /** Native decoder wall time, when supplied by the decode bridge. */
  decodeMs?: number
  /** Process-local transport measurements supplied by main and preload. */
  transportTimings?: PcmTransportTimings
}

export interface CompletePcmCopyTimingOptions {
  /** Process-local monotonic wall clock, injected so diagnostics remain testable. */
  now: () => number
}

export interface CompletePcmCopyTimings {
  /**
   * Validation of PCM/destination dimensions plus construction of the source
   * Float32Array view. Destination AudioBuffer views are acquired by the
   * caller and are therefore intentionally outside this phase.
   */
  pcmCopySetupMs: number
  /** Continuous wall span covering every channel copy and timing probe. */
  pcmChannelCopyTotalMs: number
  /** Slowest individual channel-copy wall span. */
  pcmChannelCopyMaxMs: number
  /** Channel-copy wall spans in channel-index order. */
  pcmChannelCopyByChannelMs: number[]
}

function elapsedDiagnosticMs(startedAt: number, endedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0
  return Math.max(0, endedAt - startedAt)
}

export function validateCompleteFloat32Pcm(pcm: CompleteFloat32Pcm): void {
  if (!Number.isInteger(pcm.sampleRate) || pcm.sampleRate <= 0) {
    throw new Error('Decoded PCM sample rate must be a positive integer.')
  }
  if (!Number.isInteger(pcm.channels) || pcm.channels < 1 || pcm.channels > MAX_AUDIO_CHANNELS) {
    throw new Error(`Decoded PCM channel count must be between 1 and ${MAX_AUDIO_CHANNELS}.`)
  }
  if (!Number.isSafeInteger(pcm.frames) || pcm.frames < 1) {
    throw new Error('Decoded PCM frame count must be a positive safe integer.')
  }

  const sampleCount = pcm.frames * pcm.channels
  const expectedBytes = sampleCount * FLOAT32_BYTES_PER_SAMPLE
  if (!Number.isSafeInteger(sampleCount) || !Number.isSafeInteger(expectedBytes)) {
    throw new Error('Decoded PCM dimensions exceed the supported buffer size.')
  }
  if (pcm.pcmByteLength !== expectedBytes) {
    throw new Error(
      `Decoded PCM size mismatch: expected ${expectedBytes} bytes for ${pcm.frames} frames `
      + `and ${pcm.channels} channels, received ${pcm.pcmByteLength}.`
    )
  }
  if (pcm.pcmByteLength > pcm.interleavedPcm.byteLength) {
    throw new Error(
      `Decoded PCM valid length ${pcm.pcmByteLength} exceeds its ${pcm.interleavedPcm.byteLength}-byte buffer.`
    )
  }
}

/**
 * Copies interleaved samples directly into planar AudioBuffer channel views.
 * No full-size planar staging allocation is created.
 */
export function copyCompleteFloat32PcmToChannels(
  pcm: CompleteFloat32Pcm,
  destinationChannels: readonly Float32Array[],
): void
export function copyCompleteFloat32PcmToChannels(
  pcm: CompleteFloat32Pcm,
  destinationChannels: readonly Float32Array[],
  timingOptions: CompletePcmCopyTimingOptions,
): CompletePcmCopyTimings
export function copyCompleteFloat32PcmToChannels(
  pcm: CompleteFloat32Pcm,
  destinationChannels: readonly Float32Array[],
  timingOptions?: CompletePcmCopyTimingOptions,
): CompletePcmCopyTimings | void {
  const setupStartedAt = timingOptions?.now()
  validateCompleteFloat32Pcm(pcm)
  if (destinationChannels.length !== pcm.channels) {
    throw new Error(
      `Decoded PCM destination has ${destinationChannels.length} channels; expected ${pcm.channels}.`
    )
  }
  for (const destination of destinationChannels) {
    if (destination.length !== pcm.frames) {
      throw new Error(
        `Decoded PCM destination has ${destination.length} frames; expected ${pcm.frames}.`
      )
    }
  }

  const sampleCount = pcm.frames * pcm.channels
  const interleaved = new Float32Array(pcm.interleavedPcm, 0, sampleCount)
  if (!timingOptions || setupStartedAt === undefined) {
    // Preserve the original uninstrumented hot path exactly when detailed
    // diagnostics are not requested.
    if (pcm.channels === 1) {
      destinationChannels[0].set(interleaved)
      return
    }

    for (let channelIndex = 0; channelIndex < pcm.channels; channelIndex += 1) {
      const destination = destinationChannels[channelIndex]
      let sourceIndex = channelIndex
      for (let frameIndex = 0; frameIndex < pcm.frames; frameIndex += 1) {
        destination[frameIndex] = interleaved[sourceIndex]
        sourceIndex += pcm.channels
      }
    }
    return
  }

  const setupEndedAt = timingOptions.now()
  const pcmChannelCopyByChannelMs: number[] = []
  const copyStartedAt = timingOptions.now()
  if (pcm.channels === 1) {
    const channelStartedAt = timingOptions.now()
    destinationChannels[0].set(interleaved)
    const channelEndedAt = timingOptions.now()
    pcmChannelCopyByChannelMs.push(elapsedDiagnosticMs(channelStartedAt, channelEndedAt))
  } else {
    for (let channelIndex = 0; channelIndex < pcm.channels; channelIndex += 1) {
      const channelStartedAt = timingOptions.now()
      const destination = destinationChannels[channelIndex]
      let sourceIndex = channelIndex
      for (let frameIndex = 0; frameIndex < pcm.frames; frameIndex += 1) {
        destination[frameIndex] = interleaved[sourceIndex]
        sourceIndex += pcm.channels
      }
      const channelEndedAt = timingOptions.now()
      pcmChannelCopyByChannelMs.push(elapsedDiagnosticMs(channelStartedAt, channelEndedAt))
    }
  }
  const copyEndedAt = timingOptions.now()

  return {
    pcmCopySetupMs: elapsedDiagnosticMs(setupStartedAt, setupEndedAt),
    pcmChannelCopyTotalMs: elapsedDiagnosticMs(copyStartedAt, copyEndedAt),
    pcmChannelCopyMaxMs: Math.max(0, ...pcmChannelCopyByChannelMs),
    pcmChannelCopyByChannelMs,
  }
}
