import { create } from 'zustand'
import { useVisualizerSettingsStore } from './visualizerSettingsStore'

export type ThemePresetId = 'default' | 'graphite' | 'editor' | 'midnight' | 'studio' | 'crimson' | 'light'
export type AccentSource = 'theme' | 'cover-art'
export type CoverArtAccentMethod = 'dominant' | 'average' | 'vibrant'

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
  // Foreground tint channel ("R, G, B") used by globals.css via rgba(var(--tint), a).
  // White on dark themes, black on light, so every inline white-tint flips coherently.
  tint: string
  // Opaque chrome panels (transport bar, popovers, tooltips).
  surfaceOverlay: string
  // Translucent zone-darkening scrims on top of chrome.
  scrimSoft: string
  scrimStrong: string
  // Text color that sits on an inverted (tint) fill.
  onAccent: string
  // Recessed/control surfaces bucketed by depth (dark uses high-alpha black, light
  // uses explicit low-alpha values that can't be reached by inverting alpha).
  controlBgSoft: string
  controlBg: string
  controlBgStrong: string
  controlBorder: string
  // Faint eyebrow/section-label text (needs more contrast on light than inverted tint).
  eyebrow: string
  // Emphatic text that was a solid white literal (flips to near-black on light).
  textStrong: string
  // Analyzer/graph/EQ display surfaces and drawing colors.
  stageBg: string
  stageSurface: string
  stageBorder: string
  stageGrid: string
  stageText: string
  stageTextMuted: string
  shadowSoft: string
  isLight: boolean
  accent: string
  accentHover: string
  accentGlow: string
}

type SurfaceTokens = Pick<
  ResolvedThemeTokens,
  | 'tint'
  | 'surfaceOverlay'
  | 'scrimSoft'
  | 'scrimStrong'
  | 'onAccent'
  | 'controlBgSoft'
  | 'controlBg'
  | 'controlBgStrong'
  | 'controlBorder'
  | 'eyebrow'
  | 'textStrong'
  | 'stageBg'
  | 'stageSurface'
  | 'stageBorder'
  | 'stageGrid'
  | 'stageText'
  | 'stageTextMuted'
  | 'shadowSoft'
>

// Surface tokens shared by every dark preset, resolved by isLight so the existing
// presets keep only their 9 base color tokens and don't need per-preset overrides.
// The dark values match today's hardcoded shades (imperceptible shift); light values
// are explicit low-alpha surfaces because high-alpha black can't be inverted cleanly.
const DARK_SURFACE_DEFAULTS: SurfaceTokens = {
  tint: '255, 255, 255',
  surfaceOverlay: 'rgba(5, 5, 5, 0.95)',
  scrimSoft: 'rgba(0, 0, 0, 0.4)',
  scrimStrong: 'rgba(0, 0, 0, 0.6)',
  onAccent: '#050505',
  controlBgSoft: 'rgba(0, 0, 0, 0.18)',
  controlBg: 'rgba(0, 0, 0, 0.3)',
  controlBgStrong: 'rgba(0, 0, 0, 0.45)',
  controlBorder: 'rgba(255, 255, 255, 0.1)',
  eyebrow: 'rgba(255, 255, 255, 0.4)',
  textStrong: '#ffffff',
  stageBg: '#0a0e14',
  stageSurface: 'rgba(8, 10, 14, 0.985)',
  stageBorder: 'rgba(255, 255, 255, 0.08)',
  stageGrid: 'rgba(255, 255, 255, 0.1)',
  stageText: 'rgba(255, 255, 255, 0.88)',
  stageTextMuted: 'rgba(255, 255, 255, 0.46)',
  shadowSoft: 'rgba(0, 0, 0, 0.28)',
}

const LIGHT_SURFACE_DEFAULTS: SurfaceTokens = {
  tint: '0, 0, 0',
  surfaceOverlay: 'rgba(246, 247, 249, 0.95)',
  scrimSoft: 'rgba(0, 0, 0, 0.05)',
  scrimStrong: 'rgba(0, 0, 0, 0.1)',
  onAccent: '#ffffff',
  controlBgSoft: 'rgba(0, 0, 0, 0.035)',
  controlBg: 'rgba(0, 0, 0, 0.05)',
  controlBgStrong: 'rgba(0, 0, 0, 0.08)',
  controlBorder: 'rgba(0, 0, 0, 0.1)',
  eyebrow: 'rgba(0, 0, 0, 0.55)',
  textStrong: '#0b0d12',
  stageBg: '#f1f4f8',
  stageSurface: 'rgba(255, 255, 255, 0.92)',
  stageBorder: 'rgba(15, 23, 42, 0.12)',
  stageGrid: 'rgba(15, 23, 42, 0.13)',
  stageText: 'rgba(15, 23, 42, 0.82)',
  stageTextMuted: 'rgba(15, 23, 42, 0.48)',
  shadowSoft: 'rgba(15, 23, 42, 0.12)',
}

