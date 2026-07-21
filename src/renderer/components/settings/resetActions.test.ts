import assert from 'node:assert/strict'
import test from 'node:test'
import { TRANSPORT_INFO_LINE_MODE_STORAGE_KEY } from '../../constants/settingsStorageKeys.ts'
import { RENDERER_SETTINGS_KEYS } from './resetActions.ts'

test('Reset All includes the transport info line preference', () => {
  assert.equal(RENDERER_SETTINGS_KEYS.includes(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY), true)
})
