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
import { TRANSPORT_INFO_LINE_MODE_STORAGE_KEY } from '../constants/settingsStorageKeys'
import { HOME_LAYOUT_STORAGE_KEY, HOME_SKY_TIME_STORAGE_KEY } from '../constants/settingsStorageKeys'
import { runAppViewTransition, type AppViewTransitionDirection } from '../utils/viewTransitions.ts'
import { normalizeAppView, type SessionTrackSortState, type UISessionSnapshot } from '../utils/sessionState'
import type { SignalShareTarget } from '../utils/signalShare'
import {
  DEFAULT_HOME_LAYOUT_PREFERENCE,
  DEFAULT_HOME_SKY_TIME_PREFERENCE,
  moveHomeModule,
  normalizeHomeLayoutPreference,
  normalizeHomeSkyTimePreference,
  setHomeSkyTimeModePreference,
  setHomeModuleVisible,
  type HomeLayoutPreference,
  type HomeModuleId,
  type HomeSkyTimeMode,
  type HomeSkyTimePreference
} from '../utils/homePreferences'

export type AppView = 'home' | 'library' | 'stats' | 'graph' | 'eq' | 'settings' | 'playlist'
export type WaveformTimeDisplayMode = MiniPlayerTimeDisplayMode
export type HomeGreetingTextMode = 'messages' | 'clock' | 'binary-clock' | 'off'
export type JumpToPlayingDestination = 'smart-source' | 'library-tracks' | 'album' | 'artist' | 'queue'
export type TransportInfoLineMode = 'output' | 'album' | 'hidden'
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
export const CONTROLLER_SUPPORT_EXPERIMENT_STORAGE_KEY = 'astra-experimental-controller-support-enabled-v1'
export const JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY = 'astra-jump-to-playing-destination-v1'
export const DEFAULT_JUMP_TO_PLAYING_DESTINATION: JumpToPlayingDestination = 'smart-source'
export const DEFAULT_TRANSPORT_INFO_LINE_MODE: TransportInfoLineMode = 'output'
// §14.1.4 — persisted preference: open the Zone Display layout at launch. The session-state
// `isZoneDisplayActive` derives its initial value from this OR the `--zone` launch flag, and
// "Library" clears the session flag without touching the persisted preference.
export const OPEN_ZONE_DISPLAY_ON_LAUNCH_STORAGE_KEY = 'astra-open-zone-display-on-launch-v1'
// Parallax is an experimental feature gated behind a master reveal toggle (in the Experimental
// settings section). When on, a dedicated "Parallax" settings section appears in the sidebar.
// `parallaxSetupComplete` tracks whether the guided first-run flow has been finished/dismissed,
// so returning users land directly on the management view.
export const PARALLAX_EXPERIMENT_ENABLED_STORAGE_KEY = 'astra-experimental-parallax-enabled-v1'
export const PARALLAX_SETUP_COMPLETE_STORAGE_KEY = 'astra-parallax-setup-complete-v1'
// §14.1.4 — friendly zone name for this speaker, shown on the Zone Display (now-playing footer +
// idle dashboard heading). Renderer-local override; empty string means "fall back to the OS
// hostname". Persisted here (not main) since it's a display-only label for this surface.
export const PARALLAX_ZONE_NAME_STORAGE_KEY = 'astra-parallax-zone-name-v1'

const APP_VIEW_MOTION_ORDER: AppView[] = ['home', 'library', 'stats', 'graph', 'eq', 'playlist', 'settings']

export function resolveAppViewTransitionDirection(
  sourceView: AppView | null | undefined,
  targetView: AppView | null | undefined
): AppViewTransitionDirection {
  if (!sourceView || !targetView || sourceView === targetView) return null

  const sourceIndex = APP_VIEW_MOTION_ORDER.indexOf(sourceView)
  const targetIndex = APP_VIEW_MOTION_ORDER.indexOf(targetView)
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return null

  return targetIndex > sourceIndex ? 'down' : 'up'
}

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

