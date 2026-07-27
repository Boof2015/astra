import i18next, { type TOptions } from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  createBundledResources,
  getLocaleEntry,
  localeManifest,
  normalizeSupportedLocale,
  type DevLocale,
} from '../shared/i18n/catalogs'
import type { LocaleManifestEntry, SupportedLocale } from '../shared/i18n/types'
import { DISPLAY_LANGUAGE_STORAGE_KEY } from './constants/settingsStorageKeys'
import {
  compareSourceLookupCandidates,
  formatDateForLocale,
  formatNumberForLocale,
  isLocaleStorageChange,
  persistLocale,
  readStoredLocale,
} from '../shared/i18n/core'

/**
 * `?locale=en-XA` renders the expanded pseudo-locale for layout review; `?locale=en-KEY` renders
 * every string as its own catalog key, which turns the running app into a key-to-screen map for
 * anyone writing translator context. Neither is in the manifest, so neither can be selected by a
 * user — they exist only behind this query parameter.
 */
const devLocaleRequested = ((): DevLocale | null => {
  if (typeof window === 'undefined') return null
  const requested = new URLSearchParams(window.location.search).get('locale')
  return requested === 'en-XA' || requested === 'en-KEY' ? requested : null
})()

export const rendererI18n = i18next.createInstance()

let initializationPromise: Promise<void> | null = null
let storageListenerInstalled = false
let englishSourceLookup: Map<string, string> | null = null

function addSourceMessages(value: unknown, keyPrefix: string, result: Map<string, string[]>): void {
  if (typeof value === 'string') {
    const candidates = result.get(value)
    if (candidates) candidates.push(keyPrefix)
    else result.set(value, [keyPrefix])
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    addSourceMessages(child, keyPrefix ? `${keyPrefix}.${key}` : key, result)
  }
}

function getEnglishSourceLookup(): Map<string, string> {
  if (englishSourceLookup) return englishSourceLookup
  const candidatesBySource = new Map<string, string[]>()
  for (const namespace of ['common', 'settings', 'library', 'playback', 'integrations', 'errors']) {
    const bundle = rendererI18n.getResourceBundle(localeManifest.defaultLocale, namespace) as unknown
    const namespaceMessages = new Map<string, string[]>()
    addSourceMessages(bundle, '', namespaceMessages)
    for (const [source, keys] of namespaceMessages) {
      const qualified = keys.map((key) => `${namespace}:${key}`)
      const existing = candidatesBySource.get(source)
      if (existing) existing.push(...qualified)
      else candidatesBySource.set(source, qualified)
    }
  }

  const result = new Map<string, string>()
  for (const [source, candidates] of candidatesBySource) {
    result.set(source, candidates.sort(compareSourceLookupCandidates)[0])
  }
  englishSourceLookup = result
  return result
}

function readPersistedLocale(): SupportedLocale {
  return readStoredLocale(localStorage, DISPLAY_LANGUAGE_STORAGE_KEY, localeManifest)
}

function applyDocumentLocale(locale: string): void {
  const entry = getLocaleEntry(locale)
  document.documentElement.lang = locale
  document.documentElement.dir = entry?.direction ?? 'ltr'
}

async function applyLocale(locale: string, notifyMain: boolean): Promise<void> {
  const normalized = locale === devLocaleRequested
    ? locale
    : normalizeSupportedLocale(locale)
  await rendererI18n.changeLanguage(normalized)
  applyDocumentLocale(normalized)
  if (notifyMain) {
    await window.electronAPI.localization.setLocale(normalized).catch(() => undefined)
  }
}

function installStorageListener(): void {
  if (storageListenerInstalled) return
  storageListenerInstalled = true
  window.addEventListener('storage', (event) => {
    if (!isLocaleStorageChange(event.key, DISPLAY_LANGUAGE_STORAGE_KEY)) return
    void applyLocale(normalizeSupportedLocale(event.newValue), true)
  })
}

export function initializeRendererI18n(): Promise<void> {
  if (initializationPromise) return initializationPromise
  initializationPromise = (async () => {
    const initialLocale = devLocaleRequested ?? readPersistedLocale()
    await rendererI18n
      .use(initReactI18next)
      .init({
        resources: createBundledResources(devLocaleRequested),
        lng: initialLocale,
        fallbackLng: localeManifest.defaultLocale,
        defaultNS: 'common',
        fallbackNS: 'common',
        interpolation: { escapeValue: false },
        returnNull: false,
      })
    applyDocumentLocale(initialLocale)
    installStorageListener()
    await window.electronAPI.localization.setLocale(initialLocale).catch(() => undefined)
  })()
  return initializationPromise
}

export async function setDisplayLanguage(locale: SupportedLocale): Promise<string> {
  const normalized = persistLocale(localStorage, DISPLAY_LANGUAGE_STORAGE_KEY, locale, localeManifest)
  await applyLocale(normalized, true)
  return normalized
}

export function getDisplayLanguage(): string {
  return normalizeSupportedLocale(rendererI18n.resolvedLanguage ?? rendererI18n.language)
}

export function getDisplayLanguageOptions(): readonly LocaleManifestEntry[] {
  return localeManifest.locales
}

export function translate(key: string, options?: TOptions): string {
  return rendererI18n.t(key, options) as string
}

/**
 * Localizes legacy display metadata whose stable programmatic value is still English
 * (for example option arrays and action definitions). New component copy should use
 * explicit keys; this bridge keeps shared data models free of renderer-only concerns.
 */
export function translateSourceText(source: string): string {
  const key = getEnglishSourceLookup().get(source)
  return key ? translate(key) : source
}

export function formatLocaleNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberForLocale(getDisplayLanguage(), value, options)
}

export function formatLocaleDate(
  value: number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return formatDateForLocale(getDisplayLanguage(), value, options)
}
