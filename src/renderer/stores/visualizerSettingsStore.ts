import { create } from 'zustand'
import type { ScopeKind } from '../../types/scopePopout'
import { SCOPE_KINDS, isScopeKind } from '../../types/scopePopout'

export type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384
export type OscilloscopeMode = 'classic' | 'locked'
export type VectorscopeMode = 'lissajous' | 'polar-unipolar' | 'polar-bipolar' | 'linear-unipolar' | 'linear-bipolar'

const VECTORSCOPE_MODES: readonly VectorscopeMode[] = [
  'lissajous', 'polar-unipolar', 'polar-bipolar', 'linear-unipolar', 'linear-bipolar'
]

export function isVectorscopeMode(value: unknown): value is VectorscopeMode {
  return typeof value === 'string' && VECTORSCOPE_MODES.includes(value as VectorscopeMode)
}

export interface AnalyzerProfileScopeSettings {
  spectrum: {
    fftSize: FFTSize
  }
  oscilloscope: {
    pitchLock: boolean
    underfillEnabled: boolean
    mode: OscilloscopeMode
  }
  vectorscope: {
    mode: VectorscopeMode
  }
}

export interface AnalyzerWorkingState {
  order: ScopeKind[]
  hiddenScopes: ScopeKind[]
  widthWeights: Record<ScopeKind, number>
  scopeSettings: AnalyzerProfileScopeSettings
}

export interface AnalyzerProfile extends AnalyzerWorkingState {
  id: string
  name: string
  builtIn: boolean
}

interface VisualizerSettingsSnapshot {
  lineColor: string
  isRunning: boolean
  vectorscopeMultiband: boolean
  profiles: Record<string, AnalyzerProfile>
  activeProfileId: string | null
  activeProfileName: string
  activeProfileBuiltIn: boolean
  activeProfileCanDelete: boolean
  workingState: AnalyzerWorkingState
  scopeOrder: ScopeKind[]
  hiddenScopes: ScopeKind[]
  widthWeights: Record<ScopeKind, number>
  fftSize: FFTSize
  pitchLock: boolean
  oscilloscopeUnderfillEnabled: boolean
  oscilloscopeMode: OscilloscopeMode
  vectorscopeMode: VectorscopeMode
}

interface VisualizerSettingsStore extends VisualizerSettingsSnapshot {
  setLineColor: (color: string) => void
  setIsRunning: (running: boolean) => void
  setActiveProfile: (profileId: string) => void
  saveCurrentProfile: (name: string) => void
  deleteProfile: (profileId: string) => void
  moveScope: (scope: ScopeKind, direction: 'earlier' | 'later') => void
  setScopeDeckLayout: (order: ScopeKind[], hiddenScopes: ScopeKind[]) => void
  setScopeHidden: (scope: ScopeKind, hidden: boolean) => void
  setScopeWidthWeight: (scope: ScopeKind, weight: number) => void
  setScopeWidthWeights: (weights: Partial<Record<ScopeKind, number>>) => void
  setFftSize: (size: FFTSize) => void
  setPitchLock: (enabled: boolean) => void
  setOscilloscopeUnderfillEnabled: (enabled: boolean) => void
  setVectorscopeMode: (mode: VectorscopeMode) => void
  setVectorscopeMultiband: (enabled: boolean) => void
  resetToDefaults: () => void
}

interface PersistedAnalyzerEnvelopeV2 {
  version: 2
  activeProfileId: string | null
  workingState: AnalyzerWorkingState
  profiles: AnalyzerProfile[]
}

const FFT_SIZES: readonly FFTSize[] = [1024, 2048, 4096, 8192, 16384]

const ANALYZER_PROFILE_STORAGE_VERSION = 2
export const ANALYZER_PROFILES_STORAGE_KEY = 'astra-analyzer-profiles-v1'
export const OSCILLOSCOPE_UNDERFILL_STORAGE_KEY = 'astra-oscilloscope-underfill-enabled'
export const VECTORSCOPE_MULTIBAND_STORAGE_KEY = 'astra-vectorscope-multiband'

const DEFAULT_PROFILE_ID = 'default'
const DEFAULT_PROFILE_NAME = 'Default'
const CUSTOM_PROFILE_NAME = 'Custom'

