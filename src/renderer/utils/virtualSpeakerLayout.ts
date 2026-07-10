/*
 * Virtual speaker layouts for the Astra Spatial Engine.
 *
 * A virtual speaker layout is the render target when binaural mode is active:
 * the routing/upmix machinery produces one bus channel per virtual speaker
 * (ordered exactly like buildSpeakerLayout(n) in sourceChannelLayout.ts, so
 * the existing mix-matrix/upmix code needs no changes), and the spatial
 * worklet renders each bus channel at its speaker's azimuth.
 *
 * Azimuth convention: UI values are DEGREES, clockwise-from-front, so FR sits
 * at +30 and FL at -30. libspatialaudio expects RADIANS with positive =
 * counterclockwise (listener's left); uiDegreesToAmbisonicRadians is the only
 * place that conversion happens.
 *
 * Deferred hooks kept in the data model for later phases: elevation (pinned
 * to 0 in v1), per-speaker gain (pinned to 1), distance (unused), free
 * add/remove of speakers (layouts are preset-based in v1), SOFA HRTFs and
 * IAMF sources (consume the same VirtualSpeaker list).
 */

export interface VirtualSpeaker {
  /** Stable identity, e.g. 'vs-FL'. */
  id: string
  /** Source channel role id from sourceChannelLayout: FL/FR/FC/LFE/SL/SR/BL/BR. */
  sourceChannel: string
  /** Degrees, clockwise-from-front, -180..180. */
  azimuth: number
  /** Degrees, -90..90. Fixed at 0 in v1. */
  elevation: number
  /** Linear gain. Fixed at 1 in v1. */
  gain: number
  /** Reserved for a later phase. */
  distance?: number
}

export type SpatialMode = 'off' | 'binaural'

export type SpatialLayoutPresetId = 'stereo' | 'quad' | '5.1' | '7.1' | 'wide-5.1' | 'custom'

export interface SpatialWorkletSpeakerMessage {
  azimuthRad: number
  elevationRad: number
  gain: number
  isLfe: boolean
}

export const SPATIAL_MAX_SPEAKERS = 8

export const DEFAULT_SPATIAL_LAYOUT_PRESET_ID: Exclude<SpatialLayoutPresetId, 'custom'> = '5.1'

/** Sample rates supported by the embedded MIT KEMAR HRTF. */
const SPATIAL_SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000]

function speaker(sourceChannel: string, azimuth: number): VirtualSpeaker {
  return {
    id: `vs-${sourceChannel}`,
    sourceChannel,
    azimuth,
    elevation: 0,
    gain: 1,
  }
}

// Channel order of every preset matches STANDARD_LAYOUTS in
// sourceChannelLayout.ts for the same channel count — that invariant is what
// lets resolveChannelMixMatrix/resolveStereoAmbientUpmixPlan feed the spatial
// worklet unchanged. Angles per ITU-R BS.775 (7.1 backs/sides per common
// Dolby guidance); LFE is non-positional.
const PRESET_SPEAKERS: Record<Exclude<SpatialLayoutPresetId, 'custom'>, VirtualSpeaker[]> = {
  stereo: [speaker('FL', -30), speaker('FR', 30)],
  quad: [speaker('FL', -45), speaker('FR', 45), speaker('SL', -135), speaker('SR', 135)],
  '5.1': [
    speaker('FL', -30),
    speaker('FR', 30),
    speaker('FC', 0),
    speaker('LFE', 0),
    speaker('SL', -110),
    speaker('SR', 110),
  ],
  '7.1': [
    speaker('FL', -30),
    speaker('FR', 30),
    speaker('FC', 0),
    speaker('LFE', 0),
    speaker('BL', -150),
    speaker('BR', 150),
    speaker('SL', -90),
    speaker('SR', 90),
  ],
  'wide-5.1': [
    speaker('FL', -45),
    speaker('FR', 45),
    speaker('FC', 0),
    speaker('LFE', 0),
    speaker('SL', -120),
    speaker('SR', 120),
  ],
}

export const SPATIAL_LAYOUT_PRESETS: Array<{ id: SpatialLayoutPresetId; label: string }> = [
  { id: 'stereo', label: 'Stereo' },
  { id: 'quad', label: 'Quad' },
  { id: '5.1', label: '5.1' },
  { id: '7.1', label: '7.1' },
  { id: 'wide-5.1', label: 'Wide 5.1' },
  { id: 'custom', label: 'Custom' },
]

export function normalizeSpatialMode(value: unknown): SpatialMode {
  return value === 'binaural' ? 'binaural' : 'off'
}

export function normalizeSpatialLayoutPresetId(value: unknown): SpatialLayoutPresetId {
  const match = SPATIAL_LAYOUT_PRESETS.find((preset) => preset.id === value)
  return match ? match.id : DEFAULT_SPATIAL_LAYOUT_PRESET_ID
}

