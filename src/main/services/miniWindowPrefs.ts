import { app, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { MiniPlayerVisualizerMode, MiniPlayerWindowPrefs } from '../../types/miniPlayer'

const PREFS_FILE_NAME = 'mini-player-window.json'

export const MINI_WINDOW_MIN_WIDTH = 300
export const MINI_WINDOW_MIN_HEIGHT = 116
export const MINI_WINDOW_DEFAULT_WIDTH = 440
export const MINI_WINDOW_DEFAULT_HEIGHT = 164
export const MINI_WINDOW_MAX_WIDTH = 720
export const MINI_WINDOW_MAX_HEIGHT = 720

const DEFAULT_MINI_PLAYER_VISUALIZER_MODE: MiniPlayerVisualizerMode = 'off'

const DEFAULT_PREFS: MiniPlayerWindowPrefs = {
  width: MINI_WINDOW_DEFAULT_WIDTH,
  height: MINI_WINDOW_DEFAULT_HEIGHT,
  alwaysOnTop: true,
  visualizerMode: DEFAULT_MINI_PLAYER_VISUALIZER_MODE
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

export function normalizeMiniPlayerVisualizerMode(value: unknown): MiniPlayerVisualizerMode {
  switch (value) {
    case 'off':
    case 'oscilloscope':
    case 'spectrum':
      return value
    default:
      return DEFAULT_MINI_PLAYER_VISUALIZER_MODE
  }
}

export function normalizeMiniWindowPrefs(value: unknown): MiniPlayerWindowPrefs {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_PREFS }
  }

  const raw = value as Record<string, unknown>
  const width = clamp(
    toFiniteNumber(raw.width) ?? DEFAULT_PREFS.width,
    MINI_WINDOW_MIN_WIDTH,
    MINI_WINDOW_MAX_WIDTH
  )
  const height = clamp(
    toFiniteNumber(raw.height) ?? DEFAULT_PREFS.height,
    MINI_WINDOW_MIN_HEIGHT,
    MINI_WINDOW_MAX_HEIGHT
  )
  const alwaysOnTop = typeof raw.alwaysOnTop === 'boolean'
    ? raw.alwaysOnTop
    : DEFAULT_PREFS.alwaysOnTop
  const visualizerMode = normalizeMiniPlayerVisualizerMode(raw.visualizerMode)

  const x = toFiniteNumber(raw.x)
  const y = toFiniteNumber(raw.y)
  if (x === undefined || y === undefined) {
    return { width, height, alwaysOnTop, visualizerMode }
  }

  const bounds: Rectangle = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }

  if (!isOnAnyDisplay(bounds)) {
    return { width, height, alwaysOnTop, visualizerMode }
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop,
    visualizerMode
  }
}

export async function loadMiniWindowPrefs(): Promise<MiniPlayerWindowPrefs> {
  try {
    const data = await readFile(prefsPath(), 'utf-8')
    return normalizeMiniWindowPrefs(JSON.parse(data))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export async function saveMiniWindowPrefs(prefs: MiniPlayerWindowPrefs): Promise<void> {
  const normalized = normalizeMiniWindowPrefs(prefs)
  await writeFile(prefsPath(), JSON.stringify(normalized, null, 2), 'utf-8')
}
