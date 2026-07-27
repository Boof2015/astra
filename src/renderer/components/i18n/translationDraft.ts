import type { i18n as I18n } from 'i18next'
import { I18N_NAMESPACES } from '../../../shared/i18n/types'
import { draftStorageKey } from './inspectMode'

/**
 * Holds the in-progress translation and pushes it into the running app.
 *
 * Kept outside React so that typing a translation does not re-render the studio through the same
 * path it re-renders the app: the edit applies to i18next, i18next notifies every consumer, and
 * the UI under the panel updates in place.
 */

export type Draft = Record<string, string>

export function loadDraft(locale: string): Draft {
  try {
    const raw = localStorage.getItem(draftStorageKey(locale))
    return raw ? (JSON.parse(raw) as Draft) : {}
  } catch {
    return {}
  }
}

export function saveDraft(locale: string, draft: Draft): boolean {
  try {
    localStorage.setItem(draftStorageKey(locale), JSON.stringify(draft))
    return true
  } catch {
    // Private browsing or a full quota. The draft still applies in memory; the studio warns.
    return false
  }
}

function splitKey(qualified: string): { namespace: string; key: string } {
  const separator = qualified.indexOf(':')
  return separator === -1
    ? { namespace: 'common', key: qualified }
    : { namespace: qualified.slice(0, separator), key: qualified.slice(separator + 1) }
}

/**
 * Loads the whole draft into i18next and switches the app to it.
 *
 * Anything untranslated falls through to English by the existing fallback, so the app stays
 * usable from the first keystroke rather than filling with missing-key noise.
 */
export function applyDraft(i18n: I18n, locale: string, draft: Draft): void {
  for (const namespace of I18N_NAMESPACES) {
    if (!i18n.hasResourceBundle(locale, namespace)) i18n.addResourceBundle(locale, namespace, {}, true, true)
  }
  for (const [qualified, value] of Object.entries(draft)) {
    if (!value) continue
    const { namespace, key } = splitKey(qualified)
    i18n.addResource(locale, namespace, key, value)
  }
  void i18n.changeLanguage(locale)
}

/**
 * Applies one edit and forces the app to re-render.
 *
 * react-i18next only subscribes to `languageChanged` by default, so adding a resource updates the
 * store silently and nothing on screen moves. Re-emitting the event is what makes the edit
 * visible in the actual control being translated — the entire point of editing in place.
 */
export function applyEdit(i18n: I18n, locale: string, qualified: string, value: string): void {
  const { namespace, key } = splitKey(qualified)
  // Clearing an entry has to fall back to English rather than render an empty control. i18next
  // has no single-key removal, but storing undefined makes the lookup miss, which is the same
  // thing from the caller's side.
  i18n.addResource(locale, namespace, key, value || (undefined as unknown as string))
  i18n.emit('languageChanged', locale)
}

export function draftProgress(draft: Draft, total: number): { done: number; total: number } {
  return { done: Object.values(draft).filter(Boolean).length, total }
}

/** The same bundle shape the offline workbench exports, so `npm run i18n:import` accepts both. */
export function buildBundle(
  locale: string,
  draft: Draft,
  sourceTextOf: (qualified: string) => string | undefined
): unknown {
  const namespaces: Record<string, Record<string, unknown>> = {}
  const translatedFrom: Record<string, Record<string, string>> = {}

  for (const [qualified, value] of Object.entries(draft)) {
    if (!value) continue
    const { namespace, key } = splitKey(qualified)
    namespaces[namespace] ??= {}
    translatedFrom[namespace] ??= {}

    let cursor = namespaces[namespace]
    const path = key.split('.')
    for (const segment of path.slice(0, -1)) {
      cursor[segment] ??= {}
      cursor = cursor[segment] as Record<string, unknown>
    }
    cursor[path.at(-1)!] = value
    translatedFrom[namespace][key] = sourceTextOf(qualified) ?? value
  }

  return {
    astraTranslationBundle: 1,
    locale: { code: locale, name: locale, nativeName: locale, direction: 'ltr' },
    generatedAt: new Date().toISOString(),
    namespaces,
    translatedFrom,
  }
}
