import type { PlaybackOutputMode } from '../../types/nativeAudio'
import { streamingQualityLabel, type RemotePlaybackQuality } from '../../types/streamingQuality'

export function describeRemotePlaybackQuality(quality: RemotePlaybackQuality): string {
  const selection = quality.requested === 'original' ? 'Original requested' : `${quality.requested} kbps target`
  const target = quality.mode ? `${streamingQualityLabel(quality.mode)} · ${selection}` : selection
  const delivered = quality.delivered
  if (!delivered?.codec) return quality.requested === 'original' ? target : `${target} · format unverified`
  const detail = [delivered.codec.toUpperCase()]
  if (delivered.bitrateKbps) detail.push(`${Math.round(delivered.bitrateKbps)} kbps`)
  if (delivered.bitDepth) detail.push(`${delivered.bitDepth}-bit`)
  if (delivered.sampleRate) detail.push(`${Number((delivered.sampleRate / 1000).toFixed(1))} kHz`)
  return `${detail.join(' · ')} (${target})`
}

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
