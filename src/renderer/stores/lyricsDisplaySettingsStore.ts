import { create } from 'zustand'

export const LYRICS_DISPLAY_SETTINGS_STORAGE_KEY = 'astra-lyrics-display-settings-v1'
export const DEFAULT_LYRICS_TRANSLATION_PRIORITY = ['en', 'ja-Latn'] as const

export interface LyricsDisplaySettings {
  wordTimingEnabled: boolean
  furiganaEnabled: boolean
  translationsEnabled: boolean
  translationLanguagePriority: string[]
  voiceLabelsEnabled: boolean
}

interface LyricsDisplaySettingsStore {
  settings: LyricsDisplaySettings
  setWordTimingEnabled: (enabled: boolean) => void
  setFuriganaEnabled: (enabled: boolean) => void
  setTranslationsEnabled: (enabled: boolean) => void
  setTranslationLanguagePriority: (value: string[] | string) => void
  setVoiceLabelsEnabled: (enabled: boolean) => void
  resetToDefaults: () => void
}

export const DEFAULT_LYRICS_DISPLAY_SETTINGS: LyricsDisplaySettings = {
  wordTimingEnabled: true,
  furiganaEnabled: true,
  translationsEnabled: true,
  translationLanguagePriority: [...DEFAULT_LYRICS_TRANSLATION_PRIORITY],
  voiceLabelsEnabled: false
}

let storageListenerInstalled = false

export function normalizeTranslationLanguagePriority(value: string[] | string | unknown): string[] {
  const rawList = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const priority = rawList
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
  return Array.from(new Set(priority))
}

function normalizeSettings(value: unknown): LyricsDisplaySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_LYRICS_DISPLAY_SETTINGS }
  }

  const raw = value as Partial<LyricsDisplaySettings>
  const translationLanguagePriority = normalizeTranslationLanguagePriority(raw.translationLanguagePriority)
  return {
    wordTimingEnabled: typeof raw.wordTimingEnabled === 'boolean'
      ? raw.wordTimingEnabled
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.wordTimingEnabled,
    furiganaEnabled: typeof raw.furiganaEnabled === 'boolean'
      ? raw.furiganaEnabled
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.furiganaEnabled,
    translationsEnabled: typeof raw.translationsEnabled === 'boolean'
      ? raw.translationsEnabled
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.translationsEnabled,
    translationLanguagePriority: translationLanguagePriority.length > 0
      ? translationLanguagePriority
      : [...DEFAULT_LYRICS_DISPLAY_SETTINGS.translationLanguagePriority],
    voiceLabelsEnabled: typeof raw.voiceLabelsEnabled === 'boolean'
      ? raw.voiceLabelsEnabled
      : DEFAULT_LYRICS_DISPLAY_SETTINGS.voiceLabelsEnabled
  }
}

function readSettings(): LyricsDisplaySettings {
  try {
    const raw = localStorage.getItem(LYRICS_DISPLAY_SETTINGS_STORAGE_KEY)
    return normalizeSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_LYRICS_DISPLAY_SETTINGS }
  }
}

function persistSettings(settings: LyricsDisplaySettings): void {
  try {
    localStorage.setItem(LYRICS_DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Keep the in-memory preference if localStorage is unavailable.
  }
}

export const useLyricsDisplaySettingsStore = create<LyricsDisplaySettingsStore>((set) => {
  const applySettings = (settings: LyricsDisplaySettings) => {
    persistSettings(settings)
    set({ settings })
  }

  if (!storageListenerInstalled && typeof window !== 'undefined') {
    storageListenerInstalled = true
    window.addEventListener('storage', (event) => {
      if (event.key !== LYRICS_DISPLAY_SETTINGS_STORAGE_KEY) return
      set({ settings: readSettings() })
    })
  }

  return {
    settings: readSettings(),
    setWordTimingEnabled: (enabled) => set((state) => {
      const settings = { ...state.settings, wordTimingEnabled: Boolean(enabled) }
      persistSettings(settings)
      return { settings }
    }),
    setFuriganaEnabled: (enabled) => set((state) => {
      const settings = { ...state.settings, furiganaEnabled: Boolean(enabled) }
      persistSettings(settings)
      return { settings }
    }),
    setTranslationsEnabled: (enabled) => set((state) => {
      const settings = { ...state.settings, translationsEnabled: Boolean(enabled) }
      persistSettings(settings)
      return { settings }
    }),
    setTranslationLanguagePriority: (value) => set((state) => {
      const priority = normalizeTranslationLanguagePriority(value)
      const settings = {
        ...state.settings,
        translationLanguagePriority: priority.length > 0
          ? priority
          : [...DEFAULT_LYRICS_DISPLAY_SETTINGS.translationLanguagePriority]
      }
      persistSettings(settings)
      return { settings }
    }),
    setVoiceLabelsEnabled: (enabled) => set((state) => {
      const settings = { ...state.settings, voiceLabelsEnabled: Boolean(enabled) }
      persistSettings(settings)
      return { settings }
    }),
    resetToDefaults: () => applySettings({ ...DEFAULT_LYRICS_DISPLAY_SETTINGS })
  }
})
