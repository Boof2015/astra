import { create } from 'zustand'

export const UPDATES_AUTO_CHECK_STORAGE_KEY = 'astra-updates-auto-check-enabled'

export type UpdateCheckState = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'

export interface UpdateCueNotice {
  id: number
  latestTag: string
  latestVersion: string | null
  currentVersion: string
  releaseName: string | null
  releaseUrl: string | null
}

interface UpdateStore {
  autoCheckEnabled: boolean
  checkState: UpdateCheckState
  statusMessage: string
  updateAvailable: boolean
  currentVersion: string | null
  latestTag: string | null
  latestVersion: string | null
  releaseName: string | null
  releaseUrl: string | null
  lastCheckedAt: number | null
  cueNotice: UpdateCueNotice | null
  setAutoCheckEnabled: (enabled: boolean) => void
  checkForUpdates: () => Promise<void>
  openReleasesPage: (releaseUrl?: string | null) => Promise<void>
  clearCueNotice: () => void
}

let nextCueNoticeId = 0
const shownUpdateTagsThisSession = new Set<string>()

function readAutoCheckPreference(): boolean {
  try {
    return localStorage.getItem(UPDATES_AUTO_CHECK_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

function persistAutoCheckPreference(enabled: boolean): void {
  try {
    localStorage.setItem(UPDATES_AUTO_CHECK_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory preference.
  }
}

const initialAutoCheckEnabled = readAutoCheckPreference()

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  autoCheckEnabled: initialAutoCheckEnabled,
  checkState: 'idle',
  statusMessage: initialAutoCheckEnabled
    ? 'Automatic update checks are enabled.'
    : 'Automatic update checks are disabled.',
  updateAvailable: false,
  currentVersion: null,
  latestTag: null,
  latestVersion: null,
  releaseName: null,
  releaseUrl: null,
  lastCheckedAt: null,
  cueNotice: null,

  setAutoCheckEnabled: (enabled: boolean) => {
    persistAutoCheckPreference(enabled)
    set({
      autoCheckEnabled: enabled,
      statusMessage: enabled
        ? 'Automatic update checks are enabled.'
        : 'Automatic update checks are disabled.',
    })
  },

  checkForUpdates: async () => {
    if (get().checkState === 'checking') return

    set({
      checkState: 'checking',
      statusMessage: 'Checking for updates...',
    })

    try {
      const result = await window.electronAPI.updates.checkForUpdates()
      const releaseUrl = result.releaseUrl?.trim() || null

      let cueNotice: UpdateCueNotice | null = null
      if (result.updateAvailable && result.latestTag && !shownUpdateTagsThisSession.has(result.latestTag)) {
        nextCueNoticeId += 1
        shownUpdateTagsThisSession.add(result.latestTag)
        cueNotice = {
          id: nextCueNoticeId,
          latestTag: result.latestTag,
          latestVersion: result.latestVersion,
          currentVersion: result.currentVersion,
          releaseName: result.releaseName,
          releaseUrl,
        }
      }

      set({
        checkState: result.status,
        statusMessage: result.message,
        updateAvailable: result.updateAvailable,
        currentVersion: result.currentVersion,
        latestTag: result.latestTag,
        latestVersion: result.latestVersion,
        releaseName: result.releaseName,
        releaseUrl,
        lastCheckedAt: result.checkedAt,
        cueNotice: cueNotice ?? get().cueNotice,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      set({
        checkState: 'error',
        statusMessage: `Failed to check for updates: ${message}`,
        updateAvailable: false,
        lastCheckedAt: Date.now(),
      })
    }
  },

  openReleasesPage: async (releaseUrl?: string | null) => {
    try {
      const targetReleaseUrl = typeof releaseUrl === 'string' && releaseUrl.trim().length > 0
        ? releaseUrl
        : get().releaseUrl
      await window.electronAPI.updates.openReleasesPage(targetReleaseUrl ?? undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      set({
        checkState: 'error',
        statusMessage: `Failed to open releases page: ${message}`,
      })
    }
  },

  clearCueNotice: () => {
    set({ cueNotice: null })
  },
}))
