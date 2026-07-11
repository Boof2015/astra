import { useCallback } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlaylistStore } from '../stores/playlistStore'
import { usePlayerStore, type PlaybackSourceContext } from '../stores/playerStore'
import { useUIStore } from '../stores/uiStore'
import { isSystemFavoritesPlaylistId } from '../utils/playlistSystem'
import type { Track } from '../types/audio'

function afterNavigationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      globalThis.setTimeout(resolve, 0)
      return
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resolve()
      })
    })
  })
}

function normalizeDisplay(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function resolveAlbumArtist(track: Track): string | undefined {
  const albumArtist = normalizeDisplay(track.albumArtist)
  if (albumArtist) return albumArtist

  const trackArtist = normalizeDisplay(track.artistNames?.[0] ?? track.artist)
  return trackArtist || undefined
}

function resolvePrimaryArtist(track: Track): string | null {
  const trackArtist = normalizeDisplay(track.artistNames?.[0] ?? track.artist)
  if (trackArtist) return trackArtist

  const albumArtist = normalizeDisplay(track.albumArtistNames?.[0] ?? track.albumArtist)
  return albumArtist || null
}

function splitArtistFallback(value: string | null | undefined): string[] {
  const normalized = normalizeDisplay(value)
  if (!normalized) return []

  return normalized
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')
    .replace(/\s+[xX]\s+/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s*;\s*/g, ',')
    .split(',')
    .map(normalizeDisplay)
    .filter(Boolean)
}

function getArtistCandidates(track: Track): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []

  const addCandidate = (value: string | null | undefined) => {
    const normalized = normalizeDisplay(value)
    const key = normalized.toLocaleLowerCase()
    if (!normalized || seen.has(key)) return
    seen.add(key)
    candidates.push(normalized)
  }

  track.artistNames?.forEach(addCandidate)
  splitArtistFallback(track.artist).forEach(addCandidate)
  track.albumArtistNames?.forEach(addCandidate)
  addCandidate(track.albumArtist)

  return candidates
}

async function revealTrackInLibrary(trackPath: string): Promise<boolean> {
  const library = useLibraryStore.getState()
  library.setViewMode('tracks')
  await library.clearSelection()

  const ui = useUIStore.getState()
  if (ui.activeView !== 'library') {
    ui.setActiveView('library')
  }

  await afterNavigationFrame()
  ui.requestLibraryTrackReveal(trackPath)
  return true
}

async function revealTrackAlbum(track: Track): Promise<boolean> {
  const album = normalizeDisplay(track.album)
  if (!album) return revealTrackInLibrary(track.path)

  const library = useLibraryStore.getState()
  await library.selectAlbum(album, resolveAlbumArtist(track), 'library', track.albumIdentityKey)

  const ui = useUIStore.getState()
  if (ui.activeView !== 'library') {
    ui.setActiveView('library')
  }

  await afterNavigationFrame()
  ui.requestLibraryTrackReveal(track.path)
  return true
}

async function selectArtistAndReveal(artist: string, trackPath: string): Promise<boolean> {
  const library = useLibraryStore.getState()
  await library.selectArtist(artist, 'library')

  if (!useLibraryStore.getState().trackPaths.includes(trackPath)) {
    return false
  }

  const ui = useUIStore.getState()
  if (ui.activeView !== 'library') {
    ui.setActiveView('library')
  }

  await afterNavigationFrame()
  ui.requestLibraryTrackReveal(trackPath)
  return true
}

async function revealTrackArtist(track: Track): Promise<boolean> {
  const artists = getArtistCandidates(track)
  const primaryArtist = resolvePrimaryArtist(track)
  if (primaryArtist) {
    const primaryKey = primaryArtist.toLocaleLowerCase()
    artists.sort((left, right) => {
      if (left.toLocaleLowerCase() === primaryKey) return -1
      if (right.toLocaleLowerCase() === primaryKey) return 1
      return 0
    })
  }

  for (const artist of artists) {
    if (await selectArtistAndReveal(artist, track.path)) {
      return true
    }
  }

  return revealTrackInLibrary(track.path)
}

async function revealTrackArtistFromContext(artist: string, trackPath: string): Promise<boolean> {
  if (await selectArtistAndReveal(artist, trackPath)) {
    return true
  }
  return revealTrackInLibrary(trackPath)
}

