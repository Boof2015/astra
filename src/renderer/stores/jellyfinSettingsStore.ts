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
  const applySources = async (sources: JellyfinSource[]): Promise<void> => {
    set({
      sources,
      errorMessage: ''
    })
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

  const fetchAll = async (): Promise<void> => {
    const [sources, status] = await Promise.all([
      window.electronAPI.jellyfin.listSources(),
      window.electronAPI.jellyfin.getStatus()
    ])
    ensureSubscription()
    set({ status })
    await applySources(sources)
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
        await fetchAll()
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

    testSource: async (input) => {
      try {
        const result = await window.electronAPI.jellyfin.testSource(input)
        if (!result.ok) {
          set({ errorMessage: result.error ?? result.message })
        } else {
          set({ errorMessage: '' })
        }
        return result
      } catch (error) {
        const message = toErrorMessage(error)
        set({ errorMessage: message })
        return {
          ok: false,
          message: 'Connection failed.',
          error: message
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
