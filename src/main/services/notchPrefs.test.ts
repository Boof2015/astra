import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNotchPrefs, saveNotchPrefs } from './notchPrefs.ts'
import { DEFAULT_NOTCH_PREFS } from '../../types/notch.ts'

test('notch preferences round-trip separately and malformed files recover to disabled defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-notch-prefs-'))
  try {
    const path = join(directory, 'notch-integration.json')
    assert.deepEqual(await loadNotchPrefs(path), DEFAULT_NOTCH_PREFS)
    const prefs = { ...DEFAULT_NOTCH_PREFS, enabled: true, restingView: 'spectrum' as const, showOverFullscreen: false }
    await saveNotchPrefs(path, prefs)
    assert.deepEqual(await loadNotchPrefs(path), prefs)
    await writeFile(path, '{invalid')
    assert.deepEqual(await loadNotchPrefs(path), DEFAULT_NOTCH_PREFS)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
