import { create } from 'zustand'
import { EQBand, EQPreset } from '../types/audio'
import { audioEngine } from '../audio/AudioEngine'
import { parseAutoEQ } from '../utils/autoEQParser'

let bandIdCounter = 0
const genId = (): string => `band-${++bandIdCounter}`

// ============================================
// Persistence helpers
// ============================================

const EQ_STORAGE_KEY = 'astra-eq-custom-presets'

function loadCustomPresets(): EQPreset[] {
  try {
    const raw = localStorage.getItem(EQ_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as EQPreset[]
    return parsed.map((p) => ({
      ...p,
      isCustom: true,
      bands: p.bands.map((b) => ({ ...b, id: genId() })),
    }))
  } catch {
    return []
  }
}

function persistCustomPresets(presets: EQPreset[]): void {
  const serializable = presets
    .filter((p) => p.isCustom)
    .map((p) => ({
      id: p.id,
      name: p.name,
      preamp: p.preamp,
      isCustom: true,
      bands: p.bands.map(({ type, frequency, gain, Q }) => ({ type, frequency, gain, Q })),
    }))
  localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(serializable))
}

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

export const useEQStore = create<EQStore>((set, get) => ({
  enabled: false,
  bands: DEFAULT_BANDS.map(b => ({ ...b, id: genId() })),
  preamp: 0,
  presets: [...BUILT_IN_PRESETS, ...loadCustomPresets()],
  activePresetId: null,
  showEQPanel: false,

  setEnabled: (enabled: boolean) => {
    set({ enabled })
    get()._syncToEngine()
  },

  toggleEnabled: () => {
    set(s => ({ enabled: !s.enabled }))
    get()._syncToEngine()
  },

  setPreamp: (dB: number) => {
    const clamped = Math.max(-12, Math.min(12, dB))
    set({ preamp: clamped, activePresetId: null })
    audioEngine.updatePreamp(clamped)
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

    const newBand: EQBand = {
      id: genId(),
      type: partial?.type ?? 'peaking',
      frequency: partial?.frequency ?? freq,
      gain: partial?.gain ?? 0,
      Q: partial?.Q ?? 1.0,
    }

    const newBands = [...bands, newBand].sort((a, b) => a.frequency - b.frequency)
    set({ bands: newBands, activePresetId: null })
    get()._syncToEngine()
  },

  removeBand: (index: number) => {
    const { bands } = get()
    if (index < 0 || index >= bands.length) return
    const newBands = bands.filter((_, i) => i !== index)
    set({ bands: newBands, activePresetId: null })
    get()._syncToEngine()
  },

  updateBand: (index: number, updates: Partial<EQBand>) => {
    const { bands, enabled } = get()
    if (index < 0 || index >= bands.length) return
    const updated = { ...bands[index], ...updates }
    const newBands = [...bands]
    newBands[index] = updated
    set({ bands: newBands, activePresetId: null })

    // Use efficient single-band update if only params changed (no add/remove)
    if (enabled) {
      audioEngine.updateEQBand(index, updated)
    }
  },

  applyPreset: (preset: EQPreset) => {
    const newBands = preset.bands.map(b => ({ ...b, id: genId() }))
    set({ bands: newBands, preamp: preset.preamp, activePresetId: preset.id })
    get()._syncToEngine()
  },

  resetEQ: () => {
    const newBands = DEFAULT_BANDS.map(b => ({ ...b, id: genId(), gain: 0 }))
    set({ bands: newBands, preamp: 0, activePresetId: null })
    get()._syncToEngine()
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
  },

  importPreset: (preset: EQPreset) => {
    const { presets } = get()
    const id = `custom-${Date.now()}`
    const imported: EQPreset = {
      ...preset,
      id,
      isCustom: true,
      bands: preset.bands.slice(0, 10).map((b) => ({ ...b, id: genId() })),
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

    const exportData = {
      version: 1,
      name: preset.name,
      preamp: preset.preamp,
      bands: preset.bands.map(({ type, frequency, gain, Q }) => ({ type, frequency, gain, Q })),
    }

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
      const data = JSON.parse(content)
      if (!data.name || !Array.isArray(data.bands)) {
        throw new Error('Invalid preset file')
      }
      const bands: EQBand[] = data.bands.map((b: Record<string, unknown>) => ({
        id: genId(),
        type: b.type === 'lowshelf' ? 'lowshelf' : b.type === 'highshelf' ? 'highshelf' : 'peaking',
        frequency: Math.max(20, Math.min(20000, Number(b.frequency) || 1000)),
        gain: Math.max(-12, Math.min(12, Number(b.gain) || 0)),
        Q: Math.max(0.1, Math.min(18, Number(b.Q) || 1.0)),
      }))
      get().importPreset({
        id: '',
        name: data.name,
        preamp: Math.max(-12, Math.min(12, Number(data.preamp) || 0)),
        bands,
      })
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
    localStorage.removeItem(EQ_STORAGE_KEY)
    const newBands = DEFAULT_BANDS.map((band) => ({ ...band, id: genId(), gain: 0 }))
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