const DEFAULT_LINE_COLOR = '#38bdf8'
const DEFAULT_RUNNING = true
const DEFAULT_FFT_SIZE: FFTSize = 4096
const DEFAULT_PITCH_LOCK = true
const DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED = false
const DEFAULT_OSCILLOSCOPE_MODE: OscilloscopeMode = 'classic'
const DEFAULT_VECTORSCOPE_MODE: VectorscopeMode = 'lissajous'
const DEFAULT_SCOPE_ORDER: ScopeKind[] = ['spectrum', 'oscilloscope', 'vectorscope']
const DEFAULT_WIDTH_WEIGHTS: Record<ScopeKind, number> = {
  spectrum: 1,
  oscilloscope: 1.4,
  vectorscope: 0,
}

const MIN_WEIGHT = 0.4
const MAX_WEIGHT = 2.6

function isFFTSize(value: unknown): value is FFTSize {
  return typeof value === 'number' && FFT_SIZES.includes(value as FFTSize)
}

function cloneScopeSettings(settings: AnalyzerProfileScopeSettings): AnalyzerProfileScopeSettings {
  return {
    spectrum: { ...settings.spectrum },
    oscilloscope: { ...settings.oscilloscope },
    vectorscope: { ...settings.vectorscope },
  }
}

function cloneWorkingState(state: AnalyzerWorkingState): AnalyzerWorkingState {
  return {
    order: [...state.order],
    hiddenScopes: [...state.hiddenScopes],
    widthWeights: { ...state.widthWeights },
    scopeSettings: cloneScopeSettings(state.scopeSettings),
  }
}

function workingStateFromProfile(profile: AnalyzerProfile): AnalyzerWorkingState {
  return cloneWorkingState(profile)
}

function buildProfile(id: string, name: string, builtIn: boolean, state: AnalyzerWorkingState): AnalyzerProfile {
  const normalized = normalizeWorkingState(state)
  return {
    id,
    name,
    builtIn,
    ...normalized,
  }
}

const DEFAULT_WORKING_STATE: AnalyzerWorkingState = {
  order: [...DEFAULT_SCOPE_ORDER],
  hiddenScopes: [],
  widthWeights: { ...DEFAULT_WIDTH_WEIGHTS },
  scopeSettings: {
    spectrum: { fftSize: DEFAULT_FFT_SIZE },
    oscilloscope: {
      pitchLock: DEFAULT_PITCH_LOCK,
      underfillEnabled: DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED,
      mode: DEFAULT_OSCILLOSCOPE_MODE,
    },
    vectorscope: { mode: DEFAULT_VECTORSCOPE_MODE },
  },
}

const BUILT_IN_PROFILES: Record<string, AnalyzerProfile> = {
  [DEFAULT_PROFILE_ID]: buildProfile(
    DEFAULT_PROFILE_ID,
    DEFAULT_PROFILE_NAME,
    true,
    DEFAULT_WORKING_STATE
  ),
}

function normalizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readLegacyOscilloscopeUnderfillPreference(): boolean {
  try {
    return localStorage.getItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY) === '1'
  } catch {
    return DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED
  }
}

function persistLegacyOscilloscopeUnderfillPreference(enabled: boolean): void {
  try {
    localStorage.setItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // ignore persistence failures
  }
}

function readVectorscopeMultibandPreference(): boolean {
  try {
    return localStorage.getItem(VECTORSCOPE_MULTIBAND_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistVectorscopeMultibandPreference(enabled: boolean): void {
  try {
    localStorage.setItem(VECTORSCOPE_MULTIBAND_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // ignore persistence failures
  }
}

function clampWidthWeight(scope: ScopeKind, value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_WIDTH_WEIGHTS[scope]

  if (scope === 'vectorscope' && numeric <= 0) {
    return 0
  }

  const rounded = Math.round(numeric * 100) / 100
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, rounded))
}

function normalizeOrder(value: unknown): ScopeKind[] {
  const out: ScopeKind[] = []

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isScopeKind(item) || out.includes(item)) continue
      out.push(item)
    }
  }

  for (const scope of DEFAULT_SCOPE_ORDER) {
    if (!out.includes(scope)) {
      out.push(scope)
    }
  }

  return out
}

