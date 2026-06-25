import { create } from 'zustand'

export type DiscordRpcCompactStatusMode = 'title' | 'artist'
export type DiscordRpcExpandedInfoMode = 'file-info' | 'album'
export type DiscordRpcLinkDestination = 'off' | 'ytmusic' | 'lastfm'

export const DISCORD_PAUSE_CLEAR_MINUTE_PRESETS = [0, 1, 5, 15, 30] as const
const DEFAULT_PAUSE_CLEAR_MINUTES = 5

interface DiscordSettingsStore {
  enabled: boolean
  coverArtEnabled: boolean
  smallIconEnabled: boolean
  compactStatusMode: DiscordRpcCompactStatusMode
  expandedInfoMode: DiscordRpcExpandedInfoMode
  linkDestination: DiscordRpcLinkDestination
  pauseClearMinutes: number
  coverArtLookupActive: boolean
  statusMessage: string
  setCoverArtLookupActive: (coverArtLookupActive: boolean) => void
  setEnabled: (enabled: boolean) => Promise<void>
  setCoverArtEnabled: (enabled: boolean) => Promise<void>
  setSmallIconEnabled: (enabled: boolean) => Promise<void>
  setCompactStatusMode: (mode: DiscordRpcCompactStatusMode) => Promise<void>
  setExpandedInfoMode: (mode: DiscordRpcExpandedInfoMode) => Promise<void>
  setLinkDestination: (destination: DiscordRpcLinkDestination) => Promise<void>
  setPauseClearMinutes: (minutes: number) => Promise<void>
  initFromSaved: () => Promise<void>
  resetToDefaults: () => Promise<void>
}

export const DISCORD_RPC_ENABLED_STORAGE_KEY = 'astra-discord-rpc-enabled'
export const DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY = 'astra-discord-rpc-cover-art-enabled'
export const DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY = 'astra-discord-rpc-small-icon-enabled'
export const DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY = 'astra-discord-rpc-compact-status-mode-v1'
export const DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY = 'astra-discord-rpc-expanded-info-mode-v1'
export const DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY = 'astra-discord-rpc-link-destination-v1'
export const DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY = 'astra-discord-rpc-pause-clear-minutes-v1'
const COVER_ART_CACHE_STORAGE_KEY_V1 = 'astra-discord-cover-art-cache-v1'
const COVER_ART_CACHE_STORAGE_KEY_V2 = 'astra-discord-cover-art-cache-v2'
const COVER_ART_CACHE_STORAGE_KEY_V3 = 'astra-discord-cover-art-cache-v3'
const COVER_ART_CACHE_STORAGE_KEY_V4 = 'astra-discord-cover-art-cache-v4'
const LEGACY_CLIENT_ID_STORAGE_KEY = 'astra-discord-rpc-client-id'

function normalizeCompactStatusMode(value: string | null): DiscordRpcCompactStatusMode {
  return value === 'artist' ? 'artist' : 'title'
}

function normalizeExpandedInfoMode(value: string | null): DiscordRpcExpandedInfoMode {
  return value === 'album' ? 'album' : 'file-info'
}

function normalizeLinkDestination(value: string | null): DiscordRpcLinkDestination {
  return value === 'lastfm' || value === 'off' ? value : 'ytmusic'
}

export function normalizePauseClearMinutes(value: number): number {
  return DISCORD_PAUSE_CLEAR_MINUTE_PRESETS.includes(value as typeof DISCORD_PAUSE_CLEAR_MINUTE_PRESETS[number])
    ? value
    : DEFAULT_PAUSE_CLEAR_MINUTES
}

function readSavedPauseClearMinutes(): number {
  const raw = localStorage.getItem(DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY)
  if (raw === null) return DEFAULT_PAUSE_CLEAR_MINUTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? normalizePauseClearMinutes(parsed) : DEFAULT_PAUSE_CLEAR_MINUTES
}

