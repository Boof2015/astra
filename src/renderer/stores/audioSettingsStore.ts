import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'
import {
  normalizeStereoUpmixMode,
  type StereoUpmixMode,
} from '../utils/sourceChannelLayout'
import {
  buildVirtualSpeakerLayout,
  normalizeSpatialLayoutPresetId,
  normalizeSpatialMode,
  normalizeVirtualSpeakers,
  type SpatialLayoutPresetId,
  type SpatialMode,
  type VirtualSpeaker,
} from '../utils/virtualSpeakerLayout'
import type { SpatialStatus } from '../audio/AudioEngine'
import type { NativeAudioCapabilities, PlaybackOutputMode } from '../../types/nativeAudio'

export interface AudioDevice {
  deviceId: string
  label: string
  groupId: string
  isDefaultAlias: boolean
}

export interface CalibrationInputDevice {
  deviceId: string
  label: string
  groupId: string
  isDefaultAlias: boolean
}

export type DelayCompensationMode = 'manual' | 'auto'
export type DelayCalibrationMethod = 'legacy' | 'differential'
export type ReplayGainMode = 'auto' | 'track' | 'album'

type DelayCalibrationState = 'idle' | 'running' | 'success' | 'error'

export interface DelayCompensationProfile {
  enabled: boolean
  mode: DelayCompensationMode
  calibrationMethod: DelayCalibrationMethod
  differentialReferenceOutputDeviceId: string
  manualOffsetMs: number
  autoOffsetMs: number | null
  lastRoundTripMs: number | null
  lastCalibrationInputKey: string | null
  lastCalibrationSampleRate: number | null
  lastCalibrationConfidence: number | null
  lastCalibrationMethod: DelayCalibrationMethod | null
  lastCalibrationAt: number | null
}

export interface InputDelayBaseline {
  baselineRttMs: number
  sampleRate: number
  updatedAt: number
}

interface AudioSettingsStore {
  playbackOutputMode: PlaybackOutputMode
  disableGaplessPrebufferDev: boolean
  disableStandardAnalysisGraphDev: boolean
  nativeAudioCapabilities: NativeAudioCapabilities
  playbackModeStatusMessage: string | null
  selectedDeviceId: string
  availableDevices: AudioDevice[]
  availableInputDevices: CalibrationInputDevice[]
  selectedCalibrationInputDeviceId: string
  selectedOutputChannelCount: number | null
  multichannelEnabled: boolean
  includeLfeInDownmix: boolean
  stereoUpmixMode: StereoUpmixMode
  channelRoutingMap: number[] | null
  spatialMode: SpatialMode
  spatialLayoutPresetId: SpatialLayoutPresetId
  customVirtualSpeakers: VirtualSpeaker[] | null
  spatialStatus: SpatialStatus
  normalizationEnabled: boolean
  normalizationTargetLufs: number
  replayGainScanEnabled: boolean
  replayGainMode: ReplayGainMode

  delayProfilesByDeviceKey: Record<string, DelayCompensationProfile>
  inputBaselinesByKey: Record<string, InputDelayBaseline>
  activeDelayProfileKey: string
  activeDelayProfile: DelayCompensationProfile
  effectiveDelayMs: number
  delayCalibrationState: DelayCalibrationState
  delayCalibrationMessage: string | null

  refreshDevices: () => Promise<void>
  refreshOutputChannelCount: () => Promise<void>
  setPlaybackOutputMode: (mode: PlaybackOutputMode) => Promise<void>
  setDisableGaplessPrebufferDev: (disabled: boolean) => void
  setDisableStandardAnalysisGraphDev: (disabled: boolean) => void
  selectDevice: (deviceId: string) => Promise<void>
  setCalibrationInputDeviceId: (deviceId: string) => void
  setMultichannelEnabled: (enabled: boolean) => Promise<void>
  setIncludeLfeInDownmix: (enabled: boolean) => Promise<void>
  setStereoUpmixMode: (mode: StereoUpmixMode) => Promise<void>
  setChannelRoutingMap: (map: number[] | null) => Promise<void>
  resetChannelRoutingMap: () => Promise<void>
  setSpatialMode: (mode: SpatialMode) => Promise<void>
  setSpatialLayoutPreset: (presetId: SpatialLayoutPresetId) => Promise<void>
  setVirtualSpeakerAzimuth: (speakerId: string, azimuthDeg: number) => Promise<void>
  setVirtualSpeakerElevation: (speakerId: string, elevationDeg: number) => Promise<void>
  resetSpatialSettings: () => Promise<void>
  setNormalizationEnabled: (enabled: boolean) => void
  setNormalizationTargetLufs: (targetLufs: number) => void
  setReplayGainScanEnabled: (enabled: boolean) => Promise<void>
  setReplayGainMode: (mode: ReplayGainMode) => void

  setDelayCompensationEnabled: (enabled: boolean) => Promise<void>
  setDelayCompensationMode: (mode: DelayCompensationMode) => Promise<void>
  setDelayCalibrationMethod: (method: DelayCalibrationMethod) => Promise<void>
  setDifferentialReferenceOutputDeviceId: (deviceId: string) => Promise<void>
  setDelayCompensationManualOffsetMs: (offsetMs: number) => Promise<void>
  runDelayAutoCalibration: () => Promise<void>
  resetDelayToAutoGuess: () => Promise<void>
  resetToDefaults: () => Promise<void>

  initFromSaved: () => Promise<void>
}

const STORAGE_KEY = 'astra-audio-output-device'
const NATIVE_OUTPUT_STORAGE_KEY = 'astra-native-audio-output-device'
const PLAYBACK_OUTPUT_MODE_STORAGE_KEY = 'astra-playback-output-mode-v1'
const CALIBRATION_INPUT_STORAGE_KEY = 'astra-audio-calibration-input-device'
const MULTICHANNEL_STORAGE_KEY = 'astra-audio-multichannel-enabled'
const INCLUDE_LFE_DOWNMIX_STORAGE_KEY = 'astra-audio-include-lfe-downmix-v1'
const STEREO_UPMIX_MODE_STORAGE_KEY = 'astra-audio-stereo-upmix-mode-v1'
const SPATIAL_MODE_STORAGE_KEY = 'astra-audio-spatial-mode-v1'
const SPATIAL_LAYOUT_STORAGE_KEY = 'astra-audio-spatial-layout-v1'
const ROUTING_STORAGE_KEY = 'astra-audio-channel-routing-map'
export const NORMALIZATION_ENABLED_STORAGE_KEY = 'astra-audio-normalization-enabled-v1'
export const NORMALIZATION_TARGET_STORAGE_KEY = 'astra-audio-normalization-target-lufs-v1'
export const REPLAYGAIN_MODE_STORAGE_KEY = 'astra-audio-replaygain-mode-v1'
const DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY = 'astra-dev-disable-gapless-prebuffer-v1'
const DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY = 'astra-dev-disable-standard-analysis-graph-v1'
const DELAY_PROFILE_STORAGE_KEY_V1 = 'astra-audio-delay-profiles-v1'
const DELAY_PROFILE_STORAGE_KEY_V2 = 'astra-audio-delay-profiles-v2'
const OUTPUT_GROUP_PROFILE_KEY_PREFIX = 'group:'
export const DEFAULT_NORMALIZATION_TARGET_LUFS = audioEngine.targetLufs
export const BIT_PERFECT_DSP_DISABLED_MESSAGE = 'Bit-perfect mode bypasses all app DSP and uses exclusive/direct device output.'
const BIT_PERFECT_LINUX_DEVICE_SELECTION_MESSAGE = 'Bit-perfect mode on Linux requires selecting a direct ALSA hardware output device.'

const DEFAULT_DELAY_PROFILE: DelayCompensationProfile = {
  enabled: false,
  mode: 'manual',
  calibrationMethod: 'legacy',
  differentialReferenceOutputDeviceId: '',
  manualOffsetMs: 0,
  autoOffsetMs: null,
  lastRoundTripMs: null,
  lastCalibrationInputKey: null,
  lastCalibrationSampleRate: null,
  lastCalibrationConfidence: null,
  lastCalibrationMethod: null,
  lastCalibrationAt: null,
}

const DEFAULT_NATIVE_AUDIO_CAPABILITIES: NativeAudioCapabilities = {
  bitPerfectAvailable: false,
  reasonUnavailable: 'Native bit-perfect playback is unavailable in this build.',
  activeBackend: 'unavailable',
  activeDeviceExclusive: false,
  activeSampleRate: null,
  activeSampleFormat: null,
  selectedDeviceId: null,
  selectedDeviceMaxChannels: null,
  devices: []
}

const MAX_DELAY_MS = 2500
const MAX_BASELINE_RTT_MS = 5000
const DELAY_STEP_MS = 5
const BASELINE_IMPROVEMENT_THRESHOLD_MS = 10
const REPORTED_INPUT_LATENCY_MAX_MS = 3500
const REPORTED_INPUT_LATENCY_ROUNDTRIP_TOLERANCE_MS = 300
const REPORTED_INPUT_BASELINE_LOWER_MIN_CONFIDENCE = 0.32
const OUTPUT_ANCHOR_MIN_CONFIDENCE = 0.28
const OUTPUT_ANCHOR_ROUNDTRIP_TOLERANCE_MS = 250
const AUTO_OFFSET_DOWNWARD_OUTLIER_DELTA_MS = 220
const AUTO_OFFSET_DOWNWARD_OUTLIER_MAX_CONFIDENCE = 0.5
let mediaDeviceChangeListenerAttached = false
const SYSTEM_DEFAULT_LABEL_SUFFIX = ' (System Default)'
const DEFAULT_ALIAS_PREFIX_PATTERN = /^\s*default\s*-\s*/i

function clampAppliedDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value / DELAY_STEP_MS) * DELAY_STEP_MS
  return Math.max(0, Math.min(MAX_DELAY_MS, rounded))
}

function clampSignedFineTuneMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value / DELAY_STEP_MS) * DELAY_STEP_MS
  return Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, rounded))
}

