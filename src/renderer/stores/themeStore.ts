import { create } from 'zustand'
import { useVisualizerSettingsStore } from './visualizerSettingsStore'

export type ThemePresetId = 'default' | 'graphite' | 'midnight' | 'studio' | 'crimson'

export interface ResolvedThemeTokens {
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  glassBg: string
  glassBorder: string
  glassHighlight: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  accent: string
  accentHover: string
  accentGlow: string
}

interface ThemePresetDefinition {
  id: ThemePresetId
  label: string
  description: string
  tokens: Omit<ResolvedThemeTokens, 'accent' | 'accentHover' | 'accentGlow'>
  accent: string
  accentHover: string
  accentGlow: string
}

export interface ThemeSettingsState {
  presetId: ThemePresetId
  customAccent: string | null
  resolvedTokens: ResolvedThemeTokens
  setPreset: (presetId: ThemePresetId) => void
  setCustomAccent: (accentHex: string) => void
  usePresetAccent: () => void
  resetToDefault: () => void
  initFromSaved: () => void
}

const THEME_STORAGE_KEY = 'astra-theme-settings-v1'
const DEFAULT_PRESET_ID: ThemePresetId = 'default'
const DEFAULT_ACCENT = '#38bdf8'

const THEME_PRESETS: Record<ThemePresetId, ThemePresetDefinition> = {
  default: {
    id: 'default',
    label: 'Default',
    description: 'Current Astra look',
    tokens: {
      bgPrimary: '#000000',
      bgSecondary: '#050505',
      bgTertiary: '#0a0a0a',
      glassBg: 'rgba(255, 255, 255, 0.03)',
      glassBorder: 'rgba(255, 255, 255, 0.08)',
      glassHighlight: 'rgba(255, 255, 255, 0.05)',
      textPrimary: 'rgba(255, 255, 255, 0.95)',
      textSecondary: 'rgba(255, 255, 255, 0.6)',
      textTertiary: 'rgba(255, 255, 255, 0.4)',
    },
    accent: '#38bdf8',
    accentHover: '#7dd3fc',
    accentGlow: 'rgba(56, 189, 248, 0.3)',
  },
  graphite: {
    id: 'graphite',
    label: 'Graphite',
    description: 'Neutral slate surfaces',
    tokens: {
      bgPrimary: '#07080b',
      bgSecondary: '#0d1016',
      bgTertiary: '#141923',
      glassBg: 'rgba(255, 255, 255, 0.04)',
      glassBorder: 'rgba(255, 255, 255, 0.11)',
      glassHighlight: 'rgba(255, 255, 255, 0.06)',
      textPrimary: 'rgba(255, 255, 255, 0.95)',
      textSecondary: 'rgba(219, 226, 239, 0.72)',
      textTertiary: 'rgba(190, 202, 223, 0.46)',
    },
    accent: '#4fc3f7',
    accentHover: '#8bdaf9',
    accentGlow: 'rgba(79, 195, 247, 0.34)',
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep blue-black contrast',
    tokens: {
      bgPrimary: '#03050b',
      bgSecondary: '#060b14',
      bgTertiary: '#0b1220',
      glassBg: 'rgba(177, 209, 255, 0.05)',
      glassBorder: 'rgba(169, 203, 255, 0.16)',
      glassHighlight: 'rgba(255, 255, 255, 0.07)',
      textPrimary: 'rgba(236, 244, 255, 0.96)',
      textSecondary: 'rgba(194, 213, 242, 0.72)',
      textTertiary: 'rgba(165, 187, 222, 0.48)',
    },
    accent: '#4f9bff',
    accentHover: '#89b8ff',
    accentGlow: 'rgba(79, 155, 255, 0.34)',
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    description: 'Low-glare warm dark',
    tokens: {
      bgPrimary: '#0a0908',
      bgSecondary: '#12100e',
      bgTertiary: '#1b1714',
      glassBg: 'rgba(255, 255, 255, 0.03)',
      glassBorder: 'rgba(255, 232, 214, 0.12)',
      glassHighlight: 'rgba(255, 255, 255, 0.045)',
      textPrimary: 'rgba(255, 247, 240, 0.95)',
      textSecondary: 'rgba(242, 214, 188, 0.67)',
      textTertiary: 'rgba(222, 182, 150, 0.44)',
    },
    accent: '#ff9f5b',
    accentHover: '#ffbf8f',
    accentGlow: 'rgba(255, 159, 91, 0.34)',
  },
  crimson: {
    id: 'crimson',
    label: 'Crimson',
    description: 'Default theme with red accent',
    tokens: {
      bgPrimary: '#000000',
      bgSecondary: '#050505',
      bgTertiary: '#0a0a0a',
      glassBg: 'rgba(255, 255, 255, 0.03)',
      glassBorder: 'rgba(255, 255, 255, 0.08)',
      glassHighlight: 'rgba(255, 255, 255, 0.05)',
      textPrimary: 'rgba(255, 255, 255, 0.95)',
      textSecondary: 'rgba(255, 255, 255, 0.6)',
      textTertiary: 'rgba(255, 255, 255, 0.4)',
    },
    accent: '#ef4444',
    accentHover: '#f87171',
    accentGlow: 'rgba(239, 68, 68, 0.32)',
  },
}

