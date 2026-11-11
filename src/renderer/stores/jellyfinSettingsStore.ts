import { create } from 'zustand'
import type {
  JellyfinSource,
  JellyfinSourceCreateInput,
  JellyfinSourceTestInput,
  JellyfinSourceTestResult,
  JellyfinSourceUpdateInput,
  JellyfinStatusSnapshot
} from '../../types/subsonic'
import { useLibraryStore } from './libraryStore'
import { usePlaylistStore } from './playlistStore'

interface JellyfinSettingsStore {
  sources: JellyfinSource[]
  status: JellyfinStatusSnapshot | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  createSource: (input: JellyfinSourceCreateInput) => Promise<JellyfinSource | null>
  updateSource: (sourceId: number, input: JellyfinSourceUpdateInput) => Promise<JellyfinSource | null>
  deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<boolean>
  testSource: (input: JellyfinSourceTestInput) => Promise<JellyfinSourceTestResult>
  syncSource: (sourceId: number, syncSessionKey?: string) => Promise<boolean>
  syncAll: (syncSessionKey?: string) => Promise<boolean>
}

let statusUnsubscribe: (() => void) | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update Jellyfin settings.'
}

export const useJellyfinSettingsStore = create<JellyfinSettingsStore>((set, get) => {
  const refreshLibraryViews = async (): Promise<void> => {
    await useLibraryStore.getState().loadLibrary()
    await usePlaylistStore.getState().loadPlaylists()
    const selectedPlaylistId = usePlaylistStore.getState().selectedPlaylistId
    if (selectedPlaylistId !== null) {
      await usePlaylistStore.getState().selectPlaylist(selectedPlaylistId)
    }
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.jellyfin.onStatus((status) => {
      set({ status })
    })
  }

  const fetchSources = async (): Promise<void> => {
    const [sources, status] = await Promise.all([
      window.electronAPI.jellyfin.listSources(),
      window.electronAPI.jellyfin.getStatus()
    ])
    ensureSubscription()
    set({ status, sources, errorMessage: '' })
  }

  // After a server is added, changed, removed or synced, the library shows different tracks.
  const fetchAll = async (): Promise<void> => {
    await fetchSources()
    await refreshLibraryViews()
  }

  return {
    sources: [],
    status: null,
    isLoading: false,
    isInitialized: false,
    errorMessage: '',

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        // Only the server list. The app loads the library itself at startup, and
        // nothing about the servers has changed yet.
        await fetchSources()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    refresh: async () => {
      set({ isLoading: true })
      try {
        await fetchAll()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    createSource: async (input) => {
      try {
        const source = await window.electronAPI.jellyfin.createSource(input)
        await fetchAll()
        return source
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    updateSource: async (sourceId, input) => {
      try {
        const source = await window.electronAPI.jellyfin.updateSource(sourceId, input)
        await fetchAll()
        return source
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    deleteSource: async (sourceId, purgeTracks) => {
      try {
        await window.electronAPI.jellyfin.deleteSource(sourceId, purgeTracks)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    // A test only answers the caller; server type auto-detect probes both
    // providers, so a failed probe must not leave a store-wide error behind.
    testSource: async (input) => {
      try {
        return await window.electronAPI.jellyfin.testSource(input)
      } catch (error) {
        return {
          ok: false,
          message: 'Connection failed.',
          error: toErrorMessage(error)
        }
      }
    },

    syncSource: async (sourceId, syncSessionKey) => {
      try {
        await window.electronAPI.jellyfin.syncSource(sourceId, syncSessionKey)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    syncAll: async (syncSessionKey) => {
      try {
        await window.electronAPI.jellyfin.syncAll(syncSessionKey)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    }
  }
})
