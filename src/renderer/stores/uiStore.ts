import { create } from 'zustand'
import type { SettingsSectionId } from '../constants/settingsSections'
import type { Track } from '../types/audio'

export type AppView = 'home' | 'library' | 'eq' | 'settings' | 'playlist' | 'metadata'
export type WaveformTimeDisplayMode = 'remaining' | 'duration'
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

const initialWaveformTimeDisplayMode = readWaveformTimeDisplayModePreference()
let nextLibraryTrackRevealRequestId = 0

interface UIStore {
  activeView: AppView
  showQueue: boolean
  showInfoSidebar: boolean
  showPipelineShelf: boolean
  showLyricsShelf: boolean
  lyricsShelfExpanded: boolean
  isFullscreen: boolean
  waveformTimeDisplayMode: WaveformTimeDisplayMode
  libraryTrackRevealRequest: LibraryTrackRevealRequest | null
  isQuickLaunchOpen: boolean
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
  setFullscreen: (fs: boolean) => void
  toggleWaveformTimeDisplayMode: () => void
  requestLibraryTrackReveal: (trackPath: string) => void
  openQuickLaunch: () => void
  closeQuickLaunch: () => void
  toggleQuickLaunch: () => void
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
  isFullscreen: false,
  waveformTimeDisplayMode: initialWaveformTimeDisplayMode,
  libraryTrackRevealRequest: null,
  isQuickLaunchOpen: false,
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
  setFullscreen: (fs) => set({ isFullscreen: fs }),
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