function normalizeHiddenScopes(value: unknown, order: ScopeKind[]): ScopeKind[] {
  if (!Array.isArray(value)) return []

  const hiddenSet = new Set<ScopeKind>()
  for (const item of value) {
    if (isScopeKind(item)) {
      hiddenSet.add(item)
    }
  }

  return order.filter((scope) => hiddenSet.has(scope))
}

function normalizeScopeSettings(
  value: unknown,
  legacyUnderfillEnabled: boolean
): AnalyzerProfileScopeSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  const rawSpectrum = raw.spectrum && typeof raw.spectrum === 'object' && !Array.isArray(raw.spectrum)
    ? raw.spectrum as Record<string, unknown>
    : {}

  const rawOscilloscope = raw.oscilloscope && typeof raw.oscilloscope === 'object' && !Array.isArray(raw.oscilloscope)
    ? raw.oscilloscope as Record<string, unknown>
    : {}

  const rawVectorscope = raw.vectorscope && typeof raw.vectorscope === 'object' && !Array.isArray(raw.vectorscope)
    ? raw.vectorscope as Record<string, unknown>
    : {}

  const fallbackUnderfill = raw.oscilloscopeUnderfillEnabled
  const underfillEnabled = typeof rawOscilloscope.underfillEnabled === 'boolean'
    ? rawOscilloscope.underfillEnabled
    : typeof fallbackUnderfill === 'boolean'
      ? fallbackUnderfill
      : legacyUnderfillEnabled

  const fallbackPitchLock = raw.pitchLock
  const fallbackFftSize = raw.fftSize
  const fallbackOscilloscopeMode = raw.oscilloscopeMode
  const fallbackVectorscopeMode = raw.vectorscopeMode

  const fftSizeValue = rawSpectrum.fftSize ?? fallbackFftSize
  const oscilloscopeModeValue = rawOscilloscope.mode ?? fallbackOscilloscopeMode
  const vectorscopeModeValue = rawVectorscope.mode ?? fallbackVectorscopeMode

  return {
    spectrum: {
      fftSize: isFFTSize(fftSizeValue) ? fftSizeValue : DEFAULT_FFT_SIZE,
    },
    oscilloscope: {
      pitchLock: typeof rawOscilloscope.pitchLock === 'boolean'
        ? rawOscilloscope.pitchLock
        : typeof fallbackPitchLock === 'boolean'
          ? fallbackPitchLock
          : DEFAULT_PITCH_LOCK,
      underfillEnabled,
      mode: oscilloscopeModeValue === 'locked' ? 'locked' : DEFAULT_OSCILLOSCOPE_MODE,
    },
    vectorscope: {
      mode: isVectorscopeMode(vectorscopeModeValue) ? vectorscopeModeValue : DEFAULT_VECTORSCOPE_MODE,
    },
  }
}

function normalizeWorkingState(
  value: unknown,
  legacyUnderfillEnabled = DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED
): AnalyzerWorkingState {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  const order = normalizeOrder(raw.order ?? raw.scopeOrder)
  const hiddenScopes = normalizeHiddenScopes(raw.hiddenScopes, order)
  const widthWeights = {
    spectrum: clampWidthWeight('spectrum', raw.widthWeights && typeof raw.widthWeights === 'object'
      ? (raw.widthWeights as Record<string, unknown>).spectrum
      : undefined),
    oscilloscope: clampWidthWeight('oscilloscope', raw.widthWeights && typeof raw.widthWeights === 'object'
      ? (raw.widthWeights as Record<string, unknown>).oscilloscope
      : undefined),
    vectorscope: clampWidthWeight('vectorscope', raw.widthWeights && typeof raw.widthWeights === 'object'
      ? (raw.widthWeights as Record<string, unknown>).vectorscope
      : undefined),
  }

  return {
    order,
    hiddenScopes,
    widthWeights,
    scopeSettings: normalizeScopeSettings(raw.scopeSettings ?? raw, legacyUnderfillEnabled),
  }
}

function normalizeProfile(
  value: unknown,
  legacyUnderfillEnabled: boolean,
  fallbackId?: string
): AnalyzerProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const id = normalizeProfileId(raw.id) ?? normalizeProfileId(fallbackId)
  if (!id) return null

  return buildProfile(
    id,
    normalizeProfileName(raw.name, id),
    Boolean(raw.builtIn),
    normalizeWorkingState(raw, legacyUnderfillEnabled)
  )
}