async function revealTrackGenreFromContext(genre: string, trackPath: string): Promise<boolean> {
  const normalizedGenre = normalizeDisplay(genre)
  if (!normalizedGenre) return revealTrackInLibrary(trackPath)

  const library = useLibraryStore.getState()
  library.setViewMode('genres')
  await library.selectGenre(normalizedGenre, 'library')

  if (!useLibraryStore.getState().trackPaths.includes(trackPath)) {
    return revealTrackInLibrary(trackPath)
  }

  const ui = useUIStore.getState()
  if (ui.activeView !== 'library') {
    ui.setActiveView('library')
  }

  await afterNavigationFrame()
  ui.requestLibraryTrackReveal(trackPath)
  return true
}

async function revealTrackAlbumFromContext(
  context: Extract<PlaybackSourceContext, { type: 'album' }>,
  trackPath: string
): Promise<boolean> {
  const album = normalizeDisplay(context.album)
  if (!album) return revealTrackInLibrary(trackPath)

  const library = useLibraryStore.getState()
  await library.selectAlbum(album, context.albumArtist, 'library', context.identityKey)

  if (!useLibraryStore.getState().trackPaths.includes(trackPath)) {
    return revealTrackInLibrary(trackPath)
  }

  const ui = useUIStore.getState()
  if (ui.activeView !== 'library') {
    ui.setActiveView('library')
  }

  await afterNavigationFrame()
  ui.requestLibraryTrackReveal(trackPath)
  return true
}

async function revealTrackInSourcePlaylist(trackPath: string, playlistId: number): Promise<boolean> {
  const playlist = usePlaylistStore.getState()
  const isFavorites = isSystemFavoritesPlaylistId(playlistId)

  if (!isFavorites) {
    try {
      if (!playlist.playlists.some((candidate) => candidate.id === playlistId)) {
        await playlist.loadPlaylists()
      }
    } catch (error) {
      console.error('Failed to refresh playlists before jump to playing:', error)
    }

    if (!usePlaylistStore.getState().playlists.some((candidate) => candidate.id === playlistId)) {
      return revealTrackInLibrary(trackPath)
    }
  }

  try {
    await usePlaylistStore.getState().selectPlaylist(playlistId)
  } catch (error) {
    console.error('Failed to select source playlist before jump to playing:', error)
    return revealTrackInLibrary(trackPath)
  }

  const ui = useUIStore.getState()
  if (ui.activeView !== 'playlist') {
    ui.setActiveView('playlist')
  }

  await afterNavigationFrame()
  ui.requestPlaylistTrackReveal(playlistId, trackPath)
  return true
}

async function revealTrackInQueue(): Promise<boolean> {
  const ui = useUIStore.getState()
  if (!ui.showQueue) {
    ui.toggleQueue()
  }
  await afterNavigationFrame()
  ui.requestQueueNowPlayingReveal()
  return true
}

export function useJumpToNowPlaying(): () => Promise<boolean> {
  return useCallback(async () => {
    const player = usePlayerStore.getState()
    const track = player.currentTrack
    const trackPath = track?.path
    if (!trackPath) return false

    const ui = useUIStore.getState()
    if (ui.jumpToPlayingDestination === 'queue') {
      return revealTrackInQueue()
    }

    if (ui.jumpToPlayingDestination === 'album') {
      return revealTrackAlbum(track)
    }

    if (ui.jumpToPlayingDestination === 'artist') {
      return revealTrackArtist(track)
    }

    if (ui.jumpToPlayingDestination === 'smart-source') {
      const currentItem = player.currentQueueItemId
        ? player.queueItems.find((item) => item.queueId === player.currentQueueItemId)
        : null
      const sourceContext = currentItem?.origin === 'context' ? currentItem.sourceContext : null
      if (
        sourceContext?.type === 'playlist'
        && (sourceContext.playlistId > 0 || isSystemFavoritesPlaylistId(sourceContext.playlistId))
      ) {
        return revealTrackInSourcePlaylist(trackPath, sourceContext.playlistId)
      }
      if (sourceContext?.type === 'artist') {
        return revealTrackArtistFromContext(sourceContext.artist, trackPath)
      }
      if (sourceContext?.type === 'genre') {
        return revealTrackGenreFromContext(sourceContext.genre, trackPath)
      }
      if (sourceContext?.type === 'album') {
        return revealTrackAlbumFromContext(sourceContext, trackPath)
      }
    }

    return revealTrackInLibrary(trackPath)
  }, [])
}
