import { create } from 'zustand'
import type { SettingsSectionId } from '../constants/settingsSections'
import type { Track } from '../types/audio'

export type AppView = 'home' | 'library' | 'eq' | 'settings' | 'playlist' | 'metadata'
export type WaveformTimeDisplayMode = 'remaining' | 'duration'
export const DEFAULT_ANALYZER_HEIGHT_PX = 196
export const MIN_ANALYZER_HEIGHT_PX = 144
export const MAX_ANALYZER_HEIGHT_PX = 320
export const ANALYZER_HEIGHT_STORAGE_KEY = 'astra-analyzer-height-px'
export const ANALYZER_RACK_VISIBILITY_STORAGE_KEY = 'astra-show-analyzer-rack'

export interface LibraryTrackRevealRequest {
  id: number
  trackPath: string
}

export interface QueueInsertDropTarget {
  kind: 'empty' | 'user'
  index: number
}

export interface QueueInsertDragState {
  tracks: Track[]
  pointerX: number
  pointerY: number
  dropTarget: QueueInsertDropTarget | null
}

function areQueueInsertDropTargetsEqual(
  left: QueueInsertDropTarget | null,
  right: QueueInsertDropTarget | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.kind === right.kind && left.index === right.index
}

function areQueueInsertTracksEqual(left: Track[], right: Track[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.path !== right[index]?.path) {
      return false
    }
  }
  return true
}

const WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY = 'astra-waveform-time-display-mode'

export function normalizeAnalyzerHeightPx(value: unknown): number {
  if (value == null) return DEFAULT_ANALYZER_HEIGHT_PX
  if (typeof value === 'string' && value.trim().length === 0) return DEFAULT_ANALYZER_HEIGHT_PX

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_ANALYZER_HEIGHT_PX

  const snapped = Math.round(numeric / 4) * 4
  return Math.min(MAX_ANALYZER_HEIGHT_PX, Math.max(MIN_ANALYZER_HEIGHT_PX, snapped))
}

function readWaveformTimeDisplayModePreference(): WaveformTimeDisplayMode {
  try {
    const saved = localStorage.getItem(WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY)
    return saved === 'duration' ? 'duration' : 'remaining'
  } catch {
    return 'remaining'
  }
}

