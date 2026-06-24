import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInterceptedKeyboardInput, resolveMouseAppCommand } from './inputBindings.ts'

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
