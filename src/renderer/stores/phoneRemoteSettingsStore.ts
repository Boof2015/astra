import { create } from 'zustand'
import type {
  PhoneRemotePairedDevice,
  PhoneRemotePairingTicket,
  PhoneRemotePendingPairingRequest,
  PhoneRemoteStatus
} from '../../types/phoneRemote'

interface PhoneRemoteSettingsStore {
  status: PhoneRemoteStatus | null
  pairedDevices: PhoneRemotePairedDevice[]
  pendingPairingRequests: PhoneRemotePendingPairingRequest[]
  activePairingTicket: PhoneRemotePairingTicket | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<PhoneRemoteStatus | null>
  setPort: (port: number) => Promise<PhoneRemoteStatus | null>
  resetToDefaults: () => Promise<PhoneRemoteStatus | null>
  createPairingTicket: (baseUrl?: string) => Promise<PhoneRemotePairingTicket | null>
  clearActivePairingTicket: () => void
  approvePairingRequest: (id: string) => Promise<void>
  rejectPairingRequest: (id: string) => Promise<void>
  revokePairedDevice: (id: string) => Promise<void>
  revokeAllPairedDevices: () => Promise<number>
}

let statusUnsubscribe: (() => void) | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update phone remote settings.'
}

export const usePhoneRemoteSettingsStore = create<PhoneRemoteSettingsStore>((set, get) => {
  const applyStatus = (status: PhoneRemoteStatus): PhoneRemoteStatus => {
    set({
      status,
      errorMessage: ''
    })
    return status
  }

  const refreshPairingState = async (): Promise<void> => {
    const [pairedDevices, pendingPairingRequests] = await Promise.all([
      window.electronAPI.phoneRemote.listPairedDevices(),
      window.electronAPI.phoneRemote.listPendingPairingRequests()
    ])
    set({
      pairedDevices,
      pendingPairingRequests
    })
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.phoneRemote.onStatus((status) => {
      applyStatus(status)
      void refreshPairingState().catch((error) => {
        set({ errorMessage: toErrorMessage(error) })
      })
    })
  }

  const fetchAll = async (): Promise<PhoneRemoteStatus> => {
    const status = await window.electronAPI.phoneRemote.getStatus()
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
        const status = await window.electronAPI.phoneRemote.setEnabled(enabled)
        await refreshPairingState()
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setPort: async (port: number) => {
      try {
        const status = await window.electronAPI.phoneRemote.setPort(port)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    resetToDefaults: async () => {
      try {
        const status = await window.electronAPI.phoneRemote.resetToDefaults()
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
        const ticket = await window.electronAPI.phoneRemote.createPairingTicket(baseUrl)
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
        await window.electronAPI.phoneRemote.approvePairingRequest(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    rejectPairingRequest: async (id: string) => {
      try {
        await window.electronAPI.phoneRemote.rejectPairingRequest(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokePairedDevice: async (id: string) => {
      try {
        await window.electronAPI.phoneRemote.revokePairedDevice(id)
        await refreshPairingState()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokeAllPairedDevices: async () => {
      try {
        const revokedCount = await window.electronAPI.phoneRemote.revokeAllPairedDevices()
        await refreshPairingState()
        return revokedCount
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return 0
      }
    }
  }
})
