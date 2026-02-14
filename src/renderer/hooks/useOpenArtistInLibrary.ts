import { useCallback } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { useUIStore } from '../stores/uiStore'

export function useOpenArtistInLibrary() {
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const selectArtist = useLibraryStore((s) => s.selectArtist)
  const setActiveView = useUIStore((s) => s.setActiveView)

  return useCallback(async (artistName: string) => {
    const artist = artistName.trim()
    if (!artist) return

    setViewMode('tracks')
    await selectArtist(artist, 'library')
    setActiveView('library')
  }, [selectArtist, setActiveView, setViewMode])
}
