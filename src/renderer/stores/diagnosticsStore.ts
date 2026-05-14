import { create } from 'zustand'
import type { MemoryDiagnosticsCaptureBundleResult, MemoryDiagnosticsStatus } from '../../types/diagnostics'

interface DiagnosticsStore {
  status: MemoryDiagnosticsStatus | null
  isLoading: boolean
  isInitialized: boolean
  isCapturingBundle: boolean
  lastCaptureResult: MemoryDiagnosticsCaptureBundleResult | null
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus | null>
  captureBundle: (tag?: string) => Promise<MemoryDiagnosticsCaptureBundleResult | null>
  revealCurrentLog: () => Promise<boolean>
  revealPreviousLog: () => Promise<boolean>
}

let statusUnsubscribe: (() => void) | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update memory diagnostics.'
}

export const useDiagnosticsStore = create<DiagnosticsStore>((set, get) => {
  const applyStatus = (status: MemoryDiagnosticsStatus): MemoryDiagnosticsStatus => {
    set({
      status,
      errorMessage: ''
    })
    return status
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.diagnostics.onStatus((status) => {
      applyStatus(status)
    })
  }

  const fetchStatus = async (): Promise<MemoryDiagnosticsStatus> => {
    const status = await window.electronAPI.diagnostics.getStatus()
    ensureSubscription()
    return applyStatus(status)
  }

  return {
    status: null,
    isLoading: false,
    isInitialized: false,
    isCapturingBundle: false,
    lastCaptureResult: null,
    errorMessage: '',

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        await fetchStatus()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    refresh: async () => {
      set({ isLoading: true })
      try {
        await fetchStatus()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    setEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.diagnostics.setEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    captureBundle: async (tag?: string) => {
      set({ isCapturingBundle: true, errorMessage: '' })
      try {
        const result = await window.electronAPI.diagnostics.captureMemoryBundle(tag)
        set({
          isCapturingBundle: false,
          lastCaptureResult: result
        })
        return result
      } catch (error) {
        set({
          isCapturingBundle: false,
          errorMessage: toErrorMessage(error)
        })
        return null
      }
    },

    revealCurrentLog: async () => {
      try {
        return await window.electronAPI.diagnostics.revealCurrentLog()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    revealPreviousLog: async () => {
      try {
        return await window.electronAPI.diagnostics.revealPreviousLog()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    }
  }
})
