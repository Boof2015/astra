import test from 'node:test'
import assert from 'node:assert/strict'
import type { ControllerFrame } from '../types/controller.ts'
import {
  STANDARD_GAMEPAD_BUTTON,
  detectControllerFamily,
  getControllerDirections,
  getControllerButtonEdgeCommands,
  getControllerPromptLabels,
  getControllerScrollDelta,
  hasMeaningfulControllerInput,
  isControllerButtonPressEdge,
  isStandardController,
  resolveControllerRepeat,
  selectActiveControllerFrame
} from './controllerGamepad.ts'

function frame(overrides: Partial<ControllerFrame> = {}): ControllerFrame {
  return {
    index: 0,
    id: 'Xbox Controller',
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => 0),
    axes: [0, 0, 0, 0],
    ...overrides
  }
}

test('detects PlayStation controllers and uses Xbox as the standard fallback', () => {
  assert.equal(detectControllerFamily('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation')
  assert.equal(detectControllerFamily('DualSense Edge Wireless Controller'), 'playstation')
  assert.equal(detectControllerFamily('Xbox Wireless Controller'), 'xbox')
  assert.equal(detectControllerFamily('8BitDo Pro 2'), 'xbox')
  assert.equal(getControllerPromptLabels('playstation').activate, 'Cross')
  assert.equal(getControllerPromptLabels('xbox').queue, 'Y')
})

test('accepts only standard-mapped controller frames', () => {
  assert.equal(isStandardController(frame()), true)
  assert.equal(isStandardController(frame({ mapping: '' })), false)
})

test('maps d-pad and left-stick input to navigation directions with a dead zone', () => {
  const buttons = Array.from({ length: 17 }, () => 0)
  buttons[STANDARD_GAMEPAD_BUTTON.dpadUp] = 1
  assert.deepEqual([...getControllerDirections(frame({ buttons, axes: [0.7, 0.2, 0, 0] }))], ['up'])
  assert.deepEqual([...getControllerDirections(frame({ axes: [0.7, 0.6, 0, 0] }))], ['right'])
  assert.deepEqual([...getControllerDirections(frame({ axes: [0.3, -0.4, 0, 0] }))], [])
})

test('emits button presses only on the rising edge', () => {
  const pressed = Array.from({ length: 17 }, () => 0)
  pressed[STANDARD_GAMEPAD_BUTTON.south] = 1
  assert.equal(isControllerButtonPressEdge(undefined, frame({ buttons: pressed }), STANDARD_GAMEPAD_BUTTON.south), true)
  assert.equal(isControllerButtonPressEdge(frame({ buttons: pressed }), frame({ buttons: pressed }), STANDARD_GAMEPAD_BUTTON.south), false)
  assert.equal(isControllerButtonPressEdge(frame(), frame({ buttons: pressed }), STANDARD_GAMEPAD_BUTTON.south), true)
})

test('maps standard face, bumper, and menu button edges to semantic commands', () => {
  const buttons = Array.from({ length: 17 }, () => 0)
  buttons[STANDARD_GAMEPAD_BUTTON.south] = 1
  buttons[STANDARD_GAMEPAD_BUTTON.north] = 1
  buttons[STANDARD_GAMEPAD_BUTTON.rightBumper] = 1
  buttons[STANDARD_GAMEPAD_BUTTON.menu] = 1
  assert.deepEqual(getControllerButtonEdgeCommands(frame(), frame({ buttons })), [
    { type: 'activate' },
    { type: 'toggle-queue' },
    { type: 'playback-toggle' },
    { type: 'bumper-right' }
  ])
  assert.deepEqual(getControllerButtonEdgeCommands(frame({ buttons }), frame({ buttons })), [])
})

test('maps stick-click edges to zone-jump commands', () => {
  const buttons = Array.from({ length: 17 }, () => 0)
  buttons[STANDARD_GAMEPAD_BUTTON.leftStick] = 1
  buttons[STANDARD_GAMEPAD_BUTTON.rightStick] = 1
  assert.deepEqual(getControllerButtonEdgeCommands(frame(), frame({ buttons })), [
    { type: 'jump-sidebar' },
    { type: 'jump-transport' }
  ])
  assert.equal(getControllerPromptLabels('xbox').bumperLeft, 'LB')
  assert.equal(getControllerPromptLabels('playstation').bumperLeft, 'L1')
  assert.equal(getControllerPromptLabels('xbox').stickRight, 'R3')
})

test('switches to the controller with fresh input and otherwise keeps the active controller', () => {
  const first = frame({ index: 0 })
  const pressedButtons = Array.from({ length: 17 }, () => 0)
  pressedButtons[STANDARD_GAMEPAD_BUTTON.south] = 1
  const second = frame({ index: 1, id: 'DualSense', buttons: pressedButtons })
  const previous = new Map<number, ControllerFrame>([
    [0, first],
    [1, frame({ index: 1, id: 'DualSense' })]
  ])
  assert.equal(selectActiveControllerFrame([first, second], previous, 0)?.index, 1)
  assert.equal(selectActiveControllerFrame([first], previous, 0)?.index, 0)
})

test('repeats held navigation after the initial delay and stops on release', () => {
  const initial = resolveControllerRepeat(true, false, null, 1000)
  assert.deepEqual(initial, { emit: true, nextRepeatAt: 1350 })
  assert.deepEqual(resolveControllerRepeat(true, true, initial.nextRepeatAt, 1200), {
    emit: false,
    nextRepeatAt: 1350
  })
  assert.deepEqual(resolveControllerRepeat(true, true, initial.nextRepeatAt, 1350), {
    emit: true,
    nextRepeatAt: 1470
  })
  assert.deepEqual(resolveControllerRepeat(false, true, 1470, 1400), {
    emit: false,
    nextRepeatAt: null
  })
})

test('filters right-stick drift and scales meaningful scroll input', () => {
  assert.equal(getControllerScrollDelta(frame({ axes: [0, 0, 0, 0.1] })), 0)
  assert.ok(getControllerScrollDelta(frame({ axes: [0, 0, 0, 0.8] })) > 10)
  assert.ok(getControllerScrollDelta(frame({ axes: [0, 0, 0, -0.8] })) < -10)
  assert.equal(hasMeaningfulControllerInput(frame()), false)
  assert.equal(hasMeaningfulControllerInput(frame({ axes: [0, 0, 0, 0.8] })), true)
})
