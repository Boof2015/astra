import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Records the English text each translation was made from.
 *
 * This is the fix for the one way translations rot silently. Keys are literals in both the
 * source and the catalogs, so editing English copy edits a catalog *value* and leaves the key
 * untouched — every locale keeps its translation, still bound to the key, now translated from
 * English that no longer exists. Nothing in the validator could see that, because both files
 * are structurally perfect.
 *
 * State lives outside `locales/` on purpose: `catalogs.ts` globs `./locales/*​/*.json` eagerly,
 * so anything dropped in a locale directory gets pulled into the renderer bundle and shipped to
 * every user even when no namespace matches it.
 *
 * The English source is stored verbatim rather than hashed. A hash would answer "something
 * changed"; the text answers "changed from what", which is what a translator actually needs in
 * order to decide whether their wording still holds.
 */

const STATE_VERSION = 1

export function stateDirectory(projectRoot) {
  return resolve(projectRoot, 'src/shared/i18n/translation-state')
}

export function statePath(projectRoot, locale) {
  return resolve(stateDirectory(projectRoot), `${locale}.json`)
}

export async function readTranslationState(projectRoot, locale) {
  try {
    const parsed = JSON.parse(await readFile(statePath(projectRoot, locale), 'utf8'))
    return parsed?.translatedFrom ?? {}
  } catch {
    // A hand-edited locale with no state file is legal; it simply carries no staleness data.
    return {}
  }
}

export async function writeTranslationState(projectRoot, locale, translatedFrom) {
  await mkdir(stateDirectory(projectRoot), { recursive: true })
  const sortedNamespaces = Object.keys(translatedFrom).sort()
  const normalized = {}
  for (const namespace of sortedNamespaces) {
    const entries = Object.entries(translatedFrom[namespace]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (entries.length > 0) normalized[namespace] = Object.fromEntries(entries)
  }
  const payload = { version: STATE_VERSION, locale, translatedFrom: normalized }
  await writeFile(statePath(projectRoot, locale), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/**
 * Keys whose English has moved on since they were translated. Returns entries rather than a
 * count so a caller can show the old wording beside the new one.
 */
export function findStaleTranslations(translatedFrom, englishByNamespace, translatedByNamespace) {
  const stale = []
  for (const [namespace, recorded] of Object.entries(translatedFrom)) {
    const english = englishByNamespace.get(namespace)
    const translated = translatedByNamespace.get(namespace)
    if (!english || !translated) continue
    for (const [key, translatedFromText] of Object.entries(recorded)) {
      // Only keys that are still translated can be stale; a removed translation is just missing.
      if (!translated.has(key)) continue
      const current = english.get(key)
      if (current !== undefined && current !== translatedFromText) {
        stale.push({ namespace, key, was: translatedFromText, now: current })
      }
    }
  }
  return stale
}
