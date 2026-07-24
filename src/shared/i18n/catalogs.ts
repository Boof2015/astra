/// <reference types="vite/client" />

import type { Resource, ResourceLanguage } from 'i18next'
import rawManifest from './locales/manifest.json' with { type: 'json' }
import enCommon from './locales/en/common.json' with { type: 'json' }
import enErrors from './locales/en/errors.json' with { type: 'json' }
import enIntegrations from './locales/en/integrations.json' with { type: 'json' }
import enLibrary from './locales/en/library.json' with { type: 'json' }
import enPlayback from './locales/en/playback.json' with { type: 'json' }
import enSettings from './locales/en/settings.json' with { type: 'json' }
import { normalizeLocaleCode, pseudoLocalizeMessage } from './core'
import { I18N_NAMESPACES, type LocaleManifest, type LocaleManifestEntry } from './types'

// The default locale is imported statically so English survives even where the glob below
// cannot run (bare Node, for example the store test suites that pull this module in).
const fallbackModules: Record<string, ResourceLanguage> = {
  './locales/en/common.json': enCommon as ResourceLanguage,
  './locales/en/errors.json': enErrors as ResourceLanguage,
  './locales/en/integrations.json': enIntegrations as ResourceLanguage,
  './locales/en/library.json': enLibrary as ResourceLanguage,
  './locales/en/playback.json': enPlayback as ResourceLanguage,
  './locales/en/settings.json': enSettings as ResourceLanguage,
}

// import.meta.glob is a build-time transform, so it must be called unconditionally: a
// `typeof import.meta.glob === 'function'` guard is always false at runtime and silently
// discards every catalog.
function loadLocaleModules(): Record<string, ResourceLanguage> {
  try {
    const bundled = import.meta.glob('./locales/*/*.json', {
      eager: true,
      import: 'default',
    }) as Record<string, ResourceLanguage>
    if (Object.keys(bundled).length > 0) return bundled
  } catch {
    // Not running through a bundler; the default locale below still applies.
  }
  return fallbackModules
}

const localeModules = loadLocaleModules()

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
