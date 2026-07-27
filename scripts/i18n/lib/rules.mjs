/**
 * Shared message rules for the i18n toolchain.
 *
 * Three consumers share this module: `validate-locales.mjs` (the CI gate),
 * `build-workbench.mjs` (inlined verbatim into the translator's browser), and
 * `rules.test.ts` (the drift guard against the runtime helper in shared/i18n/core.ts).
 *
 * They must never disagree. The whole premise of the offline workbench is that a translator
 * cannot produce something CI will reject, and that guarantee only holds while the workbench
 * runs literally the same code the gate runs.
 */

// Mirrors extractInterpolationVariables in src/shared/i18n/core.ts. Built fresh per call
// rather than shared at module scope: a global regex carries lastIndex between calls, and a
// consumer reaching for .test() on a shared instance would silently skip every other message.
function placeholderMatcher() {
  return /{{\s*([A-Za-z0-9_.-]+)(?:\s*,[^}]*)?\s*}}/g
}

/** Non-global on purpose — this one is used with .test(), which is lastIndex-sensitive. */
export const HTML_ENTITY_PATTERN =
  /&(?:apos|quot|amp|lt|gt|nbsp|middot|ldquo|rdquo|lsquo|rsquo|rarr|larr|times|mdash);|&#39;/

/** Interpolation variable names in a message, deduplicated and sorted for stable comparison. */
export function placeholdersOf(message) {
  const variables = new Set()
  for (const match of String(message).matchAll(placeholderMatcher())) variables.add(match[1])
  return Array.from(variables).sort()
}

/**
 * How much longer than English a translation may run before it is worth a second look.
 *
 * Advisory only, and deliberately so. German averages ~35% longer than English and Finnish
 * compounds run longer still; a hard width gate would fail honest translations and teach
 * contributors to ignore the validator. Roles that wrap freely or are only ever read aloud
 * get no budget at all — length is meaningless there.
 */
export const LENGTH_BUDGET_BY_ROLE = {
  button: 1.6,
  'menu-item': 1.6,
  label: 1.7,
  heading: 1.7,
  tooltip: 2.2,
  placeholder: 2.2,
  // Links usually sit inline in a sentence and wrap with it, so width is not theirs to own.
  link: null,
  // Search keyword lists are never rendered; length is meaningless and more synonyms is better.
  keywords: null,
  body: null,
  text: null,
  'screen-reader': null,
}

/**
 * Short source strings need an absolute allowance on top of the multiplier. "On" is two
 * characters, so a 1.6x budget leaves three — less than "Ein", "Aus", or "Encendido". Without
 * this floor every short button warns and the signal is worth nothing.
 */
const LENGTH_FLOOR_ALLOWANCE = 10

export function lengthBudgetFor(role, sourceLength) {
  const multiplier = LENGTH_BUDGET_BY_ROLE[role]
  if (!multiplier) return null
  return Math.max(Math.ceil(sourceLength * multiplier), sourceLength + LENGTH_FLOOR_ALLOWANCE)
}

/**
 * Validates one translated message against its English source.
 *
 * `errors` block a contribution and are what CI fails on. `warnings` are advisory and are
 * surfaced to the translator without gating anything.
 */
export function checkMessage(sourceMessage, translatedMessage, meta = {}) {
  const errors = []
  const warnings = []

  if (typeof translatedMessage !== 'string') {
    return { errors: ['Translation must be a string.'], warnings }
  }

  const expected = placeholdersOf(sourceMessage)
  const actual = placeholdersOf(translatedMessage)
  if (expected.join('\0') !== actual.join('\0')) {
    errors.push(
      `Placeholder mismatch: expected ${expected.length ? expected.join(', ') : '(none)'}`
        + `, found ${actual.length ? actual.join(', ') : '(none)'}.`
    )
  }

  if (HTML_ENTITY_PATTERN.test(translatedMessage)) {
    errors.push('Contains an HTML entity; use the Unicode character directly in JSON.')
  }

  if (translatedMessage.trim() === '') {
    errors.push('Translation is empty.')
  }

  const budget = lengthBudgetFor(meta.role, sourceMessage.length)
  if (budget !== null && translatedMessage.length > budget) {
    const percent = Math.round((translatedMessage.length / sourceMessage.length) * 100)
    warnings.push(
      `${translatedMessage.length} characters is ${percent}% of the English source `
        + `(${sourceMessage.length}); this ${meta.role ?? 'string'} may not fit its control.`
    )
  }

  return { errors, warnings }
}