function persistWaveformTimeDisplayModePreference(mode: WaveformTimeDisplayMode): void {
  try {
    localStorage.setItem(WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readAnalyzerHeightPreference(): number {
  try {
    return normalizeAnalyzerHeightPx(localStorage.getItem(ANALYZER_HEIGHT_STORAGE_KEY))
  } catch {
    return DEFAULT_ANALYZER_HEIGHT_PX
  }
}

function persistAnalyzerHeightPreference(heightPx: number): void {
  try {
    localStorage.setItem(ANALYZER_HEIGHT_STORAGE_KEY, String(normalizeAnalyzerHeightPx(heightPx)))
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readAnalyzerRackVisibilityPreference(): boolean {
  try {
    return localStorage.getItem(ANALYZER_RACK_VISIBILITY_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

function persistAnalyzerRackVisibilityPreference(visible: boolean): void {
  try {
    localStorage.setItem(ANALYZER_RACK_VISIBILITY_STORAGE_KEY, visible ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

const initialWaveformTimeDisplayMode = readWaveformTimeDisplayModePreference()
const initialAnalyzerHeightPx = readAnalyzerHeightPreference()
const initialAnalyzerRackVisible = readAnalyzerRackVisibilityPreference()
let nextLibraryTrackRevealRequestId = 0

interface UIStore {
  activeView: AppView
  showQueue: boolean
  showInfoSidebar: boolean
  showPipelineShelf: boolean
  showLyricsShelf: boolean
  lyricsShelfExpanded: boolean
  isAnalyzerEditMode: boolean
  isAnalyzerRackVisible: boolean
  isFullscreen: boolean
  analyzerHeightPx: number
  waveformTimeDisplayMode: WaveformTimeDisplayMode
  libraryTrackRevealRequest: LibraryTrackRevealRequest | null
  isQuickLaunchOpen: boolean
  isKeyboardShortcutsOpen: boolean
  pendingLibrarySearchQuery: string | null
  pendingSettingsSection: SettingsSectionId | null
  queueInsertDrag: QueueInsertDragState | null
  setActiveView: (view: AppView) => void
  toggleQueue: () => void
  toggleInfoSidebar: () => void
  togglePipelineShelf: () => void
  toggleLyricsShelf: () => void
  setLyricsShelfExpanded: (expanded: boolean) => void
  closeLyricsShelf: () => void
  openAnalyzerEditMode: () => void
  closeAnalyzerEditMode: () => void
  toggleAnalyzerEditMode: () => void
  showAnalyzerRack: () => void
  hideAnalyzerRack: () => void
  toggleAnalyzerRack: () => void
  setFullscreen: (fs: boolean) => void
  setAnalyzerHeightPx: (heightPx: number) => void
  resetAnalyzerHeightPx: () => void
  resetAnalyzerRackPreferences: () => void
  toggleWaveformTimeDisplayMode: () => void
  requestLibraryTrackReveal: (trackPath: string) => void
  openQuickLaunch: () => void
  closeQuickLaunch: () => void
  toggleQuickLaunch: () => void
  openKeyboardShortcuts: () => void
  closeKeyboardShortcuts: () => void
  toggleKeyboardShortcuts: () => void
  setPendingLibrarySearchQuery: (query: string | null) => void
  consumePendingLibrarySearchQuery: () => string | null
  setPendingSettingsSection: (section: SettingsSectionId | null) => void
  consumePendingSettingsSection: () => SettingsSectionId | null
  startQueueInsertDrag: (tracks: Track[], pointerX: number, pointerY: number) => void
  setQueueInsertDragTracks: (tracks: Track[]) => void
  updateQueueInsertDragPointer: (pointerX: number, pointerY: number) => void
  setQueueInsertDropTarget: (target: QueueInsertDropTarget | null) => void
  clearQueueInsertDrag: () => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  activeView: 'home',
  showQueue: false,
  showInfoSidebar: false,
  showPipelineShelf: false,
  showLyricsShelf: false,
  lyricsShelfExpanded: false,
  isAnalyzerEditMode: false,
  isAnalyzerRackVisible: initialAnalyzerRackVisible,
  isFullscreen: false,
  analyzerHeightPx: initialAnalyzerHeightPx,
  waveformTimeDisplayMode: initialWaveformTimeDisplayMode,
  libraryTrackRevealRequest: null,
  isQuickLaunchOpen: false,
  isKeyboardShortcutsOpen: false,
  pendingLibrarySearchQuery: null,
  pendingSettingsSection: null,
  queueInsertDrag: null,
  setActiveView: (view) => set({ activeView: view }),
  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
  toggleInfoSidebar: () => set((s) => ({ showInfoSidebar: !s.showInfoSidebar })),
  togglePipelineShelf: () => set((s) => ({ showPipelineShelf: !s.showPipelineShelf })),
  toggleLyricsShelf: () => set((s) => {
    if (s.showLyricsShelf) {
      return {
        showLyricsShelf: false,
        lyricsShelfExpanded: false
      }
    }
    return {
      showLyricsShelf: true
    }
  }),
  setLyricsShelfExpanded: (expanded) => set((s) => {
    if (!s.showLyricsShelf) {
      return { lyricsShelfExpanded: false }
    }
    return { lyricsShelfExpanded: expanded }
  }),
  closeLyricsShelf: () => set({
    showLyricsShelf: false,
    lyricsShelfExpanded: false
  }),
  openAnalyzerEditMode: () => set({ isAnalyzerEditMode: true }),
  closeAnalyzerEditMode: () => set({ isAnalyzerEditMode: false }),
  toggleAnalyzerEditMode: () => set((s) => ({ isAnalyzerEditMode: !s.isAnalyzerEditMode })),
  showAnalyzerRack: () => {
    persistAnalyzerRackVisibilityPreference(true)
    set({ isAnalyzerRackVisible: true })
  },
  hideAnalyzerRack: () => {
    persistAnalyzerRackVisibilityPreference(false)
    set({
      isAnalyzerRackVisible: false,
      isAnalyzerEditMode: false,
    })
  },
  toggleAnalyzerRack: () => set((s) => {
    const nextVisible = !s.isAnalyzerRackVisible
    persistAnalyzerRackVisibilityPreference(nextVisible)
    return {
      isAnalyzerRackVisible: nextVisible,
      isAnalyzerEditMode: nextVisible ? s.isAnalyzerEditMode : false,
    }
  }),
  setFullscreen: (fs) => set({ isFullscreen: fs }),
  setAnalyzerHeightPx: (heightPx) => {
    const nextHeightPx = normalizeAnalyzerHeightPx(heightPx)
    persistAnalyzerHeightPreference(nextHeightPx)
    set({ analyzerHeightPx: nextHeightPx })
  },
  resetAnalyzerHeightPx: () => {
    persistAnalyzerHeightPreference(DEFAULT_ANALYZER_HEIGHT_PX)
    set({ analyzerHeightPx: DEFAULT_ANALYZER_HEIGHT_PX })
  },
  resetAnalyzerRackPreferences: () => {
    persistAnalyzerRackVisibilityPreference(true)
    persistAnalyzerHeightPreference(DEFAULT_ANALYZER_HEIGHT_PX)
    set({
      isAnalyzerRackVisible: true,
      isAnalyzerEditMode: false,
      analyzerHeightPx: DEFAULT_ANALYZER_HEIGHT_PX,
    })
  },
  toggleWaveformTimeDisplayMode: () => set((s) => {
    const nextMode: WaveformTimeDisplayMode = s.waveformTimeDisplayMode === 'remaining' ? 'duration' : 'remaining'
    persistWaveformTimeDisplayModePreference(nextMode)
    return { waveformTimeDisplayMode: nextMode }
  }),
  requestLibraryTrackReveal: (trackPath) => set(() => {
    nextLibraryTrackRevealRequestId += 1
    return {
      libraryTrackRevealRequest: {
        id: nextLibraryTrackRevealRequestId,
        trackPath
      }
    }
  }),
  openQuickLaunch: () => set({ isQuickLaunchOpen: true }),
  closeQuickLaunch: () => set({ isQuickLaunchOpen: false }),
  toggleQuickLaunch: () => set((s) => ({ isQuickLaunchOpen: !s.isQuickLaunchOpen })),
  openKeyboardShortcuts: () => set({ isKeyboardShortcutsOpen: true }),
  closeKeyboardShortcuts: () => set({ isKeyboardShortcutsOpen: false }),
  toggleKeyboardShortcuts: () => set((s) => ({ isKeyboardShortcutsOpen: !s.isKeyboardShortcutsOpen })),
  setPendingLibrarySearchQuery: (query) => set({ pendingLibrarySearchQuery: query }),
  consumePendingLibrarySearchQuery: () => {
    const query = get().pendingLibrarySearchQuery
    if (query !== null) {
      set({ pendingLibrarySearchQuery: null })
    }
    return query
  },
  setPendingSettingsSection: (section) => set({ pendingSettingsSection: section }),
  consumePendingSettingsSection: () => {
    const section = get().pendingSettingsSection
    if (section !== null) {
      set({ pendingSettingsSection: null })
    }
    return section
  },
  startQueueInsertDrag: (tracks, pointerX, pointerY) => set({
    queueInsertDrag: {
      tracks,
      pointerX,
      pointerY,
      dropTarget: null
    }
  }),
  setQueueInsertDragTracks: (tracks) => set((state) => {
    if (!state.queueInsertDrag) return state
    if (areQueueInsertTracksEqual(state.queueInsertDrag.tracks, tracks)) {
      return state
    }
    return {
      queueInsertDrag: {
        ...state.queueInsertDrag,
        tracks
      }
    }
  }),
  updateQueueInsertDragPointer: (pointerX, pointerY) => set((state) => {
    if (!state.queueInsertDrag) return state
    if (state.queueInsertDrag.pointerX === pointerX && state.queueInsertDrag.pointerY === pointerY) {
      return state
    }
    return {
      queueInsertDrag: {
        ...state.queueInsertDrag,
        pointerX,
        pointerY
      }
    }
  }),
  setQueueInsertDropTarget: (target) => set((state) => {
    if (!state.queueInsertDrag) return state
    if (areQueueInsertDropTargetsEqual(state.queueInsertDrag.dropTarget, target)) {
      return state
    }
    return {
      queueInsertDrag: {
        ...state.queueInsertDrag,
        dropTarget: target
      }
    }
  }),
  clearQueueInsertDrag: () => set({ queueInsertDrag: null })
}))