export function isSpatialSampleRateSupported(sampleRate: number): boolean {
  return SPATIAL_SUPPORTED_SAMPLE_RATES.includes(Math.round(sampleRate))
}

export function isVirtualSpeakerLfe(speaker: Pick<VirtualSpeaker, 'sourceChannel'>): boolean {
  return speaker.sourceChannel === 'LFE'
}

function clampAzimuthDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0
  let deg = value % 360
  if (deg > 180) deg -= 360
  if (deg < -180) deg += 360
  return deg
}

/**
 * UI degrees (clockwise-from-front, FR = +30) to libspatialaudio radians
 * (positive = counterclockwise = listener's left). The only place this sign
 * flip lives — see also the convention comment in spatial_wrapper.cpp.
 */
export function uiDegreesToAmbisonicRadians(degrees: number): number {
  return (-clampAzimuthDegrees(degrees) * Math.PI) / 180
}

/** Parses persisted/unknown data into a valid speaker list, or null. */
export function normalizeVirtualSpeakers(value: unknown): VirtualSpeaker[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > SPATIAL_MAX_SPEAKERS) {
    return null
  }
  const seen = new Set<string>()
  const speakers: VirtualSpeaker[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const candidate = entry as Partial<VirtualSpeaker>
    if (typeof candidate.sourceChannel !== 'string' || candidate.sourceChannel.length === 0) {
      return null
    }
    if (seen.has(candidate.sourceChannel)) return null
    seen.add(candidate.sourceChannel)
    const azimuth = clampAzimuthDegrees(Number(candidate.azimuth))
    const elevation = Number.isFinite(Number(candidate.elevation))
      ? Math.max(-90, Math.min(90, Number(candidate.elevation)))
      : 0
    const gain = Number.isFinite(Number(candidate.gain))
      ? Math.max(0, Math.min(2, Number(candidate.gain)))
      : 1
    speakers.push({
      id: typeof candidate.id === 'string' && candidate.id.length > 0
        ? candidate.id
        : `vs-${candidate.sourceChannel}`,
      sourceChannel: candidate.sourceChannel,
      azimuth,
      elevation,
      gain,
    })
  }
  return speakers
}

/**
 * Resolves the active speaker list. Custom layouts fall back to the default
 * preset when no valid custom speakers exist.
 */
export function buildVirtualSpeakerLayout(
  presetId: SpatialLayoutPresetId,
  customSpeakers: VirtualSpeaker[] | null
): VirtualSpeaker[] {
  if (presetId === 'custom') {
    if (customSpeakers && customSpeakers.length > 0) return customSpeakers
    return PRESET_SPEAKERS[DEFAULT_SPATIAL_LAYOUT_PRESET_ID]
  }
  return PRESET_SPEAKERS[presetId as Exclude<SpatialLayoutPresetId, 'custom'>]
}

/** Protocol payload for the spatial worklet's init/set-speakers messages. */
export function buildSpatialSpeakerMessage(
  speakers: readonly VirtualSpeaker[]
): SpatialWorkletSpeakerMessage[] {
  return speakers.slice(0, SPATIAL_MAX_SPEAKERS).map((sp) => ({
    azimuthRad: uiDegreesToAmbisonicRadians(sp.azimuth),
    elevationRad: (Math.max(-90, Math.min(90, sp.elevation)) * Math.PI) / 180,
    gain: sp.gain,
    isLfe: isVirtualSpeakerLfe(sp),
  }))
}

export interface RoutingTargetOptions {
  multichannelEnabled: boolean
  binauralActive: boolean
  virtualSpeakerCount: number
  maxDestinationChannels: number
  manualMapLength: number
  hasSourceChannels: boolean
}

/**
 * Target channel count for the per-source routing stage. Pure mirror of
 * AudioEngine.getRoutingOutputChannelCount plus the binaural branch: when
 * binaural is active the render bus width is the virtual layout, independent
 * of the physical destination (headphones are 2ch — that's the point), and
 * the manual routing map is ignored (it has physical-device semantics).
 */
export function resolveRoutingTargetChannelCount(options: RoutingTargetOptions): number {
  if (options.binauralActive) {
    return Math.max(1, Math.min(SPATIAL_MAX_SPEAKERS, options.virtualSpeakerCount))
  }

  const maxChannels = Math.max(1, Math.min(32, options.maxDestinationChannels))
  if (!options.multichannelEnabled) {
    return Math.max(1, Math.min(maxChannels, 2))
  }

  if (options.manualMapLength > 0) {
    return Math.max(1, Math.min(maxChannels, options.manualMapLength))
  }

  if (options.hasSourceChannels) {
    return maxChannels
  }

  return Math.max(1, Math.min(maxChannels, 2))
}
