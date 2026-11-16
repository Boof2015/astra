import { create } from 'zustand'
import { TRACK_RATINGS_ENABLED_STORAGE_KEY } from '../constants/settingsStorageKeys'
import { useProviderSyncStore } from './providerSyncStore'
import type { RatingEditResult, RatingPreferences } from '../../shared/ratings/trackRating'

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
  // Toggles never delete ratings. Main process owns import/write permission.
  enabled: boolean
  writeToFiles: boolean
  preferencesBusy: boolean
  preferencesReady: boolean
  fileFailures: RatingEditResult['fileFailures']
  ratings: Map<string, TrackRatingState>
  setEnabled: (enabled: boolean) => Promise<void>
  setWriteToFiles: (enabled: boolean) => Promise<void>
  loadPreferences: () => Promise<void>
  loadRatings: () => Promise<void>
  setTrackRating: (trackPaths: string[], rating: number | null) => Promise<void>
}

export const useRatingsStore = create<RatingsStore>((set, get) => {
  const savePreferences = async (patch: Partial<RatingPreferences>) => {
    if (get().preferencesBusy || !get().preferencesReady) return
    set({ preferencesBusy: true })
    try {
      const preferences = await window.electronAPI.library.setRatingPreferences({ enabled: get().enabled, writeToFiles: get().writeToFiles, ...patch })
      persistEnabledPreference(preferences.enabled)
      set(preferences)
    } catch {
      useProviderSyncStore.getState().notifyError('Could not save rating settings. Your previous settings are still active.')
    } finally { set({ preferencesBusy: false }) }
  }
  return {
    enabled: readEnabledPreference(),
    writeToFiles: false,
    preferencesBusy: false,
    preferencesReady: false,
    fileFailures: [],
    ratings: new Map(),

    setEnabled: enabled => savePreferences({ enabled }),
    setWriteToFiles: writeToFiles => savePreferences({ writeToFiles }),
    loadPreferences: async () => {
      if (get().preferencesBusy) return
      set({ preferencesBusy: true })
      try {
        const preferences = await window.electronAPI.library.getRatingPreferences(readEnabledPreference())
        persistEnabledPreference(preferences.enabled)
        set({ ...preferences, preferencesReady: true })
      } catch {
        useProviderSyncStore.getState().notifyError('Could not load rating settings. Restart Astra to try again.')
      } finally { set({ preferencesBusy: false }) }
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
        const result = await window.electronAPI.library.setTrackRating(trackPaths, rating)
        set({ fileFailures: result.fileFailures })
        if (result.fileFailures.length) {
          useProviderSyncStore.getState().notifyError(`Rating saved in Astra. Could not update ${result.fileFailures.length} music file(s). See Track Ratings in Settings for details.`)
        }
      } catch (error) {
        console.error('Failed to save track rating:', error)
        useProviderSyncStore.getState().notifyError('Could not save the rating. For a synced server, check its connection and try again.')
        await get().loadRatings()
      }
    }
  }
})
