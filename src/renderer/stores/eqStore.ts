import { create } from 'zustand'
import { EQBand, EQPreset } from '../types/audio'
import { audioEngine } from '../audio/AudioEngine'

let bandIdCounter = 0
const genId = (): string => `band-${++bandIdCounter}`

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

  // Internal
  _syncToEngine: () => void
}

export const useEQStore = create<EQStore>((set, get) => ({
  enabled: false,
  bands: DEFAULT_BANDS.map(b => ({ ...b, id: genId() })),
  preamp: 0,
  presets: BUILT_IN_PRESETS,
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

  _syncToEngine: () => {
    const { bands, preamp, enabled } = get()
    audioEngine.updateEQ(bands, preamp, enabled)
  },
}))