function normalizePersistedProfiles(
  value: unknown,
  legacyUnderfillEnabled: boolean
): Record<string, AnalyzerProfile> {
  const out: Record<string, AnalyzerProfile> = {}

  if (Array.isArray(value)) {
    for (const item of value) {
      const profile = normalizeProfile(item, legacyUnderfillEnabled)
      if (!profile) continue
      out[profile.id] = profile
    }
    return out
  }

  if (!value || typeof value !== 'object') {
    return out
  }

  for (const [profileId, rawProfile] of Object.entries(value as Record<string, unknown>)) {
    const profile = normalizeProfile(rawProfile, legacyUnderfillEnabled, profileId)
    if (!profile) continue
    out[profile.id] = profile
  }

  return out
}

function mergeProfiles(persistedProfiles: Record<string, AnalyzerProfile>): Record<string, AnalyzerProfile> {
  const merged: Record<string, AnalyzerProfile> = {}

  for (const builtInProfile of Object.values(BUILT_IN_PROFILES)) {
    merged[builtInProfile.id] = buildProfile(
      builtInProfile.id,
      builtInProfile.name,
      true,
      builtInProfile
    )
  }

  for (const profile of Object.values(persistedProfiles)) {
    if (profile.builtIn && profile.id in BUILT_IN_PROFILES) {
      continue
    }
    merged[profile.id] = buildProfile(profile.id, profile.name, Boolean(profile.builtIn), profile)
  }

  return merged
}

function areWorkingStatesEqual(left: AnalyzerWorkingState, right: AnalyzerWorkingState): boolean {
  if (left.order.length !== right.order.length || left.hiddenScopes.length !== right.hiddenScopes.length) {
    return false
  }

  for (let index = 0; index < left.order.length; index += 1) {
    if (left.order[index] !== right.order[index]) return false
  }

  for (let index = 0; index < left.hiddenScopes.length; index += 1) {
    if (left.hiddenScopes[index] !== right.hiddenScopes[index]) return false
  }

  for (const scope of SCOPE_KINDS) {
    if (left.widthWeights[scope] !== right.widthWeights[scope]) return false
  }

  return (
    left.scopeSettings.spectrum.fftSize === right.scopeSettings.spectrum.fftSize
    && left.scopeSettings.oscilloscope.pitchLock === right.scopeSettings.oscilloscope.pitchLock
    && left.scopeSettings.oscilloscope.underfillEnabled === right.scopeSettings.oscilloscope.underfillEnabled
    && left.scopeSettings.oscilloscope.mode === right.scopeSettings.oscilloscope.mode
    && left.scopeSettings.vectorscope.mode === right.scopeSettings.vectorscope.mode
  )
}

function serializeProfile(profile: AnalyzerProfile): AnalyzerProfile {
  return {
    id: profile.id,
    name: profile.name,
    builtIn: profile.builtIn,
    ...cloneWorkingState(profile),
  }
}

