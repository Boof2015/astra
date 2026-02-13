import { create } from 'zustand'

interface DiscordSettingsStore {
  enabled: boolean
  statusMessage: string
  setEnabled: (enabled: boolean) => Promise<void>
  initFromSaved: () => Promise<void>
  resetToDefaults: () => Promise<void>
}

const ENABLED_STORAGE_KEY = 'astra-discord-rpc-enabled'
const LEGACY_CLIENT_ID_STORAGE_KEY = 'astra-discord-rpc-client-id'
const DEFAULT_DISCORD_CLIENT_ID = (import.meta.env.VITE_DISCORD_CLIENT_ID ?? '').trim()

function resolveClientId(): string {
  const legacyClientId = (localStorage.getItem(LEGACY_CLIENT_ID_STORAGE_KEY) ?? '').trim()
  if (legacyClientId) return legacyClientId
  return DEFAULT_DISCORD_CLIENT_ID
}

export const useDiscordSettingsStore = create<DiscordSettingsStore>((set, get) => {
  const applyDiscordConfig = async () => {
    const { enabled } = get()
    const clientId = resolveClientId()

    if (enabled && !clientId) {
      window.electronAPI.discord.clearPresence()
      set({ statusMessage: 'Discord Rich Presence is not configured for this build.' })
      return
    }

    try {
      const result = await window.electronAPI.discord.configure({ enabled, clientId })
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
    statusMessage: 'Discord Rich Presence is disabled.',

    setEnabled: async (enabled: boolean) => {
      set({ enabled })
      localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0')
      await applyDiscordConfig()
    },

    initFromSaved: async () => {
      const enabled = localStorage.getItem(ENABLED_STORAGE_KEY) === '1'
      set({ enabled })
      await applyDiscordConfig()
    },

    resetToDefaults: async () => {
      set({ enabled: false })
      localStorage.removeItem(ENABLED_STORAGE_KEY)
      localStorage.removeItem(LEGACY_CLIENT_ID_STORAGE_KEY)
      await applyDiscordConfig()
    },
  }
})
