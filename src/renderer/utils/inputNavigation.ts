import { useLibraryStore } from '../stores/libraryStore'
import { useUIStore } from '../stores/uiStore'
import { runViewTransition } from './viewTransitions'

export async function navigateInputBack(): Promise<boolean> {
  const ui = useUIStore.getState()
  if (ui.activeView === 'library') {
    const library = useLibraryStore.getState()
    if (library.selectedAlbum || library.selectedArtist || library.selectedGenre || library.selectedYear !== null) {
      const shouldAlsoReturnToPreviousView =
        library.selectionHistory.length === 0 && library.selectionOrigin === 'home'
      let handled = false
      await runViewTransition(async () => {
        handled = await useLibraryStore.getState().goBackSelection()
      }, 'library-context-backward')
      if (handled && shouldAlsoReturnToPreviousView) {
        useUIStore.getState().navigateViewBack()
      }
      return handled
    }
  }

  return useUIStore.getState().navigateViewBack()
}

export async function navigateInputForward(): Promise<boolean> {
  const ui = useUIStore.getState()
  const library = useLibraryStore.getState()

  if (ui.activeView === 'library' && library.selectionForwardHistory.length > 0) {
    let handled = false
    await runViewTransition(async () => {
      handled = await useLibraryStore.getState().goForwardSelection()
    }, 'library-context-forward')
    return handled
  }

  const nextView = ui.viewForwardHistory[ui.viewForwardHistory.length - 1]
  if (nextView === 'library' && library.selectionForwardHistory.length > 0) {
    await useLibraryStore.getState().goForwardSelection()
  }
  const movedView = ui.navigateViewForward()
  return movedView
}