function persistState(
  profiles: Record<string, AnalyzerProfile>,
  activeProfileId: string | null,
  workingState: AnalyzerWorkingState
): void {
  const payload: PersistedAnalyzerEnvelopeV2 = {
    version: ANALYZER_PROFILE_STORAGE_VERSION,
    activeProfileId,
    workingState: cloneWorkingState(workingState),
    profiles: Object.values(profiles)
      .filter((profile) => !profile.builtIn)
      .map(serializeProfile),
  }

  try {
    localStorage.setItem(ANALYZER_PROFILES_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn('Failed to persist analyzer profiles:', error)
  }

  persistLegacyOscilloscopeUnderfillPreference(
    workingState.scopeSettings.oscilloscope.underfillEnabled
  )
}

function makeProfileId(profiles: Record<string, AnalyzerProfile>): string {
  let attempt = `custom-${Date.now()}`
  let sequence = 1

  while (profiles[attempt]) {
    attempt = `custom-${Date.now()}-${sequence}`
    sequence += 1
  }

  return attempt
}

function buildSnapshot(
  lineColor: string,
  isRunning: boolean,
  profilesInput: Record<string, AnalyzerProfile>,
  requestedActiveProfileId: string | null,
  workingStateInput: AnalyzerWorkingState,
  vectorscopeMultiband = false
): VisualizerSettingsSnapshot {
  const profiles = mergeProfiles(profilesInput)
  const workingState = normalizeWorkingState(workingStateInput)
  const normalizedActiveProfileId = normalizeProfileId(requestedActiveProfileId)
  const activeProfile = normalizedActiveProfileId
    ? profiles[normalizedActiveProfileId] ?? null
    : null

  const activeProfileId = activeProfile && areWorkingStatesEqual(workingStateFromProfile(activeProfile), workingState)
    ? activeProfile.id
    : null

  return {
    lineColor,
    isRunning,
    vectorscopeMultiband,
    profiles,
    activeProfileId,
    activeProfileName: activeProfileId ? profiles[activeProfileId].name : CUSTOM_PROFILE_NAME,
    activeProfileBuiltIn: activeProfileId ? profiles[activeProfileId].builtIn : false,
    activeProfileCanDelete: activeProfileId ? !profiles[activeProfileId].builtIn : false,
    workingState,
    scopeOrder: [...workingState.order],
    hiddenScopes: [...workingState.hiddenScopes],
    widthWeights: { ...workingState.widthWeights },
    fftSize: workingState.scopeSettings.spectrum.fftSize,
    pitchLock: workingState.scopeSettings.oscilloscope.pitchLock,
    oscilloscopeUnderfillEnabled: workingState.scopeSettings.oscilloscope.underfillEnabled,
    oscilloscopeMode: workingState.scopeSettings.oscilloscope.mode,
    vectorscopeMode: workingState.scopeSettings.vectorscope.mode,
  }
}

function loadInitialSnapshot(): VisualizerSettingsSnapshot {
  const legacyUnderfillEnabled = readLegacyOscilloscopeUnderfillPreference()
  const multibandEnabled = readVectorscopeMultibandPreference()

  try {
    const raw = localStorage.getItem(ANALYZER_PROFILES_STORAGE_KEY)
    if (!raw) {
      return buildSnapshot(
        DEFAULT_LINE_COLOR,
        DEFAULT_RUNNING,
        BUILT_IN_PROFILES,
        DEFAULT_PROFILE_ID,
        DEFAULT_WORKING_STATE,
        multibandEnabled
      )
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>
    const persistedProfiles = normalizePersistedProfiles(parsed.profiles, legacyUnderfillEnabled)
    const mergedProfiles = mergeProfiles(persistedProfiles)

    const requestedActiveProfileId = normalizeProfileId(parsed.activeProfileId) ?? DEFAULT_PROFILE_ID
    const workingState = parsed.workingState !== undefined
      ? normalizeWorkingState(parsed.workingState, legacyUnderfillEnabled)
      : requestedActiveProfileId && mergedProfiles[requestedActiveProfileId]
        ? workingStateFromProfile(mergedProfiles[requestedActiveProfileId])
        : cloneWorkingState(DEFAULT_WORKING_STATE)

    return buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      mergedProfiles,
      requestedActiveProfileId,
      workingState,
      multibandEnabled
    )
  } catch {
    return buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      BUILT_IN_PROFILES,
      DEFAULT_PROFILE_ID,
      DEFAULT_WORKING_STATE,
      multibandEnabled
    )
  }
}

function updateWorkingState(
  state: VisualizerSettingsStore,
  nextWorkingStateInput: AnalyzerWorkingState
): VisualizerSettingsSnapshot {
  const nextWorkingState = normalizeWorkingState(nextWorkingStateInput)
  return buildSnapshot(
    state.lineColor,
    state.isRunning,
    state.profiles,
    state.activeProfileId,
    nextWorkingState,
    state.vectorscopeMultiband
  )
}

const initialSnapshot = loadInitialSnapshot()

