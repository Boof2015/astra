import type {
  ControllerCommand,
  ControllerDirection,
  ControllerFamily,
  ControllerFrame,
  ControllerPromptLabels
} from '../types/controller'
import type { ControllerRadialVector } from './controllerRadial'

export type ControllerTabDirection = 'previous' | 'next'

export const CONTROLLER_AXIS_DEAD_ZONE = 0.55
export const CONTROLLER_SCROLL_DEAD_ZONE = 0.2
export const CONTROLLER_BUTTON_THRESHOLD = 0.5
export const CONTROLLER_REPEAT_DELAY_MS = 350
export const CONTROLLER_REPEAT_INTERVAL_MS = 120

export const STANDARD_GAMEPAD_BUTTON = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  leftBumper: 4,
  rightBumper: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  menu: 9,
  leftStick: 10,
  rightStick: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15
} as const

const PLAYSTATION_ID_PATTERN = /playstation|dualshock|dualsense|sony|054c/i

export function detectControllerFamily(id: string): ControllerFamily {
  return PLAYSTATION_ID_PATTERN.test(id) ? 'playstation' : 'xbox'
}

export function getControllerPromptLabels(family: ControllerFamily): ControllerPromptLabels {
  if (family === 'playstation') {
    return {
      activate: 'Cross',
      back: 'Circle',
      playPause: 'Square',
      queue: 'Triangle',
      radialMenu: 'Options',
      bumperLeft: 'L1',
      bumperRight: 'R1',
      triggerLeft: 'L2',
      triggerRight: 'R2',
      stickLeft: 'L3',
      stickRight: 'R3'
    }
  }
  return {
    activate: 'A',
    back: 'B',
    playPause: 'X',
    queue: 'Y',
    radialMenu: 'Menu',
    bumperLeft: 'LB',
    bumperRight: 'RB',
    triggerLeft: 'LT',
    triggerRight: 'RT',
    stickLeft: 'L3',
    stickRight: 'R3'
  }
}

export function gamepadToControllerFrame(gamepad: Gamepad): ControllerFrame {
  return {
    index: gamepad.index,
    id: gamepad.id,
    mapping: gamepad.mapping,
    buttons: Array.from(gamepad.buttons, (button) => button.value),
    axes: Array.from(gamepad.axes)
  }
}

export function isStandardController(frame: ControllerFrame): boolean {
  return frame.mapping === 'standard'
}

export function isControllerButtonPressed(frame: ControllerFrame, buttonIndex: number): boolean {
  return (frame.buttons[buttonIndex] ?? 0) >= CONTROLLER_BUTTON_THRESHOLD
}

export function wasControllerButtonPressed(
  previous: ControllerFrame | undefined,
  buttonIndex: number
): boolean {
  return previous ? isControllerButtonPressed(previous, buttonIndex) : false
}

export function isControllerButtonPressEdge(
  previous: ControllerFrame | undefined,
  current: ControllerFrame,
  buttonIndex: number
): boolean {
  return isControllerButtonPressed(current, buttonIndex)
    && !wasControllerButtonPressed(previous, buttonIndex)
}

export function getControllerDirections(frame: ControllerFrame): Set<ControllerDirection> {
  const directions = new Set<ControllerDirection>()
  const horizontal = frame.axes[0] ?? 0
  const vertical = frame.axes[1] ?? 0
  const dpadDirection = isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadUp)
    ? 'up'
    : isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadDown)
      ? 'down'
      : isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadLeft)
        ? 'left'
        : isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadRight)
          ? 'right'
          : null
  if (dpadDirection) {
    directions.add(dpadDirection)
    return directions
  }

  if (Math.abs(horizontal) >= Math.abs(vertical) && Math.abs(horizontal) >= CONTROLLER_AXIS_DEAD_ZONE) {
    directions.add(horizontal < 0 ? 'left' : 'right')
  } else if (Math.abs(vertical) >= CONTROLLER_AXIS_DEAD_ZONE) {
    directions.add(vertical < 0 ? 'up' : 'down')
  }
  return directions
}

export function getControllerTabDirections(frame: ControllerFrame): Set<ControllerTabDirection> {
  const directions = new Set<ControllerTabDirection>()
  const horizontal = frame.axes[2] ?? 0
  if (horizontal <= -CONTROLLER_AXIS_DEAD_ZONE) directions.add('previous')
  else if (horizontal >= CONTROLLER_AXIS_DEAD_ZONE) directions.add('next')
  return directions
}

