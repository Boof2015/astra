import { create } from 'zustand'
import type {
  ListeningHistoryStatus,
  ListeningStatsDashboard,
  ListeningStatsRange,
  ListeningStatsRankingMetric
} from '../../types/listeningStats'
import { LISTENING_STATS_ENABLED_STORAGE_KEY } from '../constants/settingsStorageKeys'
import { useLibraryStore } from './libraryStore'
import { usePlayerStore } from './playerStore'

function readEnabledPreference(): boolean {
  try {
    return localStorage.getItem(LISTENING_STATS_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistEnabledPreference(enabled: boolean): void {
  try {
    localStorage.setItem(LISTENING_STATS_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore localStorage failures and retain the in-memory preference.
  }
}

interface ListeningStatsStore {
  enabled: boolean
  range: ListeningStatsRange
  rankingMetric: ListeningStatsRankingMetric
  dashboard: ListeningStatsDashboard | null
  isLoading: boolean
  error: string | null
  setEnabled: (enabled: boolean) => void
  setRange: (range: ListeningStatsRange) => void
  setRankingMetric: (metric: ListeningStatsRankingMetric) => void
  loadDashboard: () => Promise<void>
  clearDetailedHistory: () => Promise<ListeningHistoryStatus>
}

let dashboardRequestId = 0

export const useListeningStatsStore = create<ListeningStatsStore>((set, get) => ({
  enabled: readEnabledPreference(),
  range: '30d',
  rankingMetric: 'plays',
  dashboard: null,
  isLoading: false,
  error: null,

  setEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistEnabledPreference(normalized)
    set({ enabled: normalized })
  },

  setRange: (range) => {
    if (get().range === range) return
    set({ range })
    void get().loadDashboard()
  },

  setRankingMetric: (rankingMetric) => {
    if (get().rankingMetric === rankingMetric) return
    set({ rankingMetric })
    void get().loadDashboard()
  },

  loadDashboard: async () => {
    const requestId = ++dashboardRequestId
    set({ isLoading: true, error: null })
    try {
      const { range, rankingMetric } = get()
      const { artistBrowseMode } = useLibraryStore.getState()
      const dashboard = await window.electronAPI.library.getListeningStatsDashboard({
        range,
        rankingMetric,
        artistBrowseMode
      })
      if (requestId !== dashboardRequestId) return
      set({ dashboard, isLoading: false, error: null })
    } catch (error) {
      if (requestId !== dashboardRequestId) return
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Listening stats could not be loaded.'
      })
    }
  },

  clearDetailedHistory: async () => {
    const status = await window.electronAPI.library.clearDetailedListeningHistory()
    usePlayerStore.getState().resetListeningHistoryTracking(status)
    set({ dashboard: null, error: null })
    await get().loadDashboard()
    return status
  }
}))
