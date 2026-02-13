import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'

const isTextEntryTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't intercept when modifier keys are held (e.g. Cmd+Space = Spotlight)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Don't intercept while typing in text-entry fields.
      if (isTextEntryTarget(e.target)) {
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
