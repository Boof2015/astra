import { create } from 'zustand'
import { TRACK_RATINGS_ENABLED_STORAGE_KEY } from '../constants/settingsStorageKeys'

export interface TrackRatingState {
  rating: number
  updatedAt: number
}

function readEnabledPreference(): boolean {
  try {
    return localStorage.getItem(TRACK_RATINGS_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistEnabledPreference(enabled: boolean): void {
  try {
    localStorage.setItem(TRACK_RATINGS_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

interface RatingsStore {
  // Opt-in flag gates UI only; rating rows are never deleted by toggling.
  enabled: boolean
  ratings: Map<string, TrackRatingState>
  setEnabled: (enabled: boolean) => void
  loadRatings: () => Promise<void>
  setTrackRating: (trackPaths: string[], rating: number | null) => Promise<void>
}

export const useRatingsStore = create<RatingsStore>((set, get) => ({
  enabled: readEnabledPreference(),
  ratings: new Map(),

  setEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistEnabledPreference(normalized)
    set({ enabled: normalized })
  },

  loadRatings: async () => {
    try {
      const entries = await window.electronAPI.library.getTrackRatings()
      const ratings = new Map<string, TrackRatingState>()
      for (const entry of entries) {
        ratings.set(entry.track_path, { rating: entry.rating, updatedAt: entry.updated_at })
      }
      set({ ratings })
    } catch (error) {
      console.error('Failed to load track ratings:', error)
    }
  },

  setTrackRating: async (trackPaths, rating) => {
    const ratings = new Map(get().ratings)
    const updatedAt = Date.now()
    for (const trackPath of trackPaths) {
      if (rating === null) {
        ratings.delete(trackPath)
      } else {
        ratings.set(trackPath, { rating, updatedAt })
      }
    }
    set({ ratings })

    try {
      await window.electronAPI.library.setTrackRating(trackPaths, rating)
    } catch (error) {
      console.error('Failed to save track rating:', error)
      await get().loadRatings()
    }
  }
}))
