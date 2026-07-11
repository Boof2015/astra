/*
 * Virtual speaker layouts for the Astra Spatial Engine.
 *
 * A virtual speaker layout is the render target when binaural mode is active:
 * the routing/upmix machinery produces one bus channel per virtual speaker
 * (in speaker-list order, passed to resolveChannelMixMatrix /
 * resolveStereoAmbientUpmixPlan as explicit outputChannelIds), and the
 * spatial worklet renders each bus channel at its speaker's azimuth and
 * elevation.
 *
 * Azimuth convention: UI values are DEGREES, clockwise-from-front, so FR sits
 * at +30 and FL at -30. libspatialaudio expects RADIANS with positive =
 * counterclockwise (listener's left); uiDegreesToAmbisonicRadians is the only
 * place that conversion happens. Elevation is DEGREES above (+) / below (-)
 * ear level, clamped to the MIT HRTF's measured -40..+90 range.
 *
 * Deferred hooks kept in the data model for later phases: per-speaker gain
 * (pinned to 1), distance (unused), free add/remove of speakers (layouts are
 * preset-based), SOFA HRTFs. IAMF/Eclipsa sources will consume this same
 * contract: a VirtualSpeaker list plus its outputChannelIds is everything the
 * render bus needs.
 */

export interface VirtualSpeaker {
  /** Stable identity, e.g. 'vs-FL'. */
  id: string
  /** Source channel role id from sourceChannelLayout: FL/FR/FC/LFE/SL/SR/BL/BR. */
  sourceChannel: string
  /** Degrees, clockwise-from-front, -180..180. */
  azimuth: number
  /** Degrees, clamped to the MIT HRTF measurement range -40..+90. */
  elevation: number
  /** Linear gain. Fixed at 1 in v1. */
  gain: number
  /** Reserved for a later phase. */
  distance?: number
}

export type SpatialMode = 'off' | 'binaural'

export type SpatialLayoutPresetId =
  | 'stereo'
  | 'quad'
  | '5.1'
  | 'wide-5.1'
  | '5.1.2'
  | '7.1'
  | '7.1.4'
  | 'custom'

export interface SpatialWorkletSpeakerMessage {
  azimuthRad: number
  elevationRad: number
  gain: number
  isLfe: boolean
}

export const SPATIAL_MAX_SPEAKERS = 12

/**
 * The embedded MIT KEMAR HRTF is only measured for elevations -40°..+90°.
 * Outside that range the renderer's filter bake fails (silently keeping the
 * previous filter), so every elevation entering the data model or the worklet
 * message is clamped to this range.
 */
export const SPATIAL_MIN_ELEVATION_DEG = -40
export const SPATIAL_MAX_ELEVATION_DEG = 90

export const DEFAULT_SPATIAL_LAYOUT_PRESET_ID: Exclude<SpatialLayoutPresetId, 'custom'> = '5.1'

/** Sample rates supported by the embedded MIT KEMAR HRTF. */
const SPATIAL_SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000]

function speaker(sourceChannel: string, azimuth: number, elevation = 0): VirtualSpeaker {
  return {
    id: `vs-${sourceChannel}`,
    sourceChannel,
    azimuth,
    elevation,
    gain: 1,
  }
}

// Height-free presets (and 7.1.4) match STANDARD_LAYOUTS in
// sourceChannelLayout.ts for the same channel count; layouts that don't
// (5.1.2's 8 speakers are not 7.1 — and future IAMF-decoded beds) are fed to
// resolveChannelMixMatrix/resolveStereoAmbientUpmixPlan via explicit
// outputChannelIds, so the render bus always follows the speaker list order.
// Angles per ITU-R BS.775 (7.1 backs/sides per common Dolby guidance);
// heights at 45° elevation per ITU-R BS.2051 / Dolby home guidance; LFE is
// non-positional.
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
  '5.1.2': [
    speaker('FL', -30),
    speaker('FR', 30),
    speaker('FC', 0),
    speaker('LFE', 0),
    speaker('SL', -110),
    speaker('SR', 110),
    speaker('TFL', -45, 45),
    speaker('TFR', 45, 45),
  ],
  '7.1.4': [
    speaker('FL', -30),
    speaker('FR', 30),
    speaker('FC', 0),
    speaker('LFE', 0),
    speaker('BL', -150),
    speaker('BR', 150),
    speaker('SL', -90),
    speaker('SR', 90),
    speaker('TFL', -45, 45),
    speaker('TFR', 45, 45),
    speaker('TBL', -135, 45),
    speaker('TBR', 135, 45),
  ],
}

export const SPATIAL_LAYOUT_PRESETS: Array<{ id: SpatialLayoutPresetId; label: string }> = [
  { id: 'stereo', label: 'Stereo' },
  { id: 'quad', label: 'Quad' },
  { id: '5.1', label: '5.1' },
  { id: 'wide-5.1', label: 'Wide 5.1' },
  { id: '5.1.2', label: '5.1.2' },
  { id: '7.1', label: '7.1' },
  { id: '7.1.4', label: '7.1.4' },
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

function clampElevationDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(SPATIAL_MIN_ELEVATION_DEG, Math.min(SPATIAL_MAX_ELEVATION_DEG, value))
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
    const elevation = clampElevationDegrees(Number(candidate.elevation))
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
    elevationRad: (clampElevationDegrees(sp.elevation) * Math.PI) / 180,
    gain: sp.gain,
    isLfe: isVirtualSpeakerLfe(sp),
  }))
}

const ROLE_DISPLAY_AZIMUTHS: Record<string, number> = {
  M: 0,
  FL: -30,
  FR: 30,
  FC: 0,
  SL: -110,
  SR: 110,
  BL: -150,
  BR: 150,
  TFL: -45,
  TFR: 45,
  TBL: -135,
  TBR: 135,
}

/**
 * Display angles for visualizing a physical output layout on the speaker
 * stage (Direct mode). Standard layouts use their preset angles; other roles
 * fall back to conventional positions; unknown channels spread evenly.
 * LFE is non-positional and returns null.
 */
export function getDisplayAzimuthsForLayout(channelIds: readonly string[]): Array<number | null> {
  const presetForCount: Partial<Record<number, Exclude<SpatialLayoutPresetId, 'custom'>>> = {
    2: 'stereo',
    4: 'quad',
    6: '5.1',
    8: '7.1',
    12: '7.1.4',
  }
  const presetId = presetForCount[channelIds.length]
  if (presetId) {
    const preset = PRESET_SPEAKERS[presetId]
    if (preset.every((sp, index) => sp.sourceChannel === channelIds[index])) {
      return preset.map((sp) => (isVirtualSpeakerLfe(sp) ? null : sp.azimuth))
    }
  }
  return channelIds.map((id, index) => {
    if (id === 'LFE') return null
    if (id in ROLE_DISPLAY_AZIMUTHS) return ROLE_DISPLAY_AZIMUTHS[id]
    return normalizeUnknownDisplayAzimuth(index, channelIds.length)
  })
}

function normalizeUnknownDisplayAzimuth(index: number, total: number): number {
  const spread = (((index + 0.5) * 360) / Math.max(1, total)) - 180
  return clampAzimuthDegrees(spread)
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
