import { useEffect } from 'react'
import type { InputActionId, InputBinding, RawBindingInput } from '../../types/inputBindings'
import {
  INPUT_ACTION_DEFINITIONS,
  SEEK_STEP_SECONDS,
  VOLUME_STEP
} from '../constants/keyboardShortcuts'
import { dispatchInputCapture } from '../input/inputCapture'
import { useInputBindingStore, getEffectiveBindingSlots } from '../stores/inputBindingStore'
import { usePlayerStore } from '../stores/playerStore'
import { getNextUIScalePercent, useUIStore } from '../stores/uiStore'
import { inputBindingsEqual, keyboardEventToRawInput, normalizeRawKeyboardBinding } from '../utils/inputBindings'
import { navigateInputBack, navigateInputForward } from '../utils/inputNavigation'
import { useJumpToNowPlaying } from './useJumpToNowPlaying'

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

const isShortcutBlockedTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable
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

function resolveAction(binding: InputBinding): InputActionId | null {
  const overrides = useInputBindingStore.getState().overrides
  for (const definition of INPUT_ACTION_DEFINITIONS) {
    const matches = getEffectiveBindingSlots(definition.id, overrides)
      .some((candidate) => candidate !== null && inputBindingsEqual(candidate, binding))
    if (matches) return definition.id
  }
  return null
}

export function useKeyboardShortcuts(): void {
  const jumpToNowPlaying = useJumpToNowPlaying()

  useEffect(() => {
    let pendingShortcutSeekTime: number | null = null
    let lastMouseInput: { button: 'back' | 'forward'; source: 'dom' | 'ipc'; at: number } | null = null

    const seekByShortcut = (deltaSeconds: number): void => {
      const player = usePlayerStore.getState()
      const baseTime = pendingShortcutSeekTime ?? player.currentTime
      const nextTime = clamp(baseTime + deltaSeconds, 0, player.duration)
      pendingShortcutSeekTime = nextTime
      void player.seek(nextTime).finally(() => {
        if (pendingShortcutSeekTime === nextTime) pendingShortcutSeekTime = null
      })
    }

    const executeAction = (actionId: InputActionId): void => {
      const player = usePlayerStore.getState()
      const ui = useUIStore.getState()
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
          seekByShortcut(SEEK_STEP_SECONDS)
          return
        case 'seek-backward':
          seekByShortcut(-SEEK_STEP_SECONDS)
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
    }

    const handleRawInput = (
      input: RawBindingInput,
      source: 'dom' | 'ipc',
      target: EventTarget | null = document.activeElement
    ): boolean => {
      if (dispatchInputCapture(input)) return true

      if (input.device === 'mouse') {
        const now = performance.now()
        if (
          lastMouseInput &&
          lastMouseInput.button === input.button &&
          lastMouseInput.source !== source &&
          now - lastMouseInput.at < 120
        ) {
          lastMouseInput = { button: input.button, source, at: now }
          return true
        }
        lastMouseInput = { button: input.button, source, at: now }
      }

      const ui = useUIStore.getState()
      const platform = window.electronAPI?.platform ?? 'linux'
      const binding = input.device === 'mouse' ? input : normalizeRawKeyboardBinding(input, platform)
      if (!binding) return false
      const actionId = resolveAction(binding)
      if (!actionId) return false
      if (input.device === 'keyboard' && isShortcutBlockedTarget(target) && actionId !== 'quick-launch-open') {
        return false
      }
      if (ui.isQuickLaunchOpen && actionId !== 'quick-launch-open' && actionId !== 'keybinds-open') return false

      const definition = INPUT_ACTION_DEFINITIONS.find((candidate) => candidate.id === actionId)
      if (input.device === 'keyboard' && input.repeat && !definition?.allowRepeat) return true
      executeAction(actionId)
      return true
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (handleRawInput(keyboardEventToRawInput(event), 'dom', event.target)) event.preventDefault()
    }

    const handleMouseDown = (event: MouseEvent): void => {
      const button = event.button === 3 ? 'back' : event.button === 4 ? 'forward' : null
      if (!button) return
      if (handleRawInput({ device: 'mouse', button }, 'dom', event.target)) event.preventDefault()
    }

    const preventSideButtonDefault = (event: MouseEvent): void => {
      if (event.button === 3 || event.button === 4) event.preventDefault()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('auxclick', preventSideButtonDefault, true)
    const unsubscribe = window.electronAPI?.inputBindings?.onInput((input) => {
      handleRawInput(input, 'ipc')
    })

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('auxclick', preventSideButtonDefault, true)
      unsubscribe?.()
    }
  }, [jumpToNowPlaying])
}
