import test from 'node:test'
import assert from 'node:assert/strict'
import {
  keyboardBindingToAccelerator,
  resolveInterceptedKeyboardInput,
  resolveMouseAppCommand,
  sanitizeGlobalShortcutRegistrationRequests
} from './inputBindings.ts'

test('forwards native zoom chords as raw configurable keyboard input', () => {
  assert.deepEqual(resolveInterceptedKeyboardInput({
    type: 'keyDown',
    key: '=',
    code: 'Equal',
    control: true,
    shift: false,
    isAutoRepeat: true
  }, 'win32'), {
    device: 'keyboard',
    type: 'keyDown',
    key: '=',
    code: 'Equal',
    repeat: true,
    shift: false,
    control: true,
    alt: false,
    meta: false
  })
  assert.equal(resolveInterceptedKeyboardInput({ type: 'keyDown', key: 'k', code: 'KeyK', control: true }, 'win32'), null)
})

test('maps supported Electron browser app commands to mouse bindings', () => {
  assert.deepEqual(resolveMouseAppCommand('browser-backward'), { device: 'mouse', button: 'back' })
  assert.deepEqual(resolveMouseAppCommand('browser-forward'), { device: 'mouse', button: 'forward' })
  assert.equal(resolveMouseAppCommand('media-play-pause'), null)
})

test('converts unrestricted keyboard bindings into Electron accelerators', () => {
  assert.equal(keyboardBindingToAccelerator({
    device: 'keyboard',
    key: 'arrowright',
    modifiers: ['shift']
  }), 'Shift+Right')
  assert.equal(keyboardBindingToAccelerator({
    device: 'keyboard',
    key: 'n',
    modifiers: []
  }), 'N')
  assert.equal(keyboardBindingToAccelerator({
    device: 'keyboard',
    key: 'space',
    modifiers: []
  }), 'Space')
  assert.equal(keyboardBindingToAccelerator({
    device: 'keyboard',
    key: 'unknown-special-key',
    modifiers: []
  }), null)
})

test('sanitizes global shortcut registration requests at the IPC boundary', () => {
  assert.deepEqual(sanitizeGlobalShortcutRegistrationRequests([
    {
      actionId: 'next-track',
      slotIndex: 0,
      binding: { device: 'keyboard', key: 'arrowright', modifiers: ['shift'] }
    },
    {
      actionId: 'missing-action',
      slotIndex: 0,
      binding: { device: 'keyboard', key: 'x', modifiers: [] }
    },
    {
      actionId: 'next-track',
      slotIndex: 2,
      binding: { device: 'keyboard', key: 'x', modifiers: [] }
    }
  ]), [{
    actionId: 'next-track',
    slotIndex: 0,
    binding: { device: 'keyboard', key: 'arrowright', modifiers: ['shift'] }
  }])
})
