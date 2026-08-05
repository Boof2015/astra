import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY,
  TRANSPORT_INFO_LINE_MODE_STORAGE_KEY
} from '../../constants/settingsStorageKeys.ts'
import { RENDERER_SETTINGS_KEYS } from './resetActions.ts'

test('Reset All includes the transport info line preference', () => {
  assert.equal(RENDERER_SETTINGS_KEYS.includes(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY), true)
})

test('Reset All includes the session position checkpoint', () => {
  assert.equal(RENDERER_SETTINGS_KEYS.includes(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY), true)
})
