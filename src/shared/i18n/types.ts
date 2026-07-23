export const I18N_NAMESPACES = [
  'common',
  'settings',
  'library',
  'playback',
  'integrations',
  'errors',
] as const

export type I18nNamespace = (typeof I18N_NAMESPACES)[number]
export type LocaleDirection = 'ltr' | 'rtl'

export interface LocaleManifestEntry {
  code: string
  name: string
  nativeName: string
  direction: LocaleDirection
}

export interface LocaleManifest {
  defaultLocale: string
  locales: LocaleManifestEntry[]
}

// Locale codes are data-driven so contributors can add a locale without changing a
// central TypeScript union. Runtime validation still guarantees that only manifest
// entries can be selected.
export type SupportedLocale = string

