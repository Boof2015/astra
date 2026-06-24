import test from 'node:test'
import assert from 'node:assert/strict'
import type { InputActionId } from '../../types/inputBindings.ts'
import { GlobalInputShortcutService, type GlobalShortcutRegistrar } from './globalInputShortcuts.ts'

class FakeRegistrar implements GlobalShortcutRegistrar {
  readonly callbacks = new Map<string, () => void>()
  readonly unavailable = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.unavailable.has(accelerator) || this.callbacks.has(accelerator)) return false
    this.callbacks.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.callbacks.delete(accelerator)
  }
}

test('registers global bindings, dispatches actions, and replaces prior registrations', () => {
  const registrar = new FakeRegistrar()
  const service = new GlobalInputShortcutService(registrar)
  const actions: InputActionId[] = []

  const results = service.configure([{
    actionId: 'next-track',
    slotIndex: 0,
    binding: { device: 'keyboard', key: 'arrowright', modifiers: ['shift'] }
  }], (actionId) => actions.push(actionId))

  assert.equal(results[0]?.state, 'registered')
  registrar.callbacks.get('Shift+Right')?.()
  assert.deepEqual(actions, ['next-track'])

  service.configure([], (actionId) => actions.push(actionId))
  assert.equal(registrar.callbacks.size, 0)
})

test('reports unavailable and unsupported global bindings', () => {
  const registrar = new FakeRegistrar()
  registrar.unavailable.add('N')
  const service = new GlobalInputShortcutService(registrar)

  const results = service.configure([
    {
      actionId: 'next-track',
      slotIndex: 0,
      binding: { device: 'keyboard', key: 'n', modifiers: [] }
    },
    {
      actionId: 'previous-track',
      slotIndex: 1,
      binding: { device: 'keyboard', key: 'unknown-special-key', modifiers: [] }
    }
  ], () => undefined)

  assert.equal(results[0]?.state, 'unavailable')
  assert.equal(results[1]?.state, 'unsupported')
})
