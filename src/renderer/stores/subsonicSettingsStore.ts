import { create } from 'zustand'
import type {
  SubsonicSource,
  SubsonicSourceCreateInput,
  SubsonicSourceTestInput,
  SubsonicSourceTestResult,
  SubsonicSourceUpdateInput,
  SubsonicStatusSnapshot
} from '../../types/subsonic'
import { useLibraryStore } from './libraryStore'
import { usePlaylistStore } from './playlistStore'

interface SubsonicSettingsStore {
  sources: SubsonicSource[]
  status: SubsonicStatusSnapshot | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  createSource: (input: SubsonicSourceCreateInput) => Promise<SubsonicSource | null>
  updateSource: (sourceId: number, input: SubsonicSourceUpdateInput) => Promise<SubsonicSource | null>
  deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<boolean>
  testSource: (input: SubsonicSourceTestInput) => Promise<SubsonicSourceTestResult>
  syncSource: (sourceId: number, syncSessionKey?: string) => Promise<boolean>
  syncAll: (syncSessionKey?: string) => Promise<boolean>
}

let statusUnsubscribe: (() => void) | null = null
const metadataReadySourceIds = new Set<number>()
let metadataReadyRefreshPromise: Promise<void> | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update Subsonic settings.'
}

export const useSubsonicSettingsStore = create<SubsonicSettingsStore>((set, get) => {
  const refreshLibraryViews = async (): Promise<void> => {
    await useLibraryStore.getState().loadLibrary()
    await usePlaylistStore.getState().loadPlaylists()
    const selectedPlaylistId = usePlaylistStore.getState().selectedPlaylistId
    if (selectedPlaylistId !== null) {
      await usePlaylistStore.getState().selectPlaylist(selectedPlaylistId)
    }
  }

  const scheduleMetadataReadyRefresh = (): void => {
    if (metadataReadyRefreshPromise) return
    metadataReadyRefreshPromise = refreshLibraryViews()
      .catch((error) => {
        console.error('Failed to refresh library after Subsonic metadata sync.', error)
      })
      .finally(() => {
        metadataReadyRefreshPromise = null
      })
  }

  const applySources = async (sources: SubsonicSource[]): Promise<void> => {
    set({
      sources,
      errorMessage: ''
    })
    await refreshLibraryViews()
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.subsonic.onStatus((status) => {
      set({ status })
      for (const sourceStatus of status.sources) {
        if (sourceStatus.progress?.phase !== 'playlists') continue
        if (metadataReadySourceIds.has(sourceStatus.sourceId)) continue
        metadataReadySourceIds.add(sourceStatus.sourceId)
        scheduleMetadataReadyRefresh()
      }
      if (!status.isSyncing) {
        metadataReadySourceIds.clear()
      }
    })
  }

  const fetchAll = async (): Promise<void> => {
    const [sources, status] = await Promise.all([
      window.electronAPI.subsonic.listSources(),
      window.electronAPI.subsonic.getStatus()
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
        const source = await window.electronAPI.subsonic.createSource(input)
        await fetchAll()
        return source
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    updateSource: async (sourceId, input) => {
      try {
        const source = await window.electronAPI.subsonic.updateSource(sourceId, input)
        await fetchAll()
        return source
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    deleteSource: async (sourceId, purgeTracks) => {
      try {
        await window.electronAPI.subsonic.deleteSource(sourceId, purgeTracks)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    testSource: async (input) => {
      try {
        const result = await window.electronAPI.subsonic.testSource(input)
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
        await window.electronAPI.subsonic.syncSource(sourceId, syncSessionKey)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    syncAll: async (syncSessionKey) => {
      try {
        await window.electronAPI.subsonic.syncAll(syncSessionKey)
        await fetchAll()
        return true
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    }
  }
})
