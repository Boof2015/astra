import {
  canUseStereoAmbientUpmix,
  resolveChannelMixMatrix,
  resolveStereoAmbientUpmixPlan,
  type StereoUpmixMode,
} from './sourceChannelLayout'

export type SpeakerStageUsageState = 'routed' | 'unused' | 'inactive'

export interface ResolveSpeakerStageUsageOptions {
  sourceChannels: number | null
  outputChannelIds: readonly string[]
  rendererActive: boolean
  standardMode: boolean
  stereoUpmixMode: StereoUpmixMode
  includeLfeInDownmix?: boolean
}

/**
 * Mirrors the AudioEngine's binaural render-bus routing decisions as a small,
 * UI-friendly state list. This intentionally reports graph participation,
 * not instantaneous sample energy, so the stage stays stable through pauses
 * and quiet passages.
 */
export function resolveSpeakerStageUsage(
  options: ResolveSpeakerStageUsageOptions
): SpeakerStageUsageState[] {
  const outputChannels = options.outputChannelIds.length
  if (outputChannels === 0) return []

  const sourceChannels = Number(options.sourceChannels)
  if (!options.rendererActive || !Number.isFinite(sourceChannels) || sourceChannels <= 0) {
    return Array.from({ length: outputChannels }, () => 'inactive')
  }

  const normalizedSourceChannels = Math.trunc(sourceChannels)
  const ambientUpmixActive = canUseStereoAmbientUpmix({
    sourceChannels: normalizedSourceChannels,
    outputChannels,
    multichannelEnabled: true,
    standardMode: options.standardMode,
    stereoUpmixMode: options.stereoUpmixMode,
    outputChannelIds: options.outputChannelIds,
  })

  const routedIndexes = new Set<number>()
  if (ambientUpmixActive) {
    for (const route of resolveStereoAmbientUpmixPlan(outputChannels, options.outputChannelIds).routes) {
      routedIndexes.add(route.outputIndex)
    }
  } else {
    const matrix = resolveChannelMixMatrix({
      sourceChannels: normalizedSourceChannels,
      outputChannels,
      multichannelEnabled: true,
      manualRoutingMap: null,
      includeLfeInDownmix: options.includeLfeInDownmix,
      outputChannelIds: options.outputChannelIds,
    })
    matrix.forEach((row, outputIndex) => {
      if (row.length > 0) routedIndexes.add(outputIndex)
    })
  }

  return options.outputChannelIds.map((_, outputIndex) => (
    routedIndexes.has(outputIndex) ? 'routed' : 'unused'
  ))
}
