import { create } from 'zustand'
import type {
  LastFmAuthFinishResult,
  LastFmAuthStartResult,
  LastFmCustomProfileInput,
  LastFmStatus
} from '../../types/lastFm'

const LASTFM_AUTH_POLL_INTERVAL_MS = 2_000
const LASTFM_AUTH_POLL_TIMEOUT_MS = 2 * 60 * 1_000

interface LastFmSettingsStore {
  status: LastFmStatus | null
  isLoading: boolean
  isInitialized: boolean
  isAuthorizing: boolean
  errorMessage: string
  authHint: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<LastFmStatus | null>
  createCustomProfile: (input: LastFmCustomProfileInput) => Promise<LastFmStatus | null>
  updateCustomProfile: (profileId: string, input: LastFmCustomProfileInput) => Promise<LastFmStatus | null>
  deleteCustomProfile: (profileId: string) => Promise<LastFmStatus | null>
  setProfileEnabled: (profileId: string, enabled: boolean) => Promise<LastFmStatus | null>
  beginAuth: (profileId: string) => Promise<LastFmAuthStartResult | null>
  finishAuth: () => Promise<LastFmAuthFinishResult | null>
  disconnectProfile: (profileId: string) => Promise<LastFmStatus | null>
  resetToDefaults: () => Promise<LastFmStatus | null>
}

let statusUnsubscribe: (() => void) | null = null
let authPollTimer: ReturnType<typeof setTimeout> | null = null
let authPollInFlight = false
let authPollDeadlineMs = 0

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update Last.fm settings.'
}

function buildDefaultAuthHint(status: LastFmStatus): string {
  if (!status.authPending) return ''
  return 'Approve Astra in your browser tab. Connection will complete automatically.'
}

export const useLastFmSettingsStore = create<LastFmSettingsStore>((set, get) => {
  const stopAuthPolling = (): void => {
    if (authPollTimer) {
      clearTimeout(authPollTimer)
      authPollTimer = null
    }
    authPollInFlight = false
    authPollDeadlineMs = 0
    if (get().isAuthorizing) {
      set({ isAuthorizing: false })
    }
  }

  const scheduleAuthPoll = (delayMs: number): void => {
    if (authPollTimer) {
      clearTimeout(authPollTimer)
    }
    authPollTimer = setTimeout(() => {
      authPollTimer = null
      void pollAuthCompletion()
    }, Math.max(0, delayMs))
  }

  const applyStatus = (status: LastFmStatus): LastFmStatus => {
    if (!status.authPending) {
      stopAuthPolling()
    }

    set({
      status,
      errorMessage: '',
      authHint: buildDefaultAuthHint(status)
    })
    return status
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.lastFm.onStatus((status) => {
      applyStatus(status)
    })
  }

  const fetchStatus = async (): Promise<LastFmStatus> => {
    const status = await window.electronAPI.lastFm.getStatus()
    ensureSubscription()
    return applyStatus(status)
  }

  const pollAuthCompletion = async (): Promise<void> => {
    if (authPollInFlight) return

    authPollInFlight = true
    try {
      const result = await window.electronAPI.lastFm.finishAuth()
      const status = await fetchStatus().catch(() => null)

      if (result.ok) {
        stopAuthPolling()
        set({ authHint: '', errorMessage: '' })
        return
      }

      const stillPending = status?.authPending ?? false
      if (stillPending) {
        if (Date.now() >= authPollDeadlineMs) {
          stopAuthPolling()
          set({
            authHint: 'Authorization still pending. Approve Astra on Last.fm, then press Connect again.',
            errorMessage: ''
          })
          return
        }

        set({
          authHint: 'Waiting for Last.fm approval in your browser...',
          errorMessage: ''
        })
        scheduleAuthPoll(LASTFM_AUTH_POLL_INTERVAL_MS)
        return
      }

      stopAuthPolling()
      set({
        authHint: '',
        errorMessage: result.message
      })
    } catch (error) {
      const status = await fetchStatus().catch(() => null)
      const stillPending = status?.authPending ?? false

      if (stillPending && Date.now() < authPollDeadlineMs) {
        set({
          authHint: 'Waiting for Last.fm approval in your browser...',
          errorMessage: ''
        })
        scheduleAuthPoll(LASTFM_AUTH_POLL_INTERVAL_MS)
        return
      }

      stopAuthPolling()
      set({ errorMessage: toErrorMessage(error), authHint: '' })
    } finally {
      authPollInFlight = false
    }
  }

  const startAuthPolling = (): void => {
    stopAuthPolling()
    authPollDeadlineMs = Date.now() + LASTFM_AUTH_POLL_TIMEOUT_MS
    set({
      isAuthorizing: true,
      authHint: 'Waiting for Last.fm approval in your browser...',
      errorMessage: ''
    })
    scheduleAuthPoll(1_000)
  }

  return {
    status: null,
    isLoading: false,
    isInitialized: false,
    isAuthorizing: false,
    errorMessage: '',
    authHint: '',

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
        const status = await window.electronAPI.lastFm.setEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    createCustomProfile: async (input: LastFmCustomProfileInput) => {
      try {
        const status = await window.electronAPI.lastFm.createCustomProfile(input)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    updateCustomProfile: async (profileId: string, input: LastFmCustomProfileInput) => {
      try {
        const status = await window.electronAPI.lastFm.updateCustomProfile(profileId, input)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    deleteCustomProfile: async (profileId: string) => {
      try {
        const status = await window.electronAPI.lastFm.deleteCustomProfile(profileId)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setProfileEnabled: async (profileId: string, enabled: boolean) => {
      try {
        const status = await window.electronAPI.lastFm.setProfileEnabled(profileId, enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    beginAuth: async (profileId: string) => {
      try {
        const result = await window.electronAPI.lastFm.beginAuth(profileId)
        const status = await fetchStatus().catch(() => null)
        if (result.ok && (status?.authPending ?? result.authPending)) {
          startAuthPolling()
        } else if (result.ok) {
          stopAuthPolling()
          set({ errorMessage: '', authHint: status ? buildDefaultAuthHint(status) : '' })
        } else {
          stopAuthPolling()
          set({
            errorMessage: result.message,
            authHint: status ? buildDefaultAuthHint(status) : ''
          })
        }
        return result
      } catch (error) {
        stopAuthPolling()
        set({ errorMessage: toErrorMessage(error), authHint: '' })
        return null
      }
    },

    finishAuth: async () => {
      try {
        const result = await window.electronAPI.lastFm.finishAuth()
        const status = await fetchStatus().catch(() => null)
        if (result.ok) {
          stopAuthPolling()
          set({ authHint: '', errorMessage: '' })
        } else if (status?.authPending) {
          set({
            authHint: 'Waiting for Last.fm approval in your browser...',
            errorMessage: ''
          })
        } else {
          stopAuthPolling()
          set({
            errorMessage: result.message,
            authHint: status ? buildDefaultAuthHint(status) : ''
          })
        }
        return result
      } catch (error) {
        stopAuthPolling()
        set({ errorMessage: toErrorMessage(error), authHint: '' })
        return null
      }
    },

    disconnectProfile: async (profileId: string) => {
      try {
        stopAuthPolling()
        const status = await window.electronAPI.lastFm.disconnectProfile(profileId)
        set({ authHint: '' })
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    resetToDefaults: async () => {
      try {
        stopAuthPolling()
        const status = await window.electronAPI.lastFm.resetToDefaults()
        set({ authHint: '' })
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },
  }
})
