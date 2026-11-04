import { create } from 'zustand'
import type { PlexSource, PlexStatusSnapshot } from '../../types/plex'
import { useLibraryStore } from './libraryStore'
import { usePlaylistStore } from './playlistStore'

interface PlexSettingsStore {
  sources: PlexSource[]
  status: PlexStatusSnapshot | null
  error: string
  init(): Promise<void>
  refresh(): Promise<void>
}
let initialized = false
export const usePlexSettingsStore = create<PlexSettingsStore>((set, get) => ({
  sources: [], status: null, error: '',
  init: async () => {
    if (initialized) return
    initialized = true
    window.electronAPI.plex.onStatus(status => {
      const finished = get().status?.isSyncing && !status.isSyncing
      set({ status })
      if (finished) void get().refresh()
    })
    await get().refresh()
  },
  refresh: async () => {
    try {
      const [sources, status] = await Promise.all([window.electronAPI.plex.listSources(), window.electronAPI.plex.getStatus()])
      set({ sources, status, error: '' })
      await useLibraryStore.getState().loadLibrary()
      await usePlaylistStore.getState().loadPlaylists()
      const selected = usePlaylistStore.getState().selectedPlaylistId
      if (selected !== null) await usePlaylistStore.getState().selectPlaylist(selected)
    } catch (error) { set({ error: error instanceof Error ? error.message : 'Could not refresh Plex.' }) }
  }
}))
