import { useCallback } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { useUIStore } from '../stores/uiStore'

export function useOpenArtistInLibrary() {
  const selectArtist = useLibraryStore((s) => s.selectArtist)
  const setActiveView = useUIStore((s) => s.setActiveView)

  return useCallback(async (artistName: string) => {
    const artist = artistName.trim()
    if (!artist) return

    await selectArtist(artist, 'library')
    setActiveView('library')
  }, [selectArtist, setActiveView])
}
