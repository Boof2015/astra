/**
 * Message rules, shared by the in-app translation studio.
 *
 * This mirrors `scripts/i18n/lib/rules.mjs` exactly. The two cannot be one module — the
 * toolchain is plain .mjs run by Node, this is TypeScript compiled into the renderer — so they
 * are held together by the drift-guard corpus in `scripts/i18n/lib/rules.test.ts`. If they ever
 * disagree, someone translating inside the app is told their work is fine and then has it
 * rejected by CI, which is the one failure this whole design exists to prevent.
 */

export interface MessageMeta {
  role?: string
}

export interface MessageReport {
  errors: string[]
  warnings: string[]
}

/** Non-global on purpose — used with .test(), which is lastIndex-sensitive when global. */
export const HTML_ENTITY_PATTERN =
  /&(?:apos|quot|amp|lt|gt|nbsp|middot|ldquo|rdquo|lsquo|rsquo|rarr|larr|times|mdash);|&#39;/

function placeholderMatcher(): RegExp {
  return /{{\s*([A-Za-z0-9_.-]+)(?:\s*,[^}]*)?\s*}}/g
}

export function placeholdersOf(message: string): string[] {
  const variables = new Set<string>()
  for (const match of String(message).matchAll(placeholderMatcher())) variables.add(match[1])
  return Array.from(variables).sort()
}

/**
 * How much longer than English a translation may run before it is worth a second look.
 * Advisory only: German averages ~35% longer and a hard gate would fail honest translations.
 */
export const LENGTH_BUDGET_BY_ROLE: Record<string, number | null> = {
  button: 1.6,
  'menu-item': 1.6,
  label: 1.7,
  heading: 1.7,
  tooltip: 2.2,
  placeholder: 2.2,
  link: null,
  keywords: null,
  body: null,
  text: null,
  'screen-reader': null,
}

const LENGTH_FLOOR_ALLOWANCE = 10

export function lengthBudgetFor(role: string | undefined, sourceLength: number): number | null {
  const multiplier = role ? LENGTH_BUDGET_BY_ROLE[role] : null
  if (!multiplier) return null
  return Math.max(Math.ceil(sourceLength * multiplier), sourceLength + LENGTH_FLOOR_ALLOWANCE)
}

export function checkMessage(
  sourceMessage: string,
  translatedMessage: unknown,
  meta: MessageMeta = {}
): MessageReport {
  const errors: string[] = []
  const warnings: string[] = []

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
