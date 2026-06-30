import { useEffect } from 'react'
import type { InputActionId, InputBinding, RawBindingInput } from '../../types/inputBindings'
import {
  INPUT_ACTION_DEFINITIONS
} from '../constants/keyboardShortcuts'
import { dispatchInputCapture } from '../input/inputCapture'
import {
  getEffectiveBindingSlots,
  getGlobalInputBindingSlotKey,
  isGlobalInputBindingEnabled,
  useInputBindingStore
} from '../stores/inputBindingStore'
import { useUIStore } from '../stores/uiStore'
import { inputBindingsEqual, keyboardEventToRawInput, normalizeRawKeyboardBinding } from '../utils/inputBindings'
import { useInputActionDispatcher } from './useInputActionDispatcher'

const isShortcutBlockedTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable
}

interface ResolvedInputAction {
  actionId: InputActionId
  slotIndex: number
}

function resolveAction(binding: InputBinding): ResolvedInputAction | null {
  const overrides = useInputBindingStore.getState().overrides
  for (const definition of INPUT_ACTION_DEFINITIONS) {
    const slots = getEffectiveBindingSlots(definition.id, overrides)
    const slotIndex = slots.findIndex((candidate) => candidate !== null && inputBindingsEqual(candidate, binding))
    if (slotIndex >= 0) return { actionId: definition.id, slotIndex }
  }
  return null
}

export function useKeyboardShortcuts(): void {
  const executeAction = useInputActionDispatcher()
  const overrides = useInputBindingStore((state) => state.overrides)
  const globalEnabled = useInputBindingStore((state) => state.globalEnabled)
  const globalRegistrationSuspended = useInputBindingStore((state) => state.globalRegistrationSuspended)
  const setGlobalStatuses = useInputBindingStore((state) => state.setGlobalStatuses)

  useEffect(() => {
    let canceled = false
    const requests = globalRegistrationSuspended ? [] : INPUT_ACTION_DEFINITIONS.flatMap((definition) => {
      return getEffectiveBindingSlots(definition.id, overrides).flatMap((binding, slotIndex) => {
        if (
          binding?.device !== 'keyboard' ||
          !isGlobalInputBindingEnabled(definition.id, slotIndex, globalEnabled)
        ) {
          return []
        }
        return [{ actionId: definition.id, slotIndex: slotIndex as 0 | 1, binding }]
      })
    })

    void window.electronAPI.inputBindings.configureGlobal(requests).then((statuses) => {
      if (!canceled) setGlobalStatuses(statuses)
    }).catch(() => {
      if (canceled) return
      setGlobalStatuses(requests.map((request) => ({
        actionId: request.actionId,
        slotIndex: request.slotIndex,
        state: 'unavailable' as const,
        accelerator: null,
        message: 'Astra could not update this global shortcut.'
      })))
    })

    return () => {
      canceled = true
    }
  }, [globalEnabled, globalRegistrationSuspended, overrides, setGlobalStatuses])

  useEffect(() => {
    let lastMouseInput: { button: 'back' | 'forward'; source: 'dom' | 'ipc'; at: number } | null = null

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
      const resolved = resolveAction(binding)
      if (!resolved) return false
      const { actionId, slotIndex } = resolved
      if (input.device === 'keyboard' && isShortcutBlockedTarget(target) && actionId !== 'quick-launch-open') {
        return false
      }
      if (ui.isQuickLaunchOpen && actionId !== 'quick-launch-open' && actionId !== 'keybinds-open') return false

      const bindingState = useInputBindingStore.getState()
      const globalStatus = bindingState.globalStatuses[getGlobalInputBindingSlotKey(actionId, slotIndex)]
      if (input.device === 'keyboard' && globalStatus?.state === 'registered') return true

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
    const unsubscribeGlobalAction = window.electronAPI?.inputBindings?.onGlobalAction((actionId) => {
      executeAction(actionId)
    })

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('auxclick', preventSideButtonDefault, true)
      unsubscribe?.()
      unsubscribeGlobalAction?.()
    }
  }, [executeAction])
}
