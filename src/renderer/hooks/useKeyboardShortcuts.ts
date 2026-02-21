import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'

const SEEK_STEP_SECONDS = 5
const VOLUME_STEP = 0.05

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

const isShortcutBlockedTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  )
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't intercept when modifier keys are held (e.g. Cmd+Space = Spotlight)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Don't intercept while interacting with form fields/editable content.
      if (isShortcutBlockedTarget(e.target)) {
        return
      }

      const player = usePlayerStore.getState()
      const key = e.key
      const normalizedKey = key.toLowerCase()

      if (e.shiftKey && key === 'ArrowRight') {
        e.preventDefault()
        if (e.repeat) return
        void player.playNext()
        return
      }

      if (e.shiftKey && key === 'ArrowLeft') {
        e.preventDefault()
        if (e.repeat) return
        void player.playPrevious()
        return
      }

      if (!e.shiftKey && key === 'ArrowRight') {
        e.preventDefault()
        if (e.repeat) return
        const nextTime = clamp(player.currentTime + SEEK_STEP_SECONDS, 0, player.duration)
        void player.seek(nextTime)
        return
      }

      if (!e.shiftKey && key === 'ArrowLeft') {
        e.preventDefault()
        if (e.repeat) return
        const nextTime = clamp(player.currentTime - SEEK_STEP_SECONDS, 0, player.duration)
        void player.seek(nextTime)
        return
      }

      if (key === 'ArrowUp') {
        e.preventDefault()
        const nextVolume = clamp(player.volume + VOLUME_STEP, 0, 1)
        player.setVolume(nextVolume)
        return
      }

      if (key === 'ArrowDown') {
        e.preventDefault()
        const nextVolume = clamp(player.volume - VOLUME_STEP, 0, 1)
        player.setVolume(nextVolume)
        return
      }

      if (e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return
        // Remove focus from the button so it doesn't stay highlighted
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        void player.togglePlay()
        return
      }

      if (normalizedKey === 'n') {
        e.preventDefault()
        if (e.repeat) return
        void player.playNext()
        return
      }

      if (normalizedKey === 'p') {
        e.preventDefault()
        if (e.repeat) return
        void player.playPrevious()
        return
      }

      if (normalizedKey === 'm') {
        e.preventDefault()
        if (e.repeat) return
        player.toggleMute()
        return
      }

      if (normalizedKey === 's') {
        e.preventDefault()
        if (e.repeat) return
        player.toggleShuffle()
        return
      }

      if (normalizedKey === 'r') {
        e.preventDefault()
        if (e.repeat) return
        player.toggleRepeat()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
