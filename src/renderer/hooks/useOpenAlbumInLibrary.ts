import { useCallback } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { useUIStore } from '../stores/uiStore'

function normalizeDisplay(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function resolveAlbumArtist(trackArtist: string, albumArtist?: string | null): string | undefined {
  const normalizedAlbumArtist = normalizeDisplay(albumArtist ?? '')
  if (normalizedAlbumArtist) return normalizedAlbumArtist

  const normalizedTrackArtist = normalizeDisplay(trackArtist)
  if (!normalizedTrackArtist) return undefined

  const unified = normalizedTrackArtist
    .replace(/\s*;\s*/g, ',')
    .replace(/\s+&\s+/g, ',')
    .replace(/\s+[x×]\s+/gi, ',')
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/gi, ',')

  const primaryArtist = unified
    .split(',')
    .map((part) => normalizeDisplay(part))
    .find((part) => part.length > 0)

  return primaryArtist || undefined
}

export function useOpenAlbumInLibrary() {
  const selectAlbum = useLibraryStore((s) => s.selectAlbum)
  const setActiveView = useUIStore((s) => s.setActiveView)

  return useCallback(async (
    albumName: string,
    trackArtist: string,
    albumArtist?: string | null,
    albumIdentityKey?: string
  ) => {
    const album = normalizeDisplay(albumName)
    if (!album) return

    const resolvedArtist = resolveAlbumArtist(trackArtist, albumArtist)
    const library = useLibraryStore.getState()
    const isNestedLibraryDetail = useUIStore.getState().activeView === 'library'
      && Boolean(library.selectedArtist || library.selectedGenre || library.selectedYear !== null)

    await selectAlbum(
      album,
      resolvedArtist,
      isNestedLibraryDetail ? 'library-detail' : 'library',
      albumIdentityKey
    )
    setActiveView('library')
  }, [selectAlbum, setActiveView])
}