export const useVisualizerSettingsStore = create<VisualizerSettingsStore>((set, get) => ({
  ...initialSnapshot,

  setLineColor: (color) => {
    set({ lineColor: color })
  },

  setIsRunning: (running) => {
    set({ isRunning: running })
  },

  setActiveProfile: (profileId) => {
    const targetId = normalizeProfileId(profileId)
    if (!targetId) return

    const state = get()
    const profile = state.profiles[targetId]
    if (!profile) return

    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      state.profiles,
      targetId,
      workingStateFromProfile(profile),
      state.vectorscopeMultiband
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  saveCurrentProfile: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return

    const state = get()
    const profileId = makeProfileId(state.profiles)
    const nextProfiles = {
      ...state.profiles,
      [profileId]: buildProfile(profileId, trimmed, false, state.workingState),
    }

    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      nextProfiles,
      profileId,
      state.workingState,
      state.vectorscopeMultiband
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  deleteProfile: (profileId) => {
    const targetId = normalizeProfileId(profileId)
    if (!targetId) return

    const state = get()
    const profile = state.profiles[targetId]
    if (!profile || profile.builtIn) return

    const { [targetId]: _removed, ...remainingProfiles } = state.profiles
    const nextSnapshot = buildSnapshot(
      state.lineColor,
      state.isRunning,
      remainingProfiles,
      state.activeProfileId === targetId ? null : state.activeProfileId,
      state.workingState,
      state.vectorscopeMultiband
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  moveScope: (scope, direction) => {
    const state = get()
    const index = state.scopeOrder.indexOf(scope)
    if (index === -1) return

    const nextIndex = direction === 'earlier' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= state.scopeOrder.length) return

    const nextOrder = [...state.scopeOrder]
    const [movedScope] = nextOrder.splice(index, 1)
    nextOrder.splice(nextIndex, 0, movedScope)

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      order: nextOrder,
      hiddenScopes: nextOrder.filter((item) => state.hiddenScopes.includes(item)),
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeDeckLayout: (order, hiddenScopes) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      order,
      hiddenScopes,
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeHidden: (scope, hidden) => {
    const state = get()
    const hiddenSet = new Set(state.hiddenScopes)

    if (hidden) {
      hiddenSet.add(scope)
    } else {
      hiddenSet.delete(scope)
    }

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      hiddenScopes: state.scopeOrder.filter((item) => hiddenSet.has(item)),
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeWidthWeight: (scope, weight) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      widthWeights: {
        ...state.widthWeights,
        [scope]: clampWidthWeight(scope, weight),
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setScopeWidthWeights: (weights) => {
    const state = get()
    const nextWidthWeights: Record<ScopeKind, number> = {
      ...state.widthWeights,
    }

    for (const scope of SCOPE_KINDS) {
      const weight = weights[scope]
      if (weight === undefined) continue
      nextWidthWeights[scope] = clampWidthWeight(scope, weight)
    }

    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      widthWeights: nextWidthWeights,
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setFftSize: (size) => {
    if (!isFFTSize(size)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        spectrum: {
          ...state.workingState.scopeSettings.spectrum,
          fftSize: size,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setPitchLock: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        oscilloscope: {
          ...state.workingState.scopeSettings.oscilloscope,
          pitchLock: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setOscilloscopeUnderfillEnabled: (enabled) => {
    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        oscilloscope: {
          ...state.workingState.scopeSettings.oscilloscope,
          underfillEnabled: enabled,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVectorscopeMode: (mode) => {
    if (!isVectorscopeMode(mode)) return

    const state = get()
    const nextSnapshot = updateWorkingState(state, {
      ...state.workingState,
      scopeSettings: {
        ...state.workingState.scopeSettings,
        vectorscope: {
          ...state.workingState.scopeSettings.vectorscope,
          mode,
        },
      },
    })

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },

  setVectorscopeMultiband: (enabled) => {
    persistVectorscopeMultibandPreference(enabled)
    set({ vectorscopeMultiband: enabled })
  },

  resetToDefaults: () => {
    const nextSnapshot = buildSnapshot(
      DEFAULT_LINE_COLOR,
      DEFAULT_RUNNING,
      BUILT_IN_PROFILES,
      DEFAULT_PROFILE_ID,
      DEFAULT_WORKING_STATE
    )

    persistState(nextSnapshot.profiles, nextSnapshot.activeProfileId, nextSnapshot.workingState)
    set(nextSnapshot)
  },
}))

export function getActiveAnalyzerProfile(): AnalyzerProfile | null {
  const state = useVisualizerSettingsStore.getState()
  if (!state.activeProfileId) return null
  return state.profiles[state.activeProfileId] ?? null
}
