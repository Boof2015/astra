export type SpeakerRoleId =
  | 'M'
  | 'FL'
  | 'FR'
  | 'FC'
  | 'LFE'
  | 'SL'
  | 'SR'
  | 'BL'
  | 'BR'
  | 'TFL'
  | 'TFR'
  | 'TBL'
  | 'TBR'

export type SpeakerLayoutPresetId =
  | 'mono'
  | 'stereo'
  | 'quad'
  | '5.0'
  | '5.1'
  | '5.1.2'
  | '7.1'
  | '7.1.4'

export interface SpeakerLayoutDefinition {
  id: SpeakerLayoutPresetId
  label: string
  speakers: readonly SpeakerRoleId[]
}

export type SpeakerHardwareOutputMap = Partial<Record<SpeakerRoleId, number>>

export interface DeviceSpeakerProfile {
  layoutId: SpeakerLayoutPresetId
  outputMap: SpeakerHardwareOutputMap
  source: 'manual'
}

export type SourceSpeakerRouteOverride =
  | { kind: 'mute' }
  | { kind: 'source'; sourceChannelId: string }

export type SourceSpeakerRoutingMap = Partial<Record<SpeakerRoleId, SourceSpeakerRouteOverride>>

export interface SpeakerHardwareRoutingPlan {
  hardwareBusWidth: number
  logicalToHardware: number[]
  hardwareToLogical: Array<number | null>
}

const SPEAKER_ROLE_IDS: readonly SpeakerRoleId[] = [
  'M',
  'FL',
  'FR',
  'FC',
  'LFE',
  'SL',
  'SR',
  'BL',
  'BR',
  'TFL',
  'TFR',
  'TBL',
  'TBR',
]

const SPEAKER_ROLE_ID_SET = new Set<string>(SPEAKER_ROLE_IDS)

