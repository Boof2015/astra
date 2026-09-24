import React, { useEffect, useState } from 'react'
import { create } from 'zustand'

export const artistNames = ['-Alow', "'Twell", '(NAME TBA)', '(un)familiar.', '[unknown]', '*NSYNC', 'Björk', '⭐the sky⭐', '@Artist', '/Artist', 'Plain Artist']
export const tracks = artistNames.flatMap((artist, artistIndex) =>
  Array.from({ length: artistIndex === 0 ? 8 : 1 }, (_, index) => ({
    id: artistIndex * 10 + index,
    path: `fixture:${artistIndex}:${index}`,
    title: `Song ${artistIndex} ${index}`,
    artist, artist_names: [artist], album_artist: artist, album_artist_names: [artist],
    album: `Album ${artistIndex}`, album_identity_key: `album:${artistIndex}`,
    track_number: index + 1, disc_number: 1, year: 2001, genre: 'Pop', genres: ['Pop'],
    artwork_hash: null, duration: 120
  }))
)
export const commands = []
export let pageLoads = 0
let resolvePlaylist
const noop = () => {}
export const useUIStore = create((set) => ({
  isQuickLaunchOpen: false, failure: null,
  openQuickLaunch: () => set({ isQuickLaunchOpen: true }),
  closeQuickLaunch: () => set({ isQuickLaunchOpen: false }),
  setPendingLibrarySearchQuery: noop, setPendingSettingsSection: noop, setActiveView: noop
}))
export const useLibraryStore = create(() => ({
  albums: [],
  artists: artistNames.map((artist) => ({ artist, track_count: tracks.filter(track => track.artist === artist).length, artwork_hash: null })),
  artistBrowseMode: 'canonical', favoriteTrackPaths: [], recentlyPlayedPaths: [], trackCacheVersion: 0,
  resolveTrackPaths: () => [], selectedAlbum: null, selectedArtist: null, selectedGenre: null, selectedYear: null,
  setViewMode: noop, selectAlbum: noop, selectArtist: noop, clearSelection: noop, getArtwork: async () => null
}))
export const useGraphStore = create(() => ({ enabled: false, openFullMap: noop }))
export const useListeningStatsStore = create(() => ({ enabled: false }))
export const usePlaylistStore = create(() => ({
  playlists: [{ id: 1, name: 'Delayed playlist', track_count: 1 }], clearSelection: noop, selectPlaylist: noop
}))
export const usePlayerStore = create(() => ({
  enqueueTrackPaths: async (paths, position) => { commands.push({ action: position, paths }) },
  startPlaybackContextByPaths: async (paths, startIndex) => { commands.push({ action: 'play', paths, startIndex }) }
}))
export function useInputActionDispatcher() {
  const failure = useUIStore(state => state.failure)
  useEffect(() => {
    if (failure === 'effect') throw new Error('Injected Quick Search effect failure')
  }, [failure])
  if (failure === 'render') throw new Error('Injected Quick Search render failure')
  return noop
}

window.electronAPI = { library: {
  getTracksPage: async () => { pageLoads += 1; return { tracks: window.fixtureTracks, hasMore: false } },
  getFavorites: async () => [],
  getPlaylistTrackEntries: () => new Promise(resolve => { resolvePlaylist = resolve })
} }
window.fixtureTracks = tracks
window.fixture = {
  artistNames, tracks, commands, useUIStore, useLibraryStore,
  get pageLoads() { return pageLoads },
  resolvePlaylist: () => resolvePlaylist([{ id: 1, track: tracks[8] }]),
  refresh: (nextTracks) => {
    window.fixtureTracks = nextTracks
    useLibraryStore.setState(state => ({ trackCacheVersion: state.trackCacheVersion + 1 }))
  }
}

export function SurroundingApp({ children }) {
  const [clicks, setClicks] = useState(0)
  return <><button id="app-control" onClick={() => setClicks(value => value + 1)}>App clicks: {clicks}</button>{children}</>
}