function clampManualOffsetForMode(mode: DelayCompensationMode, value: number): number {
  if (mode === 'manual') {
    return clampAppliedDelayMs(value)
  }

  return clampSignedFineTuneMs(value)
}

function clampRoundTripMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_BASELINE_RTT_MS, Math.round(value)))
}

function normalizeSampleRate(value: unknown): number | null {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(Number(value))
  if (rounded <= 0) return null
  return rounded
}

function normalizeDelayMode(value: unknown): DelayCompensationMode {
  if (value === 'auto' || value === 'auto-manual') return 'auto'
  if (value === 'manual') return 'manual'
  return 'manual'
}

function normalizeCalibrationMethod(value: unknown): DelayCalibrationMethod {
  return value === 'differential' ? 'differential' : 'legacy'
}

function normalizeReplayGainMode(value: unknown): ReplayGainMode {
  if (value === 'track') return 'track'
  if (value === 'album') return 'album'
  return 'auto'
}

function isDevBuild(): boolean {
  return Boolean(import.meta.env?.DEV)
}

function readDevDisableGaplessPrebuffer(): boolean {
  if (!isDevBuild()) return false
  try {
    return localStorage.getItem(DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function readDevDisableStandardAnalysisGraph(): boolean {
  if (!isDevBuild()) return false
  try {
    return localStorage.getItem(DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function normalizeDelayProfile(value: unknown): DelayCompensationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DELAY_PROFILE }
  }

  const raw = value as Partial<DelayCompensationProfile>
  const mode = normalizeDelayMode(raw.mode)
  const calibrationMethod = normalizeCalibrationMethod(raw.calibrationMethod)
  const autoOffsetMs = raw.autoOffsetMs == null ? null : clampAppliedDelayMs(raw.autoOffsetMs)
  const lastRoundTripMs = raw.lastRoundTripMs == null ? null : clampRoundTripMs(raw.lastRoundTripMs)
  const lastCalibrationInputKey = typeof raw.lastCalibrationInputKey === 'string' && raw.lastCalibrationInputKey.trim().length > 0
    ? raw.lastCalibrationInputKey.trim()
    : null
  const normalizedReferenceOutputId = typeof raw.differentialReferenceOutputDeviceId === 'string'
    ? raw.differentialReferenceOutputDeviceId.trim()
    : ''

  return {
    enabled: Boolean(raw.enabled),
    mode,
    calibrationMethod,
    differentialReferenceOutputDeviceId: normalizedReferenceOutputId === 'default'
      ? ''
      : normalizedReferenceOutputId,
    manualOffsetMs: clampManualOffsetForMode(mode, raw.manualOffsetMs ?? 0),
    autoOffsetMs,
    lastRoundTripMs,
    lastCalibrationInputKey,
    lastCalibrationSampleRate: normalizeSampleRate(raw.lastCalibrationSampleRate),
    lastCalibrationConfidence: Number.isFinite(raw.lastCalibrationConfidence)
      ? Math.max(0, Math.min(1, Number(raw.lastCalibrationConfidence)))
      : null,
    lastCalibrationMethod: raw.lastCalibrationMethod == null
      ? null
      : normalizeCalibrationMethod(raw.lastCalibrationMethod),
    lastCalibrationAt: Number.isFinite(raw.lastCalibrationAt)
      ? Math.max(0, Math.trunc(Number(raw.lastCalibrationAt)))
      : null,
  }
}

function areDelayProfilesEqual(a: DelayCompensationProfile, b: DelayCompensationProfile): boolean {
  return a.enabled === b.enabled
    && a.mode === b.mode
    && a.calibrationMethod === b.calibrationMethod
    && a.differentialReferenceOutputDeviceId === b.differentialReferenceOutputDeviceId
    && a.manualOffsetMs === b.manualOffsetMs
    && a.autoOffsetMs === b.autoOffsetMs
    && a.lastRoundTripMs === b.lastRoundTripMs
    && a.lastCalibrationInputKey === b.lastCalibrationInputKey
    && a.lastCalibrationSampleRate === b.lastCalibrationSampleRate
    && a.lastCalibrationConfidence === b.lastCalibrationConfidence
    && a.lastCalibrationMethod === b.lastCalibrationMethod
    && a.lastCalibrationAt === b.lastCalibrationAt
}

function parseDelayProfilesValue(value: unknown): Record<string, DelayCompensationProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const map: Record<string, DelayCompensationProfile> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key || typeof key !== 'string') continue
    map[key] = normalizeDelayProfile(rawValue)
  }

  return map
}

function parseDelayProfiles(raw: string | null): Record<string, DelayCompensationProfile> {
  if (!raw) return {}

  try {
    return parseDelayProfilesValue(JSON.parse(raw))
  } catch {
    return {}
  }
}

function normalizeInputDelayBaseline(value: unknown): InputDelayBaseline | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Partial<InputDelayBaseline>
  const sampleRate = normalizeSampleRate(raw.sampleRate)
  if (!sampleRate) return null

  return {
    baselineRttMs: clampRoundTripMs(raw.baselineRttMs ?? 0),
    sampleRate,
    updatedAt: Number.isFinite(raw.updatedAt)
      ? Math.max(0, Math.trunc(Number(raw.updatedAt)))
      : Date.now()
  }
}

function parseInputDelayBaselines(value: unknown): Record<string, InputDelayBaseline> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const map: Record<string, InputDelayBaseline> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key || typeof key !== 'string') continue
    const normalized = normalizeInputDelayBaseline(rawValue)
    if (!normalized) continue
    map[key] = normalized
  }

  return map
}

function parseDelaySettingsV2(raw: string | null): {
  profiles: Record<string, DelayCompensationProfile>
  inputBaselinesByKey: Record<string, InputDelayBaseline>
} {
  if (!raw) {
    return {
      profiles: {},
      inputBaselinesByKey: {}
    }
  }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        profiles: {},
        inputBaselinesByKey: {}
      }
    }

    const envelope = parsed as {
      profiles?: unknown
      inputBaselinesByKey?: unknown
    }

    return {
      profiles: parseDelayProfilesValue(envelope.profiles),
      inputBaselinesByKey: parseInputDelayBaselines(envelope.inputBaselinesByKey)
    }
  } catch {
    return {
      profiles: {},
      inputBaselinesByKey: {}
    }
  }
}

function computeEffectiveDelayMs(profile: DelayCompensationProfile): number {
  if (!profile.enabled) return 0

  if (profile.mode === 'manual') {
    return clampAppliedDelayMs(profile.manualOffsetMs)
  }

  return clampAppliedDelayMs((profile.autoOffsetMs ?? 0) + clampSignedFineTuneMs(profile.manualOffsetMs))
}

function computeAppliedDelayMs(
  profile: DelayCompensationProfile,
  playbackOutputMode: PlaybackOutputMode
): number {
  if (playbackOutputMode === 'bitperfect') return 0
  return computeEffectiveDelayMs(profile)
}

function getOutputStorageKeyForMode(mode: PlaybackOutputMode): string {
  return mode === 'bitperfect' ? NATIVE_OUTPUT_STORAGE_KEY : STORAGE_KEY
}

function normalizePlaybackOutputMode(value: unknown): PlaybackOutputMode {
  return value === 'bitperfect' ? 'bitperfect' : 'standard'
}

function resolvePhysicalDefaultDeviceId(devices: AudioDevice[]): string | null {
  const defaultAlias = devices.find((device) => device.isDefaultAlias)
  if (!defaultAlias || !defaultAlias.groupId) return null

  const physical = devices.find((device) => (
    !device.isDefaultAlias
    && device.groupId.length > 0
    && device.groupId === defaultAlias.groupId
  ))

  return physical?.deviceId ?? null
}

function sanitizeDefaultAliasLabel(label: string): string {
  return label.replace(DEFAULT_ALIAS_PREFIX_PATTERN, '').trim()
}

function appendSystemDefaultSuffix(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  if (trimmed.endsWith(SYSTEM_DEFAULT_LABEL_SUFFIX)) return trimmed
  return `${trimmed}${SYSTEM_DEFAULT_LABEL_SUFFIX}`
}

export function resolveOutputDeviceLabel(
  selectedDeviceId: string,
  devices: AudioDevice[],
  options: {
    defaultRouteFallbackLabel?: string
    selectedFallbackLabel?: string
  } = {}
): {
  label: string
  isSystemDefaultRoute: boolean
} {
  const defaultRouteFallbackLabel = options.defaultRouteFallbackLabel ?? 'System Default Output'
  const selectedFallbackLabel = options.selectedFallbackLabel ?? 'Selected Output'
  const normalizedSelection = selectedDeviceId.trim()
  const isSystemDefaultRoute = normalizedSelection.length === 0 || normalizedSelection === 'default'

  if (!isSystemDefaultRoute) {
    const selectedDevice = devices.find((device) => device.deviceId === normalizedSelection) ?? null
    const selectedLabel = selectedDevice?.label.trim() ?? ''
    return {
      label: selectedLabel.length > 0 ? selectedLabel : selectedFallbackLabel,
      isSystemDefaultRoute: false
    }
  }

  const physicalDefaultId = resolvePhysicalDefaultDeviceId(devices)
  const physicalDefaultLabel = physicalDefaultId
    ? (devices.find((device) => device.deviceId === physicalDefaultId)?.label.trim() ?? '')
    : ''
  if (physicalDefaultLabel.length > 0) {
    return {
      label: appendSystemDefaultSuffix(physicalDefaultLabel),
      isSystemDefaultRoute: true
    }
  }

  const defaultAlias = devices.find((device) => device.isDefaultAlias) ?? null
  const sanitizedAlias = defaultAlias ? sanitizeDefaultAliasLabel(defaultAlias.label) : ''
  if (sanitizedAlias.length > 0) {
    return {
      label: appendSystemDefaultSuffix(sanitizedAlias),
      isSystemDefaultRoute: true
    }
  }

  if (devices.length > 0) {
    return {
      label: selectedFallbackLabel,
      isSystemDefaultRoute: false
    }
  }

  return {
    label: defaultRouteFallbackLabel,
    isSystemDefaultRoute: true
  }
}