// Base color tokens carried by each preset definition (surface tokens come from the
// DARK/LIGHT defaults above, accent trio is resolved separately).
type PresetBaseTokens = Omit<
  ResolvedThemeTokens,
  'accent' | 'accentHover' | 'accentGlow' | 'isLight' | keyof SurfaceTokens
>

interface ThemePresetDefinition {
  id: ThemePresetId
  label: string
  description: string
  // Light presets derive accent text by darkening (not lightening) the accent.
  isLight?: boolean
  // Some presets intentionally specify exact hover/glow values instead of deriving them.
  usePresetAccentVariants?: boolean
  tokens: PresetBaseTokens
  surfaceOverrides?: Partial<SurfaceTokens>
  accent: string
  accentHover: string
  accentGlow: string
}

interface SavedThemeSettings {
  presetId: ThemePresetId
  customAccent: string | null
  accentSource: AccentSource
  coverArtAccentMethod: CoverArtAccentMethod
}

export interface ThemeSettingsState {
  presetId: ThemePresetId
  customAccent: string | null
  accentSource: AccentSource
  coverArtAccentMethod: CoverArtAccentMethod
  coverArtAccent: string | null
  resolvedTokens: ResolvedThemeTokens
  setPreset: (presetId: ThemePresetId) => void
  setCustomAccent: (accentHex: string) => void
  usePresetAccent: () => void
  setAccentSource: (source: AccentSource) => void
  setCoverArtAccentMethod: (method: CoverArtAccentMethod) => void
  setCoverArtAccent: (accentHexOrNull: string | null) => void
  resetToDefault: () => void
  initFromSaved: () => void
}

export const THEME_STORAGE_KEY = 'astra-theme-settings-v1'
const DEFAULT_PRESET_ID: ThemePresetId = 'default'
const DEFAULT_ACCENT_SOURCE: AccentSource = 'theme'
const DEFAULT_COVER_ART_ACCENT_METHOD: CoverArtAccentMethod = 'dominant'
const DEFAULT_ACCENT = '#38bdf8'
const ACCENT_TRANSITION_MS = 280
const REDUCED_MOTION_ACCENT_TRANSITION_MS = 80

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
  editor: {
    id: 'editor',
    label: 'Editor',
    description: 'High-clarity neutral dark',
    usePresetAccentVariants: true,
    tokens: {
      bgPrimary: '#0f0f0f',
      bgSecondary: '#171717',
      bgTertiary: '#1c1c1c',
      glassBg: 'rgba(28, 28, 28, 0.82)',
      glassBorder: '#2a2a2a',
      glassHighlight: 'rgba(255, 255, 255, 0.04)',
      textPrimary: '#f0f0f0',
      textSecondary: '#9a9a9a',
      // XLRCDB's #6a6a6a is reserved for decorative/disabled content; meaningful
      // Astra helper text uses its AA-safe secondary value as a readability floor.
      textTertiary: '#9a9a9a',
    },
    surfaceOverrides: {
      surfaceOverlay: 'rgba(15, 15, 15, 0.98)',
      scrimSoft: 'rgba(0, 0, 0, 0.18)',
      scrimStrong: 'rgba(0, 0, 0, 0.38)',
      onAccent: '#0f0f0f',
      controlBgSoft: '#171717',
      controlBg: '#1c1c1c',
      controlBgStrong: '#262626',
      controlBorder: '#3d3d3d',
      eyebrow: '#9a9a9a',
      stageBg: '#0f0f0f',
      stageSurface: '#171717',
      stageBorder: '#2a2a2a',
      stageGrid: 'rgba(240, 240, 240, 0.1)',
      stageText: '#d6d6d6',
      stageTextMuted: '#9a9a9a',
      shadowSoft: 'rgba(0, 0, 0, 0.45)',
    },
    accent: '#38bdf8',
    accentHover: '#70d3ff',
    accentGlow: 'rgba(56, 189, 248, 0.14)',
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
  light: {
    id: 'light',
    label: 'Light',
    description: 'Bright daylight surfaces',
    isLight: true,
    tokens: {
      bgPrimary: '#f6f7f9',
      bgSecondary: '#eceef2',
      bgTertiary: '#e2e5ea',
      glassBg: 'rgba(0, 0, 0, 0.03)',
      glassBorder: 'rgba(0, 0, 0, 0.10)',
      glassHighlight: 'rgba(0, 0, 0, 0.05)',
      textPrimary: 'rgba(0, 0, 0, 0.92)',
      textSecondary: 'rgba(0, 0, 0, 0.6)',
      textTertiary: 'rgba(0, 0, 0, 0.42)',
    },
    accent: '#0369a1',
    accentHover: '#075985',
    accentGlow: 'rgba(3, 105, 161, 0.24)',
  },
}