export const SPEAKER_LAYOUT_PRESETS: readonly SpeakerLayoutDefinition[] = [
  { id: 'mono', label: 'Mono', speakers: ['M'] },
  { id: 'stereo', label: 'Stereo', speakers: ['FL', 'FR'] },
  { id: 'quad', label: 'Quadraphonic', speakers: ['FL', 'FR', 'SL', 'SR'] },
  { id: '5.0', label: '5.0', speakers: ['FL', 'FR', 'FC', 'SL', 'SR'] },
  { id: '5.1', label: '5.1', speakers: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'] },
  { id: '5.1.2', label: '5.1.2', speakers: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR'] },
  { id: '7.1', label: '7.1', speakers: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'] },
  {
    id: '7.1.4',
    label: '7.1.4',
    speakers: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  },
]

const SPEAKER_LAYOUT_BY_ID = new Map(
  SPEAKER_LAYOUT_PRESETS.map((layout) => [layout.id, layout] as const)
)

export function normalizeDeviceMaxChannels(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 2
  return Math.max(1, Math.min(32, Math.trunc(Number(value))))
}

export function isSpeakerRoleId(value: unknown): value is SpeakerRoleId {
  return typeof value === 'string' && SPEAKER_ROLE_ID_SET.has(value)
}

export function isSpeakerLayoutPresetId(value: unknown): value is SpeakerLayoutPresetId {
  return typeof value === 'string' && SPEAKER_LAYOUT_BY_ID.has(value as SpeakerLayoutPresetId)
}

export function getSpeakerLayoutDefinition(layoutId: SpeakerLayoutPresetId): SpeakerLayoutDefinition {
  return SPEAKER_LAYOUT_BY_ID.get(layoutId) ?? SPEAKER_LAYOUT_BY_ID.get('stereo')!
}

export function getDefaultSpeakerLayoutId(deviceMaxChannels: number | null | undefined): SpeakerLayoutPresetId {
  return normalizeDeviceMaxChannels(deviceMaxChannels) === 1 ? 'mono' : 'stereo'
}

function buildSequentialOutputMap(
  speakers: readonly SpeakerRoleId[],
  deviceMaxChannels: number
): SpeakerHardwareOutputMap {
  const outputMap: SpeakerHardwareOutputMap = {}
  speakers.slice(0, deviceMaxChannels).forEach((speaker, outputIndex) => {
    outputMap[speaker] = outputIndex
  })
  return outputMap
}

export function createDefaultDeviceSpeakerProfile(
  deviceMaxChannels: number | null | undefined
): DeviceSpeakerProfile {
  const maxChannels = normalizeDeviceMaxChannels(deviceMaxChannels)
  const layoutId = getDefaultSpeakerLayoutId(maxChannels)
  const layout = getSpeakerLayoutDefinition(layoutId)
  return {
    layoutId,
    outputMap: buildSequentialOutputMap(layout.speakers, maxChannels),
    source: 'manual',
  }
}

export function resolveDeviceSpeakerProfile(
  profiles: Readonly<Record<string, DeviceSpeakerProfile>>,
  deviceKey: string,
  deviceMaxChannels: number | null | undefined
): DeviceSpeakerProfile {
  const savedProfile = profiles[deviceKey]
  return savedProfile
    ? normalizeDeviceSpeakerProfile(savedProfile, deviceMaxChannels)
    : createDefaultDeviceSpeakerProfile(deviceMaxChannels)
}

export function normalizeDeviceSpeakerProfile(
  value: unknown,
  deviceMaxChannels: number | null | undefined
): DeviceSpeakerProfile {
  const maxChannels = normalizeDeviceMaxChannels(deviceMaxChannels)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createDefaultDeviceSpeakerProfile(maxChannels)
  }

  const raw = value as { layoutId?: unknown; outputMap?: unknown }
  if (!isSpeakerLayoutPresetId(raw.layoutId)) {
    return createDefaultDeviceSpeakerProfile(maxChannels)
  }

  const layout = getSpeakerLayoutDefinition(raw.layoutId)
  const rawOutputMap = raw.outputMap && typeof raw.outputMap === 'object' && !Array.isArray(raw.outputMap)
    ? raw.outputMap as Record<string, unknown>
    : {}
  const usedOutputs = new Set<number>()
  const outputMap: SpeakerHardwareOutputMap = {}

  for (const speaker of layout.speakers) {
    const rawOutput = rawOutputMap[speaker]
    if (!Number.isFinite(rawOutput)) continue
    const outputIndex = Math.trunc(Number(rawOutput))
    if (outputIndex < 0 || outputIndex >= maxChannels || usedOutputs.has(outputIndex)) continue
    usedOutputs.add(outputIndex)
    outputMap[speaker] = outputIndex
  }

  return {
    layoutId: layout.id,
    outputMap,
    source: 'manual',
  }
}

export function transitionDeviceSpeakerLayout(
  profile: DeviceSpeakerProfile,
  nextLayoutId: SpeakerLayoutPresetId,
  deviceMaxChannels: number | null | undefined
): DeviceSpeakerProfile {
  const maxChannels = normalizeDeviceMaxChannels(deviceMaxChannels)
  const nextLayout = getSpeakerLayoutDefinition(nextLayoutId)
  if (nextLayout.speakers.length > maxChannels) return profile

  const usedOutputs = new Set<number>()
  const outputMap: SpeakerHardwareOutputMap = {}

  for (const speaker of nextLayout.speakers) {
    const existing = profile.outputMap[speaker]
    if (existing == null || existing < 0 || existing >= maxChannels || usedOutputs.has(existing)) continue
    usedOutputs.add(existing)
    outputMap[speaker] = existing
  }

  for (const speaker of nextLayout.speakers) {
    if (outputMap[speaker] != null) continue
    const nextFreeOutput = Array.from({ length: maxChannels }, (_, index) => index)
      .find((index) => !usedOutputs.has(index))
    if (nextFreeOutput == null) break
    usedOutputs.add(nextFreeOutput)
    outputMap[speaker] = nextFreeOutput
  }

  return {
    layoutId: nextLayoutId,
    outputMap,
    source: 'manual',
  }
}

export function setSpeakerHardwareOutput(
  profile: DeviceSpeakerProfile,
  speaker: SpeakerRoleId,
  hardwareOutputIndex: number | null,
  deviceMaxChannels: number | null | undefined
): DeviceSpeakerProfile {
  const layout = getSpeakerLayoutDefinition(profile.layoutId)
  if (!layout.speakers.includes(speaker)) return profile

  const outputMap = { ...profile.outputMap }
  if (hardwareOutputIndex == null) {
    delete outputMap[speaker]
    return { ...profile, outputMap }
  }

  const maxChannels = normalizeDeviceMaxChannels(deviceMaxChannels)
  if (!Number.isInteger(hardwareOutputIndex) || hardwareOutputIndex < 0 || hardwareOutputIndex >= maxChannels) {
    return profile
  }

  const occupied = layout.speakers.some((candidate) => (
    candidate !== speaker && outputMap[candidate] === hardwareOutputIndex
  ))
  if (occupied) return profile

  outputMap[speaker] = hardwareOutputIndex
  return { ...profile, outputMap }
}

export function resolveDirectSpeakerIds(
  profile: DeviceSpeakerProfile,
  multichannelEnabled: boolean
): SpeakerRoleId[] {
  const speakers = [...getSpeakerLayoutDefinition(profile.layoutId).speakers]
  if (multichannelEnabled || speakers.length <= 1) return speakers
  return speakers.filter((speaker) => speaker === 'FL' || speaker === 'FR')
}

export function buildSpeakerHardwareRoutingPlan(
  profile: DeviceSpeakerProfile
): SpeakerHardwareRoutingPlan {
  const speakers = getSpeakerLayoutDefinition(profile.layoutId).speakers
  const logicalToHardware = speakers.map((speaker) => profile.outputMap[speaker] ?? -1)
  const highestOutput = logicalToHardware.reduce((highest, output) => Math.max(highest, output), -1)
  const hardwareBusWidth = Math.max(1, highestOutput + 1)
  const hardwareToLogical: Array<number | null> = Array.from(
    { length: hardwareBusWidth },
    () => null
  )

  logicalToHardware.forEach((hardwareOutput, logicalIndex) => {
    if (hardwareOutput >= 0 && hardwareOutput < hardwareBusWidth) {
      hardwareToLogical[hardwareOutput] = logicalIndex
    }
  })

  return { hardwareBusWidth, logicalToHardware, hardwareToLogical }
}

export function normalizeSourceSpeakerRoutingMap(value: unknown): SourceSpeakerRoutingMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const normalized: SourceSpeakerRoutingMap = {}
  for (const [speaker, rawRoute] of Object.entries(value)) {
    if (!isSpeakerRoleId(speaker) || !rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) continue
    const route = rawRoute as { kind?: unknown; sourceChannelId?: unknown }
    if (route.kind === 'mute') {
      normalized[speaker] = { kind: 'mute' }
    } else if (
      route.kind === 'source'
      && typeof route.sourceChannelId === 'string'
      && route.sourceChannelId.trim().length > 0
    ) {
      normalized[speaker] = { kind: 'source', sourceChannelId: route.sourceChannelId.trim() }
    }
  }

  return normalized
}
