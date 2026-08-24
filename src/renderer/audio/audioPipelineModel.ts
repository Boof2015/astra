import type { PlaybackOutputMode } from '../../types/nativeAudio'

export interface PipelineResamplerState {
  playbackOutputMode: PlaybackOutputMode
  trackSampleRate: number | null | undefined
  standardOutputSampleRate: number | null | undefined
  nativeSourceSampleRate: number | null | undefined
  nativeTargetSampleRate: number | null | undefined
  nativeResamplingActive: boolean
}

export interface PipelineResamplerNode {
  sourceSampleRate: number | null
  targetSampleRate: number | null
}

/**
 * Resolves the shelf's resampler independently from unrelated DSP state.
 * Native status is authoritative in Exclusive DSP mode because negotiated
 * rates can change without the Web Audio context or current track changing.
 */
export function resolvePipelineResampler(state: PipelineResamplerState): PipelineResamplerNode | null {
  if (state.playbackOutputMode === 'bitperfect') return null

  const sourceSampleRate = state.playbackOutputMode === 'exclusive'
    ? (state.nativeSourceSampleRate ?? state.trackSampleRate ?? null)
    : (state.trackSampleRate ?? null)
  const targetSampleRate = state.playbackOutputMode === 'exclusive'
    ? (state.nativeTargetSampleRate ?? null)
    : (state.standardOutputSampleRate ?? null)
  const ratesDiffer = Boolean(
    sourceSampleRate
    && targetSampleRate
    && sourceSampleRate !== targetSampleRate
  )

  if (state.playbackOutputMode === 'exclusive') {
    if (!state.nativeResamplingActive && !ratesDiffer) return null
  } else if (!ratesDiffer) {
    return null
  }

  return { sourceSampleRate, targetSampleRate }
}
