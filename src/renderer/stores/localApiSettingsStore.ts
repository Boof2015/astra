import { create } from 'zustand'
import type {
  LocalApiPairedDevice,
  LocalApiPairingTicket,
  LocalApiPendingPairingRequest,
  LocalApiStatus
} from '../../types/localApi'

interface LocalApiSettingsStore {
  status: LocalApiStatus | null
  pairedDevices: LocalApiPairedDevice[]
  pendingPairingRequests: LocalApiPendingPairingRequest[]
  activePairingTicket: LocalApiPairingTicket | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setControlsEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setRemoteWebEnabled: (enabled: boolean) => Promise<LocalApiStatus | null>
  setPort: (port: number) => Promise<LocalApiStatus | null>
  rotateToken: () => Promise<LocalApiStatus | null>
  resetToDefaults: () => Promise<LocalApiStatus | null>
  createPairingTicket: (baseUrl?: string) => Promise<LocalApiPairingTicket | null>
  clearActivePairingTicket: () => void
  approvePairingRequest: (id: string) => Promise<void>
  rejectPairingRequest: (id: string) => Promise<void>
  revokePairedDevice: (id: string) => Promise<void>
  revokeAllPairedDevices: () => Promise<number>
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

  const refreshPairingState = async (): Promise<void> => {
    const [pairedDevices, pendingPairingRequests] = await Promise.all([
      window.electronAPI.localApi.listPairedDevices(),
      window.electronAPI.localApi.listPendingPairingRequests()
    ])
    set({
      pairedDevices,
      pendingPairingRequests
    })
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.localApi.onStatus((status) => {
      applyStatus(status)
      void refreshPairingState().catch((error) => {
        set({ errorMessage: toErrorMessage(error) })
      })
    })
  }

  const fetchAll = async (): Promise<LocalApiStatus> => {
    const status = await window.electronAPI.localApi.getStatus()
    ensureSubscription()
    applyStatus(status)
    await refreshPairingState()
    return status
  }

  return {
    status: null,
    pairedDevices: [],
    pendingPairingRequests: [],
    activePairingTicket: null,
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
        await refreshPairingState()
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

    setRemoteWebEnabled: async (enabled: boolean) => {
      try {
        const status = await window.electronAPI.localApi.setRemoteWebEnabled(enabled)
        await refreshPairingState()
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
        set({
          pairedDevices: [],
          pendingPairingRequests: [],
          activePairingTicket: null
        })
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    createPairingTicket: async (baseUrl?: string) => {
      try {
        const ticket = await window.electronAPI.localApi.createPairingTicket(baseUrl)
        set({
          activePairingTicket: ticket,
          errorMessage: ''
        })
        return ticket
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    clearActivePairingTicket: () => {
      set({ activePairingTicket: null })
    },

    approvePairingRequest: async (id: string) => {
      try {
        await window.electronAPI.localApi.approvePairingRequest(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    rejectPairingRequest: async (id: string) => {
      try {
        await window.electronAPI.localApi.rejectPairingRequest(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokePairedDevice: async (id: string) => {
      try {
        await window.electronAPI.localApi.revokePairedDevice(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokeAllPairedDevices: async () => {
      try {
        const revokedCount = await window.electronAPI.localApi.revokeAllPairedDevices()
        await refreshPairingState()
        return revokedCount
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return 0
      }
    }
  }
})
