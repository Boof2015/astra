import { useCallback, useRef } from 'react'
import type { InputActionId } from '../../types/inputBindings'
import { SEEK_STEP_SECONDS, VOLUME_STEP } from '../constants/keyboardShortcuts'
import { usePlayerStore } from '../stores/playerStore'
import { getNextUIScalePercent, useUIStore } from '../stores/uiStore'
import { navigateInputBack, navigateInputForward } from '../utils/inputNavigation'
import { useJumpToNowPlaying } from './useJumpToNowPlaying'

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

const isVisibleShortcutInput = (input: HTMLInputElement): boolean => {
  if (input.disabled || input.readOnly || !input.isConnected) return false
  if (input.type !== 'text' && input.type !== 'search') return false
  const style = window.getComputedStyle(input)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  return input.offsetParent !== null || style.position === 'fixed'
}

const focusShortcutSearchInput = (): boolean => {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-shortcut-search="true"]')
  ).find(isVisibleShortcutInput)
  if (!input) return false
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  return true
}

export type InputActionDispatcher = (actionId: InputActionId) => void

export function useInputActionDispatcher(): InputActionDispatcher {
  const jumpToNowPlaying = useJumpToNowPlaying()
  const pendingSeekTimeRef = useRef<number | null>(null)

  return useCallback((actionId: InputActionId): void => {
    const player = usePlayerStore.getState()
    const ui = useUIStore.getState()

    const seekBy = (deltaSeconds: number): void => {
      const baseTime = pendingSeekTimeRef.current ?? player.currentTime
      const nextTime = clamp(baseTime + deltaSeconds, 0, player.duration)
      pendingSeekTimeRef.current = nextTime
      void player.seek(nextTime).finally(() => {
        if (pendingSeekTimeRef.current === nextTime) pendingSeekTimeRef.current = null
      })
    }

    switch (actionId) {
      case 'quick-launch-open':
        ui.toggleQuickLaunch()
        return
      case 'keybinds-open':
        ui.closeQuickLaunch()
        ui.setPendingSettingsSection('keybinds')
        ui.setActiveView('settings')
        return
      case 'ui-scale-increase':
        ui.setUIScalePercent(getNextUIScalePercent(ui.uiScalePercent, 'increase'))
        return
      case 'ui-scale-decrease':
        ui.setUIScalePercent(getNextUIScalePercent(ui.uiScalePercent, 'decrease'))
        return
      case 'ui-scale-reset':
        ui.resetUIScalePercent()
        return
      case 'playback-toggle':
        void player.togglePlay()
        return
      case 'seek-forward':
        seekBy(SEEK_STEP_SECONDS)
        return
      case 'seek-backward':
        seekBy(-SEEK_STEP_SECONDS)
        return
      case 'next-track':
        void player.playNext()
        return
      case 'previous-track':
        void player.playPrevious()
        return
      case 'volume-up':
        player.setVolume(clamp(player.volume + VOLUME_STEP, 0, 1))
        return
      case 'volume-down':
        player.setVolume(clamp(player.volume - VOLUME_STEP, 0, 1))
        return
      case 'jump-to-now-playing':
        void jumpToNowPlaying()
        return
      case 'mute':
        player.toggleMute()
        return
      case 'shuffle':
        player.toggleShuffle()
        return
      case 'repeat':
        player.toggleRepeat()
        return
      case 'focus-search-field':
        focusShortcutSearchInput()
        return
      case 'navigate-back':
        void navigateInputBack()
        return
      case 'navigate-forward':
        void navigateInputForward()
    }
  }, [jumpToNowPlaying])
}
