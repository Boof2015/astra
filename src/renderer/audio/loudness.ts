export * from '../../shared/audio/kWeightedLoudness'
import { analyzeKWeightedChannelData, analyzeRenderedKWeightedChannelData, calculatePeakLinear, getKWeightingCoeffs, type BiquadCoeffs, type LoudnessAnalysis } from '../../shared/audio/kWeightedLoudness'

function getAudioBufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, channelIndex) => (
    buffer.getChannelData(channelIndex)
  ))
}

export function analyzeAudioBufferLoudnessSync(buffer: AudioBuffer): LoudnessAnalysis {
  return analyzeKWeightedChannelData(getAudioBufferChannels(buffer), buffer.sampleRate)
}

function createIIRFilter(context: BaseAudioContext, coeffs: BiquadCoeffs): IIRFilterNode {
  const filter = context.createIIRFilter(
    [coeffs.b0, coeffs.b1, coeffs.b2],
    [1, coeffs.a1, coeffs.a2]
  )
  try {
    filter.channelInterpretation = 'discrete'
  } catch {
    // Some Web Audio implementations do not allow these properties on IIRFilterNode.
  }
  return filter
}

export async function analyzeAudioBufferLoudness(buffer: AudioBuffer): Promise<LoudnessAnalysis> {
  const peakLinear = calculatePeakLinear(getAudioBufferChannels(buffer))
  const OfflineContext = globalThis.OfflineAudioContext
  if (!OfflineContext || buffer.length <= 0 || buffer.numberOfChannels <= 0) {
    return analyzeAudioBufferLoudnessSync(buffer)
  }

  try {
    const offlineContext = new OfflineContext(
      buffer.numberOfChannels,
      buffer.length,
      buffer.sampleRate
    )
    const coeffs = getKWeightingCoeffs(buffer.sampleRate)
    const source = offlineContext.createBufferSource()
    const preFilter = createIIRFilter(offlineContext, coeffs.pre)
    const rlbFilter = createIIRFilter(offlineContext, coeffs.rlb)

    source.buffer = buffer
    source.connect(preFilter)
    preFilter.connect(rlbFilter)
    rlbFilter.connect(offlineContext.destination)
    source.start(0)

    const rendered = await offlineContext.startRendering()
    return analyzeRenderedKWeightedChannelData(
      getAudioBufferChannels(rendered),
      rendered.sampleRate,
      peakLinear
    )
  } catch (error) {
    console.warn('Offline loudness analysis failed; falling back to JS K-weighting.', error)
    return analyzeAudioBufferLoudnessSync(buffer)
  }
}
