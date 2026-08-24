import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countConfiguredGlobalInputBindings,
  isGlobalInputRegistrationSuspended,
  useInputBindingStore,
  type GlobalInputBindingPreferences,
} from './inputBindingStore.ts'

test('global shortcut capture and user suspension remain independent', () => {
  assert.equal(isGlobalInputRegistrationSuspended(false, false), false)
  assert.equal(isGlobalInputRegistrationSuspended(true, false), true)
  assert.equal(isGlobalInputRegistrationSuspended(false, true), true)
  assert.equal(isGlobalInputRegistrationSuspended(true, true), true)
  assert.equal(isGlobalInputRegistrationSuspended(false, true), true)

  const store = useInputBindingStore.getState()
  store.setGlobalUserSuspended(true)
  store.setGlobalRegistrationSuspended(true)
  store.setGlobalRegistrationSuspended(false)
  assert.equal(useInputBindingStore.getState().globalUserSuspended, true)
  assert.equal(isGlobalInputRegistrationSuspended(
    useInputBindingStore.getState().globalRegistrationSuspended,
    useInputBindingStore.getState().globalUserSuspended
  ), true)
  useInputBindingStore.getState().setGlobalUserSuspended(false)
})

test('configured global shortcut count includes only enabled keyboard slots', () => {
  const preferences: GlobalInputBindingPreferences = {
    'playback-toggle': [true, false],
    'next-track': [true, false],
  }
  assert.equal(countConfiguredGlobalInputBindings({}, preferences), 2)
})
