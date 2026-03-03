import { create } from 'zustand'
import type { LyricsLookupResult, LyricsStatus, LyricsTrackQuery } from '../../types/lyrics'

interface LyricsStore {
  status: LyricsStatus | null
  resultByTrackPath: Record<string, LyricsLookupResult>
  currentTrackPath: string | null
  currentResult: LyricsLookupResult | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<LyricsStatus | null>
  loadForTrack: (query: LyricsTrackQuery | null) => Promise<LyricsLookupResult | null>
  refreshForTrack: (query: LyricsTrackQuery | null) => Promise<LyricsLookupResult | null>
  resetToDefaults: () => Promise<LyricsStatus | null>
}

let statusUnsubscribe: (() => void) | null = null
let activeRequestId = 0

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update lyrics settings.'
}

function normalizeTrackPath(path: string | undefined): string | null {
  if (!path) return null
  const normalized = path.trim()
  return normalized.length > 0 ? normalized : null
}

export const useLyricsStore = create<LyricsStore>((set, get) => {
  const applyStatus = (status: LyricsStatus): LyricsStatus => {
    set({
      status,
      errorMessage: ''
    })
    return status
  }

  const ensureSubscription = (): void => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.lyrics.onStatus((status) => {
      applyStatus(status)
    })
  }

  const fetchStatus = async (): Promise<LyricsStatus> => {
    const status = await window.electronAPI.lyrics.getStatus()
    ensureSubscription()
    return applyStatus(status)
  }

  const applyTrackResult = (
    requestId: number,
    trackPath: string,
    result: LyricsLookupResult
  ): LyricsLookupResult => {
    if (requestId !== activeRequestId) return result
    set((state) => ({
      resultByTrackPath: {
        ...state.resultByTrackPath,
        [trackPath]: result
      },
      currentTrackPath: trackPath,
      currentResult: result,
      isLoading: false,
      errorMessage: result.status === 'transient_error' ? result.message : ''
    }))
    return result
  }

  return {
    status: null,
    resultByTrackPath: {},
    currentTrackPath: null,
    currentResult: null,
    isLoading: false,
    isInitialized: false,
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
        const status = await window.electronAPI.lyrics.setEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    loadForTrack: async (query) => {
      const trackPath = normalizeTrackPath(query?.path)
      if (!query || !trackPath) {
        activeRequestId += 1
        set({
          currentTrackPath: null,
          currentResult: null,
          isLoading: false,
          errorMessage: ''
        })
        return null
      }

      const requestId = activeRequestId + 1
      activeRequestId = requestId
      set((state) => ({
        currentTrackPath: trackPath,
        currentResult: state.resultByTrackPath[trackPath] ?? null,
        isLoading: true,
        errorMessage: ''
      }))

      try {
        const result = await window.electronAPI.lyrics.getForTrack(query)
        return applyTrackResult(requestId, trackPath, result)
      } catch (error) {
        if (requestId !== activeRequestId) return null
        set({
          isLoading: false,
          errorMessage: toErrorMessage(error)
        })
        return null
      }
    },

    refreshForTrack: async (query) => {
      const trackPath = normalizeTrackPath(query?.path)
      if (!query || !trackPath) {
        return null
      }

      const requestId = activeRequestId + 1
      activeRequestId = requestId
      set({
        currentTrackPath: trackPath,
        isLoading: true,
        errorMessage: ''
      })

      try {
        const result = await window.electronAPI.lyrics.refreshForTrack(query)
        return applyTrackResult(requestId, trackPath, result)
      } catch (error) {
        if (requestId !== activeRequestId) return null
        set({
          isLoading: false,
          errorMessage: toErrorMessage(error)
        })
        return null
      }
    },

    resetToDefaults: async () => {
      try {
        const status = await window.electronAPI.lyrics.resetToDefaults()
        applyStatus(status)
        set({
          resultByTrackPath: {},
          currentTrackPath: null,
          currentResult: null,
          isLoading: false,
          errorMessage: ''
        })
        return status
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    }
  }
})