export interface PlaylistNavigationRestoreRequest {
  id: number
  playlistId: number | null
  sortState: SessionTrackSortState | null
}

export type CollectionQueueTarget =
  | {
      kind: 'album'
      album: string
      artist: string
      identityKey?: string
    }
  | {
      kind: 'playlist'
      playlistId: number
      name: string
    }

export interface CollectionQueueMenuRequest {
  target: CollectionQueueTarget
  x: number
  y: number
}

export type TrackDragSurface = 'queue' | 'sidebar' | 'playlist'

export interface TrackDragItem {
  key: string
  path: string
  title: string
  artist: string
  track: Track | null
  playlistEntryId: number | null
  missing: boolean
}

export type TrackDragSource =
  | {
      kind: 'track-list'
      playlistId: number | null
    }
  | {
      kind: 'queue'
      section: 'current' | 'upcoming' | 'history'
      queueId: string | null
      index: number | null
    }

export interface TrackDragOriginSnapshot {
  activeView: AppView
  showQueue: boolean
  selectedPlaylistId: number | null
  playlistSortState: SessionTrackSortState | null
}

export interface QueueTrackDragDropTarget {
  surface: 'queue'
  kind: 'empty' | 'upcoming'
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

export interface PlaylistTrackDragDropTarget {
  surface: 'playlist'
  kind: 'insert'
  playlistId: number
  index: number
}

export type TrackDragDropTarget =
  | QueueTrackDragDropTarget
  | SidebarPlaylistTrackDragDropTarget
  | SidebarCreatePlaylistTrackDragDropTarget
  | PlaylistTrackDragDropTarget

export type TrackDragSpringTarget =
  | { kind: 'playlist'; playlistId: number }
  | { kind: 'queue' }
  | { kind: 'sidebar-overflow' }
  | { kind: 'playlist-browser' }
  | { kind: 'playlist-back' }

export interface TrackDragState {
  pointerId: number
  items: TrackDragItem[]
  source: TrackDragSource
  origin: TrackDragOriginSnapshot
  pointerX: number
  pointerY: number
  dropTarget: TrackDragDropTarget | null
  springTarget: TrackDragSpringTarget | null
  springOpened: boolean
  phase: 'dragging' | 'dropping'
}

interface TrackDragCommittedNavigation {
  origin: TrackDragOriginSnapshot
  destinationView: AppView
  historyDepth: number
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
  if (left.surface === 'playlist' && right.surface === 'playlist') {
    return left.playlistId === right.playlistId && left.index === right.index
  }
  if (left.kind === 'playlist' && right.kind === 'playlist') {
    return left.playlistId === right.playlistId
  }
  return true
}

export const WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY = 'astra-waveform-time-display-mode'

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
  return value === 'clock' || value === 'binary-clock' || value === 'off' || value === 'messages'
    ? value
    : DEFAULT_HOME_GREETING_TEXT_MODE
}

export function normalizeJumpToPlayingDestination(value: unknown): JumpToPlayingDestination {
  return value === 'library-tracks' || value === 'album' || value === 'artist' || value === 'queue' || value === 'smart-source'
    ? value
    : DEFAULT_JUMP_TO_PLAYING_DESTINATION
}

export function normalizeTransportInfoLineMode(value: unknown): TransportInfoLineMode {
  return value === 'album' || value === 'hidden' || value === 'output'
    ? value
    : DEFAULT_TRANSPORT_INFO_LINE_MODE
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

function readJsonPreference(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function persistJsonPreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage failures and retain the in-memory preference.
  }
}

function readHomeSkyTimePreference(): HomeSkyTimePreference {
  return normalizeHomeSkyTimePreference(readJsonPreference(HOME_SKY_TIME_STORAGE_KEY))
}

