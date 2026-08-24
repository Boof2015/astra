import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  loadDesktopIntegrationPrefsAtPath,
  normalizeDesktopIntegrationPrefs,
  resolveMainWindowCloseDisposition,
  saveDesktopIntegrationPrefsAtPath,
} from './desktopIntegrationPrefs.ts'

test('desktop integration preferences default to a visible tray and normal close behavior', () => {
  assert.deepEqual(normalizeDesktopIntegrationPrefs(null), {
    trayEnabled: true,
    closeToTray: false,
  })
})

test('disabling the tray also disables close-to-tray', () => {
  assert.deepEqual(normalizeDesktopIntegrationPrefs({
    trayEnabled: false,
    closeToTray: true,
  }), {
    trayEnabled: false,
    closeToTray: false,
  })
})

test('desktop integration preferences persist their normalized representation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-desktop-prefs-'))
  const filePath = join(directory, 'prefs.json')
  try {
    const saved = await saveDesktopIntegrationPrefsAtPath(filePath, {
      trayEnabled: false,
      closeToTray: true,
    })
    assert.deepEqual(saved, { trayEnabled: false, closeToTray: false })
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf-8')), saved)
    assert.deepEqual(await loadDesktopIntegrationPrefsAtPath(filePath), saved)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('main-window close hides only when the tray is available and the app is not quitting', () => {
  assert.equal(resolveMainWindowCloseDisposition({
    closeToTray: true,
    isAppQuitting: false,
    trayAvailable: true,
  }), 'hide-to-tray')
  assert.equal(resolveMainWindowCloseDisposition({
    closeToTray: true,
    isAppQuitting: true,
    trayAvailable: true,
  }), 'close')
  assert.equal(resolveMainWindowCloseDisposition({
    closeToTray: true,
    isAppQuitting: false,
    trayAvailable: false,
  }), 'close')
})