export const THEME_PRESET_LIST: ThemePresetDefinition[] = Object.values(THEME_PRESETS)
export const DEFAULT_THEME_ACCENT = THEME_PRESETS.default.accent

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

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`
}

function lightenChannel(channel: number, amount: number): number {
  return Math.round(channel + ((255 - channel) * amount))
}

function darkenChannel(channel: number, amount: number): number {
  return Math.round(channel * (1 - amount))
}

function deriveAccentHover(hex: string, darken = false): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return DEFAULT_ACCENT
  const adjust = darken ? darkenChannel : lightenChannel
  const amount = darken ? 0.15 : 0.35
  const r = adjust(rgb.r, amount)
  const g = adjust(rgb.g, amount)
  const b = adjust(rgb.b, amount)
  return rgbToHex(r, g, b)
}

function deriveAccentGlow(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return THEME_PRESETS.default.accentGlow
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`
}

function deriveAccentRgb(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '56, 189, 248'
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
}

function deriveHueFromRgb({ r, g, b }: { r: number; g: number; b: number }): number {
  const nr = r / 255
  const ng = g / 255
  const nb = b / 255
  const max = Math.max(nr, ng, nb)
  const min = Math.min(nr, ng, nb)
  const delta = max - min

  if (delta === 0) return 0

  let hueSegment = 0
  if (max === nr) {
    hueSegment = ((ng - nb) / delta) % 6
  } else if (max === ng) {
    hueSegment = ((nb - nr) / delta) + 2
  } else {
    hueSegment = ((nr - ng) / delta) + 4
  }

  const hue = (hueSegment * 60 + 360) % 360
  return Math.round(hue)
}

export function deriveAccentHue(hex: string): number {
  const rgb = hexToRgb(hex)
  if (rgb) return deriveHueFromRgb(rgb)

  const fallbackRgb = hexToRgb(DEFAULT_ACCENT)
  if (fallbackRgb) return deriveHueFromRgb(fallbackRgb)

  return 199
}

function deriveAccentText(hex: string, amount: number, fallbackHex: string, darken = false): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return fallbackHex

  const adjust = darken ? darkenChannel : lightenChannel
  return rgbToHex(
    adjust(rgb.r, amount),
    adjust(rgb.g, amount),
    adjust(rgb.b, amount)
  )
}

export function resolveThemeTokens(
  presetId: ThemePresetId,
  customAccent: string | null,
  accentSource: AccentSource,
  coverArtAccent: string | null
): ResolvedThemeTokens {
  const preset = THEME_PRESETS[presetId] ?? THEME_PRESETS.default
  const themeAccent = customAccent ?? preset.accent
  const effectiveAccent = accentSource === 'cover-art' && coverArtAccent
    ? coverArtAccent
    : themeAccent
  const isLight = Boolean(preset.isLight)
  const usesPresetAccent = customAccent === null && !(accentSource === 'cover-art' && coverArtAccent)
  const usesExactPresetAccentVariants = usesPresetAccent && (isLight || preset.usePresetAccentVariants)

  return {
    ...preset.tokens,
    ...(isLight ? LIGHT_SURFACE_DEFAULTS : DARK_SURFACE_DEFAULTS),
    ...preset.surfaceOverrides,
    isLight,
    accent: effectiveAccent,
    accentHover: usesExactPresetAccentVariants
      ? preset.accentHover
      : deriveAccentHover(effectiveAccent, isLight),
    accentGlow: usesExactPresetAccentVariants
      ? preset.accentGlow
      : deriveAccentGlow(effectiveAccent),
  }
}

