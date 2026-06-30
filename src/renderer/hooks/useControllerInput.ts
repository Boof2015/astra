import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerDirection, ControllerFamily, ControllerFrame } from '../types/controller'
import {
  STANDARD_GAMEPAD_BUTTON,
  detectControllerFamily,
  gamepadToControllerFrame,
  getControllerButtonEdgeCommands,
  getControllerDirections,
  getControllerScrollDelta,
  hasMeaningfulControllerInput,
  isControllerButtonPressed,
  isStandardController,
  resolveControllerRepeat,
  selectActiveControllerFrame,
  wasControllerButtonPressed
} from '../utils/controllerGamepad'
import {
  activateControllerTarget,
  closeTopControllerOverlay,
  controllerTargetSupportsContext,
  focusControllerRegion,
  focusInitialControllerTarget,
  isNowPlayingContext,
  moveControllerFocus,
  openControllerContextMenu,
  scrollActiveControllerRegion,
  switchControllerSection
} from '../utils/controllerFocus'
import { navigateInputBack } from '../utils/inputNavigation'
import { useUIStore } from '../stores/uiStore'
import { useInputActionDispatcher } from './useInputActionDispatcher'

type ControllerContext = 'browsing' | 'now-playing'

interface ControllerInputState {
  active: boolean
  family: ControllerFamily
  canOpenContext: boolean
  context: ControllerContext
}

interface RepeatState {
  nextRepeatAt: number | null
}

const directionRepeatKey = (direction: ControllerDirection): string => `direction:${direction}`

function getStandardControllerFrames(): ControllerFrame[] {
  if (typeof navigator.getGamepads !== 'function') return []
  try {
    return Array.from(navigator.getGamepads())
      .filter((gamepad): gamepad is Gamepad => gamepad !== null)
      .map(gamepadToControllerFrame)
      .filter(isStandardController)
  } catch {
    return []
  }
}

