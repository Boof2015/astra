/// <reference types="vite/client" />

import type { Resource, ResourceLanguage } from 'i18next'
import rawManifest from './locales/manifest.json' with { type: 'json' }
import { normalizeLocaleCode, pseudoLocalizeMessage } from './core'
import { I18N_NAMESPACES, type LocaleManifest, type LocaleManifestEntry } from './types'

const localeModules = typeof import.meta.glob === 'function'
  ? import.meta.glob('./locales/*/*.json', {
      eager: true,
      import: 'default',
    }) as Record<string, ResourceLanguage>
  : {}

export const localeManifest = rawManifest as LocaleManifest

export function getLocaleEntry(code: string): LocaleManifestEntry | null {
  return localeManifest.locales.find((locale) => locale.code === code) ?? null
}

export function isSupportedLocale(code: unknown): code is string {
  return typeof code === 'string' && getLocaleEntry(code) !== null
}

export function normalizeSupportedLocale(code: unknown): string {
  return normalizeLocaleCode(code, localeManifest)
}

function pseudoLocalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return pseudoLocalizeMessage(value)
  }
  if (Array.isArray(value)) return value.map(pseudoLocalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, pseudoLocalize(child)])
    )
  }
  return value
}

export function createBundledResources(includePseudoLocale = false): Resource {
  const resources: Resource = {}

  for (const [modulePath, catalog] of Object.entries(localeModules)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(modulePath)
    if (!match) continue
    const [, locale, namespace] = match
    if (!I18N_NAMESPACES.includes(namespace as (typeof I18N_NAMESPACES)[number])) continue
    resources[locale] ??= {}
    resources[locale][namespace] = catalog
  }

  if (includePseudoLocale) {
    const english = resources[localeManifest.defaultLocale]
    if (english) {
      resources['en-XA'] = Object.fromEntries(
        Object.entries(english).map(([namespace, catalog]) => [namespace, pseudoLocalize(catalog)])
      ) as Record<string, ResourceLanguage>
    }
  }

  return resources
}
