import { create } from 'zustand'
import type { SettingsSectionId } from '../constants/settingsSections'
import type { Track } from '../types/audio'

export type AppView = 'home' | 'library' | 'graph' | 'eq' | 'settings' | 'playlist' | 'metadata'
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

export type TrackDragSurface = 'queue' | 'sidebar'

export interface QueueTrackDragDropTarget {
  surface: 'queue'
  kind: 'empty' | 'user'
  index: number
}

export interface SidebarPlaylistTrackDragDropTarget {
  surface: 'sidebar'
  kind: 'playlist'
  playlistId: number
}

export interface SidebarCreatePlaylistTrackDragDropTarget {
  surface: 'sidebar'
  kind: 'create-playlist'
}

export type TrackDragDropTarget =
  | QueueTrackDragDropTarget
  | SidebarPlaylistTrackDragDropTarget
  | SidebarCreatePlaylistTrackDragDropTarget

export interface TrackDragState {
  tracks: Track[]
  pointerX: number
  pointerY: number
  dropTarget: TrackDragDropTarget | null
}

export interface SidebarPlaylistCreateRequest {
  trackPaths: string[]
}

function areTrackDragDropTargetsEqual(
  left: TrackDragDropTarget | null,
  right: TrackDragDropTarget | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.surface !== right.surface || left.kind !== right.kind) return false
  if (left.surface === 'queue' && right.surface === 'queue') {
    return left.index === right.index
  }
  if (left.kind === 'playlist' && right.kind === 'playlist') {
    return left.playlistId === right.playlistId
  }
  return true
}

function areTrackDragTracksEqual(left: Track[], right: Track[]): boolean {
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
  trackDrag: TrackDragState | null
  sidebarPlaylistCreateRequest: SidebarPlaylistCreateRequest | null
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
  startTrackDrag: (tracks: Track[], pointerX: number, pointerY: number) => void
  setTrackDragTracks: (tracks: Track[]) => void
  updateTrackDragPointer: (pointerX: number, pointerY: number) => void
  setTrackDragDropTarget: (surface: TrackDragSurface, target: TrackDragDropTarget | null) => void
  clearTrackDrag: () => void
  openSidebarPlaylistCreateRequest: (trackPaths: string[]) => void
  clearSidebarPlaylistCreateRequest: () => void
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
  trackDrag: null,
  sidebarPlaylistCreateRequest: null,
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
  startTrackDrag: (tracks, pointerX, pointerY) => set({
    trackDrag: {
      tracks,
      pointerX,
      pointerY,
      dropTarget: null
    }
  }),
  setTrackDragTracks: (tracks) => set((state) => {
    if (!state.trackDrag) return state
    if (areTrackDragTracksEqual(state.trackDrag.tracks, tracks)) {
      return state
    }
    return {
      trackDrag: {
        ...state.trackDrag,
        tracks
      }
    }
  }),
  updateTrackDragPointer: (pointerX, pointerY) => set((state) => {
    if (!state.trackDrag) return state
    if (state.trackDrag.pointerX === pointerX && state.trackDrag.pointerY === pointerY) {
      return state
    }
    return {
      trackDrag: {
        ...state.trackDrag,
        pointerX,
        pointerY
      }
    }
  }),
  setTrackDragDropTarget: (surface, target) => set((state) => {
    if (!state.trackDrag) return state
    if (target && target.surface !== surface) return state

    const currentTarget = state.trackDrag.dropTarget
    if (!target && currentTarget?.surface !== surface) {
      return state
    }
    if (areTrackDragDropTargetsEqual(currentTarget, target)) {
      return state
    }
    return {
      trackDrag: {
        ...state.trackDrag,
        dropTarget: target
      }
    }
  }),
  clearTrackDrag: () => set({ trackDrag: null }),
  openSidebarPlaylistCreateRequest: (trackPaths) => set({
    sidebarPlaylistCreateRequest: {
      trackPaths: [...trackPaths]
    }
  }),
  clearSidebarPlaylistCreateRequest: () => set({ sidebarPlaylistCreateRequest: null })
}))
