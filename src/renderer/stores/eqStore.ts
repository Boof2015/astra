import { create } from 'zustand'
import { EQBand, EQPreset } from '../types/audio'
import { audioEngine } from '../audio/AudioEngine'
import { parseAutoEQ } from '../utils/autoEQParser'
import {
  clampEQGain,
  createNormalizedEQBand,
  parseEQPresetData,
  parseEQPresetJSON,
  serializeEQPresetData,
} from '../utils/eq'
import { useAudioSettingsStore } from './audioSettingsStore'

let bandIdCounter = 0
const genId = (): string => `band-${++bandIdCounter}`

// ============================================
// Persistence helpers
// ============================================

export const EQ_STORAGE_KEY = 'astra-eq-custom-presets'
export const EQ_DEVICE_PROFILE_STORAGE_KEY = 'astra-eq-device-profiles-v1'
const EQ_DEVICE_PROFILE_STORAGE_VERSION = 1
const DEFAULT_OUTPUT_PROFILE_KEY = 'default'

interface PersistedEQDeviceProfile {
  presetId: string
  enabled: boolean
  updatedAt: number
}

interface PersistedEQDeviceProfileEnvelope {
  version: number
  profiles: Record<string, PersistedEQDeviceProfile>
}

type EQDeviceProfileMap = Record<string, PersistedEQDeviceProfile>

