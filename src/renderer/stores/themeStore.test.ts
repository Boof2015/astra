import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseColorToRgba } from '../utils/color.ts'

const storageValues = new Map<string, string>()
const appliedStyles = new Map<string, string>()

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
    removeItem: (key: string) => storageValues.delete(key),
  },
})

const documentElement = {
  dataset: {} as Record<string, string>,
  style: {
    setProperty: (name: string, value: string) => appliedStyles.set(name, value),
  },
}

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
})

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  },
})

const {
  THEME_PRESET_LIST,
  THEME_STORAGE_KEY,
  resolveThemeTokens,
  useThemeStore,
} = await import('./themeStore.ts')

type Rgba = { r: number; g: number; b: number; a: number }

function parsed(color: string): Rgba {
  const value = parseColorToRgba(color)
  assert.ok(value, `Expected a parseable color, received ${color}`)
  return value
}

function composite(foreground: string, background: string): string {
  const fg = parsed(foreground)
  const bg = parsed(background)
  const alpha = fg.a + (bg.a * (1 - fg.a))
  const channel = (front: number, back: number): number => (
    ((front * fg.a) + (back * bg.a * (1 - fg.a))) / Math.max(alpha, Number.EPSILON)
  )
  return `rgba(${channel(fg.r, bg.r)}, ${channel(fg.g, bg.g)}, ${channel(fg.b, bg.b)}, ${alpha})`
}

function linearized(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function luminance(color: string): number {
  const value = parsed(color)
  return (
    (0.2126 * linearized(value.r))
    + (0.7152 * linearized(value.g))
    + (0.0722 * linearized(value.b))
  )
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

test('Editor follows Graphite and resolves the intended high-clarity palette', () => {
  const ids = THEME_PRESET_LIST.map((preset) => preset.id)
  assert.equal(ids[ids.indexOf('graphite') + 1], 'editor')

  const editor = resolveThemeTokens('editor', null, 'theme', null)
  assert.deepEqual({
    bgPrimary: editor.bgPrimary,
    bgSecondary: editor.bgSecondary,
    bgTertiary: editor.bgTertiary,
    glassBg: editor.glassBg,
    glassBorder: editor.glassBorder,
    glassHighlight: editor.glassHighlight,
    textPrimary: editor.textPrimary,
    textSecondary: editor.textSecondary,
    textTertiary: editor.textTertiary,
    controlBgSoft: editor.controlBgSoft,
    controlBg: editor.controlBg,
    controlBgStrong: editor.controlBgStrong,
    controlBorder: editor.controlBorder,
    stageBg: editor.stageBg,
    stageSurface: editor.stageSurface,
    stageBorder: editor.stageBorder,
    stageGrid: editor.stageGrid,
    stageText: editor.stageText,
    stageTextMuted: editor.stageTextMuted,
    accent: editor.accent,
    accentHover: editor.accentHover,
    accentGlow: editor.accentGlow,
    isLight: editor.isLight,
  }, {
    bgPrimary: '#0f0f0f',
    bgSecondary: '#171717',
    bgTertiary: '#1c1c1c',
    glassBg: 'rgba(28, 28, 28, 0.82)',
    glassBorder: '#2a2a2a',
    glassHighlight: 'rgba(255, 255, 255, 0.04)',
    textPrimary: '#f0f0f0',
    textSecondary: '#9a9a9a',
    textTertiary: '#9a9a9a',
    controlBgSoft: '#171717',
    controlBg: '#1c1c1c',
    controlBgStrong: '#262626',
    controlBorder: '#3d3d3d',
    stageBg: '#0f0f0f',
    stageSurface: '#171717',
    stageBorder: '#2a2a2a',
    stageGrid: 'rgba(240, 240, 240, 0.1)',
    stageText: '#d6d6d6',
    stageTextMuted: '#9a9a9a',
    accent: '#38bdf8',
    accentHover: '#70d3ff',
    accentGlow: 'rgba(56, 189, 248, 0.14)',
    isLight: false,
  })
})

test('Editor keeps useful text at AA contrast across its brightest surfaces', () => {
  const editor = resolveThemeTokens('editor', null, 'theme', null)
  const surfaces = [
    editor.bgPrimary,
    editor.bgSecondary,
    editor.bgTertiary,
    composite(editor.glassBg, editor.bgTertiary),
    composite(editor.controlBgStrong, editor.bgTertiary),
  ]

  for (const foreground of [editor.textPrimary, editor.textSecondary, editor.textTertiary]) {
    for (const background of surfaces) {
      assert.ok(
        contrastRatio(foreground, background) >= 4.5,
        `${foreground} should remain readable on ${background}`,
      )
    }
  }

  for (const background of [editor.stageBg, editor.stageSurface]) {
    assert.ok(contrastRatio(editor.stageText, background) >= 4.5)
    assert.ok(contrastRatio(editor.stageTextMuted, background) >= 4.5)
  }
})

test('Editor preserves accent precedence and existing preset defaults', () => {
  assert.equal(resolveThemeTokens('editor', '#ff00ff', 'theme', null).accent, '#ff00ff')
  assert.equal(resolveThemeTokens('editor', '#ff00ff', 'cover-art', '#00ff00').accent, '#00ff00')

  const defaultTheme = resolveThemeTokens('default', null, 'theme', null)
  assert.equal(defaultTheme.controlBorder, 'rgba(255, 255, 255, 0.1)')
  assert.equal(defaultTheme.stageTextMuted, 'rgba(255, 255, 255, 0.46)')

  const lightTheme = resolveThemeTokens('light', null, 'theme', null)
  assert.equal(lightTheme.controlBorder, 'rgba(0, 0, 0, 0.1)')
  assert.equal(lightTheme.stageTextMuted, 'rgba(15, 23, 42, 0.48)')
})

test('Editor persists, restores, and applies its CSS variables without a storage migration', () => {
  storageValues.clear()
  appliedStyles.clear()
  useThemeStore.getState().resetToDefault()
  useThemeStore.getState().setPreset('editor')

  const persisted = JSON.parse(storageValues.get(THEME_STORAGE_KEY) ?? '{}')
  assert.equal(persisted.presetId, 'editor')
  assert.equal(useThemeStore.getState().presetId, 'editor')
  assert.equal(appliedStyles.get('--control-border'), '#3d3d3d')
  assert.equal(appliedStyles.get('--stage-text-muted'), '#9a9a9a')
  assert.equal(documentElement.dataset.themePreset, 'editor')
  assert.equal(documentElement.dataset.themeTone, 'dark')

  useThemeStore.getState().resetToDefault()
  storageValues.set(THEME_STORAGE_KEY, JSON.stringify({ presetId: 'editor' }))
  useThemeStore.getState().initFromSaved()
  assert.equal(useThemeStore.getState().presetId, 'editor')

  storageValues.set(THEME_STORAGE_KEY, JSON.stringify({ presetId: 'not-a-theme' }))
  useThemeStore.getState().initFromSaved()
  assert.equal(useThemeStore.getState().presetId, 'default')
})

test.after(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
