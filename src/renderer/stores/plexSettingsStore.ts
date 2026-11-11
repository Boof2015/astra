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
export const usePlexSettingsStore = create<PlexSettingsStore>((set, get) => {
  const fetchSources = async (): Promise<void> => {
    const [sources, status] = await Promise.all([window.electronAPI.plex.listSources(), window.electronAPI.plex.getStatus()])
    set({ sources, status, error: '' })
  }
  const failed = (error: unknown) => set({ error: error instanceof Error ? error.message : 'Could not refresh Plex.' })

  return {
    sources: [], status: null, error: '',
    init: async () => {
      if (initialized) return
      initialized = true
      window.electronAPI.plex.onStatus(status => {
        const finished = get().status?.isSyncing && !status.isSyncing
        set({ status })
        if (finished) void get().refresh()
      })
      // Only the server list. The app loads the library itself at startup, and nothing
      // about the servers has changed yet.
      try { await fetchSources() } catch (error) { failed(error) }
    },
    refresh: async () => {
      try {
        await fetchSources()
        await useLibraryStore.getState().loadLibrary()
        await usePlaylistStore.getState().loadPlaylists()
        const selected = usePlaylistStore.getState().selectedPlaylistId
        if (selected !== null) await usePlaylistStore.getState().selectPlaylist(selected)
      } catch (error) { failed(error) }
    }
  }
})