function loadCustomPresets(): EQPreset[] {
  try {
    const raw = localStorage.getItem(EQ_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((value, index) => {
      try {
        const preset = parseEQPresetData(value, genId)
        const rawPreset = value as Partial<EQPreset>
        const presetId = typeof rawPreset.id === 'string' && rawPreset.id.trim().length > 0
          ? rawPreset.id.trim()
          : `custom-restored-${index + 1}`

        return [{
          ...preset,
          id: presetId,
          isCustom: true,
        }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function persistCustomPresets(presets: EQPreset[]): void {
  const serializable = presets
    .filter((p) => p.isCustom)
    .map((p) => {
      const serializedPreset = serializeEQPresetData(p)
      return {
      id: p.id,
      name: serializedPreset.name,
      preamp: serializedPreset.preamp,
      isCustom: true,
      bands: serializedPreset.bands,
    }
    })
  try {
    localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(serializable))
  } catch (error) {
    console.warn('Failed to persist custom EQ presets:', error)
  }
}

function normalizeOutputProfileKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length === 0) return null
  return normalized
}

function resolveActiveOutputProfileKey(): string {
  return normalizeOutputProfileKey(useAudioSettingsStore.getState().activeDelayProfileKey)
    ?? DEFAULT_OUTPUT_PROFILE_KEY
}

function normalizePersistedEQDeviceProfile(value: unknown): PersistedEQDeviceProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Partial<PersistedEQDeviceProfile>
  if (typeof raw.presetId !== 'string' || raw.presetId.trim().length === 0) {
    return null
  }

  const updatedAt = Number.isFinite(raw.updatedAt)
    ? Math.max(0, Math.trunc(Number(raw.updatedAt)))
    : Date.now()

  return {
    presetId: raw.presetId.trim(),
    enabled: Boolean(raw.enabled),
    updatedAt,
  }
}

function parsePersistedEQDeviceProfiles(value: unknown): EQDeviceProfileMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const out: EQDeviceProfileMap = {}
  for (const [rawKey, rawProfile] of Object.entries(value)) {
    const key = normalizeOutputProfileKey(rawKey)
    if (!key) continue
    const profile = normalizePersistedEQDeviceProfile(rawProfile)
    if (!profile) continue
    out[key] = profile
  }

  return out
}

function loadEQDeviceProfiles(): EQDeviceProfileMap {
  try {
    const raw = localStorage.getItem(EQ_DEVICE_PROFILE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const envelope = parsed as Partial<PersistedEQDeviceProfileEnvelope>
    if (envelope.profiles && typeof envelope.profiles === 'object') {
      return parsePersistedEQDeviceProfiles(envelope.profiles)
    }

    // Recovery path for any legacy/non-enveloped shape.
    return parsePersistedEQDeviceProfiles(parsed)
  } catch {
    return {}
  }
}

let eqDeviceProfilesByOutputKey: EQDeviceProfileMap = loadEQDeviceProfiles()

function persistEQDeviceProfiles(): void {
  try {
    const payload: PersistedEQDeviceProfileEnvelope = {
      version: EQ_DEVICE_PROFILE_STORAGE_VERSION,
      profiles: eqDeviceProfilesByOutputKey,
    }
    localStorage.setItem(EQ_DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn('Failed to persist EQ device profiles:', error)
  }
}

function setEQDeviceProfileForOutputKey(outputProfileKey: string, presetId: string, enabled: boolean): void {
  const key = normalizeOutputProfileKey(outputProfileKey)
  if (!key) return

  eqDeviceProfilesByOutputKey = {
    ...eqDeviceProfilesByOutputKey,
    [key]: {
      presetId,
      enabled,
      updatedAt: Date.now(),
    },
  }
  persistEQDeviceProfiles()
}

function updateEQDeviceProfileEnabledForOutputKey(outputProfileKey: string, enabled: boolean): void {
  const key = normalizeOutputProfileKey(outputProfileKey)
  if (!key) return

  const existing = eqDeviceProfilesByOutputKey[key]
  if (!existing) return

  eqDeviceProfilesByOutputKey = {
    ...eqDeviceProfilesByOutputKey,
    [key]: {
      ...existing,
      enabled,
      updatedAt: Date.now(),
    },
  }
  persistEQDeviceProfiles()
}

function removeEQDeviceProfileForOutputKey(outputProfileKey: string): void {
  const key = normalizeOutputProfileKey(outputProfileKey)
  if (!key) return
  if (!eqDeviceProfilesByOutputKey[key]) return

  const { [key]: _removed, ...rest } = eqDeviceProfilesByOutputKey
  eqDeviceProfilesByOutputKey = rest
  persistEQDeviceProfiles()
}

function removeEQDeviceProfilesByPresetId(presetId: string): void {
  let changed = false
  const nextProfiles: EQDeviceProfileMap = {}

  for (const [key, profile] of Object.entries(eqDeviceProfilesByOutputKey)) {
    if (profile.presetId === presetId) {
      changed = true
      continue
    }
    nextProfiles[key] = profile
  }

  if (!changed) return
  eqDeviceProfilesByOutputKey = nextProfiles
  persistEQDeviceProfiles()
}

function clearAllEQDeviceProfiles(): void {
  eqDeviceProfilesByOutputKey = {}
  try {
    localStorage.removeItem(EQ_DEVICE_PROFILE_STORAGE_KEY)
  } catch (error) {
    console.warn('Failed to clear EQ device profiles:', error)
  }
}

let isApplyingDeviceProfileRestore = false

// ============================================
// Default bands & built-in presets
// ============================================

const DEFAULT_BANDS: EQBand[] = [
  { id: genId(), type: 'lowshelf', frequency: 60, gain: 0, Q: 0.707 },
  { id: genId(), type: 'peaking', frequency: 250, gain: 0, Q: 1.0 },
  { id: genId(), type: 'peaking', frequency: 1000, gain: 0, Q: 1.0 },
  { id: genId(), type: 'peaking', frequency: 4000, gain: 0, Q: 1.0 },
  { id: genId(), type: 'highshelf', frequency: 12000, gain: 0, Q: 0.707 },
]

const BUILT_IN_PRESETS: EQPreset[] = [
  { id: 'flat', name: 'Flat', bands: DEFAULT_BANDS.map(b => ({ ...b, id: genId() })), preamp: 0 },
  {
    id: 'bass-boost', name: 'Bass Boost', preamp: -2,
    bands: [
      { id: genId(), type: 'lowshelf', frequency: 60, gain: 6, Q: 0.707 },
      { id: genId(), type: 'peaking', frequency: 150, gain: 4, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 400, gain: 1, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 1000, gain: 0, Q: 1.0 },
      { id: genId(), type: 'highshelf', frequency: 12000, gain: 0, Q: 0.707 },
    ],
  },
  {
    id: 'treble-boost', name: 'Treble Boost', preamp: -2,
    bands: [
      { id: genId(), type: 'lowshelf', frequency: 60, gain: 0, Q: 0.707 },
      { id: genId(), type: 'peaking', frequency: 1000, gain: 0, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 4000, gain: 3, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 8000, gain: 5, Q: 1.0 },
      { id: genId(), type: 'highshelf', frequency: 12000, gain: 6, Q: 0.707 },
    ],
  },
  {
    id: 'vocal', name: 'Vocal', preamp: -1,
    bands: [
      { id: genId(), type: 'lowshelf', frequency: 80, gain: -2, Q: 0.707 },
      { id: genId(), type: 'peaking', frequency: 250, gain: 1, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 1500, gain: 4, Q: 1.2 },
      { id: genId(), type: 'peaking', frequency: 4000, gain: 3, Q: 1.0 },
      { id: genId(), type: 'highshelf', frequency: 12000, gain: 1, Q: 0.707 },
    ],
  },
  {
    id: 'loudness', name: 'Loudness', preamp: -3,
    bands: [
      { id: genId(), type: 'lowshelf', frequency: 60, gain: 5, Q: 0.707 },
      { id: genId(), type: 'peaking', frequency: 400, gain: 2, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 1000, gain: -1, Q: 1.0 },
      { id: genId(), type: 'peaking', frequency: 4000, gain: 2, Q: 1.0 },
      { id: genId(), type: 'highshelf', frequency: 12000, gain: 5, Q: 0.707 },
    ],
  },
]

interface EQStore {
  // State
  enabled: boolean
  bands: EQBand[]
  preamp: number // dB, -12 to +12
  presets: EQPreset[]
  activePresetId: string | null
  showEQPanel: boolean

  // Actions
  setEnabled: (enabled: boolean) => void
  toggleEnabled: () => void
  setPreamp: (dB: number) => void
  addBand: (band?: Partial<EQBand>) => void
  removeBand: (index: number) => void
  updateBand: (index: number, updates: Partial<EQBand>) => void
  applyPreset: (preset: EQPreset) => void
  resetEQ: () => void
  toggleEQPanel: () => void
  setShowEQPanel: (show: boolean) => void

  // Custom preset management
  saveCustomPreset: (name: string) => void
  deleteCustomPreset: (presetId: string) => void
  importPreset: (preset: EQPreset) => void
  exportPreset: (presetId: string) => Promise<void>
  importFromFile: () => Promise<void>
  importAutoEQ: () => Promise<void>
  resetToDefaults: () => void

  // Internal
  _syncToEngine: () => void
}

function createDefaultBands(): EQBand[] {
  return DEFAULT_BANDS.map((band) => createNormalizedEQBand(band, genId()))
}

function buildBandsFromPreset(preset: EQPreset): EQBand[] {
  return preset.bands.map((band) => createNormalizedEQBand(band, genId()))
}

export const useEQStore = create<EQStore>((set, get) => ({
  enabled: false,
  bands: createDefaultBands(),
  preamp: 0,
  presets: [...BUILT_IN_PRESETS, ...loadCustomPresets()],
  activePresetId: null,
  showEQPanel: false,

  setEnabled: (enabled: boolean) => {
    set({ enabled })
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      updateEQDeviceProfileEnabledForOutputKey(resolveActiveOutputProfileKey(), enabled)
    }
  },

  toggleEnabled: () => {
    set((state) => ({ enabled: !state.enabled }))
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      updateEQDeviceProfileEnabledForOutputKey(resolveActiveOutputProfileKey(), get().enabled)
    }
  },

  setPreamp: (dB: number) => {
    const clamped = clampEQGain(dB)
    set({ preamp: clamped, activePresetId: null })
    audioEngine.updatePreamp(clamped)
    if (!isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  addBand: (partial?: Partial<EQBand>) => {
    const { bands } = get()
    if (bands.length >= 10) return

    // Find largest frequency gap (log scale) for default placement
    let freq = 1000
    if (bands.length > 0) {
      const sorted = [...bands].sort((a, b) => a.frequency - b.frequency)
      const points = [20, ...sorted.map(b => b.frequency), 20000]
      let maxGap = 0
      let gapStart = 20
      let gapEnd = 20000
      for (let i = 0; i < points.length - 1; i++) {
        const gap = Math.log10(points[i + 1]) - Math.log10(points[i])
        if (gap > maxGap) {
          maxGap = gap
          gapStart = points[i]
          gapEnd = points[i + 1]
        }
      }
      freq = Math.round(Math.sqrt(gapStart * gapEnd))
    }

    const newBand: EQBand = createNormalizedEQBand({
      type: partial?.type ?? 'peaking',
      frequency: partial?.frequency ?? freq,
      gain: partial?.gain ?? 0,
      Q: partial?.Q ?? 1.0,
    }, genId())

    const newBands = [...bands, newBand].sort((a, b) => a.frequency - b.frequency)
    set({ bands: newBands, activePresetId: null })
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  removeBand: (index: number) => {
    const { bands } = get()
    if (index < 0 || index >= bands.length) return
    const newBands = bands.filter((_, i) => i !== index)
    set({ bands: newBands, activePresetId: null })
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  updateBand: (index: number, updates: Partial<EQBand>) => {
    const { bands, enabled } = get()
    if (index < 0 || index >= bands.length) return
    const updated = createNormalizedEQBand({ ...bands[index], ...updates }, bands[index].id)
    const newBands = [...bands]
    newBands[index] = updated
    set({ bands: newBands, activePresetId: null })

    // Use efficient single-band update if only params changed (no add/remove)
    if (enabled) {
      audioEngine.updateEQBand(index, updated)
    }

    if (!isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  applyPreset: (preset: EQPreset) => {
    const newBands = buildBandsFromPreset(preset)
    set({ bands: newBands, preamp: preset.preamp, activePresetId: preset.id })
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      setEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey(), preset.id, get().enabled)
    }
  },

  resetEQ: () => {
    const newBands = createDefaultBands()
    set({ bands: newBands, preamp: 0, activePresetId: null })
    get()._syncToEngine()
    if (!isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  toggleEQPanel: () => set(s => ({ showEQPanel: !s.showEQPanel })),
  setShowEQPanel: (show: boolean) => set({ showEQPanel: show }),

  // ============================================
  // Custom preset management
  // ============================================

  saveCustomPreset: (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return

    const { bands, preamp, presets } = get()
    const id = `custom-${Date.now()}`
    const newPreset: EQPreset = {
      id,
      name: trimmed,
      bands: bands.map((b) => ({ ...b, id: genId() })),
      preamp,
      isCustom: true,
    }
    const updated = [...presets, newPreset]
    set({ presets: updated, activePresetId: id })
    persistCustomPresets(updated)
    if (!isApplyingDeviceProfileRestore) {
      setEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey(), id, get().enabled)
    }
  },

  deleteCustomPreset: (presetId: string) => {
    const { presets, activePresetId } = get()
    const target = presets.find((p) => p.id === presetId)
    if (!target || !target.isCustom) return

    const updated = presets.filter((p) => p.id !== presetId)
    set({
      presets: updated,
      activePresetId: activePresetId === presetId ? null : activePresetId,
    })
    persistCustomPresets(updated)
    removeEQDeviceProfilesByPresetId(presetId)
    if (activePresetId === presetId && !isApplyingDeviceProfileRestore) {
      removeEQDeviceProfileForOutputKey(resolveActiveOutputProfileKey())
    }
  },

  importPreset: (preset: EQPreset) => {
    const { presets } = get()
    const id = `custom-${Date.now()}`
    const imported: EQPreset = {
      ...preset,
      id,
      isCustom: true,
      bands: preset.bands.slice(0, 10).map((band) => createNormalizedEQBand(band, genId())),
    }
    const updated = [...presets, imported]
    set({ presets: updated, activePresetId: id })
    get().applyPreset(imported)
    persistCustomPresets(updated)
  },

  exportPreset: async (presetId: string) => {
    const { presets } = get()
    const preset = presets.find((p) => p.id === presetId)
    if (!preset) return

    const exportData = serializeEQPresetData(preset)

    const filePath = await window.electronAPI.showSaveDialog({
      title: 'Export EQ Preset',
      defaultPath: `${preset.name}.json`,
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    })
    if (filePath) {
      await window.electronAPI.writeFile(filePath, JSON.stringify(exportData, null, 2))
    }
  },

  importFromFile: async () => {
    const filePath = await window.electronAPI.openFileDialog({
      title: 'Import EQ Preset',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    })
    if (!filePath) return

    try {
      const content = await window.electronAPI.readTextFile(filePath)
      const preset = parseEQPresetJSON(content, genId)
      get().importPreset(preset)
    } catch (err) {
      console.error('Failed to import preset:', err)
    }
  },

  importAutoEQ: async () => {
    const filePath = await window.electronAPI.openFileDialog({
      title: 'Import AutoEQ Profile',
      filters: [
        { name: 'AutoEQ Files', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!filePath) return

    try {
      const content = await window.electronAPI.readTextFile(filePath)
      const preset = parseAutoEQ(content, filePath)
      get().importPreset(preset)
    } catch (err) {
      console.error('Failed to import AutoEQ profile:', err)
    }
  },

  resetToDefaults: () => {
    try {
      localStorage.removeItem(EQ_STORAGE_KEY)
    } catch (error) {
      console.warn('Failed to clear custom EQ presets:', error)
    }
    clearAllEQDeviceProfiles()
    const newBands = createDefaultBands()
    set({
      enabled: false,
      bands: newBands,
      preamp: 0,
      presets: [...BUILT_IN_PRESETS],
      activePresetId: null,
      showEQPanel: false,
    })
    get()._syncToEngine()
  },

  _syncToEngine: () => {
    const { bands, preamp, enabled } = get()
    audioEngine.updateEQ(bands, preamp, enabled)
  },
}))

function persistCurrentEQProfileForOutputKey(outputProfileKey: string): void {
  const normalizedKey = normalizeOutputProfileKey(outputProfileKey) ?? DEFAULT_OUTPUT_PROFILE_KEY
  const state = useEQStore.getState()
  const activePresetId = state.activePresetId
  if (!activePresetId) {
    removeEQDeviceProfileForOutputKey(normalizedKey)
    return
  }

  const presetExists = state.presets.some((preset) => preset.id === activePresetId)
  if (!presetExists) {
    removeEQDeviceProfileForOutputKey(normalizedKey)
    return
  }

  setEQDeviceProfileForOutputKey(normalizedKey, activePresetId, state.enabled)
}

function applyFallbackEQForOutput(): void {
  isApplyingDeviceProfileRestore = true
  useEQStore.setState({
    enabled: false,
    bands: createDefaultBands(),
    preamp: 0,
    activePresetId: null,
  })
  isApplyingDeviceProfileRestore = false
  useEQStore.getState()._syncToEngine()
}

function applyDeviceEQProfileForOutputKey(outputProfileKey: string): void {
  const normalizedKey = normalizeOutputProfileKey(outputProfileKey) ?? DEFAULT_OUTPUT_PROFILE_KEY
  const profile = eqDeviceProfilesByOutputKey[normalizedKey]
  if (!profile) {
    applyFallbackEQForOutput()
    return
  }

  const { presets } = useEQStore.getState()
  const preset = presets.find((candidate) => candidate.id === profile.presetId)
  if (!preset) {
    removeEQDeviceProfileForOutputKey(normalizedKey)
    applyFallbackEQForOutput()
    return
  }

  isApplyingDeviceProfileRestore = true
  useEQStore.setState({
    enabled: profile.enabled,
    bands: buildBandsFromPreset(preset),
    preamp: preset.preamp,
    activePresetId: preset.id,
  })
  isApplyingDeviceProfileRestore = false
  useEQStore.getState()._syncToEngine()
}

function initializeDeviceAwareEQPersistence(): void {
  let previousOutputProfileKey = resolveActiveOutputProfileKey()
  applyDeviceEQProfileForOutputKey(previousOutputProfileKey)

  useAudioSettingsStore.subscribe((nextState, prevState) => {
    const nextOutputProfileKey = normalizeOutputProfileKey(nextState.activeDelayProfileKey) ?? DEFAULT_OUTPUT_PROFILE_KEY
    const prevOutputProfileKey = normalizeOutputProfileKey(prevState.activeDelayProfileKey) ?? previousOutputProfileKey
    if (nextOutputProfileKey === prevOutputProfileKey) return

    persistCurrentEQProfileForOutputKey(prevOutputProfileKey)
    previousOutputProfileKey = nextOutputProfileKey
    applyDeviceEQProfileForOutputKey(nextOutputProfileKey)
  })
}

initializeDeviceAwareEQPersistence()