function readHomeLayoutPreference(): HomeLayoutPreference {
  return normalizeHomeLayoutPreference(readJsonPreference(HOME_LAYOUT_STORAGE_KEY))
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

function readControllerSupportExperimentPreference(): boolean {
  try {
    return localStorage.getItem(CONTROLLER_SUPPORT_EXPERIMENT_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistControllerSupportExperimentPreference(enabled: boolean): void {
  try {
    localStorage.setItem(CONTROLLER_SUPPORT_EXPERIMENT_STORAGE_KEY, enabled ? '1' : '0')
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

function readTransportInfoLineModePreference(): TransportInfoLineMode {
  try {
    return normalizeTransportInfoLineMode(localStorage.getItem(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY))
  } catch {
    return DEFAULT_TRANSPORT_INFO_LINE_MODE
  }
}

function persistTransportInfoLineModePreference(mode: TransportInfoLineMode): void {
  try {
    localStorage.setItem(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY, normalizeTransportInfoLineMode(mode))
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

function readParallaxExperimentEnabledPreference(): boolean {
  try {
    return localStorage.getItem(PARALLAX_EXPERIMENT_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistParallaxExperimentEnabledPreference(enabled: boolean): void {
  try {
    localStorage.setItem(PARALLAX_EXPERIMENT_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readParallaxSetupCompletePreference(): boolean {
  try {
    return localStorage.getItem(PARALLAX_SETUP_COMPLETE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistParallaxSetupCompletePreference(complete: boolean): void {
  try {
    localStorage.setItem(PARALLAX_SETUP_COMPLETE_STORAGE_KEY, complete ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

function readParallaxZoneNamePreference(): string {
  try {
    return localStorage.getItem(PARALLAX_ZONE_NAME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function persistParallaxZoneNamePreference(name: string): void {
  try {
    if (name) localStorage.setItem(PARALLAX_ZONE_NAME_STORAGE_KEY, name)
    else localStorage.removeItem(PARALLAX_ZONE_NAME_STORAGE_KEY)
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
const initialHomeSkyTimePreference = readHomeSkyTimePreference()
const initialHomeLayoutPreference = readHomeLayoutPreference()
const initialActivityIndicatorExperimentEnabled = readActivityIndicatorExperimentPreference()
const initialControllerSupportEnabled = readControllerSupportExperimentPreference()
const initialJumpToPlayingDestination = readJumpToPlayingDestinationPreference()
const initialTransportInfoLineMode = readTransportInfoLineModePreference()
const initialOpenZoneDisplayOnLaunch = readOpenZoneDisplayOnLaunchPreference()
const initialParallaxExperimentEnabled = readParallaxExperimentEnabledPreference()
const initialParallaxSetupComplete = readParallaxSetupCompletePreference()
const initialParallaxZoneName = readParallaxZoneNamePreference()
const initialZoneDisplayLaunchFlag = readLaunchInZoneModeFlag()
// Session state: zone display is active at startup if the preference is on OR `--zone` was passed.
// "Library" escape sets this back to false without touching the preference.
const initialIsZoneDisplayActive = initialOpenZoneDisplayOnLaunch || initialZoneDisplayLaunchFlag
const MAX_VIEW_HISTORY_ENTRIES = 50
let nextLibraryTrackRevealRequestId = 0
let nextPlaylistTrackRevealRequestId = 0
let nextQueueNowPlayingRevealRequestId = 0
let nextPlaylistNavigationRestoreRequestId = 0
let pendingActiveView: AppView | null = null

interface UIStore {
  activeView: AppView
  viewBackHistory: AppView[]
  viewForwardHistory: AppView[]
  showQueue: boolean
  showInfoSidebar: boolean
  showPipelineShelf: boolean
  showLyricsShelf: boolean
  lyricsShelfExpanded: boolean
  fullscreenLyricsVisible: boolean
  isAnalyzerEditMode: boolean
  isAnalyzerRackVisible: boolean
  isFullscreen: boolean
  openZoneDisplayOnLaunch: boolean
  parallaxExperimentEnabled: boolean
  parallaxSetupComplete: boolean
  parallaxZoneName: string
  isZoneDisplayActive: boolean
  analyzerHeightPx: number
  uiScalePercent: number
  homeGreetingTextMode: HomeGreetingTextMode
  homeSkyTimePreference: HomeSkyTimePreference
  homeLayoutPreference: HomeLayoutPreference
  activityIndicatorExperimentEnabled: boolean
  controllerSupportEnabled: boolean
  jumpToPlayingDestination: JumpToPlayingDestination
  transportInfoLineMode: TransportInfoLineMode
  waveformTimeDisplayMode: WaveformTimeDisplayMode
  libraryTrackRevealRequest: LibraryTrackRevealRequest | null
  playlistTrackRevealRequest: PlaylistTrackRevealRequest | null
  queueNowPlayingRevealRequest: QueueNowPlayingRevealRequest | null
  playlistNavigationRestoreRequest: PlaylistNavigationRestoreRequest | null
  isQuickLaunchOpen: boolean
  pendingLibrarySearchQuery: string | null
  pendingSettingsSection: SettingsSectionId | null
  trackDrag: TrackDragState | null
  trackDragCommittedNavigation: TrackDragCommittedNavigation | null
  sidebarPlaylistCreateRequest: SidebarPlaylistCreateRequest | null
  collectionQueueMenu: CollectionQueueMenuRequest | null
  signalShareTarget: SignalShareTarget | null
  setActiveView: (view: AppView) => void
  replaceActiveView: (view: AppView) => void
  commitTransientView: (origin: TrackDragOriginSnapshot) => void
  navigateViewBack: () => boolean
  navigateViewForward: () => boolean
  toggleQueue: () => void
  setQueueVisible: (visible: boolean) => void
  toggleInfoSidebar: () => void
  togglePipelineShelf: () => void
  toggleLyricsShelf: () => void
  setLyricsShelfExpanded: (expanded: boolean) => void
  closeLyricsShelf: () => void
  setFullscreenLyricsVisible: (visible: boolean) => void
  toggleFullscreenLyricsVisible: () => void
  openAnalyzerEditMode: () => void
  closeAnalyzerEditMode: () => void
  toggleAnalyzerEditMode: () => void
  showAnalyzerRack: () => void
  hideAnalyzerRack: () => void
  toggleAnalyzerRack: () => void
  setFullscreen: (fs: boolean) => void
  setOpenZoneDisplayOnLaunch: (enabled: boolean) => void
  setParallaxExperimentEnabled: (enabled: boolean) => void
  setParallaxSetupComplete: (complete: boolean) => void
  setParallaxZoneName: (name: string) => void
  exitZoneDisplayForSession: () => void
  enterZoneDisplay: () => void
  setAnalyzerHeightPx: (heightPx: number) => void
  resetAnalyzerHeightPx: () => void
  resetAnalyzerRackPreferences: () => void
  setUIScalePercent: (percent: number) => void
  resetUIScalePercent: () => void
  setHomeGreetingTextMode: (mode: HomeGreetingTextMode) => void
  resetHomeGreetingTextMode: () => void
  setHomeSkyTimeMode: (mode: HomeSkyTimeMode, now?: Date) => void
  setHomeSkyFixedMinutes: (minutes: number) => void
  resetHomeSkyTimePreference: () => void
  setHomeModuleVisible: (moduleId: HomeModuleId, visible: boolean) => void
  moveHomeModule: (moduleId: HomeModuleId, targetIndex: number) => void
  resetHomeLayoutPreference: () => void
  setActivityIndicatorExperimentEnabled: (enabled: boolean) => void
  setControllerSupportEnabled: (enabled: boolean) => void
  setJumpToPlayingDestination: (destination: JumpToPlayingDestination) => void
  resetJumpToPlayingDestination: () => void
  setTransportInfoLineMode: (mode: TransportInfoLineMode) => void
  resetTransportInfoLineMode: () => void
  toggleWaveformTimeDisplayMode: () => void
  requestLibraryTrackReveal: (trackPath: string) => void
  clearLibraryTrackRevealRequest: (requestId: number) => void
  requestPlaylistTrackReveal: (playlistId: number, trackPath: string) => void
  clearPlaylistTrackRevealRequest: (requestId: number) => void
  requestQueueNowPlayingReveal: () => void
  clearQueueNowPlayingRevealRequest: (requestId: number) => void
  clearPlaylistNavigationRestoreRequest: (requestId: number) => void
  openQuickLaunch: () => void
  closeQuickLaunch: () => void
  toggleQuickLaunch: () => void
  setPendingLibrarySearchQuery: (query: string | null) => void
  consumePendingLibrarySearchQuery: () => string | null
  setPendingSettingsSection: (section: SettingsSectionId | null) => void
  consumePendingSettingsSection: () => SettingsSectionId | null
  startTrackDrag: (
    items: TrackDragItem[],
    source: TrackDragSource,
    origin: TrackDragOriginSnapshot,
    pointerId: number,
    pointerX: number,
    pointerY: number
  ) => void
  setTrackDragItems: (items: TrackDragItem[]) => void
  setTrackDragDropTarget: (surface: TrackDragSurface, target: TrackDragDropTarget | null) => void
  setTrackDragSpringTarget: (target: TrackDragSpringTarget | null) => void
  markTrackDragSpringOpened: () => void
  setTrackDragPhase: (phase: TrackDragState['phase']) => void
  clearTrackDrag: () => void
  openSidebarPlaylistCreateRequest: (trackPaths: string[]) => void
  clearSidebarPlaylistCreateRequest: () => void
  openCollectionQueueMenu: (request: CollectionQueueMenuRequest) => void
  closeCollectionQueueMenu: () => void
  openSignalShare: (target: SignalShareTarget) => void
  closeSignalShare: () => void
  getSessionSnapshot: () => UISessionSnapshot
  restoreSession: (snapshot: UISessionSnapshot) => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  activeView: 'home',
  viewBackHistory: [],
  viewForwardHistory: [],
  showQueue: false,
  showInfoSidebar: false,
  showPipelineShelf: false,
  showLyricsShelf: false,
  lyricsShelfExpanded: false,
  fullscreenLyricsVisible: false,
  isAnalyzerEditMode: false,
  isAnalyzerRackVisible: initialAnalyzerRackVisible,
  isFullscreen: false,
  openZoneDisplayOnLaunch: initialOpenZoneDisplayOnLaunch,
  parallaxExperimentEnabled: initialParallaxExperimentEnabled,
  parallaxSetupComplete: initialParallaxSetupComplete,
  parallaxZoneName: initialParallaxZoneName,
  isZoneDisplayActive: initialIsZoneDisplayActive,
  analyzerHeightPx: initialAnalyzerHeightPx,
  uiScalePercent: initialUIScalePercent,
  homeGreetingTextMode: initialHomeGreetingTextMode,
  homeSkyTimePreference: initialHomeSkyTimePreference,
  homeLayoutPreference: initialHomeLayoutPreference,
  activityIndicatorExperimentEnabled: initialActivityIndicatorExperimentEnabled,
  controllerSupportEnabled: initialControllerSupportEnabled,
  jumpToPlayingDestination: initialJumpToPlayingDestination,
  transportInfoLineMode: initialTransportInfoLineMode,
  waveformTimeDisplayMode: initialWaveformTimeDisplayMode,
  libraryTrackRevealRequest: null,
  playlistTrackRevealRequest: null,
  queueNowPlayingRevealRequest: null,
  playlistNavigationRestoreRequest: null,
  isQuickLaunchOpen: false,
  pendingLibrarySearchQuery: null,
  pendingSettingsSection: null,
  trackDrag: null,
  trackDragCommittedNavigation: null,
  sidebarPlaylistCreateRequest: null,
  collectionQueueMenu: null,
  signalShareTarget: null,
  setActiveView: (view) => {
    const sourceView = pendingActiveView ?? get().activeView
    if (sourceView === view) return
    const direction = resolveAppViewTransitionDirection(sourceView, view)
    pendingActiveView = view
    runAppViewTransition(() => {
      if (pendingActiveView !== view) return
      pendingActiveView = null
      set((state) => state.activeView === view ? state : {
        activeView: view,
        viewBackHistory: [...state.viewBackHistory, state.activeView].slice(-MAX_VIEW_HISTORY_ENTRIES),
        viewForwardHistory: []
      })
    }, direction)
  },
  replaceActiveView: (view) => {
    const sourceView = pendingActiveView ?? get().activeView
    if (sourceView === view) return
    const direction = resolveAppViewTransitionDirection(sourceView, view)
    pendingActiveView = view
    runAppViewTransition(() => {
      if (pendingActiveView !== view) return
      pendingActiveView = null
      set({ activeView: view })
    }, direction)
  },
  commitTransientView: (origin) => set((state) => {
    const viewBackHistory = [...state.viewBackHistory, origin.activeView].slice(-MAX_VIEW_HISTORY_ENTRIES)
    return {
      viewBackHistory,
      viewForwardHistory: [],
      trackDragCommittedNavigation: {
        origin,
        destinationView: state.activeView,
        historyDepth: viewBackHistory.length
      }
    }
  }),
  navigateViewBack: () => {
    const state = get()
    const target = state.viewBackHistory[state.viewBackHistory.length - 1]
    if (!target) return false
    const committedNavigation = state.trackDragCommittedNavigation
    const restoresTrackDragOrigin = Boolean(
      committedNavigation
      && committedNavigation.historyDepth === state.viewBackHistory.length
      && committedNavigation.destinationView === state.activeView
    )
    const sourceView = pendingActiveView ?? state.activeView
    const direction = resolveAppViewTransitionDirection(sourceView, target)
    pendingActiveView = target
    runAppViewTransition(() => {
      if (pendingActiveView !== target) return
      pendingActiveView = null
      set((latest) => {
        const origin = restoresTrackDragOrigin ? latest.trackDragCommittedNavigation?.origin ?? null : null
        if (origin) {
          nextPlaylistNavigationRestoreRequestId += 1
        }
        return {
          activeView: target,
          viewBackHistory: latest.viewBackHistory.slice(0, -1),
          viewForwardHistory: [...latest.viewForwardHistory, latest.activeView].slice(-MAX_VIEW_HISTORY_ENTRIES),
          ...(origin ? {
            showQueue: origin.showQueue,
            trackDragCommittedNavigation: null,
            playlistNavigationRestoreRequest: {
              id: nextPlaylistNavigationRestoreRequestId,
              playlistId: origin.selectedPlaylistId,
              sortState: origin.playlistSortState
            }
          } : {})
        }
      })
    }, direction)
    return true
  },
  navigateViewForward: () => {
    const state = get()
    const target = state.viewForwardHistory[state.viewForwardHistory.length - 1]
    if (!target) return false
    const sourceView = pendingActiveView ?? state.activeView
    const direction = resolveAppViewTransitionDirection(sourceView, target)
    pendingActiveView = target
    runAppViewTransition(() => {
      if (pendingActiveView !== target) return
      pendingActiveView = null
      set((latest) => ({
        activeView: target,
        viewBackHistory: [...latest.viewBackHistory, latest.activeView].slice(-MAX_VIEW_HISTORY_ENTRIES),
        viewForwardHistory: latest.viewForwardHistory.slice(0, -1)
      }))
    }, direction)
    return true
  },
  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
  setQueueVisible: (visible) => set((state) => state.showQueue === visible ? state : { showQueue: visible }),
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
  setFullscreenLyricsVisible: (visible) => set({ fullscreenLyricsVisible: Boolean(visible) }),
  toggleFullscreenLyricsVisible: () => set((state) => ({
    fullscreenLyricsVisible: !state.fullscreenLyricsVisible
  })),
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
  setParallaxExperimentEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistParallaxExperimentEnabledPreference(normalized)
    set({ parallaxExperimentEnabled: normalized })
  },
  setParallaxSetupComplete: (complete) => {
    const normalized = Boolean(complete)
    persistParallaxSetupCompletePreference(normalized)
    set({ parallaxSetupComplete: normalized })
  },
  setParallaxZoneName: (name) => {
    const normalized = typeof name === 'string' ? name.trim().slice(0, 60) : ''
    persistParallaxZoneNamePreference(normalized)
    set({ parallaxZoneName: normalized })
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
  setHomeSkyTimeMode: (mode, now = new Date()) => set((state) => {
    const nextPreference = setHomeSkyTimeModePreference(state.homeSkyTimePreference, mode, now)
    persistJsonPreference(HOME_SKY_TIME_STORAGE_KEY, nextPreference)
    return { homeSkyTimePreference: nextPreference }
  }),
  setHomeSkyFixedMinutes: (minutes) => set((state) => {
    const nextPreference = normalizeHomeSkyTimePreference({
      mode: state.homeSkyTimePreference.mode,
      fixedMinutes: minutes
    })
    persistJsonPreference(HOME_SKY_TIME_STORAGE_KEY, nextPreference)
    return { homeSkyTimePreference: nextPreference }
  }),
  resetHomeSkyTimePreference: () => {
    const nextPreference = { ...DEFAULT_HOME_SKY_TIME_PREFERENCE }
    persistJsonPreference(HOME_SKY_TIME_STORAGE_KEY, nextPreference)
    set({ homeSkyTimePreference: nextPreference })
  },
  setHomeModuleVisible: (moduleId, visible) => set((state) => {
    const nextPreference = setHomeModuleVisible(state.homeLayoutPreference, moduleId, visible)
    persistJsonPreference(HOME_LAYOUT_STORAGE_KEY, nextPreference)
    return { homeLayoutPreference: nextPreference }
  }),
  moveHomeModule: (moduleId, targetIndex) => set((state) => {
    const nextPreference = moveHomeModule(state.homeLayoutPreference, moduleId, targetIndex)
    persistJsonPreference(HOME_LAYOUT_STORAGE_KEY, nextPreference)
    return { homeLayoutPreference: nextPreference }
  }),
  resetHomeLayoutPreference: () => {
    const nextPreference = normalizeHomeLayoutPreference(DEFAULT_HOME_LAYOUT_PREFERENCE)
    persistJsonPreference(HOME_LAYOUT_STORAGE_KEY, nextPreference)
    set({ homeLayoutPreference: nextPreference })
  },
  setActivityIndicatorExperimentEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistActivityIndicatorExperimentPreference(normalized)
    set({ activityIndicatorExperimentEnabled: normalized })
  },
  setControllerSupportEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistControllerSupportExperimentPreference(normalized)
    set({ controllerSupportEnabled: normalized })
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
  setTransportInfoLineMode: (mode) => {
    const normalized = normalizeTransportInfoLineMode(mode)
    persistTransportInfoLineModePreference(normalized)
    set({ transportInfoLineMode: normalized })
  },
  resetTransportInfoLineMode: () => {
    persistTransportInfoLineModePreference(DEFAULT_TRANSPORT_INFO_LINE_MODE)
    set({ transportInfoLineMode: DEFAULT_TRANSPORT_INFO_LINE_MODE })
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
  clearPlaylistNavigationRestoreRequest: (requestId) => set((state) => {
    if (state.playlistNavigationRestoreRequest?.id !== requestId) return {}
    return { playlistNavigationRestoreRequest: null }
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
  startTrackDrag: (items, source, origin, pointerId, pointerX, pointerY) => set({
    trackDrag: {
      pointerId,
      items,
      source,
      origin,
      pointerX,
      pointerY,
      dropTarget: null,
      springTarget: null,
      springOpened: false,
      phase: 'dragging'
    }
  }),
  setTrackDragItems: (items) => set((state) => {
    if (!state.trackDrag || state.trackDrag.phase !== 'dragging') return state
    const currentItems = state.trackDrag.items
    if (
      currentItems.length === items.length
      && currentItems.every((item, index) => item.key === items[index]?.key)
    ) {
      return state
    }
    return { trackDrag: { ...state.trackDrag, items } }
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
  setTrackDragSpringTarget: (target) => set((state) => {
    if (!state.trackDrag) return state
    const current = state.trackDrag.springTarget
    const equal = current === target
      || (current?.kind === 'queue' && target?.kind === 'queue')
      || (current?.kind === 'sidebar-overflow' && target?.kind === 'sidebar-overflow')
      || (current?.kind === 'playlist-browser' && target?.kind === 'playlist-browser')
      || (current?.kind === 'playlist-back' && target?.kind === 'playlist-back')
      || (current?.kind === 'playlist' && target?.kind === 'playlist' && current.playlistId === target.playlistId)
    if (equal) return state
    return { trackDrag: { ...state.trackDrag, springTarget: target } }
  }),
  markTrackDragSpringOpened: () => set((state) => state.trackDrag && !state.trackDrag.springOpened
    ? { trackDrag: { ...state.trackDrag, springOpened: true } }
    : state),
  setTrackDragPhase: (phase) => set((state) => state.trackDrag && state.trackDrag.phase !== phase
    ? { trackDrag: { ...state.trackDrag, phase } }
    : state),
  clearTrackDrag: () => set({ trackDrag: null }),
  openSidebarPlaylistCreateRequest: (trackPaths) => set({
    sidebarPlaylistCreateRequest: {
      trackPaths: [...trackPaths]
    }
  }),
  clearSidebarPlaylistCreateRequest: () => set({ sidebarPlaylistCreateRequest: null }),
  openCollectionQueueMenu: (request) => set({
    collectionQueueMenu: {
      target: request.target,
      x: Number.isFinite(request.x) ? request.x : 0,
      y: Number.isFinite(request.y) ? request.y : 0
    }
  }),
  closeCollectionQueueMenu: () => set({ collectionQueueMenu: null }),
  openSignalShare: (target) => set({
    signalShareTarget: {
      artist: String(target.artist ?? ''),
      title: String(target.title ?? ''),
      duration: Number(target.duration)
    }
  }),
  closeSignalShare: () => set({ signalShareTarget: null }),
  getSessionSnapshot: () => {
    const state = get()
    return {
      activeView: state.activeView,
      showQueue: state.showQueue,
      showInfoSidebar: state.showInfoSidebar,
      showPipelineShelf: state.showPipelineShelf,
      showLyricsShelf: state.showLyricsShelf,
      lyricsShelfExpanded: state.lyricsShelfExpanded,
      fullscreenLyricsVisible: state.fullscreenLyricsVisible
    }
  },
  restoreSession: (snapshot) => {
    const showLyricsShelf = Boolean(snapshot.showLyricsShelf)
    set({
      activeView: normalizeAppView(snapshot.activeView),
      viewBackHistory: [],
      viewForwardHistory: [],
      showQueue: Boolean(snapshot.showQueue),
      showInfoSidebar: Boolean(snapshot.showInfoSidebar),
      showPipelineShelf: Boolean(snapshot.showPipelineShelf),
      showLyricsShelf,
      lyricsShelfExpanded: showLyricsShelf && Boolean(snapshot.lyricsShelfExpanded),
      fullscreenLyricsVisible: Boolean(snapshot.fullscreenLyricsVisible),
      isFullscreen: false,
      isQuickLaunchOpen: false,
      pendingLibrarySearchQuery: null,
      pendingSettingsSection: null,
      playlistNavigationRestoreRequest: null,
      collectionQueueMenu: null,
      signalShareTarget: null,
      sidebarPlaylistCreateRequest: null,
      trackDrag: null,
      trackDragCommittedNavigation: null
    })
  }
}))
