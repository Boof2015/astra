import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveUIScaleShortcutAction,
  type UIScaleShortcutInput
} from './uiScaleShortcuts.ts'

function keyDown(input: Omit<UIScaleShortcutInput, 'type'>): UIScaleShortcutInput {
  return {
    type: 'keyDown',
    ...input
  }
}

test('resolves control zoom shortcuts on Windows and Linux', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'linux']

  for (const platform of platforms) {
    assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', control: true }), platform), 'increase')
    assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '=', code: 'Equal', control: true }), platform), 'increase')
    assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '-', code: 'Minus', control: true }), platform), 'decrease')
    assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '0', code: 'Digit0', control: true }), platform), 'reset')
  }
})

test('resolves command zoom shortcuts on macOS', () => {
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', meta: true }), 'darwin'), 'increase')
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '=', code: 'Equal', meta: true }), 'darwin'), 'increase')
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '-', code: 'Minus', meta: true }), 'darwin'), 'decrease')
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '0', code: 'Digit0', meta: true }), 'darwin'), 'reset')
})

test('resolves numpad zoom shortcuts by Electron code', () => {
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: 'Unidentified', code: 'NumpadAdd', control: true }), 'win32'), 'increase')
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: 'Unidentified', code: 'NumpadSubtract', control: true }), 'linux'), 'decrease')
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: 'Unidentified', code: 'Numpad0', meta: true }), 'darwin'), 'reset')
})

test('ignores alt-modified and wrong-platform shortcut chords', () => {
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', control: true, alt: true }), 'win32'), null)
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', meta: true, alt: true }), 'darwin'), null)
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', control: true }), 'darwin'), null)
  assert.equal(resolveUIScaleShortcutAction(keyDown({ key: '+', code: 'Equal', meta: true }), 'linux'), null)
})

test('ignores non-keydown input events', () => {
  assert.equal(resolveUIScaleShortcutAction({ type: 'keyUp', key: '+', code: 'Equal', control: true }, 'win32'), null)
})
