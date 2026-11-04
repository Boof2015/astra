export interface RemoteAudioLoudness {
  loudnessLufs: number
  peakLinear: number | null
}

/** Compact results for one complete encoded cache representation. */
export interface RemoteAudioAnalysis extends RemoteAudioLoudness {
  version: 1
  duration: number
  peaks: number[]
}

export function isRemoteAudioAnalysis(value: unknown): value is RemoteAudioAnalysis {
  const result = value as RemoteAudioAnalysis | null
  return !!result && result.version === 1 && Number.isFinite(result.duration) && result.duration > 0
    && Number.isFinite(result.loudnessLufs)
    && (result.peakLinear === null || (Number.isFinite(result.peakLinear) && result.peakLinear >= 0))
    && Array.isArray(result.peaks) && result.peaks.length === 512
    && result.peaks.every(peak => Number.isFinite(peak) && peak >= 0 && peak <= 1)
}
