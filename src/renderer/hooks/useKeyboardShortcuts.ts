import { useEffect } from 'react'
import { SEEK_STEP_SECONDS, VOLUME_STEP } from '../constants/keyboardShortcuts'
import { usePlayerStore } from '../stores/playerStore'
import { getNextUIScalePercent, useUIStore } from '../stores/uiStore'
import { useJumpToNowPlaying } from './useJumpToNowPlaying'

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

const isVisibleShortcutInput = (input: HTMLInputElement): boolean => {
  if (input.disabled || input.readOnly) return false
  if (!input.isConnected) return false
  if (input.type !== 'text' && input.type !== 'search') return false

  const style = window.getComputedStyle(input)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (input.offsetParent === null && style.position !== 'fixed') return false

  return true
}

const focusShortcutSearchInput = (): boolean => {
  const candidateInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-shortcut-search="true"]')
  )
  const shortcutSearchInput = candidateInputs.find(isVisibleShortcutInput)
  if (!shortcutSearchInput) return false

  shortcutSearchInput.focus()
  const caretPosition = shortcutSearchInput.value.length
  shortcutSearchInput.setSelectionRange(caretPosition, caretPosition)
  return true
}

export function useKeyboardShortcuts(): void {
  const jumpToNowPlaying = useJumpToNowPlaying()

  useEffect(() => {
    const unsubscribe = window.electronAPI?.uiScale?.onShortcut((action) => {
      const ui = useUIStore.getState()
      if (action === 'reset') {
        ui.resetUIScalePercent()
        return
      }

      ui.setUIScalePercent(getNextUIScalePercent(ui.uiScalePercent, action))
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key
      const normalizedKey = key.toLowerCase()
      const ui = useUIStore.getState()
      const isTextInputTarget = isShortcutBlockedTarget(e.target)
      const isShortcutHelpOpen =
        (!e.metaKey && !e.ctrlKey && !e.altKey && key === '?') ||
        ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === '/')

      if (isShortcutHelpOpen && !isTextInputTarget) {
        e.preventDefault()
        if (e.repeat) return
        ui.openKeyboardShortcuts()
        return
      }

      if (ui.isKeyboardShortcutsOpen) {
        if (key === 'Escape') {
          e.preventDefault()
          if (e.repeat) return
          ui.closeKeyboardShortcuts()
        }
        return
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && normalizedKey === 'k') {
        e.preventDefault()
        if (e.repeat) return
        ui.toggleQuickLaunch()
        return
      }

      if (ui.isQuickLaunchOpen) return

      // Don't intercept when modifier keys are held (e.g. Cmd+Space = Spotlight)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Don't intercept while interacting with form fields/editable content.
      if (isTextInputTarget) {
        return
      }

      const player = usePlayerStore.getState()

      if (key === '/') {
        if (focusShortcutSearchInput()) {
          e.preventDefault()
        }
        return
      }

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

      if (!e.shiftKey && normalizedKey === 'j') {
        e.preventDefault()
        if (e.repeat) return
        jumpToNowPlaying()
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
  }, [jumpToNowPlaying])
}
