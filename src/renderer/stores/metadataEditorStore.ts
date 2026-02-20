import { create } from 'zustand'

export type MetadataSaveMode = 'virtual' | 'file'

export interface MetadataEditChanges {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string | null
  genre?: string | null
  year?: number | null
  trackNumber?: number | null
  discNumber?: number | null
}

export interface MetadataEditRequest {
  mode: MetadataSaveMode
  trackPaths: string[]
  changes: MetadataEditChanges
}

export interface MetadataEditFailure {
  trackPath: string
  message: string
}

export interface MetadataEditResult {
  mode: MetadataSaveMode
  requested: number
  succeeded: number
  failed: number
  updatedTrackPaths: string[]
  failures: MetadataEditFailure[]
}

const METADATA_SAVE_MODE_STORAGE_KEY = 'astra-metadata-save-mode-v1'

function readSavedDefaultMode(): MetadataSaveMode {
  try {
    const saved = localStorage.getItem(METADATA_SAVE_MODE_STORAGE_KEY)
    return saved === 'file' ? 'file' : 'virtual'
  } catch {
    return 'virtual'
  }
}

function persistDefaultMode(mode: MetadataSaveMode): void {
  try {
    localStorage.setItem(METADATA_SAVE_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore localStorage write failures.
  }
}

interface MetadataEditorStore {
  defaultSaveMode: MetadataSaveMode
  saveMode: MetadataSaveMode
  overridePaths: Set<string>
  isSaving: boolean
  lastResult: MetadataEditResult | null

  setSaveMode: (mode: MetadataSaveMode) => void
  setDefaultSaveMode: (mode: MetadataSaveMode) => void
  loadOverridePaths: () => Promise<void>
  clearOverrides: (trackPaths: string[]) => Promise<{ cleared: number }>
  saveEdits: (request: MetadataEditRequest) => Promise<MetadataEditResult>
  clearLastResult: () => void
}

const initialDefaultMode = readSavedDefaultMode()

export const useMetadataEditorStore = create<MetadataEditorStore>((set) => ({
  defaultSaveMode: initialDefaultMode,
  saveMode: initialDefaultMode,
  overridePaths: new Set<string>(),
  isSaving: false,
  lastResult: null,

  setSaveMode: (mode) => {
    set({ saveMode: mode })
  },

  setDefaultSaveMode: (mode) => {
    persistDefaultMode(mode)
    set({ defaultSaveMode: mode, saveMode: mode })
  },

  loadOverridePaths: async () => {
    const paths = await window.electronAPI.library.getMetadataOverridePaths()
    set({ overridePaths: new Set(paths) })
  },

  clearOverrides: async (trackPaths) => {
    const result = await window.electronAPI.library.clearMetadataOverrides(trackPaths)
    const paths = await window.electronAPI.library.getMetadataOverridePaths()
    set({ overridePaths: new Set(paths) })
    return result
  },

  saveEdits: async (request) => {
    set({ isSaving: true })
    try {
      const result = await window.electronAPI.library.saveMetadataEdits(request)
      const paths = await window.electronAPI.library.getMetadataOverridePaths()
      set({ lastResult: result, overridePaths: new Set(paths) })
      return result
    } finally {
      set({ isSaving: false })
    }
  },

  clearLastResult: () => {
    set({ lastResult: null })
  }
}))
