import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useDiscordSettingsStore } from '../../stores/discordSettingsStore'
import { EQ_DEVICE_PROFILE_STORAGE_KEY, EQ_STORAGE_KEY, useEQStore } from '../../stores/eqStore'
import { ARTIST_BROWSE_MODE_STORAGE_KEY, useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { useThemeStore } from '../../stores/themeStore'
import {
  ANALYZER_PROFILES_STORAGE_KEY,
  OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
  SPECTRUM_HEATMAP_STORAGE_KEY,
  VECTORSCOPE_MULTIBAND_STORAGE_KEY,
  WAVEFORM_MULTIBAND_STORAGE_KEY,
  useVisualizerSettingsStore
} from '../../stores/visualizerSettingsStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import { useLastFmSettingsStore } from '../../stores/lastFmSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import {
  LYRICS_DISPLAY_SETTINGS_STORAGE_KEY,
  useLyricsDisplaySettingsStore
} from '../../stores/lyricsDisplaySettingsStore'
import { clearDiscordCoverArtLookupCache } from '../../hooks/useDiscordPresence'
import { PLAYER_VOLUME_STORAGE_KEY, usePlayerStore } from '../../stores/playerStore'
import {
  ALBUM_SORT_MODE_STORAGE_KEY,
  ARTIST_ROOT_VIEW_MODE_STORAGE_KEY,
  ASTRA_SESSION_STATE_STORAGE_KEY,
  INCLUDE_COLLAB_ARTISTS_STORAGE_KEY,
  INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY,
  TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
  TRACKLIST_GENRE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY,
  LISTENING_STATS_ENABLED_STORAGE_KEY,
  TRANSPORT_INFO_LINE_MODE_STORAGE_KEY,
} from '../../constants/settingsStorageKeys'
import {
  ANALYZER_HEIGHT_STORAGE_KEY,
  ANALYZER_RACK_VISIBILITY_STORAGE_KEY,
  ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY,
  HOME_GREETING_TEXT_MODE_STORAGE_KEY,
  JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
  UI_SCALE_STORAGE_KEY,
  useUIStore
} from '../../stores/uiStore'
import {
  GLOBAL_INPUT_BINDINGS_STORAGE_KEY,
  INPUT_BINDINGS_STORAGE_KEY,
  useInputBindingStore
} from '../../stores/inputBindingStore'
import { clearPersistedSessionStateForReset } from '../../utils/sessionAutosave'

export const RENDERER_SETTINGS_KEYS = [
  'astra-theme-settings-v1',
  'astra-audio-output-device',
  'astra-native-audio-output-device',
  'astra-playback-output-mode-v1',
  'astra-audio-calibration-input-device',
  'astra-audio-multichannel-enabled',
  'astra-audio-channel-routing-map',
  'astra-audio-spatial-mode-v1',
  'astra-audio-spatial-layout-v1',
  'astra-audio-normalization-enabled-v1',
  'astra-audio-normalization-target-lufs-v1',
  'astra-audio-delay-profiles-v1',
  'astra-audio-delay-profiles-v2',
  PLAYER_VOLUME_STORAGE_KEY,
  ASTRA_SESSION_STATE_STORAGE_KEY,
  'astra-discord-rpc-enabled',
  'astra-discord-rpc-cover-art-enabled',
  'astra-discord-rpc-small-icon-enabled',
  'astra-discord-rpc-compact-status-mode-v1',
  'astra-discord-rpc-expanded-info-mode-v1',
  'astra-discord-rpc-link-destination-v1',
  'astra-discord-rpc-pause-clear-minutes-v1',
  'astra-discord-cover-art-cache-v1',
  'astra-discord-cover-art-cache-v2',
  'astra-discord-cover-art-cache-v3',
  'astra-discord-cover-art-cache-v4',
  ANALYZER_PROFILES_STORAGE_KEY,
  OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
  VECTORSCOPE_MULTIBAND_STORAGE_KEY,
  WAVEFORM_MULTIBAND_STORAGE_KEY,
  SPECTRUM_HEATMAP_STORAGE_KEY,
  ANALYZER_HEIGHT_STORAGE_KEY,
  ANALYZER_RACK_VISIBILITY_STORAGE_KEY,
  ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY,
  UI_SCALE_STORAGE_KEY,
  HOME_GREETING_TEXT_MODE_STORAGE_KEY,
  JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
  TRANSPORT_INFO_LINE_MODE_STORAGE_KEY,
  INPUT_BINDINGS_STORAGE_KEY,
  GLOBAL_INPUT_BINDINGS_STORAGE_KEY,
  'astra-updates-auto-check-enabled',
  LYRICS_DISPLAY_SETTINGS_STORAGE_KEY,
  ARTIST_BROWSE_MODE_STORAGE_KEY,
  TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
  TRACKLIST_GENRE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY,
  LISTENING_STATS_ENABLED_STORAGE_KEY,
  ALBUM_SORT_MODE_STORAGE_KEY,
  INCLUDE_SINGLES_IN_ALBUMS_STORAGE_KEY,
  INCLUDE_COLLAB_ARTISTS_STORAGE_KEY,
  ARTIST_ROOT_VIEW_MODE_STORAGE_KEY,
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
  usePlayerStore.getState().resetAudioPreferences()
  return 'Audio settings reset.'
}

export async function resetIntegrationSettings(): Promise<string> {
  await useDiscordSettingsStore.getState().resetToDefaults()
  const lastFmStatus = await useLastFmSettingsStore.getState().resetToDefaults()
  if (!lastFmStatus) {
    throw new Error('Failed to reset scrobbling settings.')
  }
  const lyricsStatus = await useLyricsStore.getState().resetToDefaults()
  if (!lyricsStatus) {
    throw new Error('Failed to reset lyrics settings.')
  }
  useLyricsDisplaySettingsStore.getState().resetToDefaults()
  const status = await useLocalApiSettingsStore.getState().resetToDefaults()
  if (!status) {
    throw new Error('Failed to reset local API settings.')
  }
  const phoneRemoteStatus = await usePhoneRemoteSettingsStore.getState().resetToDefaults()
  if (!phoneRemoteStatus) {
    throw new Error('Failed to reset phone remote settings.')
  }
  return 'Integrations reset (Discord, Scrobbling, Lyrics, Local API, and Phone Remote).'
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
  usePlayerStore.getState().resetAudioPreferences()
  await useDiscordSettingsStore.getState().resetToDefaults()
  useLyricsDisplaySettingsStore.getState().resetToDefaults()
  useEQStore.getState().resetToDefaults()
  clearRendererSettingsKeys()
  useVisualizerSettingsStore.getState().resetToDefaults()
  useUIStore.getState().resetAnalyzerRackPreferences()
  useUIStore.getState().resetUIScalePercent()
  useUIStore.getState().resetHomeGreetingTextMode()
  useUIStore.getState().setActivityIndicatorExperimentEnabled(false)
  useUIStore.getState().resetJumpToPlayingDestination()
  useUIStore.getState().resetTransportInfoLineMode()
  useLibraryStore.getState().setShowTracklistPlayCount(false)
  useListeningStatsStore.getState().setEnabled(false)
  useInputBindingStore.getState().resetAll()
  clearPersistedSessionStateForReset()
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

  const listeningStatus = await window.electronAPI.library.getListeningHistoryStatus()
  usePlayerStore.getState().resetListeningHistoryTracking(listeningStatus)
  await reloadLibraryAndPlaylists()
  return `Mapped folders reset (${result.clearedFolders} folders, ${result.clearedTracks} tracks removed).`
}

export async function resetTrackRatings(): Promise<string> {
  const result = await window.electronAPI.library.resetTrackRatings()
  if (!result.success) {
    throw new Error('Failed to reset track ratings.')
  }

  await useRatingsStore.getState().loadRatings()
  return result.cleared === 1
    ? '1 rating removed.'
    : `${result.cleared} ratings removed.`
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