export const useDiscordSettingsStore = create<DiscordSettingsStore>((set, get) => {
  const clearLegacyClientId = () => {
    localStorage.removeItem(LEGACY_CLIENT_ID_STORAGE_KEY)
  }

  const applyDiscordConfig = async () => {
    const {
      enabled,
      coverArtEnabled,
      smallIconEnabled,
      compactStatusMode,
      expandedInfoMode,
      linkDestination,
      pauseClearMinutes
    } = get()

    try {
      const result = await window.electronAPI.discord.configure({
        enabled,
        coverArtEnabled,
        smallIconEnabled,
        compactStatusMode,
        expandedInfoMode,
        linkDestination,
        pauseClearMinutes
      })
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
    smallIconEnabled: true,
    compactStatusMode: 'title',
    expandedInfoMode: 'file-info',
    linkDestination: 'ytmusic',
    pauseClearMinutes: DEFAULT_PAUSE_CLEAR_MINUTES,
    coverArtLookupActive: false,
    statusMessage: 'Discord Rich Presence is disabled.',

    setCoverArtLookupActive: (coverArtLookupActive: boolean) => {
      set({ coverArtLookupActive })
    },

    setEnabled: async (enabled: boolean) => {
      set({ enabled, coverArtLookupActive: enabled ? get().coverArtLookupActive : false })
      localStorage.setItem(DISCORD_RPC_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
      await applyDiscordConfig()
    },

    setCoverArtEnabled: async (coverArtEnabled: boolean) => {
      set({ coverArtEnabled, coverArtLookupActive: coverArtEnabled ? get().coverArtLookupActive : false })
      localStorage.setItem(DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY, coverArtEnabled ? '1' : '0')
      await applyDiscordConfig()
    },

    setSmallIconEnabled: async (smallIconEnabled: boolean) => {
      set({ smallIconEnabled })
      localStorage.setItem(DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY, smallIconEnabled ? '1' : '0')
      await applyDiscordConfig()
    },

    setCompactStatusMode: async (compactStatusMode: DiscordRpcCompactStatusMode) => {
      set({ compactStatusMode })
      localStorage.setItem(DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY, compactStatusMode)
      await applyDiscordConfig()
    },

    setExpandedInfoMode: async (expandedInfoMode: DiscordRpcExpandedInfoMode) => {
      set({ expandedInfoMode })
      localStorage.setItem(DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY, expandedInfoMode)
      await applyDiscordConfig()
    },

    setLinkDestination: async (linkDestination: DiscordRpcLinkDestination) => {
      set({ linkDestination })
      localStorage.setItem(DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY, linkDestination)
      await applyDiscordConfig()
    },

    setPauseClearMinutes: async (minutes: number) => {
      const pauseClearMinutes = normalizePauseClearMinutes(minutes)
      set({ pauseClearMinutes })
      localStorage.setItem(DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY, String(pauseClearMinutes))
      await applyDiscordConfig()
    },

    initFromSaved: async () => {
      clearLegacyClientId()
      const enabled = localStorage.getItem(DISCORD_RPC_ENABLED_STORAGE_KEY) === '1'
      const coverArtEnabled = localStorage.getItem(DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY) === '1'
      const smallIconEnabled = localStorage.getItem(DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY) !== '0'
      const compactStatusMode = normalizeCompactStatusMode(localStorage.getItem(DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY))
      const expandedInfoMode = normalizeExpandedInfoMode(localStorage.getItem(DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY))
      const linkDestination = normalizeLinkDestination(localStorage.getItem(DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY))
      const pauseClearMinutes = readSavedPauseClearMinutes()
      set({
        enabled,
        coverArtEnabled,
        smallIconEnabled,
        compactStatusMode,
        expandedInfoMode,
        linkDestination,
        pauseClearMinutes,
        coverArtLookupActive: false
      })
      await applyDiscordConfig()
    },

    resetToDefaults: async () => {
      set({
        enabled: false,
        coverArtEnabled: false,
        smallIconEnabled: true,
        compactStatusMode: 'title',
        expandedInfoMode: 'file-info',
        linkDestination: 'ytmusic',
        pauseClearMinutes: DEFAULT_PAUSE_CLEAR_MINUTES,
        coverArtLookupActive: false
      })
      localStorage.removeItem(DISCORD_RPC_ENABLED_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY)
      localStorage.removeItem(DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V1)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V2)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V3)
      localStorage.removeItem(COVER_ART_CACHE_STORAGE_KEY_V4)
      clearLegacyClientId()
      await applyDiscordConfig()
    },
  }
})
