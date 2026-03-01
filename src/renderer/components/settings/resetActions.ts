import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useDiscordSettingsStore } from '../../stores/discordSettingsStore'
import { EQ_DEVICE_PROFILE_STORAGE_KEY, EQ_STORAGE_KEY, useEQStore } from '../../stores/eqStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useThemeStore } from '../../stores/themeStore'
import {
  OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
  useVisualizerSettingsStore
} from '../../stores/visualizerSettingsStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import { clearDiscordCoverArtLookupCache } from '../../hooks/useDiscordPresence'

export const RENDERER_SETTINGS_KEYS = [
  'astra-theme-settings-v1',
  'astra-audio-output-device',
  'astra-audio-calibration-input-device',
  'astra-audio-multichannel-enabled',
  'astra-audio-channel-routing-map',
  'astra-audio-normalization-enabled-v1',
  'astra-audio-normalization-target-lufs-v1',
  'astra-audio-delay-profiles-v1',
  'astra-audio-delay-profiles-v2',
  'astra-discord-rpc-enabled',
  'astra-discord-rpc-cover-art-enabled',
  'astra-discord-cover-art-cache-v1',
  'astra-discord-cover-art-cache-v2',
  'astra-discord-cover-art-cache-v3',
  'astra-discord-cover-art-cache-v4',
  OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
  'astra-updates-auto-check-enabled',
  'astra-library-tracklist-bpm-key-visible-v1',
  EQ_STORAGE_KEY,
  EQ_DEVICE_PROFILE_STORAGE_KEY,
] as const

function clearRendererSettingsKeys(): void {
  for (const key of RENDERER_SETTINGS_KEYS) {
    localStorage.removeItem(key)
  }
}

export async function resetThemeSettings(): Promise<string> {
  useThemeStore.getState().resetToDefault()
  return 'Theme reset to Default.'
}

export async function resetAudioSettings(): Promise<string> {
  await useAudioSettingsStore.getState().resetToDefaults()
  return 'Audio settings reset.'
}

export async function resetIntegrationSettings(): Promise<string> {
  await useDiscordSettingsStore.getState().resetToDefaults()
  const status = await useLocalApiSettingsStore.getState().resetToDefaults()
  if (!status) {
    throw new Error('Failed to reset local API settings.')
  }
  return 'Integrations reset (Discord and Local API).'
}

export async function resetDiscordCoverArtCache(): Promise<string> {
  clearDiscordCoverArtLookupCache()
  return 'Discord cover art lookup cache reset.'
}

export async function resetEqSettings(): Promise<string> {
  useEQStore.getState().resetToDefaults()
  return 'EQ presets and curve reset.'
}

export async function resetAllSettings(): Promise<string> {
  useThemeStore.getState().resetToDefault()
  await useAudioSettingsStore.getState().resetToDefaults()
  await useDiscordSettingsStore.getState().resetToDefaults()
  useEQStore.getState().resetToDefaults()
  useVisualizerSettingsStore.getState().resetToDefaults()
  clearRendererSettingsKeys()
  return 'All renderer settings reset.'
}

async function reloadLibraryAndPlaylists(): Promise<void> {
  const libraryStore = useLibraryStore.getState()
  await libraryStore.loadLibrary()
  await libraryStore.loadFolders()

  const playlistStore = usePlaylistStore.getState()
  await playlistStore.loadPlaylists()
  if (playlistStore.selectedPlaylistId != null) {
    await playlistStore.selectPlaylist(playlistStore.selectedPlaylistId)
  }
}

export async function resetMappedFolders(): Promise<string> {
  const result = await window.electronAPI.library.resetMappedFolders()
  if (!result.success) {
    throw new Error('Failed to reset mapped folders.')
  }

  await reloadLibraryAndPlaylists()
  return `Mapped folders reset (${result.clearedFolders} folders, ${result.clearedTracks} tracks removed).`
}

export async function factoryResetApplication(): Promise<void> {
  const result = await window.electronAPI.library.factoryReset()
  if (!result.success) {
    throw new Error('Failed to complete factory reset.')
  }

  await resetAllSettings()
  const playlistStore = usePlaylistStore.getState()
  playlistStore.clearSelection()
  await reloadLibraryAndPlaylists()
  window.location.reload()
}
