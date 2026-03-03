import { app, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'

const PREFS_FILE_NAME = 'main-window.json'

export const MAIN_WINDOW_MIN_WIDTH = 900
export const MAIN_WINDOW_MIN_HEIGHT = 600
export const MAIN_WINDOW_DEFAULT_WIDTH = 1280
export const MAIN_WINDOW_DEFAULT_HEIGHT = 800

export interface MainWindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_PREFS: MainWindowPrefs = {
  width: MAIN_WINDOW_DEFAULT_WIDTH,
  height: MAIN_WINDOW_DEFAULT_HEIGHT,
  maximized: false
}

function prefsPath(): string {
  return join(app.getPath('userData'), PREFS_FILE_NAME)
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
}

function isOnAnyDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => intersects(bounds, display.workArea))
}

function resolveMaxWorkAreaBounds(): { maxWidth: number; maxHeight: number } {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) {
    return {
      maxWidth: MAIN_WINDOW_DEFAULT_WIDTH,
      maxHeight: MAIN_WINDOW_DEFAULT_HEIGHT
    }
  }

  let maxWidth = 0
  let maxHeight = 0
  for (const display of displays) {
    maxWidth = Math.max(maxWidth, Math.floor(display.workArea.width))
    maxHeight = Math.max(maxHeight, Math.floor(display.workArea.height))
  }

  return {
    maxWidth: Math.max(MAIN_WINDOW_MIN_WIDTH, maxWidth),
    maxHeight: Math.max(MAIN_WINDOW_MIN_HEIGHT, maxHeight)
  }
}

export function normalizeMainWindowPrefs(value: unknown): MainWindowPrefs {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_PREFS }
  }

  const raw = value as Record<string, unknown>
  const { maxWidth, maxHeight } = resolveMaxWorkAreaBounds()
  const width = clamp(
    Math.round(toFiniteNumber(raw.width) ?? DEFAULT_PREFS.width),
    MAIN_WINDOW_MIN_WIDTH,
    maxWidth
  )
  const height = clamp(
    Math.round(toFiniteNumber(raw.height) ?? DEFAULT_PREFS.height),
    MAIN_WINDOW_MIN_HEIGHT,
    maxHeight
  )
  const maximized = typeof raw.maximized === 'boolean'
    ? raw.maximized
    : DEFAULT_PREFS.maximized

  const x = toFiniteNumber(raw.x)
  const y = toFiniteNumber(raw.y)
  if (x === undefined || y === undefined) {
    return { width, height, maximized }
  }

  const bounds: Rectangle = {
    x: Math.round(x),
    y: Math.round(y),
    width,
    height
  }

  if (!isOnAnyDisplay(bounds)) {
    return { width, height, maximized }
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized
  }
}

export async function loadMainWindowPrefs(): Promise<MainWindowPrefs> {
  try {
    const data = await readFile(prefsPath(), 'utf-8')
    return normalizeMainWindowPrefs(JSON.parse(data))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export async function saveMainWindowPrefs(prefs: MainWindowPrefs): Promise<void> {
  const normalized = normalizeMainWindowPrefs(prefs)
  await writeFile(prefsPath(), JSON.stringify(normalized, null, 2), 'utf-8')
}
