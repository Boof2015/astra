import i18next, { type TOptions } from 'i18next'
import {
  createBundledResources,
  localeManifest,
  normalizeSupportedLocale,
} from '../shared/i18n/catalogs'

const mainI18n = i18next.createInstance()
let initializationPromise: Promise<void> | null = null

export function initializeMainI18n(): Promise<void> {
  if (initializationPromise) return initializationPromise
  initializationPromise = mainI18n.init({
    resources: createBundledResources(),
    lng: localeManifest.defaultLocale,
    fallbackLng: localeManifest.defaultLocale,
    defaultNS: 'common',
    fallbackNS: 'common',
    interpolation: { escapeValue: false },
    returnNull: false,
  }).then(() => undefined)
  return initializationPromise
}

export async function setMainLocale(locale: unknown): Promise<string> {
  await initializeMainI18n()
  const normalized = normalizeSupportedLocale(locale)
  await mainI18n.changeLanguage(normalized)
  return normalized
}

export function mainT(key: string, options?: TOptions): string {
  return mainI18n.t(key, options) as string
}

