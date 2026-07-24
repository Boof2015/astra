import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_TRANSFER_WRITE_MAX_BYTES,
  checkSettingsTransferWrite
} from './settingsTransferWrite.ts'

const CHOSEN = '/Users/someone/Desktop/astra-settings-2026-07-24.json'

function check(overrides: Partial<Parameters<typeof checkSettingsTransferWrite>[0]> = {}) {
  return checkSettingsTransferWrite({
    filePath: CHOSEN,
    content: '{}',
    byteLength: 2,
    isUserChosenPath: (candidate) => candidate === CHOSEN,
    extensionOf: (candidate) => {
      const index = candidate.lastIndexOf('.')
      return index === -1 ? '' : candidate.slice(index)
    },
    ...overrides
  })
}

test('a save-dialog path with json content is accepted', () => {
  assert.deepEqual(check(), { ok: true })
})

test('a path the user never chose is rejected', () => {
  // The whole point of the higher size ceiling: the renderer cannot pick the destination,
  // only confirm one the main process already handed back from a dialog.
  const result = check({ filePath: '/Users/someone/.ssh/authorized_keys' })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /chosen in the save dialog/i)
})

test('a chosen path with the wrong extension is rejected', () => {
  const result = check({
    filePath: '/Users/someone/Desktop/notes.txt',
    isUserChosenPath: () => true
  })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.error, /\.json/i)
})

test('extension matching ignores case', () => {
  const upper = '/Users/someone/Desktop/export.JSON'
  assert.deepEqual(check({ filePath: upper, isUserChosenPath: () => true }), { ok: true })
})

test('non-string paths and content are rejected', () => {
  for (const filePath of [undefined, null, 42, '', '   ']) {
    assert.equal(check({ filePath }).ok, false, `expected rejection for ${String(filePath)}`)
  }
  assert.equal(check({ content: undefined }).ok, false)
  assert.equal(check({ content: { toString: () => 'x' } }).ok, false)
})

test('content beyond the ceiling is rejected, and the ceiling is well above the generic 10 MB cap', () => {
  assert.equal(check({ byteLength: SETTINGS_TRANSFER_WRITE_MAX_BYTES }).ok, true)
  assert.equal(check({ byteLength: SETTINGS_TRANSFER_WRITE_MAX_BYTES + 1 }).ok, false)
  assert.equal(check({ byteLength: Number.NaN }).ok, false)
  assert.ok(SETTINGS_TRANSFER_WRITE_MAX_BYTES > 10 * 1024 * 1024)
})