function applyNonAccentTokensToDocument(tokens: ResolvedThemeTokens): void {
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
  root.style.setProperty('--tint', tokens.tint)
  root.style.setProperty('--surface-overlay', tokens.surfaceOverlay)
  root.style.setProperty('--scrim-soft', tokens.scrimSoft)
  root.style.setProperty('--scrim-strong', tokens.scrimStrong)
  root.style.setProperty('--on-accent', tokens.onAccent)
  root.style.setProperty('--control-bg-soft', tokens.controlBgSoft)
  root.style.setProperty('--control-bg', tokens.controlBg)
  root.style.setProperty('--control-bg-strong', tokens.controlBgStrong)
  root.style.setProperty('--control-border', tokens.controlBorder)
  root.style.setProperty('--eyebrow', tokens.eyebrow)
  root.style.setProperty('--text-strong', tokens.textStrong)
  root.style.setProperty('--stage-bg', tokens.stageBg)
  root.style.setProperty('--stage-surface', tokens.stageSurface)
  root.style.setProperty('--stage-border', tokens.stageBorder)
  root.style.setProperty('--stage-grid', tokens.stageGrid)
  root.style.setProperty('--stage-text', tokens.stageText)
  root.style.setProperty('--stage-text-muted', tokens.stageTextMuted)
  root.style.setProperty('--shadow-soft', tokens.shadowSoft)
  root.dataset.themeTone = tokens.isLight ? 'light' : 'dark'
}

function applyAccentTokensToDocument(
  accent: string,
  accentHover: string,
  accentGlow: string,
  isLight = false
): void {
  const root = document.documentElement
  const accentRgb = deriveAccentRgb(accent)
  const accentHoverRgb = deriveAccentRgb(accentHover)
  // On dark themes accent text is lightened for legibility; on light themes it must
  // be darkened instead so accent-colored text stays readable on bright surfaces.
  const accentText = isLight
    ? deriveAccentText(accent, 0.1, '#0369a1', true)
    : deriveAccentText(accent, 0.65, '#bae6fd')
  const accentTextStrong = isLight
    ? deriveAccentText(accent, 0.3, '#075985', true)
    : deriveAccentText(accent, 0.85, '#e0f2fe')
  const accentHue = deriveAccentHue(accent)

  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-hover', accentHover)
  root.style.setProperty('--accent-glow', accentGlow)
  root.style.setProperty('--accent-rgb', accentRgb)
  root.style.setProperty('--accent-hover-rgb', accentHoverRgb)
  root.style.setProperty('--accent-text', accentText)
  root.style.setProperty('--accent-text-strong', accentTextStrong)
  root.style.setProperty('--accent-h', `${accentHue}`)
}

function persistThemeSettings(
  presetId: ThemePresetId,
  customAccent: string | null,
  accentSource: AccentSource,
  coverArtAccentMethod: CoverArtAccentMethod
): void {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
    presetId,
    customAccent,
    accentSource,
    coverArtAccentMethod,
  }))
}

