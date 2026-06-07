import { create } from 'zustand'
import type { SettingsSectionId } from '../constants/settingsSections'
import type { Track } from '../types/audio'
import {
  DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE,
  getNextMiniPlayerTimeDisplayMode,
  normalizeMiniPlayerTimeDisplayMode,
  type MiniPlayerTimeDisplayMode
} from '../../types/miniPlayer.ts'
import type { UIScaleShortcutAction } from '../../types/uiScale'

export type AppView = 'home' | 'library' | 'graph' | 'eq' | 'settings' | 'playlist'
export type WaveformTimeDisplayMode = MiniPlayerTimeDisplayMode
export type HomeGreetingTextMode = 'messages' | 'clock' | 'off'
export type JumpToPlayingDestination = 'smart-source' | 'library-tracks' | 'album' | 'artist' | 'queue'
export const DEFAULT_ANALYZER_HEIGHT_PX = 196
export const MIN_ANALYZER_HEIGHT_PX = 144
export const MAX_ANALYZER_HEIGHT_PX = 320
export const ANALYZER_HEIGHT_STORAGE_KEY = 'astra-analyzer-height-px'
export const ANALYZER_RACK_VISIBILITY_STORAGE_KEY = 'astra-show-analyzer-rack'
export const MIN_UI_SCALE_PERCENT = 80
export const DEFAULT_UI_SCALE_PERCENT = 100
export const MAX_UI_SCALE_PERCENT = 125
export const UI_SCALE_STEP_PERCENT = 5
export const UI_SCALE_STORAGE_KEY = 'astra-ui-scale-percent-v1'
export const HOME_GREETING_TEXT_MODE_STORAGE_KEY = 'astra-home-greeting-text-mode-v1'
export const DEFAULT_HOME_GREETING_TEXT_MODE: HomeGreetingTextMode = 'messages'
export const ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY = 'astra-experimental-activity-indicator-enabled-v1'
export const JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY = 'astra-jump-to-playing-destination-v1'
export const DEFAULT_JUMP_TO_PLAYING_DESTINATION: JumpToPlayingDestination = 'smart-source'
// §14.1.4 — persisted preference: open the Zone Display layout at launch. The session-state
// `isZoneDisplayActive` derives its initial value from this OR the `--zone` launch flag, and
// "Library" clears the session flag without touching the persisted preference.
export const OPEN_ZONE_DISPLAY_ON_LAUNCH_STORAGE_KEY = 'astra-open-zone-display-on-launch-v1'

export interface LibraryTrackRevealRequest {
  id: number
  trackPath: string
}

export interface PlaylistTrackRevealRequest {
  id: number
  playlistId: number
  trackPath: string
}

