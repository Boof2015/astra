import { useLibraryStore } from '../stores/libraryStore'
import type { CollectionQueueTarget } from '../stores/uiStore'
import { isSystemFavoritesPlaylistId } from './playlistSystem'

export async function resolveCollectionTrackPaths(target: CollectionQueueTarget): Promise<string[]> {
  if (target.kind === 'album') {
    const tracks = await window.electronAPI.library.getTracksByAlbum(
      target.album,
      target.artist,
      target.identityKey
    )
    return tracks.map((track) => track.path)
  }

  if (isSystemFavoritesPlaylistId(target.playlistId)) {
    return [...useLibraryStore.getState().favoriteTrackPaths]
  }

  const entries = await window.electronAPI.library.getPlaylistTrackEntries(target.playlistId)
  return entries
    .filter((entry) => !entry.missing && entry.track !== null)
    .map((entry) => entry.track_path)
}
