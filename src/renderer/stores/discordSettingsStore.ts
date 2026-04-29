import { create } from 'zustand'

interface DiscordSettingsStore {
  enabled: boolean
  coverArtEnabled: boolean
  coverArtLookupActive: boolean
  statusMessage: string
  setCoverArtLookupActive: (coverArtLookupActive: boolean) => void
  setEnabled: (enabled: boolean) => Promise<void>
  setCoverArtEnabled: (enabled: boolean) => Promise<void>
  initFromSaved: () => Promise<void>
  resetToDefaults: () => Promise<void>
}

const ENABLED_STORAGE_KEY = 'astra-discord-rpc-enabled'
const COVER_ART_ENABLED_STORAGE_KEY = 'astra-discord-rpc-cover-art-enabled'
const COVER_ART_CACHE_STORAGE_KEY_V1 = 'astra-discord-cover-art-cache-v1'
const COVER_ART_CACHE_STORAGE_KEY_V2 = 'astra-discord-cover-art-cache-v2'
const COVER_ART_CACHE_STORAGE_KEY_V3 = 'astra-discord-cover-art-cache-v3'
const COVER_ART_CACHE_STORAGE_KEY_V4 = 'astra-discord-cover-art-cache-v4'
const LEGACY_CLIENT_ID_STORAGE_KEY = 'astra-discord-rpc-client-id'

export const useDiscordSettingsStore = create<DiscordSettingsStore>((set, get) => {
  const clearLegacyClientId = () => {
    localStorage.removeItem(LEGACY_CLIENT_ID_STORAGE_KEY)
  }

  const applyDiscordConfig = async () => {
    const { enabled, coverArtEnabled } = get()

    try {
      const result = await window.electronAPI.discord.configure({ enabled, coverArtEnabled })
      set({ statusMessage: result.message })
      if (!enabled) {
        window.electronAPI.discord.clearPresence()
      }
    } catch (error) {
      console.error('Failed to configure Discord Rich Presence:', error)
      set({ statusMessage: 'Failed to configure Discord Rich Presence.' })
    }
  }

  return {
    enabled: false,
    coverArtEnabled: false,
    coverArtLookupActive: false,
    statusMessage: 'Discord Rich Presence is disabled.',

    setCoverArtLookupActive: (coverArtLookupActive: boolean) => {
      set({ coverArtLookupActive })
    },

    setEnabled: async (enabled: boolean) => {
      set({ enabled, coverArtLookupActive: enabled ? get().coverArtLookupActive : false })
      localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0')
      await applyDiscordConfig()
    },

    setCoverArtEnabled: async (coverArtEnabled: boolean) => {
      set({ coverArtEnabled, coverArtLookupActive: coverArtEnabled ? get().coverArtLookupActive : false })
      localStorage.setItem(COVER_ART_ENABLED_STORAGE_KEY, coverArtEnabled ? '1' : '0')
      await applyDiscordConfig()
    },

    initFromSaved: async () => {
      clearLegacyClientId()
      const enabled = localStorage.getItem(ENABLED_STORAGE_KEY) === '1'
      const coverArtEnabled = localStorage.getItem(COVER_ART_ENABLED_STORAGE_KEY) === '1'
      set({ enabled, coverArtEnabled, coverArtLookupActive: false })
      await applyDiscordConfig()
    },

    resetToDefaults: async () => {
      set({ enabled: false, coverArtEnabled: false, coverArtLookupActive: false })
      localStorage.removeItem(ENABLED_STORAGE_KEY)
      localStorage.removeItem(COVER_ART_ENABLED_STORAGE_KEY)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V1)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V2)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V3)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V4)
      clearLegacyClientId()
      await applyDiscordConfig()
    },
  }
})
