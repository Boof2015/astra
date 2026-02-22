import { create } from 'zustand'
import type { SettingsSectionId } from '../constants/settingsSections'

export type AppView = 'home' | 'library' | 'eq' | 'settings' | 'playlist' | 'metadata'
export type WaveformTimeDisplayMode = 'remaining' | 'duration'
export interface LibraryTrackRevealRequest {
  id: number
  trackPath: string
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
  isFullscreen: boolean
  waveformTimeDisplayMode: WaveformTimeDisplayMode
  libraryTrackRevealRequest: LibraryTrackRevealRequest | null
  isQuickLaunchOpen: boolean
  pendingLibrarySearchQuery: string | null
  pendingSettingsSection: SettingsSectionId | null
  setActiveView: (view: AppView) => void
  toggleQueue: () => void
  toggleInfoSidebar: () => void
  togglePipelineShelf: () => void
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
}

export const useUIStore = create<UIStore>((set, get) => ({
  activeView: 'home',
  showQueue: false,
  showInfoSidebar: false,
  showPipelineShelf: false,
  isFullscreen: false,
  waveformTimeDisplayMode: initialWaveformTimeDisplayMode,
  libraryTrackRevealRequest: null,
  isQuickLaunchOpen: false,
  pendingLibrarySearchQuery: null,
  pendingSettingsSection: null,
  setActiveView: (view) => set({ activeView: view }),
  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
  toggleInfoSidebar: () => set((s) => ({ showInfoSidebar: !s.showInfoSidebar })),
  togglePipelineShelf: () => set((s) => ({ showPipelineShelf: !s.showPipelineShelf })),
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
  }
}))
