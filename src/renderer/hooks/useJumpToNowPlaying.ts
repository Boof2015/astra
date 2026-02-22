import { useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useUIStore } from '../stores/uiStore'

export function useJumpToNowPlaying(): () => boolean {
  return useCallback(() => {
    const trackPath = usePlayerStore.getState().currentTrack?.path
    if (!trackPath) return false

    const ui = useUIStore.getState()
    if (ui.activeView !== 'library') {
      ui.setActiveView('library')
    }

    ui.requestLibraryTrackReveal(trackPath)
    return true
  }, [])
}
