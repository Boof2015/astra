import { create } from 'zustand'
import type { LibraryDiagnosticsStatus } from '../../types/libraryDiagnostics'

interface LibraryDiagnosticsStore {
  status: LibraryDiagnosticsStatus | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  revealCurrentLog: () => Promise<boolean>
  revealPreviousLog: () => Promise<boolean>
}

let statusUnsubscribe: (() => void) | null = null

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Failed to update library diagnostics.'
}

export const useLibraryDiagnosticsStore = create<LibraryDiagnosticsStore>((set, get) => {
  const applyStatus = (status: LibraryDiagnosticsStatus): void => {
    set({ status, errorMessage: '' })
  }

  const ensureSubscription = (): void => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.libraryDiagnostics.onStatus(applyStatus)
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
        applyStatus(await window.electronAPI.libraryDiagnostics.getStatus())
        ensureSubscription()
      } catch (error) {
        set({ errorMessage: getErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    setEnabled: async (enabled: boolean) => {
      set({ isLoading: true, errorMessage: '' })
      try {
        applyStatus(await window.electronAPI.libraryDiagnostics.setEnabled(enabled))
      } catch (error) {
        set({ errorMessage: getErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    revealCurrentLog: async () => {
      try {
        return await window.electronAPI.libraryDiagnostics.revealCurrentLog()
      } catch (error) {
        set({ errorMessage: getErrorMessage(error) })
        return false
      }
    },

    revealPreviousLog: async () => {
      try {
        return await window.electronAPI.libraryDiagnostics.revealPreviousLog()
      } catch (error) {
        set({ errorMessage: getErrorMessage(error) })
        return false
      }
    }
  }
})