export function getControllerRadialVector(frame: ControllerFrame): ControllerRadialVector | null {
  let x = 0
  let y = 0
  if (isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadLeft)) x -= 1
  if (isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadRight)) x += 1
  if (isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadUp)) y -= 1
  if (isControllerButtonPressed(frame, STANDARD_GAMEPAD_BUTTON.dpadDown)) y += 1
  if (x !== 0 || y !== 0) return { x, y }

  const horizontal = frame.axes[0] ?? 0
  const vertical = frame.axes[1] ?? 0
  return Math.hypot(horizontal, vertical) >= CONTROLLER_AXIS_DEAD_ZONE
    ? { x: horizontal, y: vertical }
    : null
}

export function hasMeaningfulControllerInput(frame: ControllerFrame): boolean {
  if (frame.buttons.some((value) => value >= CONTROLLER_BUTTON_THRESHOLD)) return true
  if (getControllerDirections(frame).size > 0) return true
  if (getControllerTabDirections(frame).size > 0) return true
  const scrollAxis = frame.axes[3] ?? 0
  return Math.abs(scrollAxis) >= CONTROLLER_SCROLL_DEAD_ZONE
}

export function hasFreshControllerActivity(
  previous: ControllerFrame | undefined,
  current: ControllerFrame
): boolean {
  if (!hasMeaningfulControllerInput(current)) return false
  if (!previous) return true
  if (current.buttons.some((_value, index) => isControllerButtonPressEdge(previous, current, index))) return true

  const previousDirections = getControllerDirections(previous)
  for (const direction of getControllerDirections(current)) {
    if (!previousDirections.has(direction)) return true
  }

  return Math.abs(getControllerScrollDelta(current)) > 0
    && Math.abs(getControllerScrollDelta(previous)) === 0
}

export function selectActiveControllerFrame(
  frames: readonly ControllerFrame[],
  previousFrames: ReadonlyMap<number, ControllerFrame>,
  currentControllerIndex: number | null
): ControllerFrame | null {
  const freshFrame = frames.find((frame) => hasFreshControllerActivity(previousFrames.get(frame.index), frame))
  if (freshFrame) return freshFrame
  return frames.find((frame) => frame.index === currentControllerIndex)
    ?? frames.find(hasMeaningfulControllerInput)
    ?? null
}

export function getControllerButtonEdgeCommands(
  previous: ControllerFrame | undefined,
  current: ControllerFrame
): ControllerCommand[] {
  const commands: ControllerCommand[] = []
  const pushOnEdge = (buttonIndex: number, command: ControllerCommand): void => {
    if (isControllerButtonPressEdge(previous, current, buttonIndex)) commands.push(command)
  }

  pushOnEdge(STANDARD_GAMEPAD_BUTTON.south, { type: 'activate' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.east, { type: 'back' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.west, { type: 'playback-toggle' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.north, { type: 'toggle-queue' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.menu, { type: 'open-radial' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.leftBumper, { type: 'previous-track' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.rightBumper, { type: 'next-track' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.leftStick, { type: 'jump-sidebar' })
  pushOnEdge(STANDARD_GAMEPAD_BUTTON.rightStick, { type: 'jump-transport' })
  return commands
}

export interface RepeatResolution {
  emit: boolean
  nextRepeatAt: number | null
}

export function resolveControllerRepeat(
  active: boolean,
  wasActive: boolean,
  nextRepeatAt: number | null,
  now: number,
  initialDelayMs = CONTROLLER_REPEAT_DELAY_MS,
  repeatIntervalMs = CONTROLLER_REPEAT_INTERVAL_MS
): RepeatResolution {
  if (!active) return { emit: false, nextRepeatAt: null }
  if (!wasActive) return { emit: true, nextRepeatAt: now + initialDelayMs }
  if (nextRepeatAt === null) return { emit: false, nextRepeatAt: now + initialDelayMs }
  if (now < nextRepeatAt) return { emit: false, nextRepeatAt }
  return { emit: true, nextRepeatAt: now + repeatIntervalMs }
}

export function getControllerScrollDelta(frame: ControllerFrame): number {
  const axis = frame.axes[3] ?? 0
  if (Math.abs(axis) < CONTROLLER_SCROLL_DEAD_ZONE) return 0
  const normalized = (Math.abs(axis) - CONTROLLER_SCROLL_DEAD_ZONE) / (1 - CONTROLLER_SCROLL_DEAD_ZONE)
  return Math.sign(axis) * Math.max(2, normalized * 18)
}
