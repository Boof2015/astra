import type { LocaleManifest } from './types'

export interface LocaleStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function isLocaleStorageChange(eventKey: string | null, storageKey: string): boolean {
  return eventKey === storageKey
}

export function formatNumberForLocale(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function formatDateForLocale(
  locale: string,
  value: number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(locale, options).format(value)
}

export function normalizeLocaleCode(code: unknown, manifest: LocaleManifest): string {
  if (typeof code !== 'string') return manifest.defaultLocale
  return manifest.locales.some((locale) => locale.code === code)
    ? code
    : manifest.defaultLocale
}

export function readStoredLocale(
  storage: LocaleStorage,
  key: string,
  manifest: LocaleManifest
): string {
  try {
    return normalizeLocaleCode(storage.getItem(key), manifest)
  } catch {
    return manifest.defaultLocale
  }
}

export function persistLocale(
  storage: LocaleStorage,
  key: string,
  locale: unknown,
  manifest: LocaleManifest
): string {
  const normalized = normalizeLocaleCode(locale, manifest)
  try {
    storage.setItem(key, normalized)
  } catch {
    // The caller can still use the normalized in-memory locale.
  }
  return normalized
}

export function extractInterpolationVariables(message: string): string[] {
  const variables = new Set<string>()
  const matcher = /{{\s*([A-Za-z0-9_.-]+)(?:\s*,[^}]*)?\s*}}/g
  for (const match of message.matchAll(matcher)) {
    variables.add(match[1])
  }
  return Array.from(variables).sort()
}

export function pseudoLocalizeMessage(message: string): string {
  const replacements: Record<string, string> = {
    a: 'á', A: 'Á', e: 'ë', E: 'Ë', i: 'ï', I: 'Ï', o: 'ô', O: 'Ô',
    u: 'ü', U: 'Ü', c: 'ç', C: 'Ç', n: 'ñ', N: 'Ñ', y: 'ÿ', Y: 'Ÿ',
  }
  const expanded = message
    .split(/({{.*?}})/g)
    .map((part) => part.startsWith('{{')
      ? part
      : part.replace(/[A-Za-z]/g, (character) => replacements[character] ?? character))
    .join('')
  return `［${expanded} ···］`
}
