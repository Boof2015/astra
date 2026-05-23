import { create } from 'zustand'
import type { TrackOverrideSnapshot } from '../../preload/index'

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
  artworkPath?: string | null
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

export interface MetadataEditorPanelRequest {
  id: number
  trackPaths: string[]
  skippedRemoteCount: number
}

export interface OpenMetadataEditorPanelRequest {
  trackPaths: string[]
  skippedRemoteCount?: number
}

interface UndoSnapshot {
  previousOverrides: Record<string, TrackOverrideSnapshot | null>
  trackPaths: string[]
}

const METADATA_SAVE_MODE_STORAGE_KEY = 'astra-metadata-save-mode-v1'
const MAX_UNDO_STACK_SIZE = 20
let nextPanelRequestId = 0

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
  panelRequest: MetadataEditorPanelRequest | null
  overridePaths: Set<string>
  isSaving: boolean
  lastResult: MetadataEditResult | null
  undoStack: UndoSnapshot[]
  redoStack: UndoSnapshot[]

  openPanel: (request: OpenMetadataEditorPanelRequest) => void
  closePanel: () => void
  setSaveMode: (mode: MetadataSaveMode) => void
  setDefaultSaveMode: (mode: MetadataSaveMode) => void
  loadOverridePaths: () => Promise<void>
  clearOverrides: (trackPaths: string[]) => Promise<{ cleared: number }>
  saveEdits: (request: MetadataEditRequest) => Promise<MetadataEditResult>
  clearLastResult: () => void
  undo: () => Promise<string[]>
  redo: () => Promise<string[]>
}

const initialDefaultMode = readSavedDefaultMode()

function normalizePanelTrackPaths(trackPaths: string[]): string[] {
  const normalized = trackPaths
    .map((trackPath) => trackPath.trim())
    .filter((trackPath) => trackPath.length > 0)
  return Array.from(new Set(normalized))
}

export const useMetadataEditorStore = create<MetadataEditorStore>((set, get) => ({
  defaultSaveMode: initialDefaultMode,
  saveMode: initialDefaultMode,
  panelRequest: null,
  overridePaths: new Set<string>(),
  isSaving: false,
  lastResult: null,
  undoStack: [],
  redoStack: [],

  openPanel: (request) => {
    const trackPaths = normalizePanelTrackPaths(request.trackPaths)
    if (trackPaths.length === 0) return

    nextPanelRequestId += 1
    set({
      panelRequest: {
        id: nextPanelRequestId,
        trackPaths,
        skippedRemoteCount: Math.max(0, Math.trunc(request.skippedRemoteCount ?? 0))
      },
      lastResult: null
    })
  },

  closePanel: () => {
    set({ panelRequest: null })
  },

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
      let undoEntry: UndoSnapshot | undefined

      if (request.mode === 'virtual') {
        const snapshots = await window.electronAPI.library.getTrackOverrideSnapshots(request.trackPaths)
        undoEntry = {
          previousOverrides: snapshots,
          trackPaths: request.trackPaths
        }
      }

      const result = await window.electronAPI.library.saveMetadataEdits(request)
      const paths = await window.electronAPI.library.getMetadataOverridePaths()

      set((state) => {
        const nextUndoStack = undoEntry
          ? [...state.undoStack, undoEntry].slice(-MAX_UNDO_STACK_SIZE)
          : state.undoStack

        return {
          lastResult: result,
          overridePaths: new Set(paths),
          undoStack: nextUndoStack,
          redoStack: undoEntry ? [] : state.redoStack
        }
      })

      return result
    } finally {
      set({ isSaving: false })
    }
  },

  clearLastResult: () => {
    set({ lastResult: null })
  },

  undo: async () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return []

    set({ isSaving: true })
    try {
      const entry = undoStack[undoStack.length - 1]

      // Snapshot current state for redo
      const currentSnapshots = await window.electronAPI.library.getTrackOverrideSnapshots(entry.trackPaths)

      // Restore previous state
      await window.electronAPI.library.restoreTrackOverrides(entry.previousOverrides)
      const paths = await window.electronAPI.library.getMetadataOverridePaths()

      const redoEntry: UndoSnapshot = {
        previousOverrides: currentSnapshots,
        trackPaths: entry.trackPaths
      }

      set((state) => ({
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, redoEntry],
        overridePaths: new Set(paths)
      }))

      return entry.trackPaths
    } finally {
      set({ isSaving: false })
    }
  },

  redo: async () => {
    const { redoStack } = get()
    if (redoStack.length === 0) return []

    set({ isSaving: true })
    try {
      const entry = redoStack[redoStack.length - 1]

      // Snapshot current state for undo
      const currentSnapshots = await window.electronAPI.library.getTrackOverrideSnapshots(entry.trackPaths)

      // Restore the redo state
      await window.electronAPI.library.restoreTrackOverrides(entry.previousOverrides)
      const paths = await window.electronAPI.library.getMetadataOverridePaths()

      const undoEntry: UndoSnapshot = {
        previousOverrides: currentSnapshots,
        trackPaths: entry.trackPaths
      }

      set((state) => ({
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, undoEntry],
        overridePaths: new Set(paths)
      }))

      return entry.trackPaths
    } finally {
      set({ isSaving: false })
    }
  }
}))
