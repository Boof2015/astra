import { create } from 'zustand'
import type { LocalApiStatus } from '../../types/localApi'

interface LocalApiSettingsStore {
  status: LocalApiStatus | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setControlsEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setLibrarySearchEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setLibraryWriteEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setPort: (port: number) => Promise<LocalApiStatus | null>
  rotateToken: () => Promise<LocalApiStatus | null>
  resetToDefaults: () => Promise<LocalApiStatus | null>
}

let statusUnsubscribe: (() => void) | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update local integration API settings.'
}

export const useLocalApiSettingsStore = create<LocalApiSettingsStore>((set, get) => {
  const applyStatus = (status: LocalApiStatus): LocalApiStatus => {
    set({
      status,
      errorMessage: ''
    })
    return status
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.localApi.onStatus((status) => {
      applyStatus(status)
    })
  }

  const fetchAll = async (): Promise<LocalApiStatus> => {
    const status = await window.electronAPI.localApi.getStatus()
    ensureSubscription()
    applyStatus(status)
    return status
  }

  return {
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

    setEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.localApi.setEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setControlsEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.localApi.setControlsEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setLibrarySearchEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.localApi.setLibrarySearchEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setLibraryWriteEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.localApi.setLibraryWriteEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setPort: async (port: number) => {
      try {
        const status = await window.electronAPI.localApi.setPort(port)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    rotateToken: async () => {
      try {
        const status = await window.electronAPI.localApi.rotateToken()
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    resetToDefaults: async () => {
      try {
        const status = await window.electronAPI.localApi.resetToDefaults()
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    }
  }
})
