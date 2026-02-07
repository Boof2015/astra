import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't intercept when modifier keys are held (e.g. Cmd+Space = Spotlight)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Don't intercept when typing in input fields
      const target = e.target as HTMLElement
      const tagName = target.tagName.toLowerCase()
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target.isContentEditable
      ) {
        return
      }

      if (e.code === 'Space') {
        e.preventDefault()
        // Remove focus from the button so it doesn't stay highlighted
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        usePlayerStore.getState().togglePlay()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
