import test from 'node:test'
import assert from 'node:assert/strict'
import type { InputBinding, RawKeyboardBindingInput } from '../../types/inputBindings.ts'
import { INPUT_ACTION_DEFINITIONS } from '../constants/keyboardShortcuts.ts'
import {
  findBindingConflict,
  getDefaultBindingSlots,
  getEffectiveBindingSlots,
  isGlobalInputBindingEnabled,
  parseInputBindingOverrides,
  useInputBindingStore
} from '../stores/inputBindingStore.ts'
import {
  formatInputBinding,
  inputBindingsEqual,
  normalizeRawKeyboardBinding,
  sanitizeInputBinding
} from './inputBindings.ts'

function keyInput(overrides: Partial<RawKeyboardBindingInput> = {}): RawKeyboardBindingInput {
  return {
    device: 'keyboard',
    type: 'keyDown',
    key: 'k',
    code: 'KeyK',
    repeat: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...overrides
  }
}

test('normalizes logical keys and platform primary modifiers', () => {
  assert.deepEqual(
    normalizeRawKeyboardBinding(keyInput({ control: true }), 'win32'),
    { device: 'keyboard', key: 'k', modifiers: ['primary'] }
  )
  assert.deepEqual(
    normalizeRawKeyboardBinding(keyInput({ meta: true }), 'darwin'),
    { device: 'keyboard', key: 'k', modifiers: ['primary'] }
  )
  assert.deepEqual(
    normalizeRawKeyboardBinding(keyInput({ key: '?', code: 'Slash', shift: true }), 'linux'),
    { device: 'keyboard', key: '?', modifiers: [] }
  )
  assert.deepEqual(
    normalizeRawKeyboardBinding(keyInput({ key: 'Unidentified', code: 'NumpadAdd', control: true }), 'win32'),
    { device: 'keyboard', key: '+', modifiers: ['primary'] }
  )
})

test('rejects reserved and modifier-only keyboard inputs', () => {
  assert.equal(normalizeRawKeyboardBinding(keyInput({ key: 'Escape', code: 'Escape' }), 'linux'), null)
  assert.equal(normalizeRawKeyboardBinding(keyInput({ key: 'Tab', code: 'Tab' }), 'linux'), null)
  assert.equal(normalizeRawKeyboardBinding(keyInput({ key: 'Shift', code: 'ShiftLeft', shift: true }), 'linux'), null)
})

test('formats keyboard and mouse bindings for the active platform', () => {
  assert.equal(formatInputBinding({ device: 'keyboard', key: 'k', modifiers: ['primary'] }, 'darwin'), 'Cmd + K')
  assert.equal(formatInputBinding({ device: 'keyboard', key: 'arrowright', modifiers: ['shift'] }, 'linux'), 'Shift + Right')
  assert.equal(formatInputBinding({ device: 'mouse', button: 'back' }, 'win32'), 'Mouse 4 (Back)')
})

test('all actions expose no more than two valid default binding slots', () => {
  for (const definition of INPUT_ACTION_DEFINITIONS) {
    assert.ok(definition.defaultBindings.length <= 2)
    const slots = getDefaultBindingSlots(definition.id)
    for (const binding of slots) {
      if (binding) assert.deepEqual(sanitizeInputBinding(binding), binding)
    }
  }
})

test('detects conflicts across actions but ignores the target slot', () => {
  const binding: InputBinding = { device: 'keyboard', key: 'n', modifiers: [] }
  assert.deepEqual(findBindingConflict(binding, 'playback-toggle', 0, {}), {
    actionId: 'next-track',
    slotIndex: 1
  })
  assert.equal(findBindingConflict(binding, 'next-track', 1, {}), null)
  assert.equal(inputBindingsEqual(binding, { device: 'keyboard', key: 'n', modifiers: [] }), true)
})

test('parses versioned overrides and ignores malformed or removed entries', () => {
  const overrides = parseInputBindingOverrides(JSON.stringify({
    version: 1,
    overrides: {
      'playback-toggle': [{ device: 'mouse', button: 'back' }, null],
      removed: [{ device: 'keyboard', key: 'x', modifiers: [] }],
      mute: [{ device: 'keyboard', key: 'Escape', modifiers: [] }]
    }
  }))

  assert.deepEqual(overrides['playback-toggle'], [{ device: 'mouse', button: 'back' }, null])
  assert.equal('removed' in overrides, false)
  assert.equal(overrides.mute, undefined)
  assert.deepEqual(parseInputBindingOverrides('{bad json'), {})
})

test('assignment moves conflicts, clearing preserves slots, and resets restore defaults', () => {
  useInputBindingStore.setState({ overrides: {}, globalEnabled: {}, globalStatuses: {} })
  const store = useInputBindingStore.getState()
  const nextTrackBinding: InputBinding = { device: 'keyboard', key: 'n', modifiers: [] }

  store.assignBinding('playback-toggle', 1, nextTrackBinding)
  let overrides = useInputBindingStore.getState().overrides
  assert.deepEqual(getEffectiveBindingSlots('playback-toggle', overrides)[1], nextTrackBinding)
  assert.equal(getEffectiveBindingSlots('next-track', overrides)[1], null)

  useInputBindingStore.getState().resetAction('next-track')
  overrides = useInputBindingStore.getState().overrides
  assert.deepEqual(getEffectiveBindingSlots('next-track', overrides)[1], nextTrackBinding)
  assert.equal(getEffectiveBindingSlots('playback-toggle', overrides)[1], null)

  useInputBindingStore.getState().assignBinding('playback-toggle', 1, nextTrackBinding)

  useInputBindingStore.getState().clearBinding('playback-toggle', 0)
  overrides = useInputBindingStore.getState().overrides
  assert.equal(getEffectiveBindingSlots('playback-toggle', overrides)[0], null)
  assert.deepEqual(getEffectiveBindingSlots('playback-toggle', overrides)[1], nextTrackBinding)

  useInputBindingStore.getState().resetAction('playback-toggle')
  overrides = useInputBindingStore.getState().overrides
  assert.deepEqual(getEffectiveBindingSlots('playback-toggle', overrides), getDefaultBindingSlots('playback-toggle'))

  useInputBindingStore.getState().resetAll()
  assert.deepEqual(useInputBindingStore.getState().overrides, {})
})

test('global enablement is per keyboard slot and resets when the binding is cleared', () => {
  useInputBindingStore.setState({ overrides: {}, globalEnabled: {}, globalStatuses: {} })

  useInputBindingStore.getState().setGlobalEnabled('next-track', 0, true)
  assert.equal(isGlobalInputBindingEnabled(
    'next-track',
    0,
    useInputBindingStore.getState().globalEnabled
  ), true)

  useInputBindingStore.getState().setGlobalEnabled('navigate-back', 0, true)
  assert.equal(isGlobalInputBindingEnabled(
    'navigate-back',
    0,
    useInputBindingStore.getState().globalEnabled
  ), false)

  useInputBindingStore.getState().clearBinding('next-track', 0)
  assert.equal(isGlobalInputBindingEnabled(
    'next-track',
    0,
    useInputBindingStore.getState().globalEnabled
  ), false)
})