function resolveInitialNativeOutputSelection(
  capabilities: NativeAudioCapabilities,
  devices: AudioDevice[]
): {
  deviceId: string
  statusMessage: string | null
} {
  const selectedNativeDeviceId = capabilities.selectedDeviceId?.trim() ?? ''
  if (selectedNativeDeviceId.length > 0 && devices.some((device) => device.deviceId === selectedNativeDeviceId)) {
    return {
      deviceId: selectedNativeDeviceId,
      statusMessage: null
    }
  }

  if (capabilities.activeBackend !== 'alsa-hw') {
    const physicalDefaultId = resolvePhysicalDefaultDeviceId(devices)
    if (physicalDefaultId) {
      return {
        deviceId: physicalDefaultId,
        statusMessage: null
      }
    }

    const firstPhysicalDevice = devices.find((device) => !device.isDefaultAlias) ?? null
    return {
      deviceId: firstPhysicalDevice?.deviceId ?? '',
      statusMessage: null
    }
  }

  const physicalDevices = devices.filter((device) => !device.isDefaultAlias)
  if (physicalDevices.length === 1) {
    return {
      deviceId: physicalDevices[0].deviceId,
      statusMessage: null
    }
  }

  return {
    deviceId: '',
    statusMessage: physicalDevices.length > 0
      ? BIT_PERFECT_LINUX_DEVICE_SELECTION_MESSAGE
      : null
  }
}

function buildOutputGroupProfileKey(groupId: string): string {
  return `${OUTPUT_GROUP_PROFILE_KEY_PREFIX}${groupId}`
}

function dedupeKeys(values: string[], exclude: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized.length === 0) continue
    if (normalized === exclude) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function resolveActiveDelayProfileTarget(
  selectedDeviceId: string,
  devices: AudioDevice[]
): {
  key: string
  legacyFallbackKeys: string[]
} {
  const normalizedSelection = selectedDeviceId.trim()
  const isSystemDefault = normalizedSelection.length === 0 || normalizedSelection === 'default'

  if (!isSystemDefault) {
    const selectedDevice = devices.find((device) => device.deviceId === normalizedSelection) ?? null
    if (selectedDevice?.groupId) {
      const groupKey = buildOutputGroupProfileKey(selectedDevice.groupId)
      const sameGroupDeviceIds = devices
        .filter((device) => (
          !device.isDefaultAlias
          && device.groupId.length > 0
          && device.groupId === selectedDevice.groupId
        ))
        .map((device) => device.deviceId)
      return {
        key: normalizedSelection,
        legacyFallbackKeys: dedupeKeys(
          [groupKey, ...sameGroupDeviceIds],
          normalizedSelection
        )
      }
    }

    return {
      key: normalizedSelection,
      legacyFallbackKeys: []
    }
  }

  const physicalDefaultId = resolvePhysicalDefaultDeviceId(devices)
  if (!physicalDefaultId) {
    return {
      key: 'default',
      legacyFallbackKeys: []
    }
  }

  const physicalDevice = devices.find((device) => device.deviceId === physicalDefaultId) ?? null
  if (physicalDevice?.groupId) {
    const key = buildOutputGroupProfileKey(physicalDevice.groupId)
    const sameGroupDeviceIds = devices
      .filter((device) => (
        !device.isDefaultAlias
        && device.groupId.length > 0
        && device.groupId === physicalDevice.groupId
      ))
      .map((device) => device.deviceId)

    return {
      key: physicalDefaultId,
      legacyFallbackKeys: dedupeKeys(
        [key, ...sameGroupDeviceIds],
        physicalDefaultId
      )
    }
  }

  return {
    key: physicalDefaultId,
    legacyFallbackKeys: []
  }
}

function resolveDelayProfileForTarget(
  profiles: Record<string, DelayCompensationProfile>,
  target: { key: string; legacyFallbackKeys: string[] }
): {
  profile: DelayCompensationProfile
} {
  const direct = profiles[target.key]
  const directNormalized = direct ? normalizeDelayProfile(direct) : null
  const fallbackCandidates: DelayCompensationProfile[] = []
  for (const key of target.legacyFallbackKeys) {
    const fallback = profiles[key]
    if (!fallback) continue
    fallbackCandidates.push(normalizeDelayProfile(fallback))
  }

  // Prefer the most recent calibrated profile when timestamps are available.
  let bestByTimestamp: DelayCompensationProfile | null = directNormalized
  let bestTimestamp = directNormalized?.lastCalibrationAt ?? 0
  for (const candidate of fallbackCandidates) {
    const timestamp = candidate.lastCalibrationAt ?? 0
    if (!bestByTimestamp || timestamp > bestTimestamp) {
      bestByTimestamp = candidate
      bestTimestamp = timestamp
    }
  }
  if (bestByTimestamp && bestTimestamp > 0) {
    return {
      profile: bestByTimestamp
    }
  }

  // If timestamps are missing, preserve any known auto estimate over empty defaults.
  if (directNormalized?.autoOffsetMs != null) {
    return {
      profile: directNormalized
    }
  }
  const fallbackWithEstimate = fallbackCandidates.find((candidate) => candidate.autoOffsetMs != null)
  if (fallbackWithEstimate) {
    return {
      profile: fallbackWithEstimate
    }
  }

  if (directNormalized) {
    return {
      profile: directNormalized
    }
  }

  const firstFallback = fallbackCandidates[0]
  if (firstFallback) {
    return {
      profile: firstFallback
    }
  }

  // Last-resort recovery path for key churn: keep the most recently calibrated
  // non-empty profile instead of dropping to defaults.
  let bestGlobalWithEstimate: DelayCompensationProfile | null = null
  let bestGlobalTimestamp = Number.NEGATIVE_INFINITY
  for (const rawProfile of Object.values(profiles)) {
    const normalized = normalizeDelayProfile(rawProfile)
    if (normalized.autoOffsetMs == null) continue
    const timestamp = normalized.lastCalibrationAt ?? 0
    if (bestGlobalWithEstimate == null || timestamp > bestGlobalTimestamp) {
      bestGlobalWithEstimate = normalized
      bestGlobalTimestamp = timestamp
    }
  }
  if (bestGlobalWithEstimate) {
    return {
      profile: bestGlobalWithEstimate
    }
  }

  return {
    profile: { ...DEFAULT_DELAY_PROFILE }
  }
}

function upsertCanonicalDelayProfileForTarget(
  profiles: Record<string, DelayCompensationProfile>,
  target: { key: string; legacyFallbackKeys: string[] },
  profile: DelayCompensationProfile
): {
  profiles: Record<string, DelayCompensationProfile>
  changed: boolean
} {
  const normalizedProfile = normalizeDelayProfile(profile)
  const currentAtTarget = profiles[target.key]
  if (currentAtTarget && areDelayProfilesEqual(currentAtTarget, normalizedProfile)) {
    return {
      profiles,
      changed: false
    }
  }

  const nextProfiles: Record<string, DelayCompensationProfile> = {
    ...profiles,
    [target.key]: normalizedProfile
  }

  return {
    profiles: nextProfiles,
    changed: true
  }
}

function resolvePhysicalDefaultInputDeviceId(inputs: CalibrationInputDevice[]): string | null {
  const defaultAlias = inputs.find((input) => input.isDefaultAlias)
  if (!defaultAlias || !defaultAlias.groupId) return null

  const physical = inputs.find((input) => (
    !input.isDefaultAlias
    && input.groupId.length > 0
    && input.groupId === defaultAlias.groupId
  ))

  return physical?.deviceId ?? null
}

function resolveCalibrationInputDeviceKey(
  selectedInputDeviceId: string,
  inputs: CalibrationInputDevice[]
): string {
  const normalizedSelection = selectedInputDeviceId.trim()
  const isSystemDefault = normalizedSelection.length === 0 || normalizedSelection === 'default'
  if (!isSystemDefault) {
    return normalizedSelection
  }

  return resolvePhysicalDefaultInputDeviceId(inputs) ?? 'default-input'
}

function buildInputBaselineKey(inputDeviceKey: string, sampleRate: number): string {
  return `${inputDeviceKey}@${sampleRate}`
}

function buildAudioDevice(entry: MediaDeviceInfo): AudioDevice {
  const deviceId = entry.deviceId
  const isDefaultAlias = deviceId === 'default' || deviceId === ''
  const fallbackLabel = isDefaultAlias
    ? 'System Default Device'
    : `Speaker (${deviceId.slice(0, 8)}...)`

  return {
    deviceId,
    label: entry.label || fallbackLabel,
    groupId: entry.groupId || '',
    isDefaultAlias,
  }
}

function buildNativeOutputDevices(capabilities: NativeAudioCapabilities): AudioDevice[] {
  const mappedDevices = capabilities.devices.map((device) => ({
    deviceId: device.deviceId,
    label: device.label,
    groupId: device.deviceId,
    isDefaultAlias: false
  }))

  if (capabilities.activeBackend === 'alsa-hw') {
    return mappedDevices
  }

  const defaultDevice = capabilities.devices.find((device) => device.isDefault) ?? null
  if (!defaultDevice) {
    return [
      {
        deviceId: '',
        label: 'System Default Output',
        groupId: '',
        isDefaultAlias: true
      },
      ...mappedDevices
    ]
  }

  return [
    {
      deviceId: '',
      label: appendSystemDefaultSuffix(defaultDevice.label),
      groupId: defaultDevice.deviceId,
      isDefaultAlias: true
    },
    ...mappedDevices
  ]
}

function buildCalibrationInputDevice(entry: MediaDeviceInfo): CalibrationInputDevice {
  const deviceId = entry.deviceId
  const isDefaultAlias = deviceId === 'default' || deviceId === ''
  const fallbackLabel = isDefaultAlias
    ? 'System Default Input'
    : `Input (${deviceId.slice(0, 8)}...)`

  return {
    deviceId,
    label: entry.label || fallbackLabel,
    groupId: entry.groupId || '',
    isDefaultAlias,
  }
}

function formatCalibrationFailureMessage(message: string, code: string): string {
  if (code === 'mic-denied' || code === 'mic-unavailable') {
    return `${message} Falling back to manual offset.`
  }
  if (code === 'low-confidence') {
    return `${message} Keep using manual offset or retry in a quieter setup.`
  }
  return message
}