export const THEME_PRESET_LIST: ThemePresetDefinition[] = Object.values(THEME_PRESETS)

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim()
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }

  const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
  if (!fullMatch) return null
  return `#${fullMatch[1].toLowerCase()}`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return null

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  }
}

function lightenChannel(channel: number, amount: number): number {
  return Math.round(channel + ((255 - channel) * amount))
}

function deriveAccentHover(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return DEFAULT_ACCENT
  const r = lightenChannel(rgb.r, 0.35)
  const g = lightenChannel(rgb.g, 0.35)
  const b = lightenChannel(rgb.b, 0.35)
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function deriveAccentGlow(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return THEME_PRESETS.default.accentGlow
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`
}

function resolveThemeTokens(presetId: ThemePresetId, customAccent: string | null): ResolvedThemeTokens {
  const preset = THEME_PRESETS[presetId] ?? THEME_PRESETS.default
  const accent = customAccent ?? preset.accent
  const accentHover = customAccent ? deriveAccentHover(customAccent) : preset.accentHover
  const accentGlow = customAccent ? deriveAccentGlow(customAccent) : preset.accentGlow

  return {
    ...preset.tokens,
    accent,
    accentHover,
    accentGlow,
  }
}

function applyTokensToDocument(tokens: ResolvedThemeTokens): void {
  const root = document.documentElement
  root.style.setProperty('--bg-primary', tokens.bgPrimary)
  root.style.setProperty('--bg-secondary', tokens.bgSecondary)
  root.style.setProperty('--bg-tertiary', tokens.bgTertiary)
  root.style.setProperty('--glass-bg', tokens.glassBg)
  root.style.setProperty('--glass-border', tokens.glassBorder)
  root.style.setProperty('--glass-highlight', tokens.glassHighlight)
  root.style.setProperty('--text-primary', tokens.textPrimary)
  root.style.setProperty('--text-secondary', tokens.textSecondary)
  root.style.setProperty('--text-tertiary', tokens.textTertiary)
  root.style.setProperty('--accent', tokens.accent)
  root.style.setProperty('--accent-hover', tokens.accentHover)
  root.style.setProperty('--accent-glow', tokens.accentGlow)
}

function persistThemeSettings(presetId: ThemePresetId, customAccent: string | null): void {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
    presetId,
    customAccent,
  }))
}

function readSavedThemeSettings(): { presetId: ThemePresetId; customAccent: string | null } | null {
  const raw = localStorage.getItem(THEME_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { presetId?: unknown; customAccent?: unknown }
    const presetCandidate = parsed.presetId
    const presetId = (
      presetCandidate === 'default'
      || presetCandidate === 'graphite'
      || presetCandidate === 'midnight'
      || presetCandidate === 'studio'
      || presetCandidate === 'crimson'
    )
      ? presetCandidate
      : DEFAULT_PRESET_ID

    const customAccent = typeof parsed.customAccent === 'string'
      ? normalizeHexColor(parsed.customAccent)
      : null

    return {
      presetId,
      customAccent,
    }
  } catch {
    return null
  }
}

export const useThemeStore = create<ThemeSettingsState>((set, get) => {
  const applyAndSet = (presetId: ThemePresetId, customAccent: string | null, persist: boolean) => {
    const resolvedTokens = resolveThemeTokens(presetId, customAccent)
    applyTokensToDocument(resolvedTokens)
    useVisualizerSettingsStore.getState().setLineColor(resolvedTokens.accent)
    set({ presetId, customAccent, resolvedTokens })
    if (persist) {
      persistThemeSettings(presetId, customAccent)
    }
  }

  const defaultTokens = resolveThemeTokens(DEFAULT_PRESET_ID, null)

  return {
    presetId: DEFAULT_PRESET_ID,
    customAccent: null,
    resolvedTokens: defaultTokens,
    setPreset: (presetId) => {
      applyAndSet(presetId, get().customAccent, true)
    },
    setCustomAccent: (accentHex) => {
      const normalized = normalizeHexColor(accentHex)
      if (!normalized) return
      applyAndSet(get().presetId, normalized, true)
    },
    usePresetAccent: () => {
      applyAndSet(get().presetId, null, true)
    },
    resetToDefault: () => {
      applyAndSet(DEFAULT_PRESET_ID, null, true)
    },
    initFromSaved: () => {
      const saved = readSavedThemeSettings()
      if (!saved) {
        applyAndSet(DEFAULT_PRESET_ID, null, false)
        return
      }

      applyAndSet(saved.presetId, saved.customAccent, false)
    },
  }
})
