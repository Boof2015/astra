import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerDirection, ControllerFamily, ControllerFrame } from '../types/controller'
import {
  STANDARD_GAMEPAD_BUTTON,
  detectControllerFamily,
  gamepadToControllerFrame,
  getControllerButtonEdgeCommands,
  getControllerDirections,
  getControllerRadialVector,
  getControllerScrollDelta,
  getControllerTabDirections,
  hasMeaningfulControllerInput,
  isControllerButtonPressed,
  isControllerButtonPressEdge,
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
import {
  CLOSED_CONTROLLER_RADIAL_MENU,
  clampControllerRadialIndex,
  createControllerRadialRoot,
  getControllerRadialView,
  resolveControllerRadialActivation,
  resolveControllerRadialBack,
  selectControllerRadialIndexFromVector,
  type ControllerRadialAction,
  type ControllerRadialMenuState,
  type ControllerRadialVector
} from '../utils/controllerRadial'
import { navigateInputBack } from '../utils/inputNavigation'
import { useUIStore } from '../stores/uiStore'
import { useInputActionDispatcher } from './useInputActionDispatcher'

type ControllerContext = 'browsing' | 'now-playing'

interface ControllerInputState {
  active: boolean
  family: ControllerFamily
  canOpenContext: boolean
  context: ControllerContext
  radialMenu: ControllerRadialMenuState
}

interface RepeatState {
  nextRepeatAt: number | null
}

const directionRepeatKey = (direction: ControllerDirection): string => `direction:${direction}`
const tabRepeatKey = (direction: 'previous' | 'next'): string => `tab:${direction}`

function controllerRadialVectorsEqual(
  left: ControllerRadialVector | null,
  right: ControllerRadialVector | null
): boolean {
  if (!left || !right) return left === right
  return Math.abs(left.x - right.x) < 0.01 && Math.abs(left.y - right.y) < 0.01
}

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
    context: 'browsing',
    radialMenu: CLOSED_CONTROLLER_RADIAL_MENU
  })
  const activeControllerIndexRef = useRef<number | null>(null)
  const previousFramesRef = useRef(new Map<number, ControllerFrame>())
  const repeatStatesRef = useRef(new Map<string, RepeatState>())
  const activeRef = useRef(false)
  const familyRef = useRef<ControllerFamily>('xbox')
  const radialMenuRef = useRef<ControllerRadialMenuState>(CLOSED_CONTROLLER_RADIAL_MENU)
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

  const setRadialMenuState = useCallback((radialMenu: ControllerRadialMenuState) => {
    const normalizedRadialMenu = {
      open: radialMenu.open,
      path: [...radialMenu.path],
      selectedIndex: radialMenu.selectedIndex,
      aimVector: radialMenu.aimVector ? { ...radialMenu.aimVector } : null
    }
    radialMenuRef.current = normalizedRadialMenu
    setState((current) => ({ ...current, radialMenu: normalizedRadialMenu }))
  }, [])

  const setControllerMode = useCallback((active: boolean, family?: ControllerFamily) => {
    activeRef.current = active
    if (family) familyRef.current = family
    if (!active) radialMenuRef.current = CLOSED_CONTROLLER_RADIAL_MENU
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
      context: active && isNowPlayingContext() ? 'now-playing' : 'browsing',
      radialMenu: active ? current.radialMenu : CLOSED_CONTROLLER_RADIAL_MENU
    }))
  }, [])

  const createRadialRoot = useCallback(() => {
    return createControllerRadialRoot({
      canOpenContext: controllerTargetSupportsContext(),
      showQueue: useUIStore.getState().showQueue
    })
  }, [])

  const openControllerRadialMenu = useCallback(() => {
    setRadialMenuState({ open: true, path: [], selectedIndex: 0, aimVector: null })
  }, [setRadialMenuState])

  const closeControllerRadialMenu = useCallback(() => {
    setRadialMenuState(CLOSED_CONTROLLER_RADIAL_MENU)
  }, [setRadialMenuState])

  const executeControllerRadialAction = useCallback((action: ControllerRadialAction): void => {
    switch (action) {
      case 'more':
        openControllerContextMenu()
        return
      case 'previous-tab':
        switchControllerSection('previous')
        return
      case 'next-tab':
        switchControllerSection('next')
        return
      case 'sidebar':
        focusControllerRegion('sidebar')
        return
      case 'now-playing':
        focusControllerRegion('transport')
        return
      case 'toggle-queue':
        useUIStore.getState().toggleQueue()
        return
      default:
        executeActionRef.current(action)
    }
  }, [])

  useEffect(() => {
    if (!controllerSupportEnabled) {
      // Experimental feature is off: make sure we are not holding controller mode and skip polling.
      if (activeRef.current) setControllerMode(false)
      if (radialMenuRef.current.open) closeControllerRadialMenu()
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

        if (radialMenuRef.current.open) {
          const radialVector = getControllerRadialVector(frame)
          if (!controllerRadialVectorsEqual(radialVector, radialMenuRef.current.aimVector)) {
            setRadialMenuState({
              ...radialMenuRef.current,
              aimVector: radialVector
            })
          }
          if (radialVector) {
            const root = createRadialRoot()
            const view = getControllerRadialView(root, radialMenuRef.current.path)
            const selectedIndex = selectControllerRadialIndexFromVector(view.items.length, radialVector)
            if (selectedIndex !== null && selectedIndex !== radialMenuRef.current.selectedIndex) {
              markInput()
              setRadialMenuState({
                ...radialMenuRef.current,
                selectedIndex,
                aimVector: radialVector
              })
            }
          }

          if (isControllerButtonPressEdge(previous, frame, STANDARD_GAMEPAD_BUTTON.south)) {
            markInput()
            const root = createRadialRoot()
            const view = getControllerRadialView(root, radialMenuRef.current.path)
            const activation = resolveControllerRadialActivation(
              root,
              view.path,
              clampControllerRadialIndex(radialMenuRef.current.selectedIndex, view.items.length)
            )
            switch (activation.type) {
              case 'enter':
                setRadialMenuState({ open: true, path: activation.path, selectedIndex: 0, aimVector: radialMenuRef.current.aimVector })
                break
              case 'execute':
                executeControllerRadialAction(activation.action)
                if (!activation.keepOpen) closeControllerRadialMenu()
                break
              case 'noop':
                break
            }
            updateContextState()
          }

          if (isControllerButtonPressEdge(previous, frame, STANDARD_GAMEPAD_BUTTON.east)) {
            markInput()
            const next = resolveControllerRadialBack(radialMenuRef.current.path)
            if (next.type === 'parent') setRadialMenuState({ open: true, path: next.path, selectedIndex: 0, aimVector: radialMenuRef.current.aimVector })
            else closeControllerRadialMenu()
            updateContextState()
          }

          if (isControllerButtonPressEdge(previous, frame, STANDARD_GAMEPAD_BUTTON.menu)) {
            markInput()
            closeControllerRadialMenu()
            updateContextState()
          }

          previousFramesRef.current = nextFrames
          animationFrame = window.requestAnimationFrame(poll)
          return
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

        const tabDirections = getControllerTabDirections(frame)
        const previousTabDirections = previous ? getControllerTabDirections(previous) : new Set<'previous' | 'next'>()
        for (const direction of ['previous', 'next'] as const) {
          emitRepeat(
            tabRepeatKey(direction),
            tabDirections.has(direction),
            previousTabDirections.has(direction),
            now,
            () => {
              markInput()
              switchControllerSection(direction)
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
            case 'toggle-queue':
              useUIStore.getState().toggleQueue()
              break
            case 'playback-toggle':
              executeActionRef.current('playback-toggle')
              break
            case 'previous-track':
              executeActionRef.current('previous-track')
              break
            case 'next-track':
              executeActionRef.current('next-track')
              break
            case 'open-radial':
              openControllerRadialMenu()
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
  }, [
    closeControllerRadialMenu,
    controllerSupportEnabled,
    createRadialRoot,
    executeControllerRadialAction,
    openControllerRadialMenu,
    setControllerMode,
    setRadialMenuState,
    updateContextState
  ])

  return state
}