export function useControllerInput(): ControllerInputState {
  const controllerSupportEnabled = useUIStore((state) => state.controllerSupportEnabled)
  const executeAction = useInputActionDispatcher()
  const [state, setState] = useState<ControllerInputState>({
    active: false,
    family: 'xbox',
    canOpenContext: false,
    context: 'browsing'
  })
  const activeControllerIndexRef = useRef<number | null>(null)
  const previousFramesRef = useRef(new Map<number, ControllerFrame>())
  const repeatStatesRef = useRef(new Map<string, RepeatState>())
  const activeRef = useRef(false)
  const familyRef = useRef<ControllerFamily>('xbox')
  // Read the dispatcher through a ref so the polling effect never re-subscribes when its identity
  // changes. Re-running that effect would fire its cleanup, which clears data-input-modality while
  // a controller is still active.
  const executeActionRef = useRef(executeAction)
  executeActionRef.current = executeAction

  const updateContextState = useCallback(() => {
    const canOpenContext = controllerTargetSupportsContext()
    const context: ControllerContext = isNowPlayingContext() ? 'now-playing' : 'browsing'
    setState((current) => (current.canOpenContext === canOpenContext && current.context === context)
      ? current
      : { ...current, canOpenContext, context })
  }, [])

  const setControllerMode = useCallback((active: boolean, family?: ControllerFamily) => {
    activeRef.current = active
    if (family) familyRef.current = family
    if (active) {
      document.documentElement.dataset.inputModality = 'controller'
      if (!document.activeElement || document.activeElement === document.body) {
        focusInitialControllerTarget()
      }
    } else if (document.documentElement.dataset.inputModality === 'controller') {
      delete document.documentElement.dataset.inputModality
    }
    setState((current) => ({
      active,
      family: family ?? current.family,
      canOpenContext: active ? controllerTargetSupportsContext() : false,
      context: active && isNowPlayingContext() ? 'now-playing' : 'browsing'
    }))
  }, [])

  useEffect(() => {
    if (!controllerSupportEnabled) {
      // Experimental feature is off: make sure we are not holding controller mode and skip polling.
      if (activeRef.current) setControllerMode(false)
      return
    }

    let animationFrame = 0

    const emitRepeat = (
      key: string,
      active: boolean,
      wasActive: boolean,
      now: number,
      emit: () => void
    ): void => {
      const previousState = repeatStatesRef.current.get(key)
      const resolution = resolveControllerRepeat(
        active,
        wasActive,
        previousState?.nextRepeatAt ?? null,
        now
      )
      if (resolution.nextRepeatAt === null) repeatStatesRef.current.delete(key)
      else repeatStatesRef.current.set(key, { nextRepeatAt: resolution.nextRepeatAt })
      if (resolution.emit) emit()
    }

    const poll = (now: number): void => {
      const frames = getStandardControllerFrames()
      const nextFrames = new Map(frames.map((frame) => [frame.index, frame]))

      if (!document.hasFocus() || document.visibilityState === 'hidden') {
        previousFramesRef.current = nextFrames
        repeatStatesRef.current.clear()
        animationFrame = window.requestAnimationFrame(poll)
        return
      }

      const frame = selectActiveControllerFrame(
        frames,
        previousFramesRef.current,
        activeControllerIndexRef.current
      )
      if (frame && hasMeaningfulControllerInput(frame)) activeControllerIndexRef.current = frame.index

      if (frame) {
        const previous = previousFramesRef.current.get(frame.index)
        const family = detectControllerFamily(frame.id)
        let emittedInput = false
        const markInput = (): void => {
          emittedInput = true
          if (!activeRef.current || familyRef.current !== family) setControllerMode(true, family)
        }

        const directions = getControllerDirections(frame)
        const previousDirections = previous ? getControllerDirections(previous) : new Set<ControllerDirection>()
        for (const direction of ['up', 'down', 'left', 'right'] as const) {
          emitRepeat(
            directionRepeatKey(direction),
            directions.has(direction),
            previousDirections.has(direction),
            now,
            () => {
              markInput()
              moveControllerFocus(direction)
              updateContextState()
            }
          )
        }

        const executeButtonCommand = (command: ReturnType<typeof getControllerButtonEdgeCommands>[number]): void => {
          markInput()
          switch (command.type) {
            case 'activate':
              activateControllerTarget()
              break
            case 'back':
              if (!closeTopControllerOverlay()) void navigateInputBack()
              break
            case 'context':
              openControllerContextMenu()
              break
            case 'toggle-queue':
              useUIStore.getState().toggleQueue()
              break
            case 'playback-toggle':
              executeActionRef.current('playback-toggle')
              break
            case 'bumper-left':
              if (isNowPlayingContext()) executeActionRef.current('previous-track')
              else switchControllerSection('previous')
              break
            case 'bumper-right':
              if (isNowPlayingContext()) executeActionRef.current('next-track')
              else switchControllerSection('next')
              break
            case 'jump-sidebar':
              focusControllerRegion('sidebar')
              break
            case 'jump-transport':
              focusControllerRegion('transport')
              break
            default:
              break
          }
          updateContextState()
        }
        getControllerButtonEdgeCommands(previous, frame).forEach(executeButtonCommand)

        const repeatButton = (buttonIndex: number, key: string, callback: () => void): void => {
          emitRepeat(
            key,
            isControllerButtonPressed(frame, buttonIndex),
            wasControllerButtonPressed(previous, buttonIndex),
            now,
            () => {
              markInput()
              callback()
            }
          )
        }
        repeatButton(STANDARD_GAMEPAD_BUTTON.leftTrigger, 'seek-backward', () => executeActionRef.current('seek-backward'))
        repeatButton(STANDARD_GAMEPAD_BUTTON.rightTrigger, 'seek-forward', () => executeActionRef.current('seek-forward'))

        const scrollDelta = getControllerScrollDelta(frame)
        if (scrollDelta !== 0) {
          markInput()
          scrollActiveControllerRegion(scrollDelta)
        }

        if (!emittedInput && activeRef.current && frames.length === 0) setControllerMode(false)
      } else if (activeRef.current && frames.length === 0) {
        setControllerMode(false)
        activeControllerIndexRef.current = null
      }

      previousFramesRef.current = nextFrames
      animationFrame = window.requestAnimationFrame(poll)
    }

    const exitControllerMode = (): void => {
      if (activeRef.current) setControllerMode(false)
    }
    const handleFocusIn = (): void => {
      if (activeRef.current) updateContextState()
    }
    const handleGamepadDisconnected = (event: GamepadEvent): void => {
      previousFramesRef.current.delete(event.gamepad.index)
      if (activeControllerIndexRef.current === event.gamepad.index) {
        activeControllerIndexRef.current = null
      }
    }

    document.addEventListener('keydown', exitControllerMode, true)
    document.addEventListener('pointerdown', exitControllerMode, true)
    document.addEventListener('focusin', handleFocusIn, true)
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected)
    animationFrame = window.requestAnimationFrame(poll)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('keydown', exitControllerMode, true)
      document.removeEventListener('pointerdown', exitControllerMode, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected)
      delete document.documentElement.dataset.inputModality
    }
  }, [controllerSupportEnabled, setControllerMode, updateContextState])

  return state
}