function formatDifferentialCalibrationFailureMessage(message: string, code: string): string {
  if (code === 'not-supported') {
    return `${message} Switch to Old (Legacy) method for this device or retry on a supported setup.`
  }
  if (code === 'mic-denied' || code === 'mic-unavailable') {
    return `${message} Grant mic access and retry New (Differential) calibration.`
  }
  if (code === 'low-confidence' || code === 'timeout') {
    return `${message} Keep both outputs audible to the mic, then retry New (Differential).`
  }
  return `${message} Retry New (Differential) calibration.`
}

export const useAudioSettingsStore = create<AudioSettingsStore>((set, get) => {
  const persistDelaySettings = (
    profiles: Record<string, DelayCompensationProfile>,
    inputBaselinesByKey: Record<string, InputDelayBaseline>
  ) => {
    localStorage.setItem(DELAY_PROFILE_STORAGE_KEY_V2, JSON.stringify({
      version: 2,
      profiles,
      inputBaselinesByKey
    }))
    localStorage.removeItem(DELAY_PROFILE_STORAGE_KEY_V1)
  }

  const syncDelayCompensationForActiveDevice = async (
    options: { resetCalibrationStatus?: boolean } = {}
  ): Promise<void> => {
    const state = get()
    const profileTarget = resolveActiveDelayProfileTarget(state.selectedDeviceId, state.availableDevices)
    const activeDelayProfileKey = profileTarget.key

    const normalizedProfile = resolveDelayProfileForTarget(state.delayProfilesByDeviceKey, profileTarget).profile
    const canonicalized = upsertCanonicalDelayProfileForTarget(
      state.delayProfilesByDeviceKey,
      profileTarget,
      normalizedProfile
    )
    const nextProfiles = canonicalized.profiles
    if (canonicalized.changed) {
      persistDelaySettings(nextProfiles, state.inputBaselinesByKey)
    }

    const effectiveDelayMs = computeAppliedDelayMs(normalizedProfile, state.playbackOutputMode)

    set({
      delayProfilesByDeviceKey: nextProfiles,
      activeDelayProfileKey,
      activeDelayProfile: normalizedProfile,
      effectiveDelayMs,
      ...(options.resetCalibrationStatus
        ? { delayCalibrationState: 'idle' as const, delayCalibrationMessage: null }
        : {}),
    })

    try {
      await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
    } catch (error) {
      console.warn('Failed to apply analysis delay for active output profile, retrying...', error)
      try {
        await audioEngine.ensureContextReady()
        await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
      } catch (retryError) {
        console.error('Failed to apply analysis delay after retry:', retryError)
      }
    }
  }

  const updateActiveDelayProfile = async (
    updater: (profile: DelayCompensationProfile) => DelayCompensationProfile,
    options: {
      calibrationState?: DelayCalibrationState
      calibrationMessage?: string | null
    } = {}
  ): Promise<void> => {
    const state = get()
    const profileTarget = resolveActiveDelayProfileTarget(state.selectedDeviceId, state.availableDevices)
    const activeDelayProfileKey = profileTarget.key
    const currentProfile = resolveDelayProfileForTarget(state.delayProfilesByDeviceKey, profileTarget).profile
    const updatedProfile = normalizeDelayProfile(updater(currentProfile))
    const canonicalized = upsertCanonicalDelayProfileForTarget(
      state.delayProfilesByDeviceKey,
      profileTarget,
      updatedProfile
    )
    const nextProfiles = canonicalized.profiles
    const effectiveDelayMs = computeAppliedDelayMs(updatedProfile, state.playbackOutputMode)

    set({
      delayProfilesByDeviceKey: nextProfiles,
      activeDelayProfileKey,
      activeDelayProfile: updatedProfile,
      effectiveDelayMs,
      ...(options.calibrationState ? { delayCalibrationState: options.calibrationState } : {}),
      ...(options.calibrationMessage !== undefined ? { delayCalibrationMessage: options.calibrationMessage } : {}),
    })

    persistDelaySettings(nextProfiles, state.inputBaselinesByKey)
    try {
      await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
    } catch (error) {
      console.warn('Failed to apply analysis delay after profile update, retrying...', error)
      try {
        await audioEngine.ensureContextReady()
        await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
      } catch (retryError) {
        console.error('Failed to apply analysis delay after retry:', retryError)
      }
    }
  }

  const handleMediaDeviceChange = async (): Promise<void> => {
    await get().refreshDevices()

    const state = get()
    const selectedDeviceId = state.selectedDeviceId.trim()
    if (selectedDeviceId.length > 0 && selectedDeviceId !== 'default') {
      const deviceStillExists = state.availableDevices.some((device) => device.deviceId === selectedDeviceId)
      if (!deviceStillExists) {
        try {
          await audioEngine.setOutputDevice('')
        } catch {
          // Ignore failures when falling back to default output.
        }
        set({ selectedDeviceId: '' })
        localStorage.removeItem(getOutputStorageKeyForMode(state.playbackOutputMode))
        await syncDelayCompensationForActiveDevice()
      }
    }
  }

  const ensureMediaDeviceChangeListener = (): void => {
    if (mediaDeviceChangeListenerAttached) return
    if (!navigator.mediaDevices?.addEventListener) return

    navigator.mediaDevices.addEventListener('devicechange', () => {
      void handleMediaDeviceChange()
    })

    mediaDeviceChangeListenerAttached = true
  }

  const persistSpatialLayout = (
    presetId: SpatialLayoutPresetId,
    customSpeakers: VirtualSpeaker[] | null
  ): void => {
    localStorage.setItem(SPATIAL_LAYOUT_STORAGE_KEY, JSON.stringify({ presetId, customSpeakers }))
  }

  audioEngine.on('spatialStatusChange', (status) => {
    set({ spatialStatus: status as SpatialStatus })
  })

  const initialDisableGaplessPrebufferDev = readDevDisableGaplessPrebuffer()
  const initialDisableStandardAnalysisGraphDev = readDevDisableStandardAnalysisGraph()
  audioEngine.setDisableStandardAnalysisGraphDev(initialDisableStandardAnalysisGraphDev)

  return {
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: initialDisableGaplessPrebufferDev,
    disableStandardAnalysisGraphDev: initialDisableStandardAnalysisGraphDev,
    nativeAudioCapabilities: { ...DEFAULT_NATIVE_AUDIO_CAPABILITIES },
    playbackModeStatusMessage: null,
    selectedDeviceId: '',
    availableDevices: [],
    availableInputDevices: [],
    selectedCalibrationInputDeviceId: '',
    selectedOutputChannelCount: null,
    multichannelEnabled: false,
    includeLfeInDownmix: false,
    stereoUpmixMode: 'off',
    channelRoutingMap: null,
    spatialMode: 'off',
    spatialLayoutPresetId: '5.1',
    customVirtualSpeakers: null,
    spatialStatus: { state: 'idle', sampleRate: null, taps: 0, message: null },
    normalizationEnabled: true,
    normalizationTargetLufs: DEFAULT_NORMALIZATION_TARGET_LUFS,
    replayGainScanEnabled: false,
    replayGainMode: 'auto',

    delayProfilesByDeviceKey: {},
    inputBaselinesByKey: {},
    activeDelayProfileKey: 'default',
    activeDelayProfile: { ...DEFAULT_DELAY_PROFILE },
    effectiveDelayMs: 0,
    delayCalibrationState: 'idle',
    delayCalibrationMessage: null,

    refreshDevices: async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices
          .filter((device) => device.kind === 'audioinput')
          .map(buildCalibrationInputDevice)
        const playbackOutputMode = get().playbackOutputMode
        let audioOutputs = devices
          .filter((device) => device.kind === 'audiooutput')
          .map(buildAudioDevice)
        let nativeAudioCapabilities = get().nativeAudioCapabilities
        let playbackModeStatusMessage = get().playbackModeStatusMessage

        if (playbackOutputMode === 'bitperfect') {
          nativeAudioCapabilities = await audioEngine.refreshNativeAudioCapabilities()
          audioOutputs = buildNativeOutputDevices(nativeAudioCapabilities)
          playbackModeStatusMessage = audioEngine.getPlaybackModeStatusMessage()
        }

        set({
          nativeAudioCapabilities,
          playbackModeStatusMessage,
          availableDevices: audioOutputs,
          availableInputDevices: audioInputs
        })

        const selectedInputId = get().selectedCalibrationInputDeviceId.trim()
        if (selectedInputId.length > 0 && selectedInputId !== 'default') {
          const inputStillExists = audioInputs.some((device) => device.deviceId === selectedInputId)
          if (!inputStillExists) {
            set({ selectedCalibrationInputDeviceId: '' })
            localStorage.removeItem(CALIBRATION_INPUT_STORAGE_KEY)
          }
        }

        await get().refreshOutputChannelCount()
        await syncDelayCompensationForActiveDevice()
      } catch {
        console.warn('Could not enumerate audio devices')
      }
    },

    refreshOutputChannelCount: async () => {
      try {
        await audioEngine.ensureContextReady()
        const maxChannels = audioEngine.getOutputMaxChannelCount()
        set({ selectedOutputChannelCount: maxChannels })
      } catch {
        set({ selectedOutputChannelCount: null })
      }
    },

    setPlaybackOutputMode: async (mode: PlaybackOutputMode) => {
      const normalizedMode = normalizePlaybackOutputMode(mode)
      const previousMode = get().playbackOutputMode
      const result = await audioEngine.setPlaybackOutputMode(normalizedMode)
      const fallbackMode = result.activeMode
      const selectedStorageKey = getOutputStorageKeyForMode(fallbackMode)
      const savedSelectedDeviceId = localStorage.getItem(selectedStorageKey) ?? ''
      const capabilities = fallbackMode === 'bitperfect'
        ? await audioEngine.refreshNativeAudioCapabilities()
        : result.capabilities

      set({
        playbackOutputMode: fallbackMode,
        nativeAudioCapabilities: capabilities,
        playbackModeStatusMessage: result.message ?? audioEngine.getPlaybackModeStatusMessage()
      })

      localStorage.setItem(PLAYBACK_OUTPUT_MODE_STORAGE_KEY, fallbackMode)
      logMemoryDiagnosticsEvent('playback_output_mode_changed', {
        requestedMode: normalizedMode,
        previousMode,
        activeMode: fallbackMode,
        message: result.message ?? null,
        bitPerfectActive: audioEngine.isBitPerfectActive()
      })
      await get().refreshDevices()

      const selectedOutputId = savedSelectedDeviceId.trim()
      const availableDevices = get().availableDevices
      const selectedExists = selectedOutputId.length === 0
        ? true
        : availableDevices.some((device) => device.deviceId === selectedOutputId)

      if (selectedExists && selectedOutputId.length > 0) {
        await get().selectDevice(selectedOutputId)
      } else if (selectedExists) {
        const initialSelection = resolveInitialNativeOutputSelection(capabilities, availableDevices)
        if (initialSelection.statusMessage) {
          set({ playbackModeStatusMessage: initialSelection.statusMessage })
        }
        await get().selectDevice(initialSelection.deviceId)
      } else {
        localStorage.removeItem(selectedStorageKey)
        const initialSelection = resolveInitialNativeOutputSelection(capabilities, availableDevices)
        if (initialSelection.statusMessage) {
          set({ playbackModeStatusMessage: initialSelection.statusMessage })
        }
        await get().selectDevice(initialSelection.deviceId)
      }

      if (fallbackMode !== normalizedMode && result.message) {
        set({ playbackModeStatusMessage: result.message })
      }
    },

    setDisableGaplessPrebufferDev: (disabled: boolean) => {
      const normalized = isDevBuild() && Boolean(disabled)
      if (get().disableGaplessPrebufferDev === normalized) {
        return
      }

      set({ disableGaplessPrebufferDev: normalized })

      try {
        if (normalized) {
          localStorage.setItem(DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY, '1')
        } else {
          localStorage.removeItem(DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY)
        }
      } catch {
        // Ignore storage failures and keep the in-memory override.
      }

      if (normalized) {
        audioEngine.clearNextBuffer()
      }

      logMemoryDiagnosticsEvent('dev_gapless_prebuffer_override_changed', {
        disabled: normalized
      })
    },

    setDisableStandardAnalysisGraphDev: (disabled: boolean) => {
      const normalized = isDevBuild() && Boolean(disabled)
      if (get().disableStandardAnalysisGraphDev === normalized) {
        return
      }

      audioEngine.setDisableStandardAnalysisGraphDev(normalized)
      set({ disableStandardAnalysisGraphDev: normalized })

      try {
        if (normalized) {
          localStorage.setItem(DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY, '1')
        } else {
          localStorage.removeItem(DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY)
        }
      } catch {
        // Ignore storage failures and keep the in-memory override.
      }

      logMemoryDiagnosticsEvent('dev_standard_analysis_graph_override_changed', {
        disabled: normalized
      })
    },

    selectDevice: async (deviceId: string) => {
      try {
        const playbackOutputMode = get().playbackOutputMode
        const requestedDeviceId = playbackOutputMode === 'bitperfect'
          && (deviceId.trim().length === 0 || deviceId.trim() === 'default')
          ? (resolvePhysicalDefaultDeviceId(get().availableDevices) ?? deviceId)
          : deviceId

        await audioEngine.setOutputDevice(requestedDeviceId)
        const nativeAudioCapabilities = playbackOutputMode === 'bitperfect'
          ? audioEngine.getNativeAudioCapabilities()
          : get().nativeAudioCapabilities
        const selectedDeviceId = playbackOutputMode === 'bitperfect'
          ? (nativeAudioCapabilities.selectedDeviceId?.trim() || requestedDeviceId)
          : requestedDeviceId

        set({
          selectedDeviceId,
          nativeAudioCapabilities,
          playbackModeStatusMessage: audioEngine.getPlaybackModeStatusMessage()
        })

        const storageKey = getOutputStorageKeyForMode(playbackOutputMode)
        if (selectedDeviceId.trim().length > 0) {
          localStorage.setItem(storageKey, selectedDeviceId)
        } else {
          localStorage.removeItem(storageKey)
        }

        await get().refreshOutputChannelCount()
        await syncDelayCompensationForActiveDevice({ resetCalibrationStatus: true })
      } catch (err) {
        console.error('Failed to set audio output device:', err)
      }
    },

    setCalibrationInputDeviceId: (deviceId: string) => {
      const normalized = deviceId.trim()
      set({ selectedCalibrationInputDeviceId: deviceId })
      if (normalized.length > 0) {
        localStorage.setItem(CALIBRATION_INPUT_STORAGE_KEY, deviceId)
      } else {
        localStorage.removeItem(CALIBRATION_INPUT_STORAGE_KEY)
      }
    },

    setMultichannelEnabled: async (enabled: boolean) => {
      set({ multichannelEnabled: enabled })
      localStorage.setItem(MULTICHANNEL_STORAGE_KEY, enabled ? '1' : '0')
      await audioEngine.setMultichannelEnabled(enabled)
    },

    setIncludeLfeInDownmix: async (enabled: boolean) => {
      const normalized = Boolean(enabled)
      set({ includeLfeInDownmix: normalized })
      localStorage.setItem(INCLUDE_LFE_DOWNMIX_STORAGE_KEY, normalized ? '1' : '0')
      await audioEngine.setIncludeLfeInDownmix(normalized)
    },

    setStereoUpmixMode: async (mode: StereoUpmixMode) => {
      const normalized = normalizeStereoUpmixMode(mode)
      set({ stereoUpmixMode: normalized })
      localStorage.setItem(STEREO_UPMIX_MODE_STORAGE_KEY, normalized)
      await audioEngine.setStereoUpmixMode(normalized)
    },

    setChannelRoutingMap: async (map: number[] | null) => {
      const normalized = map && map.length > 0
        ? map.map((value) => {
          if (!Number.isFinite(value)) return -1
          const rounded = Math.trunc(value)
          return rounded >= -1 ? rounded : -1
        })
        : null

      set({ channelRoutingMap: normalized })

      if (normalized) {
        localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(normalized))
      } else {
        localStorage.removeItem(ROUTING_STORAGE_KEY)
      }

      await audioEngine.setChannelRoutingMap(normalized)
    },

    resetChannelRoutingMap: async () => {
      await get().setChannelRoutingMap(null)
    },

    setSpatialMode: async (mode: SpatialMode) => {
      const normalized = normalizeSpatialMode(mode)
      set({ spatialMode: normalized })
      localStorage.setItem(SPATIAL_MODE_STORAGE_KEY, normalized)
      if (normalized === 'binaural') {
        const state = get()
        await audioEngine.setVirtualSpeakers(
          buildVirtualSpeakerLayout(state.spatialLayoutPresetId, state.customVirtualSpeakers)
        )
      }
      await audioEngine.setSpatialMode(normalized)
      set({ spatialStatus: audioEngine.getSpatialStatus() })
    },

    setSpatialLayoutPreset: async (presetId: SpatialLayoutPresetId) => {
      const normalized = normalizeSpatialLayoutPresetId(presetId)
      set({ spatialLayoutPresetId: normalized })
      persistSpatialLayout(normalized, get().customVirtualSpeakers)
      await audioEngine.setVirtualSpeakers(
        buildVirtualSpeakerLayout(normalized, get().customVirtualSpeakers)
      )
    },

    // Store state updates synchronously for immediate visual feedback; the
    // Virtual Speaker Room throttles its calls to this action while dragging.
    setVirtualSpeakerAzimuth: async (speakerId: string, azimuthDeg: number) => {
      const state = get()
      const active = buildVirtualSpeakerLayout(state.spatialLayoutPresetId, state.customVirtualSpeakers)
      const index = active.findIndex((sp) => sp.id === speakerId)
      if (index < 0) return
      const edited = normalizeVirtualSpeakers(
        active.map((sp, i) => (i === index ? { ...sp, azimuth: azimuthDeg } : sp))
      )
      if (!edited) return
      // Editing a preset speaker turns the layout into a Custom copy.
      set({ spatialLayoutPresetId: 'custom', customVirtualSpeakers: edited })
      persistSpatialLayout('custom', edited)
      await audioEngine.setVirtualSpeakers(edited)
    },

    setVirtualSpeakerElevation: async (speakerId: string, elevationDeg: number) => {
      const state = get()
      const active = buildVirtualSpeakerLayout(state.spatialLayoutPresetId, state.customVirtualSpeakers)
      const index = active.findIndex((sp) => sp.id === speakerId)
      if (index < 0) return
      const edited = normalizeVirtualSpeakers(
        active.map((sp, i) => (i === index ? { ...sp, elevation: elevationDeg } : sp))
      )
      if (!edited) return
      // Editing a preset speaker turns the layout into a Custom copy.
      set({ spatialLayoutPresetId: 'custom', customVirtualSpeakers: edited })
      persistSpatialLayout('custom', edited)
      await audioEngine.setVirtualSpeakers(edited)
    },

    resetSpatialSettings: async () => {
      localStorage.removeItem(SPATIAL_MODE_STORAGE_KEY)
      localStorage.removeItem(SPATIAL_LAYOUT_STORAGE_KEY)
      set({ spatialMode: 'off', spatialLayoutPresetId: '5.1', customVirtualSpeakers: null })
      try {
        await audioEngine.setVirtualSpeakers(buildVirtualSpeakerLayout('5.1', null))
        await audioEngine.setSpatialMode('off')
      } catch (error) {
        console.warn('Failed to reset spatial mode:', error)
      }
      set({ spatialStatus: audioEngine.getSpatialStatus() })
    },

    setNormalizationEnabled: (enabled: boolean) => {
      const normalized = Boolean(enabled)
      set({ normalizationEnabled: normalized })
      audioEngine.normalizationEnabled = normalized
      localStorage.setItem(NORMALIZATION_ENABLED_STORAGE_KEY, normalized ? '1' : '0')
    },

    setNormalizationTargetLufs: (targetLufs: number) => {
      if (!Number.isFinite(targetLufs)) return
      const rounded = Math.round(targetLufs * 10) / 10
      set({ normalizationTargetLufs: rounded })
      audioEngine.targetLufs = rounded
      localStorage.setItem(NORMALIZATION_TARGET_STORAGE_KEY, String(rounded))
    },

    setReplayGainScanEnabled: async (enabled: boolean) => {
      const previous = get().replayGainScanEnabled
      const normalized = Boolean(enabled)
      set({ replayGainScanEnabled: normalized })
      audioEngine.setReplayGainEnabled(normalized)

      try {
        const persisted = await window.electronAPI.setReplayGainScanEnabled(normalized)
        const resolved = Boolean(persisted)
        if (resolved !== normalized) {
          set({ replayGainScanEnabled: resolved })
          audioEngine.setReplayGainEnabled(resolved)
        }
      } catch (error) {
        console.error('Failed to persist ReplayGain scan setting:', error)
        set({ replayGainScanEnabled: previous })
        audioEngine.setReplayGainEnabled(previous)
      }
    },

    setReplayGainMode: (mode: ReplayGainMode) => {
      const normalized = normalizeReplayGainMode(mode)
      set({ replayGainMode: normalized })
      localStorage.setItem(REPLAYGAIN_MODE_STORAGE_KEY, normalized)
    },

    setDelayCompensationEnabled: async (enabled: boolean) => {
      await updateActiveDelayProfile((profile) => ({
        ...profile,
        enabled,
      }))
    },

    setDelayCompensationMode: async (mode: DelayCompensationMode) => {
      await updateActiveDelayProfile((profile) => ({
        ...profile,
        mode,
      }))
    },

    setDelayCalibrationMethod: async (method: DelayCalibrationMethod) => {
      await updateActiveDelayProfile((profile) => ({
        ...profile,
        calibrationMethod: normalizeCalibrationMethod(method)
      }))
    },

    setDifferentialReferenceOutputDeviceId: async (deviceId: string) => {
      await updateActiveDelayProfile((profile) => ({
        ...profile,
        differentialReferenceOutputDeviceId: deviceId.trim() === 'default' ? '' : deviceId.trim()
      }))
    },

    setDelayCompensationManualOffsetMs: async (offsetMs: number) => {
      await updateActiveDelayProfile((profile) => ({
        ...profile,
        manualOffsetMs: clampManualOffsetForMode(profile.mode, offsetMs),
      }))
    },

    runDelayAutoCalibration: async () => {
      if (get().playbackOutputMode === 'bitperfect') {
        set({
          delayCalibrationState: 'error',
          delayCalibrationMessage: audioEngine.getBitPerfectUnavailableMessage()
        })
        return
      }

      const initialState = get()
      const selectedMethod = initialState.activeDelayProfile.calibrationMethod
      set({
        delayCalibrationState: 'running',
        delayCalibrationMessage: selectedMethod === 'differential'
          ? 'Running New (Differential) calibration...'
          : 'Running Old (Legacy) calibration...'
      })

      const calibrationInputDeviceId = get().selectedCalibrationInputDeviceId

      if (selectedMethod === 'differential') {
        const differentialInputState = get()
        const btDeviceId = differentialInputState.selectedDeviceId
        const referenceDeviceId = differentialInputState.activeDelayProfile.differentialReferenceOutputDeviceId
        const normalizedReferenceDeviceId = referenceDeviceId.trim()
        const availableOutputs = differentialInputState.availableDevices
        const selectedOutputDevice = availableOutputs.find((device) => device.deviceId === btDeviceId) ?? null
        const defaultOutputAlias = availableOutputs.find((device) => device.isDefaultAlias) ?? null
        const selectedReferenceDevice = (
          normalizedReferenceDeviceId.length > 0 && normalizedReferenceDeviceId !== 'default'
            ? (availableOutputs.find((device) => device.deviceId === normalizedReferenceDeviceId) ?? null)
            : defaultOutputAlias
        )

        if (normalizedReferenceDeviceId.length > 0 && normalizedReferenceDeviceId !== 'default' && !selectedReferenceDevice) {
          set({
            delayCalibrationState: 'error',
            delayCalibrationMessage: 'Selected reference output is unavailable. Re-select a reference output and retry New (Differential).'
          })
          return
        }

        if (
          selectedOutputDevice
          && selectedReferenceDevice
          && selectedOutputDevice.groupId.length > 0
          && selectedReferenceDevice.groupId.length > 0
          && selectedOutputDevice.groupId === selectedReferenceDevice.groupId
        ) {
          set({
            delayCalibrationState: 'error',
            delayCalibrationMessage: 'Reference output resolves to the same physical device as target output. Pick a different reference speaker and retry New (Differential).'
          })
          return
        }

        const result = await audioEngine.runDifferentialCalibration(
          btDeviceId,
          referenceDeviceId,
          calibrationInputDeviceId
        )

        if (!result.ok) {
          set({
            delayCalibrationState: 'error',
            delayCalibrationMessage: formatDifferentialCalibrationFailureMessage(result.message, result.code)
          })
          return
        }

        const state = get()
        const profileTarget = resolveActiveDelayProfileTarget(state.selectedDeviceId, state.availableDevices)
        const activeDelayProfileKey = profileTarget.key
        const currentActiveProfile = resolveDelayProfileForTarget(state.delayProfilesByDeviceKey, profileTarget).profile
        const sampleRate = normalizeSampleRate(result.sampleRate)
          ?? Math.max(1, Math.round(audioEngine.getSampleRate()))
        const now = Date.now()
        const autoOffsetMs = clampAppliedDelayMs(result.btOutputLatencyMs)

        let nextProfiles: Record<string, DelayCompensationProfile> = {
          ...state.delayProfilesByDeviceKey,
          [activeDelayProfileKey]: normalizeDelayProfile({
            ...currentActiveProfile,
            autoOffsetMs,
            lastRoundTripMs: null,
            lastCalibrationInputKey: null,
            lastCalibrationSampleRate: sampleRate,
            lastCalibrationConfidence: result.confidence,
            lastCalibrationMethod: 'differential',
            lastCalibrationAt: now
          })
        }

        const canonicalized = upsertCanonicalDelayProfileForTarget(
          nextProfiles,
          profileTarget,
          normalizeDelayProfile(nextProfiles[activeDelayProfileKey])
        )
        nextProfiles = canonicalized.profiles

        const activeProfile = normalizeDelayProfile(nextProfiles[activeDelayProfileKey])
        const effectiveDelayMs = computeAppliedDelayMs(activeProfile, state.playbackOutputMode)
        const confidencePct = Math.round(result.confidence * 100)
        const propagationBiasNote = result.propagationBiasWarning
          ? ' Mic placement may bias this result; keep the mic near both outputs and retry if needed.'
          : ''

        set({
          delayProfilesByDeviceKey: nextProfiles,
          activeDelayProfileKey,
          activeDelayProfile: activeProfile,
          effectiveDelayMs,
          delayCalibrationState: 'success',
          delayCalibrationMessage: `Differential output ${autoOffsetMs} ms, reference output ${Math.round(result.refOutputLatencyMs)} ms (confidence ${confidencePct}%).${propagationBiasNote}`
        })

        persistDelaySettings(nextProfiles, state.inputBaselinesByKey)
        try {
          await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
        } catch (error) {
          console.warn('Failed to apply analysis delay after differential calibration, retrying...', error)
          try {
            await audioEngine.ensureContextReady()
            await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
          } catch (retryError) {
            console.error('Failed to apply analysis delay after retry:', retryError)
          }
        }
        return
      }

      const result = await audioEngine.runOutputDelayCalibration(calibrationInputDeviceId)
      if (!result.ok) {
        const shouldFallbackToManual = (
          (result.code === 'mic-denied' || result.code === 'mic-unavailable' || result.code === 'low-confidence')
          && get().activeDelayProfile.mode === 'auto'
          && get().activeDelayProfile.autoOffsetMs == null
        )

        if (shouldFallbackToManual) {
          await updateActiveDelayProfile((profile) => ({
            ...profile,
            mode: 'manual',
          }))
        }

        set({
          delayCalibrationState: 'error',
          delayCalibrationMessage: formatCalibrationFailureMessage(result.message, result.code)
        })
        return
      }

      const state = get()
      const profileTarget = resolveActiveDelayProfileTarget(state.selectedDeviceId, state.availableDevices)
      const activeDelayProfileKey = profileTarget.key
      const currentActiveProfile = resolveDelayProfileForTarget(state.delayProfilesByDeviceKey, profileTarget).profile
      const calibrationInputKey = resolveCalibrationInputDeviceKey(
        calibrationInputDeviceId,
        state.availableInputDevices
      )
      const sampleRate = normalizeSampleRate(result.sampleRate)
        ?? Math.max(1, Math.round(audioEngine.getSampleRate()))
      const roundTripMs = clampRoundTripMs(result.roundTripMs)
      const baselineKey = buildInputBaselineKey(calibrationInputKey, sampleRate)
      const existingBaseline = state.inputBaselinesByKey[baselineKey]
      const now = Date.now()

      const rawReportedInputLatencyMs = result.inputLatencyMs
      const hasUsableReportedInputLatency = (
        Number.isFinite(rawReportedInputLatencyMs)
        && rawReportedInputLatencyMs != null
        && rawReportedInputLatencyMs >= 0
        && rawReportedInputLatencyMs <= REPORTED_INPUT_LATENCY_MAX_MS
        && rawReportedInputLatencyMs <= (roundTripMs + REPORTED_INPUT_LATENCY_ROUNDTRIP_TOLERANCE_MS)
      )
      const reportedInputBaselineCandidate = hasUsableReportedInputLatency
        ? clampRoundTripMs(rawReportedInputLatencyMs as number)
        : null
      const allowReportedInputBaselineLowering = (
        reportedInputBaselineCandidate != null
        && result.confidence >= REPORTED_INPUT_BASELINE_LOWER_MIN_CONFIDENCE
      )

      const previousAutoOffsetMs = currentActiveProfile.autoOffsetMs
      const previousOutputConfidence = currentActiveProfile.lastCalibrationConfidence
      const outputAnchorConfidenceOk = (
        previousOutputConfidence == null
        || previousOutputConfidence >= OUTPUT_ANCHOR_MIN_CONFIDENCE
      )
      const outputAnchorMagnitudeOk = (
        previousAutoOffsetMs != null
        && previousAutoOffsetMs >= 0
        && previousAutoOffsetMs <= (roundTripMs + OUTPUT_ANCHOR_ROUNDTRIP_TOLERANCE_MS)
      )
      const anchoredBaselineCandidate = (
        reportedInputBaselineCandidate == null
        && outputAnchorConfidenceOk && outputAnchorMagnitudeOk && previousAutoOffsetMs != null
      )
        ? clampRoundTripMs(roundTripMs - previousAutoOffsetMs)
        : null

      let baselineRttMs = roundTripMs
      let baselineWasLowered = false
      let baselineUsedInputEstimate = false
      let baselineUsedOutputAnchor = false
      let nextBaselines = state.inputBaselinesByKey

      if (!existingBaseline) {
        baselineRttMs = reportedInputBaselineCandidate ?? anchoredBaselineCandidate ?? roundTripMs
        baselineUsedInputEstimate = reportedInputBaselineCandidate != null
        baselineUsedOutputAnchor = !baselineUsedInputEstimate && anchoredBaselineCandidate != null
        nextBaselines = {
          ...state.inputBaselinesByKey,
          [baselineKey]: {
            baselineRttMs,
            sampleRate,
            updatedAt: now
          }
        }
      } else {
        const baselineCandidates = [roundTripMs, existingBaseline.baselineRttMs]
        if (allowReportedInputBaselineLowering && reportedInputBaselineCandidate != null) {
          baselineCandidates.push(reportedInputBaselineCandidate)
        }
        if (anchoredBaselineCandidate != null) {
          baselineCandidates.push(anchoredBaselineCandidate)
        }
        const baselineCandidate = Math.min(...baselineCandidates)
        const improvement = existingBaseline.baselineRttMs - baselineCandidate
        if (improvement >= BASELINE_IMPROVEMENT_THRESHOLD_MS) {
          baselineWasLowered = true
          baselineRttMs = baselineCandidate
          baselineUsedInputEstimate = (
            allowReportedInputBaselineLowering
            && reportedInputBaselineCandidate != null
            && baselineCandidate === reportedInputBaselineCandidate
          )
          baselineUsedOutputAnchor = (
            !baselineUsedInputEstimate
            && anchoredBaselineCandidate != null
            && baselineCandidate === anchoredBaselineCandidate
          )
          nextBaselines = {
            ...state.inputBaselinesByKey,
            [baselineKey]: {
              baselineRttMs,
              sampleRate,
              updatedAt: now
            }
          }
        } else {
          baselineRttMs = existingBaseline.baselineRttMs
        }
      }

      baselineRttMs = nextBaselines[baselineKey]?.baselineRttMs ?? baselineRttMs
      const derivedOutputMs = clampAppliedDelayMs(roundTripMs - baselineRttMs)
      const shouldSuppressDownwardOutlierAutoOffset = (
        previousAutoOffsetMs != null
        && !baselineWasLowered
        && (previousAutoOffsetMs - derivedOutputMs) >= AUTO_OFFSET_DOWNWARD_OUTLIER_DELTA_MS
        && result.confidence <= AUTO_OFFSET_DOWNWARD_OUTLIER_MAX_CONFIDENCE
      )
      const appliedAutoOffsetMs = shouldSuppressDownwardOutlierAutoOffset
        ? previousAutoOffsetMs
        : derivedOutputMs
      let nextProfiles: Record<string, DelayCompensationProfile> = {
        ...state.delayProfilesByDeviceKey,
        [activeDelayProfileKey]: normalizeDelayProfile({
          ...currentActiveProfile,
          autoOffsetMs: appliedAutoOffsetMs,
          lastRoundTripMs: roundTripMs,
          lastCalibrationInputKey: calibrationInputKey,
          lastCalibrationSampleRate: sampleRate,
          lastCalibrationConfidence: result.confidence,
          lastCalibrationMethod: 'legacy',
          lastCalibrationAt: now,
        })
      }

      if (baselineWasLowered) {
        for (const [profileKey, rawProfile] of Object.entries(nextProfiles)) {
          const profile = normalizeDelayProfile(rawProfile)
          if (profile.lastCalibrationInputKey !== calibrationInputKey) continue
          if (profile.lastCalibrationSampleRate !== sampleRate) continue
          if (profile.lastRoundTripMs == null) continue

          const rebasedAutoOffset = clampAppliedDelayMs(profile.lastRoundTripMs - baselineRttMs)
          if (profile.autoOffsetMs === rebasedAutoOffset) continue

          nextProfiles[profileKey] = {
            ...profile,
            autoOffsetMs: rebasedAutoOffset
          }
        }
      }

      const canonicalized = upsertCanonicalDelayProfileForTarget(
        nextProfiles,
        profileTarget,
        normalizeDelayProfile(nextProfiles[activeDelayProfileKey])
      )
      nextProfiles = canonicalized.profiles

      const activeProfile = normalizeDelayProfile(nextProfiles[activeDelayProfileKey])
      const effectiveDelayMs = computeAppliedDelayMs(activeProfile, state.playbackOutputMode)
      const confidencePct = Math.round(result.confidence * 100)
      const baselineNote = baselineWasLowered
        ? ' Baseline improved and matching profiles were rebased.'
        : ''
      const inputLatencyNote = baselineUsedInputEstimate
        ? ' Input baseline used reported capture latency.'
        : ''
      const anchorNote = baselineUsedOutputAnchor
        ? ' Input baseline was anchored using current output estimate.'
        : ''
      const outlierNote = shouldSuppressDownwardOutlierAutoOffset
        ? ` Large downward jump detected; kept prior auto estimate ${previousAutoOffsetMs ?? 0} ms.`
        : ''

      set({
        inputBaselinesByKey: nextBaselines,
        delayProfilesByDeviceKey: nextProfiles,
        activeDelayProfileKey,
        activeDelayProfile: activeProfile,
        effectiveDelayMs,
        delayCalibrationState: 'success',
        delayCalibrationMessage: `Round-trip ${roundTripMs} ms, input baseline ${baselineRttMs} ms, derived output ${derivedOutputMs} ms, applied output ${appliedAutoOffsetMs} ms (confidence ${confidencePct}%).${inputLatencyNote}${anchorNote}${baselineNote}${outlierNote}`
      })

      persistDelaySettings(nextProfiles, nextBaselines)
      try {
        await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
      } catch (error) {
        console.warn('Failed to apply analysis delay after calibration, retrying...', error)
        try {
          await audioEngine.ensureContextReady()
          await audioEngine.setAnalysisDelayMs(effectiveDelayMs)
        } catch (retryError) {
          console.error('Failed to apply analysis delay after retry:', retryError)
        }
      }
    },

    resetDelayToAutoGuess: async () => {
      const { activeDelayProfile } = get()
      if (activeDelayProfile.autoOffsetMs == null) {
        set({
          delayCalibrationState: 'error',
          delayCalibrationMessage: 'No auto estimate exists for this output yet.'
        })
        return
      }

      await updateActiveDelayProfile((profile) => ({
        ...profile,
        mode: 'auto',
        manualOffsetMs: 0,
      }), {
        calibrationState: 'success',
        calibrationMessage: `Using stored auto estimate (${activeDelayProfile.autoOffsetMs ?? 0} ms).`
      })
    },

    resetToDefaults: async () => {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(NATIVE_OUTPUT_STORAGE_KEY)
      localStorage.removeItem(PLAYBACK_OUTPUT_MODE_STORAGE_KEY)
      localStorage.removeItem(CALIBRATION_INPUT_STORAGE_KEY)
      localStorage.removeItem(MULTICHANNEL_STORAGE_KEY)
      localStorage.removeItem(INCLUDE_LFE_DOWNMIX_STORAGE_KEY)
      localStorage.removeItem(STEREO_UPMIX_MODE_STORAGE_KEY)
      localStorage.removeItem(SPATIAL_MODE_STORAGE_KEY)
      localStorage.removeItem(SPATIAL_LAYOUT_STORAGE_KEY)
      localStorage.removeItem(ROUTING_STORAGE_KEY)
      localStorage.removeItem(NORMALIZATION_ENABLED_STORAGE_KEY)
      localStorage.removeItem(NORMALIZATION_TARGET_STORAGE_KEY)
      localStorage.removeItem(REPLAYGAIN_MODE_STORAGE_KEY)
      localStorage.removeItem(DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY)
      localStorage.removeItem(DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY)
      localStorage.removeItem(DELAY_PROFILE_STORAGE_KEY_V1)
      localStorage.removeItem(DELAY_PROFILE_STORAGE_KEY_V2)

      try {
        await audioEngine.setOutputDevice('')
      } catch (error) {
        console.warn('Failed to reset output device to system default:', error)
      }

      try {
        await audioEngine.setMultichannelEnabled(false)
      } catch (error) {
        console.warn('Failed to reset multichannel mode:', error)
      }

      try {
        await audioEngine.setIncludeLfeInDownmix(false)
      } catch (error) {
        console.warn('Failed to reset LFE downmix mode:', error)
      }

      try {
        await audioEngine.setStereoUpmixMode('off')
      } catch (error) {
        console.warn('Failed to reset stereo upmix mode:', error)
      }

      try {
        await audioEngine.setSpatialMode('off')
        await audioEngine.setVirtualSpeakers(buildVirtualSpeakerLayout('5.1', null))
      } catch (error) {
        console.warn('Failed to reset spatial mode:', error)
      }

      try {
        await audioEngine.setChannelRoutingMap(null)
      } catch (error) {
        console.warn('Failed to reset channel routing map:', error)
      }

      try {
        await audioEngine.setAnalysisDelayMs(0)
      } catch (error) {
        console.warn('Failed to reset analysis delay, retrying...', error)
        try {
          await audioEngine.ensureContextReady()
          await audioEngine.setAnalysisDelayMs(0)
        } catch (retryError) {
          console.error('Failed to reset analysis delay after retry:', retryError)
        }
      }

      try {
        await window.electronAPI.setReplayGainScanEnabled(false)
      } catch (error) {
        console.warn('Failed to reset ReplayGain scan setting to default:', error)
      }
      audioEngine.setReplayGainEnabled(false)
      audioEngine.normalizationEnabled = true
      audioEngine.targetLufs = DEFAULT_NORMALIZATION_TARGET_LUFS
      audioEngine.setDisableStandardAnalysisGraphDev(false)
      await audioEngine.setPlaybackOutputMode('standard')

      let availableDevices = get().availableDevices
      let availableInputDevices = get().availableInputDevices

      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        availableDevices = devices
          .filter((device) => device.kind === 'audiooutput')
          .map(buildAudioDevice)
        availableInputDevices = devices
          .filter((device) => device.kind === 'audioinput')
          .map(buildCalibrationInputDevice)
      } catch {
        console.warn('Could not enumerate audio devices during reset')
      }

      let selectedOutputChannelCount: number | null = null
      try {
        await audioEngine.ensureContextReady()
        selectedOutputChannelCount = audioEngine.getOutputMaxChannelCount()
      } catch {
        selectedOutputChannelCount = null
      }

      set({
        playbackOutputMode: 'standard',
        disableGaplessPrebufferDev: false,
        disableStandardAnalysisGraphDev: false,
        nativeAudioCapabilities: { ...DEFAULT_NATIVE_AUDIO_CAPABILITIES },
        playbackModeStatusMessage: null,
        selectedDeviceId: '',
        availableDevices,
        availableInputDevices,
        selectedCalibrationInputDeviceId: '',
        selectedOutputChannelCount,
        multichannelEnabled: false,
        includeLfeInDownmix: false,
        stereoUpmixMode: 'off',
        channelRoutingMap: null,
        spatialMode: 'off',
        spatialLayoutPresetId: '5.1',
        customVirtualSpeakers: null,
        spatialStatus: audioEngine.getSpatialStatus(),
        normalizationEnabled: true,
        normalizationTargetLufs: DEFAULT_NORMALIZATION_TARGET_LUFS,
        replayGainScanEnabled: false,
        replayGainMode: 'auto',
        delayProfilesByDeviceKey: {},
        inputBaselinesByKey: {},
        activeDelayProfileKey: 'default',
        activeDelayProfile: { ...DEFAULT_DELAY_PROFILE },
        effectiveDelayMs: 0,
        delayCalibrationState: 'idle',
        delayCalibrationMessage: null,
      })
    },

    initFromSaved: async () => {
      const disableStandardAnalysisGraphDev = readDevDisableStandardAnalysisGraph()
      audioEngine.setDisableStandardAnalysisGraphDev(disableStandardAnalysisGraphDev)

      const savedPlaybackOutputMode = normalizePlaybackOutputMode(
        localStorage.getItem(PLAYBACK_OUTPUT_MODE_STORAGE_KEY)
      )
      const playbackModeResult = await audioEngine.setPlaybackOutputMode(savedPlaybackOutputMode)
      const playbackOutputMode = playbackModeResult.activeMode
      const nativeAudioCapabilities = playbackOutputMode === 'bitperfect'
        ? await audioEngine.refreshNativeAudioCapabilities()
        : playbackModeResult.capabilities

      const savedNormalizationEnabled = localStorage.getItem(NORMALIZATION_ENABLED_STORAGE_KEY)
      const normalizationEnabled = savedNormalizationEnabled == null
        ? true
        : savedNormalizationEnabled === '1'
      const savedNormalizationTargetRaw = localStorage.getItem(NORMALIZATION_TARGET_STORAGE_KEY)
      const parsedNormalizationTarget = savedNormalizationTargetRaw == null
        ? Number.NaN
        : Number(savedNormalizationTargetRaw)
      const normalizationTargetLufs = Number.isFinite(parsedNormalizationTarget)
        ? Math.round(parsedNormalizationTarget * 10) / 10
        : DEFAULT_NORMALIZATION_TARGET_LUFS
      audioEngine.normalizationEnabled = normalizationEnabled
      audioEngine.targetLufs = normalizationTargetLufs

      let replayGainEnabled = false
      try {
        replayGainEnabled = await window.electronAPI.getReplayGainScanEnabled()
      } catch (error) {
        console.warn('Failed to load ReplayGain scan setting; defaulting to disabled.', error)
      }
      audioEngine.setReplayGainEnabled(replayGainEnabled)
      const replayGainMode = normalizeReplayGainMode(localStorage.getItem(REPLAYGAIN_MODE_STORAGE_KEY))

      const rawDelaySettingsV2 = localStorage.getItem(DELAY_PROFILE_STORAGE_KEY_V2)
      let savedProfiles: Record<string, DelayCompensationProfile> = {}
      let savedInputBaselines: Record<string, InputDelayBaseline> = {}

      if (rawDelaySettingsV2) {
        const parsedV2 = parseDelaySettingsV2(rawDelaySettingsV2)
        savedProfiles = parsedV2.profiles
        savedInputBaselines = parsedV2.inputBaselinesByKey
      } else {
        const legacyProfiles = parseDelayProfiles(localStorage.getItem(DELAY_PROFILE_STORAGE_KEY_V1))
        savedProfiles = legacyProfiles
        if (Object.keys(legacyProfiles).length > 0) {
          persistDelaySettings(legacyProfiles, {})
        }
      }

      set({
        playbackOutputMode,
        disableGaplessPrebufferDev: readDevDisableGaplessPrebuffer(),
        disableStandardAnalysisGraphDev,
        nativeAudioCapabilities,
        playbackModeStatusMessage: playbackModeResult.message ?? audioEngine.getPlaybackModeStatusMessage(),
        delayProfilesByDeviceKey: savedProfiles,
        inputBaselinesByKey: savedInputBaselines,
        normalizationEnabled,
        normalizationTargetLufs,
        replayGainScanEnabled: replayGainEnabled,
        replayGainMode
      })

      await get().refreshDevices()

      const saved = localStorage.getItem(getOutputStorageKeyForMode(get().playbackOutputMode))
      if (saved) {
        const { availableDevices } = get()
        const exists = availableDevices.some((device) => device.deviceId === saved)
        if (exists) {
          await get().selectDevice(saved)
        } else {
          localStorage.removeItem(getOutputStorageKeyForMode(get().playbackOutputMode))
          set({ selectedDeviceId: '' })
        }
      } else {
        const initialSelection = resolveInitialNativeOutputSelection(nativeAudioCapabilities, get().availableDevices)
        if (initialSelection.statusMessage) {
          set({ playbackModeStatusMessage: initialSelection.statusMessage })
        }
        await get().selectDevice(initialSelection.deviceId)
      }

      const savedCalibrationInputDeviceId = localStorage.getItem(CALIBRATION_INPUT_STORAGE_KEY)
      if (savedCalibrationInputDeviceId) {
        const { availableInputDevices } = get()
        const exists = availableInputDevices.some((device) => device.deviceId === savedCalibrationInputDeviceId)
        if (exists) {
          get().setCalibrationInputDeviceId(savedCalibrationInputDeviceId)
        } else {
          localStorage.removeItem(CALIBRATION_INPUT_STORAGE_KEY)
          set({ selectedCalibrationInputDeviceId: '' })
        }
      }

      const savedMultichannel = localStorage.getItem(MULTICHANNEL_STORAGE_KEY)
      const multichannelEnabled = savedMultichannel === '1'
      await get().setMultichannelEnabled(multichannelEnabled)

      const savedIncludeLfeInDownmix = localStorage.getItem(INCLUDE_LFE_DOWNMIX_STORAGE_KEY)
      const includeLfeInDownmix = savedIncludeLfeInDownmix === '1'
      await get().setIncludeLfeInDownmix(includeLfeInDownmix)

      const savedStereoUpmixMode = normalizeStereoUpmixMode(
        localStorage.getItem(STEREO_UPMIX_MODE_STORAGE_KEY)
      )
      await get().setStereoUpmixMode(savedStereoUpmixMode)

      const savedSpatialLayoutRaw = localStorage.getItem(SPATIAL_LAYOUT_STORAGE_KEY)
      if (savedSpatialLayoutRaw) {
        try {
          const parsed = JSON.parse(savedSpatialLayoutRaw) as {
            presetId?: unknown
            customSpeakers?: unknown
          }
          set({
            spatialLayoutPresetId: normalizeSpatialLayoutPresetId(parsed?.presetId),
            customVirtualSpeakers: normalizeVirtualSpeakers(parsed?.customSpeakers),
          })
        } catch {
          localStorage.removeItem(SPATIAL_LAYOUT_STORAGE_KEY)
        }
      }
      const savedSpatialMode = normalizeSpatialMode(localStorage.getItem(SPATIAL_MODE_STORAGE_KEY))
      if (savedSpatialMode === 'binaural') {
        await get().setSpatialMode('binaural')
      } else {
        // Keep the engine's speaker list warm so enabling later is instant.
        await audioEngine.setVirtualSpeakers(
          buildVirtualSpeakerLayout(get().spatialLayoutPresetId, get().customVirtualSpeakers)
        )
      }

      const savedRoutingMap = localStorage.getItem(ROUTING_STORAGE_KEY)
      if (savedRoutingMap) {
        try {
          const parsed = JSON.parse(savedRoutingMap)
          if (Array.isArray(parsed)) {
            const map = parsed.map((value) => {
              if (!Number.isFinite(value)) return -1
              const rounded = Math.trunc(value)
              return rounded >= -1 ? rounded : -1
            })
            await get().setChannelRoutingMap(map)
          } else {
            localStorage.removeItem(ROUTING_STORAGE_KEY)
          }
        } catch {
          localStorage.removeItem(ROUTING_STORAGE_KEY)
        }
      }

      ensureMediaDeviceChangeListener()
      await syncDelayCompensationForActiveDevice({ resetCalibrationStatus: true })
    }
  }
})
