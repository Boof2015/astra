/**
 * Translation studio: inspect and translate strings inside the running app.
 *
 * Screenshots were the obvious alternative and a worse one — they go stale the moment the UI
 * moves, and driving the app to every modal, wizard and popout to capture them is a fragile
 * automation project. The app already knows where every string is, so this asks it directly.
 *
 * Editing in place matters more than inspecting: a translator types their wording and watches it
 * land in the real control, at the real width, in the real sentence. No length budget or context
 * note substitutes for seeing the button it has to fit inside.
 *
 * Enabled with `ASTRA_I18N_INSPECT=1` (read-only) or `ASTRA_TRANSLATE=<locale>` (editing), which
 * the main process turns into query parameters on every window. It is a development tool: the
 * context it reads is dev-only and never reaches a packaged build.
 */

export const INSPECT_QUERY_PARAM = 'i18nInspect'
export const TRANSLATE_QUERY_PARAM = 'i18nTranslate'

/** Marks the element wrapping a localized string so the studio can find it by pointer. */
export const INSPECT_KEY_ATTRIBUTE = 'data-i18n-key'

function readParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return null
  }
}

const params = readParams()

/** The locale being translated, or null when the studio is read-only. */
export const translateLocale: string | null = (() => {
  const requested = params?.get(TRANSLATE_QUERY_PARAM)?.trim()
  if (!requested) return null
  try {
    // A malformed tag would break Intl formatting everywhere once we switch to it.
    return Intl.getCanonicalLocales(requested)[0] ?? null
  } catch {
    return null
  }
})()

// Read once: this cannot change without a reload, and LocalizedText consults it on every render
// of every string in the app.
export const isInspecting: boolean = params?.get(INSPECT_QUERY_PARAM) === '1' || translateLocale !== null

/** Drafts share the workbench's storage shape, so work moves between the two tools freely. */
export function draftStorageKey(locale: string): string {
  return `astra-i18n-workbench-${locale}`
}

/**
 * macOS reports Option as `altKey`, but Option+letter emits a dead key — Option+I produces "ˆ",
 * not "i" — so matching on `event.key` silently never fires there. Chords must match
 * `event.code`, and the modifier for picking is Command on macOS and Control elsewhere.
 */
export const isMac: boolean = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')

export function hasPickModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

export const PICK_MODIFIER_LABEL = isMac ? '⌘' : 'Ctrl'
export const ALT_LABEL = isMac ? '⌥' : 'Alt'
