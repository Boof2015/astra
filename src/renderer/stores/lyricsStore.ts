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
  setLrclibBaseUrl: (baseUrl: string) => Promise<LyricsStatus | null>
  loadForTrack: (query: LyricsTrackQuery | null) => Promise<LyricsLookupResult | null>
  refreshForTrack: (query: LyricsTrackQuery | null) => Promise<LyricsLookupResult | null>
  resetToDefaults: () => Promise<LyricsStatus | null>
}

let statusUnsubscribe: (() => void) | null = null
let activeRequestId = 0

export const LYRICS_RESULT_CACHE_LIMIT = 64

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update lyrics settings.'
}

function normalizeTrackPath(path: string | undefined): string | null {
  if (!path) return null
  const normalized = path.trim()
  return normalized.length > 0 ? normalized : null
}

export function putLyricsResultInCache(
  cache: Record<string, LyricsLookupResult>,
  trackPath: string,
  result: LyricsLookupResult,
  currentTrackPath: string | null,
  limit = LYRICS_RESULT_CACHE_LIMIT
): Record<string, LyricsLookupResult> {
  const maxEntries = Math.max(1, Math.floor(limit))
  const entries = Object.entries(cache).filter(([path]) => path !== trackPath)
  entries.push([trackPath, result])

  if (entries.length <= maxEntries) {
    return Object.fromEntries(entries)
  }

  const bounded = new Map(entries)
  while (bounded.size > maxEntries) {
    const oldestPath = bounded.keys().next().value as string | undefined
    if (oldestPath === undefined) break

    if (oldestPath === currentTrackPath) {
      const currentResult = bounded.get(oldestPath)
      if (currentResult === undefined) break
      bounded.delete(oldestPath)
      bounded.set(oldestPath, currentResult)
      continue
    }

    bounded.delete(oldestPath)
  }

  return Object.fromEntries(bounded)
}

function touchLyricsResultCacheEntry(
  cache: Record<string, LyricsLookupResult>,
  trackPath: string,
  currentTrackPath: string | null
): Record<string, LyricsLookupResult> {
  const result = cache[trackPath]
  if (result === undefined) return cache
  return putLyricsResultInCache(cache, trackPath, result, currentTrackPath)
}

function isProviderUnavailableResult(result: LyricsLookupResult): boolean {
  return result.status === 'not_found' && result.reason === 'provider-unavailable'
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
      resultByTrackPath: isProviderUnavailableResult(result) && state.resultByTrackPath[trackPath]?.status === 'hit'
        ? touchLyricsResultCacheEntry(state.resultByTrackPath, trackPath, trackPath)
        : putLyricsResultInCache(state.resultByTrackPath, trackPath, result, trackPath),
      currentTrackPath: trackPath,
      currentResult: isProviderUnavailableResult(result) && state.resultByTrackPath[trackPath]?.status === 'hit'
        ? state.resultByTrackPath[trackPath]
        : result,
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

    setLrclibBaseUrl: async (baseUrl: string) => {
      try {
        const status = await window.electronAPI.lyrics.setLrclibBaseUrl(baseUrl)
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
        resultByTrackPath: touchLyricsResultCacheEntry(state.resultByTrackPath, trackPath, trackPath),
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
      set((state) => ({
        resultByTrackPath: touchLyricsResultCacheEntry(state.resultByTrackPath, trackPath, trackPath),
        currentTrackPath: trackPath,
        isLoading: true,
        errorMessage: ''
      }))

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
