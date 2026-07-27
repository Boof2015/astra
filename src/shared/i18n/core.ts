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

/**
 * Generated keys carry no meaning — `auto.eqpanel.custom` is wherever the extractor happened to
 * find the word first. A hand-written key like `states.disabled` was named deliberately.
 */
export function isGeneratedKey(qualifiedKey: string): boolean {
  const key = qualifiedKey.slice(qualifiedKey.indexOf(':') + 1)
  return key.startsWith('auto.') || key.startsWith('runtime.')
}

/**
 * Ranks reverse-lookup candidates so that an English string shared by several keys always
 * resolves to the same one: hand-written keys before generated ones, then namespace order, then
 * the key path. Previously whichever key the catalogs happened to yield first won, which made
 * the choice an accident of object ordering and invisible until a second locale existed.
 *
 * Ambiguity is reported at build time by scripts/i18n/check-source-lookup.mjs. This only makes
 * the fallback predictable, it does not make an ambiguous string correct.
 */
export function compareSourceLookupCandidates(left: string, right: string): number {
  const leftGenerated = isGeneratedKey(left)
  const rightGenerated = isGeneratedKey(right)
  if (leftGenerated !== rightGenerated) return leftGenerated ? 1 : -1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Rewrites every message in a catalog to its own key.
 *
 * Running the app in this mode turns the UI into a map: each label reads as the key a
 * translator would edit, so "where does this string live?" is answered by looking at the screen
 * instead of grepping. It is also how the component-to-screen table in the context sidecars is
 * authored without guesswork.
 *
 * Unlike pseudoLocalizeMessage this has to know where it is in the tree, so it recurses with
 * the key path rather than transforming leaves in isolation.
 */
export function buildKeyOverlayCatalog(catalog: unknown, namespace: string, path = ''): unknown {
  if (typeof catalog === 'string') return `${namespace}:${path}`
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return catalog
  return Object.fromEntries(
    Object.entries(catalog as Record<string, unknown>).map(([key, child]) => [
      key,
      buildKeyOverlayCatalog(child, namespace, path ? `${path}.${key}` : key),
    ])
  )
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