export interface QueueNowPlayingRevealRequest {
  id: number
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

export function normalizeUIScalePercent(value: unknown): number {
  if (value == null) return DEFAULT_UI_SCALE_PERCENT
  if (typeof value === 'string' && value.trim().length === 0) return DEFAULT_UI_SCALE_PERCENT

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_UI_SCALE_PERCENT

  const snapped = Math.round(numeric / UI_SCALE_STEP_PERCENT) * UI_SCALE_STEP_PERCENT
  return Math.min(MAX_UI_SCALE_PERCENT, Math.max(MIN_UI_SCALE_PERCENT, snapped))
}

export function getNextUIScalePercent(currentPercent: number, action: UIScaleShortcutAction): number {
  if (action === 'reset') return DEFAULT_UI_SCALE_PERCENT

  const delta = action === 'increase'
    ? UI_SCALE_STEP_PERCENT
    : -UI_SCALE_STEP_PERCENT
  return normalizeUIScalePercent(currentPercent + delta)
}

export function normalizeHomeGreetingTextMode(value: unknown): HomeGreetingTextMode {
  return value === 'clock' || value === 'off' || value === 'messages'
    ? value
    : DEFAULT_HOME_GREETING_TEXT_MODE
}

export function normalizeJumpToPlayingDestination(value: unknown): JumpToPlayingDestination {
  return value === 'library-tracks' || value === 'album' || value === 'artist' || value === 'queue' || value === 'smart-source'
    ? value
    : DEFAULT_JUMP_TO_PLAYING_DESTINATION
}

function readWaveformTimeDisplayModePreference(): WaveformTimeDisplayMode {
  try {
    const saved = localStorage.getItem(WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY)
    return normalizeMiniPlayerTimeDisplayMode(saved)
  } catch {
    return DEFAULT_MINI_PLAYER_TIME_DISPLAY_MODE
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

function readUIScalePreference(): number {
  try {
    return normalizeUIScalePercent(localStorage.getItem(UI_SCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_UI_SCALE_PERCENT
  }
}

function persistUIScalePreference(percent: number): void {
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(normalizeUIScalePercent(percent)))
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readHomeGreetingTextModePreference(): HomeGreetingTextMode {
  try {
    return normalizeHomeGreetingTextMode(localStorage.getItem(HOME_GREETING_TEXT_MODE_STORAGE_KEY))
  } catch {
    return DEFAULT_HOME_GREETING_TEXT_MODE
  }
}

function persistHomeGreetingTextModePreference(mode: HomeGreetingTextMode): void {
  try {
    localStorage.setItem(HOME_GREETING_TEXT_MODE_STORAGE_KEY, normalizeHomeGreetingTextMode(mode))
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readActivityIndicatorExperimentPreference(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistActivityIndicatorExperimentPreference(enabled: boolean): void {
  try {
    localStorage.setItem(ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readJumpToPlayingDestinationPreference(): JumpToPlayingDestination {
  try {
    return normalizeJumpToPlayingDestination(localStorage.getItem(JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY))
  } catch {
    return DEFAULT_JUMP_TO_PLAYING_DESTINATION
  }
}

function persistJumpToPlayingDestinationPreference(destination: JumpToPlayingDestination): void {
  try {
    localStorage.setItem(JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY, normalizeJumpToPlayingDestination(destination))
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readOpenZoneDisplayOnLaunchPreference(): boolean {
  try {
    return localStorage.getItem(OPEN_ZONE_DISPLAY_ON_LAUNCH_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistOpenZoneDisplayOnLaunchPreference(enabled: boolean): void {
  try {
    localStorage.setItem(OPEN_ZONE_DISPLAY_ON_LAUNCH_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readLaunchInZoneModeFlag(): boolean {
  // §14.1.4 — `--zone` launch flag (forwarded by main as `electronAPI.parallax.launchInZoneMode`).
  // Single-launch override; does NOT mutate the persisted preference.
  try {
    return window.electronAPI?.parallax?.launchInZoneMode === true
  } catch {
    return false
  }
}

const initialWaveformTimeDisplayMode = readWaveformTimeDisplayModePreference()
const initialAnalyzerHeightPx = readAnalyzerHeightPreference()
const initialAnalyzerRackVisible = readAnalyzerRackVisibilityPreference()
const initialUIScalePercent = readUIScalePreference()
const initialHomeGreetingTextMode = readHomeGreetingTextModePreference()
const initialActivityIndicatorExperimentEnabled = readActivityIndicatorExperimentPreference()
const initialJumpToPlayingDestination = readJumpToPlayingDestinationPreference()
const initialOpenZoneDisplayOnLaunch = readOpenZoneDisplayOnLaunchPreference()
const initialZoneDisplayLaunchFlag = readLaunchInZoneModeFlag()
// Session state: zone display is active at startup if the preference is on OR `--zone` was passed.
// "Library" escape sets this back to false without touching the preference.
const initialIsZoneDisplayActive = initialOpenZoneDisplayOnLaunch || initialZoneDisplayLaunchFlag
let nextLibraryTrackRevealRequestId = 0
let nextPlaylistTrackRevealRequestId = 0
let nextQueueNowPlayingRevealRequestId = 0

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
  openZoneDisplayOnLaunch: boolean
  isZoneDisplayActive: boolean
  analyzerHeightPx: number
  uiScalePercent: number
  homeGreetingTextMode: HomeGreetingTextMode
  activityIndicatorExperimentEnabled: boolean
  jumpToPlayingDestination: JumpToPlayingDestination
  waveformTimeDisplayMode: WaveformTimeDisplayMode
  libraryTrackRevealRequest: LibraryTrackRevealRequest | null
  playlistTrackRevealRequest: PlaylistTrackRevealRequest | null
  queueNowPlayingRevealRequest: QueueNowPlayingRevealRequest | null
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
  setOpenZoneDisplayOnLaunch: (enabled: boolean) => void
  exitZoneDisplayForSession: () => void
  enterZoneDisplay: () => void
  setAnalyzerHeightPx: (heightPx: number) => void
  resetAnalyzerHeightPx: () => void
  resetAnalyzerRackPreferences: () => void
  setUIScalePercent: (percent: number) => void
  resetUIScalePercent: () => void
  setHomeGreetingTextMode: (mode: HomeGreetingTextMode) => void
  resetHomeGreetingTextMode: () => void
  setActivityIndicatorExperimentEnabled: (enabled: boolean) => void
  setJumpToPlayingDestination: (destination: JumpToPlayingDestination) => void
  resetJumpToPlayingDestination: () => void
  toggleWaveformTimeDisplayMode: () => void
  requestLibraryTrackReveal: (trackPath: string) => void
  clearLibraryTrackRevealRequest: (requestId: number) => void
  requestPlaylistTrackReveal: (playlistId: number, trackPath: string) => void
  clearPlaylistTrackRevealRequest: (requestId: number) => void
  requestQueueNowPlayingReveal: () => void
  clearQueueNowPlayingRevealRequest: (requestId: number) => void
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
  openZoneDisplayOnLaunch: initialOpenZoneDisplayOnLaunch,
  isZoneDisplayActive: initialIsZoneDisplayActive,
  analyzerHeightPx: initialAnalyzerHeightPx,
  uiScalePercent: initialUIScalePercent,
  homeGreetingTextMode: initialHomeGreetingTextMode,
  activityIndicatorExperimentEnabled: initialActivityIndicatorExperimentEnabled,
  jumpToPlayingDestination: initialJumpToPlayingDestination,
  waveformTimeDisplayMode: initialWaveformTimeDisplayMode,
  libraryTrackRevealRequest: null,
  playlistTrackRevealRequest: null,
  queueNowPlayingRevealRequest: null,
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
  setOpenZoneDisplayOnLaunch: (enabled) => {
    persistOpenZoneDisplayOnLaunchPreference(enabled)
    set({ openZoneDisplayOnLaunch: enabled })
  },
  exitZoneDisplayForSession: () => set({ isZoneDisplayActive: false }),
  enterZoneDisplay: () => set({ isZoneDisplayActive: true }),
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
  setUIScalePercent: (percent) => {
    const nextScalePercent = normalizeUIScalePercent(percent)
    persistUIScalePreference(nextScalePercent)
    set({ uiScalePercent: nextScalePercent })
  },
  resetUIScalePercent: () => {
    persistUIScalePreference(DEFAULT_UI_SCALE_PERCENT)
    set({ uiScalePercent: DEFAULT_UI_SCALE_PERCENT })
  },
  setHomeGreetingTextMode: (mode) => {
    const nextMode = normalizeHomeGreetingTextMode(mode)
    persistHomeGreetingTextModePreference(nextMode)
    set({ homeGreetingTextMode: nextMode })
  },
  resetHomeGreetingTextMode: () => {
    persistHomeGreetingTextModePreference(DEFAULT_HOME_GREETING_TEXT_MODE)
    set({ homeGreetingTextMode: DEFAULT_HOME_GREETING_TEXT_MODE })
  },
  setActivityIndicatorExperimentEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistActivityIndicatorExperimentPreference(normalized)
    set({ activityIndicatorExperimentEnabled: normalized })
  },
  setJumpToPlayingDestination: (destination) => {
    const normalized = normalizeJumpToPlayingDestination(destination)
    persistJumpToPlayingDestinationPreference(normalized)
    set({ jumpToPlayingDestination: normalized })
  },
  resetJumpToPlayingDestination: () => {
    persistJumpToPlayingDestinationPreference(DEFAULT_JUMP_TO_PLAYING_DESTINATION)
    set({ jumpToPlayingDestination: DEFAULT_JUMP_TO_PLAYING_DESTINATION })
  },
  toggleWaveformTimeDisplayMode: () => set((s) => {
    const nextMode = getNextMiniPlayerTimeDisplayMode(s.waveformTimeDisplayMode)
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
  clearLibraryTrackRevealRequest: (requestId) => set((state) => {
    if (state.libraryTrackRevealRequest?.id !== requestId) return {}
    return { libraryTrackRevealRequest: null }
  }),
  requestPlaylistTrackReveal: (playlistId, trackPath) => set(() => {
    nextPlaylistTrackRevealRequestId += 1
    return {
      playlistTrackRevealRequest: {
        id: nextPlaylistTrackRevealRequestId,
        playlistId,
        trackPath
      }
    }
  }),
  clearPlaylistTrackRevealRequest: (requestId) => set((state) => {
    if (state.playlistTrackRevealRequest?.id !== requestId) return {}
    return { playlistTrackRevealRequest: null }
  }),
  requestQueueNowPlayingReveal: () => set(() => {
    nextQueueNowPlayingRevealRequestId += 1
    return {
      queueNowPlayingRevealRequest: {
        id: nextQueueNowPlayingRevealRequestId
      }
    }
  }),
  clearQueueNowPlayingRevealRequest: (requestId) => set((state) => {
    if (state.queueNowPlayingRevealRequest?.id !== requestId) return {}
    return { queueNowPlayingRevealRequest: null }
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