function readSavedThemeSettings(): SavedThemeSettings | null {
  const raw = localStorage.getItem(THEME_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as {
      presetId?: unknown
      customAccent?: unknown
      accentSource?: unknown
      coverArtAccentMethod?: unknown
    }

    const presetCandidate = parsed.presetId
    const presetId = (
      presetCandidate === 'default'
      || presetCandidate === 'graphite'
      || presetCandidate === 'editor'
      || presetCandidate === 'midnight'
      || presetCandidate === 'studio'
      || presetCandidate === 'crimson'
      || presetCandidate === 'light'
    )
      ? presetCandidate
      : DEFAULT_PRESET_ID

    const customAccent = typeof parsed.customAccent === 'string'
      ? normalizeHexColor(parsed.customAccent)
      : null

    const accentSource = parsed.accentSource === 'cover-art'
      ? 'cover-art'
      : DEFAULT_ACCENT_SOURCE

    const coverArtAccentMethod = (
      parsed.coverArtAccentMethod === 'average'
      || parsed.coverArtAccentMethod === 'vibrant'
    )
      ? parsed.coverArtAccentMethod
      : DEFAULT_COVER_ART_ACCENT_METHOD

    return {
      presetId,
      customAccent,
      accentSource,
      coverArtAccentMethod,
    }
  } catch {
    return null
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function easeInOutSine(value: number): number {
  return 0.5 - (Math.cos(Math.PI * value) / 2)
}

interface ThemeMutation {
  presetId: ThemePresetId
  customAccent: string | null
  accentSource: AccentSource
  coverArtAccentMethod: CoverArtAccentMethod
  coverArtAccent: string | null
}

export const useThemeStore = create<ThemeSettingsState>((set, get) => {
  let accentAnimationFrame: number | null = null
  let accentAnimationToken = 0

  const cancelAccentAnimation = () => {
    if (accentAnimationFrame !== null) {
      window.cancelAnimationFrame(accentAnimationFrame)
      accentAnimationFrame = null
    }
    accentAnimationToken += 1
  }

  const applyAndSet = (nextState: ThemeMutation, persist: boolean) => {
    const normalizedCustomAccent = nextState.customAccent ? normalizeHexColor(nextState.customAccent) : null
    const normalizedCoverArtAccent = nextState.coverArtAccent ? normalizeHexColor(nextState.coverArtAccent) : null

    const targetTokens = resolveThemeTokens(
      nextState.presetId,
      normalizedCustomAccent,
      nextState.accentSource,
      normalizedCoverArtAccent
    )
    const isLight = Boolean(THEME_PRESETS[nextState.presetId]?.isLight)

    const previousAccent = normalizeHexColor(get().resolvedTokens.accent) ?? targetTokens.accent
    const initialAccent = previousAccent
    const initialTokens: ResolvedThemeTokens = {
      ...targetTokens,
      accent: initialAccent,
      accentHover: deriveAccentHover(initialAccent, isLight),
      accentGlow: deriveAccentGlow(initialAccent),
    }

    cancelAccentAnimation()

    applyNonAccentTokensToDocument(targetTokens)
    document.documentElement.dataset.themePreset = nextState.presetId
    applyAccentTokensToDocument(initialTokens.accent, initialTokens.accentHover, initialTokens.accentGlow, isLight)
    useVisualizerSettingsStore.getState().setLineColor(initialTokens.accent)

    set({
      presetId: nextState.presetId,
      customAccent: normalizedCustomAccent,
      accentSource: nextState.accentSource,
      coverArtAccentMethod: nextState.coverArtAccentMethod,
      coverArtAccent: normalizedCoverArtAccent,
      resolvedTokens: initialTokens,
    })

    if (persist) {
      persistThemeSettings(
        nextState.presetId,
        normalizedCustomAccent,
        nextState.accentSource,
        nextState.coverArtAccentMethod
      )
    }

    if (initialTokens.accent === targetTokens.accent) {
      set((state) => ({
        resolvedTokens: {
          ...state.resolvedTokens,
          accent: targetTokens.accent,
          accentHover: targetTokens.accentHover,
          accentGlow: targetTokens.accentGlow,
        },
      }))
      applyAccentTokensToDocument(targetTokens.accent, targetTokens.accentHover, targetTokens.accentGlow, isLight)
      useVisualizerSettingsStore.getState().setLineColor(targetTokens.accent)
      return
    }

    const startRgb = hexToRgb(initialTokens.accent)
    const endRgb = hexToRgb(targetTokens.accent)
    if (!startRgb || !endRgb) {
      applyAccentTokensToDocument(targetTokens.accent, targetTokens.accentHover, targetTokens.accentGlow, isLight)
      useVisualizerSettingsStore.getState().setLineColor(targetTokens.accent)
      set((state) => ({
        resolvedTokens: {
          ...state.resolvedTokens,
          accent: targetTokens.accent,
          accentHover: targetTokens.accentHover,
          accentGlow: targetTokens.accentGlow,
        },
      }))
      return
    }

    const durationMs = prefersReducedMotion()
      ? REDUCED_MOTION_ACCENT_TRANSITION_MS
      : ACCENT_TRANSITION_MS

    const animationToken = ++accentAnimationToken
    let startTime: number | null = null

    const animate = (timestamp: number) => {
      if (animationToken !== accentAnimationToken) return

      if (startTime == null) {
        startTime = timestamp
      }

      const elapsed = timestamp - startTime
      const progress = Math.max(0, Math.min(1, elapsed / durationMs))
      const eased = easeInOutSine(progress)

      const accent = rgbToHex(
        startRgb.r + ((endRgb.r - startRgb.r) * eased),
        startRgb.g + ((endRgb.g - startRgb.g) * eased),
        startRgb.b + ((endRgb.b - startRgb.b) * eased)
      )
      const accentHover = deriveAccentHover(accent, isLight)
      const accentGlow = deriveAccentGlow(accent)

      applyAccentTokensToDocument(accent, accentHover, accentGlow, isLight)
      useVisualizerSettingsStore.getState().setLineColor(accent)
      set((state) => ({
        resolvedTokens: {
          ...state.resolvedTokens,
          accent,
          accentHover,
          accentGlow,
        },
      }))

      if (progress >= 1) {
        accentAnimationFrame = null
        applyAccentTokensToDocument(targetTokens.accent, targetTokens.accentHover, targetTokens.accentGlow, isLight)
        useVisualizerSettingsStore.getState().setLineColor(targetTokens.accent)
        set((state) => ({
          resolvedTokens: {
            ...state.resolvedTokens,
            accent: targetTokens.accent,
            accentHover: targetTokens.accentHover,
            accentGlow: targetTokens.accentGlow,
          },
        }))
        return
      }

      accentAnimationFrame = window.requestAnimationFrame(animate)
    }

    accentAnimationFrame = window.requestAnimationFrame(animate)
  }

  const defaultTokens = resolveThemeTokens(
    DEFAULT_PRESET_ID,
    null,
    DEFAULT_ACCENT_SOURCE,
    null
  )

  return {
    presetId: DEFAULT_PRESET_ID,
    customAccent: null,
    accentSource: DEFAULT_ACCENT_SOURCE,
    coverArtAccentMethod: DEFAULT_COVER_ART_ACCENT_METHOD,
    coverArtAccent: null,
    resolvedTokens: defaultTokens,
    setPreset: (presetId) => {
      const state = get()
      applyAndSet({
        presetId,
        customAccent: state.customAccent,
        accentSource: state.accentSource,
        coverArtAccentMethod: state.coverArtAccentMethod,
        coverArtAccent: state.coverArtAccent,
      }, true)
    },
    setCustomAccent: (accentHex) => {
      const normalized = normalizeHexColor(accentHex)
      if (!normalized) return

      const state = get()
      applyAndSet({
        presetId: state.presetId,
        customAccent: normalized,
        accentSource: state.accentSource,
        coverArtAccentMethod: state.coverArtAccentMethod,
        coverArtAccent: state.coverArtAccent,
      }, true)
    },
    usePresetAccent: () => {
      const state = get()
      applyAndSet({
        presetId: state.presetId,
        customAccent: null,
        accentSource: state.accentSource,
        coverArtAccentMethod: state.coverArtAccentMethod,
        coverArtAccent: state.coverArtAccent,
      }, true)
    },
    setAccentSource: (source) => {
      const state = get()
      applyAndSet({
        presetId: state.presetId,
        customAccent: state.customAccent,
        accentSource: source,
        coverArtAccentMethod: state.coverArtAccentMethod,
        coverArtAccent: source === 'cover-art' ? state.coverArtAccent : null,
      }, true)
    },
    setCoverArtAccentMethod: (method) => {
      const state = get()
      applyAndSet({
        presetId: state.presetId,
        customAccent: state.customAccent,
        accentSource: state.accentSource,
        coverArtAccentMethod: method,
        coverArtAccent: state.coverArtAccent,
      }, true)
    },
    setCoverArtAccent: (accentHexOrNull) => {
      const normalized = accentHexOrNull ? normalizeHexColor(accentHexOrNull) : null
      const state = get()
      if (state.coverArtAccent === normalized) return

      applyAndSet({
        presetId: state.presetId,
        customAccent: state.customAccent,
        accentSource: state.accentSource,
        coverArtAccentMethod: state.coverArtAccentMethod,
        coverArtAccent: normalized,
      }, false)
    },
    resetToDefault: () => {
      applyAndSet({
        presetId: DEFAULT_PRESET_ID,
        customAccent: null,
        accentSource: DEFAULT_ACCENT_SOURCE,
        coverArtAccentMethod: DEFAULT_COVER_ART_ACCENT_METHOD,
        coverArtAccent: null,
      }, true)
    },
    initFromSaved: () => {
      const saved = readSavedThemeSettings()
      if (!saved) {
        applyAndSet({
          presetId: DEFAULT_PRESET_ID,
          customAccent: null,
          accentSource: DEFAULT_ACCENT_SOURCE,
          coverArtAccentMethod: DEFAULT_COVER_ART_ACCENT_METHOD,
          coverArtAccent: null,
        }, false)
        return
      }

      applyAndSet({
        presetId: saved.presetId,
        customAccent: saved.customAccent,
        accentSource: saved.accentSource,
        coverArtAccentMethod: saved.coverArtAccentMethod,
        coverArtAccent: null,
      }, false)
    },
  }
})
