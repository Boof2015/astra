import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  DEFAULT_DESKTOP_INTEGRATION_PREFS,
  type DesktopIntegrationPrefs,
} from '../../types/desktopIntegration'

const PREFS_FILE_NAME = 'desktop-integration.json'

function prefsPath(): string {
  return join(app.getPath('userData'), PREFS_FILE_NAME)
}

export function normalizeDesktopIntegrationPrefs(value: unknown): DesktopIntegrationPrefs {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DESKTOP_INTEGRATION_PREFS }
  }

  const raw = value as Record<string, unknown>
  const trayEnabled = typeof raw.trayEnabled === 'boolean'
    ? raw.trayEnabled
    : DEFAULT_DESKTOP_INTEGRATION_PREFS.trayEnabled
  const requestedCloseToTray = typeof raw.closeToTray === 'boolean'
    ? raw.closeToTray
    : DEFAULT_DESKTOP_INTEGRATION_PREFS.closeToTray

  return {
    trayEnabled,
    closeToTray: trayEnabled && requestedCloseToTray,
  }
}

export type MainWindowCloseDisposition = 'hide-to-tray' | 'close'

export function resolveMainWindowCloseDisposition(options: {
  closeToTray: boolean
  isAppQuitting: boolean
  trayAvailable: boolean
}): MainWindowCloseDisposition {
  return options.closeToTray && !options.isAppQuitting && options.trayAvailable
    ? 'hide-to-tray'
    : 'close'
}

export async function loadDesktopIntegrationPrefsAtPath(filePath: string): Promise<DesktopIntegrationPrefs> {
  try {
    const data = await readFile(filePath, 'utf-8')
    return normalizeDesktopIntegrationPrefs(JSON.parse(data))
  } catch {
    return { ...DEFAULT_DESKTOP_INTEGRATION_PREFS }
  }
}

export async function saveDesktopIntegrationPrefsAtPath(
  filePath: string,
  prefs: DesktopIntegrationPrefs
): Promise<DesktopIntegrationPrefs> {
  const normalized = normalizeDesktopIntegrationPrefs(prefs)
  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}

export function loadDesktopIntegrationPrefs(): Promise<DesktopIntegrationPrefs> {
  return loadDesktopIntegrationPrefsAtPath(prefsPath())
}

export function saveDesktopIntegrationPrefs(
  prefs: DesktopIntegrationPrefs
): Promise<DesktopIntegrationPrefs> {
  return saveDesktopIntegrationPrefsAtPath(prefsPath(), prefs)
}
