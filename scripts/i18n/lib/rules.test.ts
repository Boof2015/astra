import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareSourceLookupCandidates,
  extractInterpolationVariables,
} from '../../../src/shared/i18n/core.ts'
// @ts-expect-error - plain ESM toolchain modules, intentionally untyped.
import { checkMessage, lengthBudgetFor, placeholdersOf } from './rules.mjs'
// @ts-expect-error - plain ESM toolchain modules, intentionally untyped.
import { compareSourceLookupCandidates as scriptCompare } from './lookup.mjs'

/**
 * The toolchain (scripts/i18n) and the runtime (src/shared/i18n) each need to understand
 * interpolation, and they cannot share a module: the scripts are plain .mjs and core.ts is
 * TypeScript compiled into the app bundle. This corpus is the seam between them. If the two
 * implementations ever diverge, the workbench will accept a message the CI gate rejects —
 * which is the one failure mode the whole design exists to prevent.
 */
const CORPUS = [
  '',
  'Rescan library',
  'Playing {{count}} tracks',
  '{{count}}',
  '{{ count }}',
  'Copied {{count}} of {{total}} files',
  '{{total}} then {{count}} then {{total}} again',
  'Loudness is {{value}} LUFS ({{target}} target)',
  '{{resolvedchannelcount}} channels',
  'Braces { alone } are not placeholders',
  'Single {brace} is not a placeholder',
  '{{a.b}} and {{a-b}} and {{a_b}}',
  '{{count, number}}',
  'Trailing text after {{placeholder}}',
  'Nothing to interpolate here at all',
]

test('placeholdersOf agrees with the runtime extractor across the corpus', () => {
  for (const message of CORPUS) {
    assert.deepEqual(
      placeholdersOf(message),
      extractInterpolationVariables(message),
      `diverged on: ${JSON.stringify(message)}`
    )
  }
})

test('placeholdersOf is stable across repeated calls', () => {
  // Guards against a module-scope global regex leaking lastIndex between calls, which would
  // make every second validation silently pass.
  const message = 'Copied {{count}} of {{total}} files'
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(placeholdersOf(message), ['count', 'total'])
  }
})

test('checkMessage accepts a faithful translation', () => {
  const { errors, warnings } = checkMessage('Rescan library', 'Bibliothek neu einlesen', {
    role: 'body',
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('checkMessage rejects placeholder loss, renaming and invention', () => {
  const dropped = checkMessage('Playing {{count}} tracks', 'Titel werden abgespielt', {})
  assert.equal(dropped.errors.length, 1)
  assert.match(dropped.errors[0], /Placeholder mismatch/)

  const renamed = checkMessage('Playing {{count}} tracks', '{{anzahl}} Titel', {})
  assert.equal(renamed.errors.length, 1)

  const invented = checkMessage('Rescan library', 'Neu einlesen {{count}}', {})
  assert.equal(invented.errors.length, 1)
})

test('checkMessage ignores placeholder order and repetition', () => {
  // i18next substitutes by name, so reordering is not just legal but often required.
  const { errors } = checkMessage(
    'Copied {{count}} of {{total}}',
    '{{total}} davon {{count}} kopiert',
    {}
  )
  assert.deepEqual(errors, [])

  const repeated = checkMessage('{{count}} of {{total}}', '{{count}} von {{total}} ({{count}})', {})
  assert.deepEqual(repeated.errors, [])
})

test('checkMessage rejects HTML entities and empty strings', () => {
  const entity = checkMessage("Don't stop", 'Nicht &apos;anhalten&apos;', {})
  assert.equal(entity.errors.length, 1)
  assert.match(entity.errors[0], /HTML entity/)

  assert.match(checkMessage('Play', '   ', {}).errors[0], /empty/)
  assert.match(checkMessage('Play', undefined, {}).errors[0], /must be a string/)
})

test('length budgets warn without ever erroring', () => {
  const { errors, warnings } = checkMessage('Play', 'Wiedergabe starten und fortsetzen', {
    role: 'button',
  })
  assert.deepEqual(errors, [], 'length is advisory and must never block a contribution')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /may not fit/)
})

test('short strings get an absolute allowance on top of the multiplier', () => {
  // "On" x 1.6 is three characters. Without the floor, "Encendido" would warn and every
  // short button in the app would carry a meaningless warning.
  assert.deepEqual(checkMessage('On', 'Encendido', { role: 'button' }).warnings, [])
  assert.deepEqual(checkMessage('Off', 'Desactivado', { role: 'button' }).warnings, [])
})

test('roles that wrap or are read aloud carry no budget', () => {
  const long = 'x'.repeat(400)
  for (const role of ['body', 'text', 'screen-reader', undefined]) {
    assert.equal(lengthBudgetFor(role, 10), null, `${role} should be unbudgeted`)
    assert.deepEqual(checkMessage('Short source', long, { role }).warnings, [])
  }
})

test('unknown roles are unbudgeted rather than treated as tight', () => {
  assert.equal(lengthBudgetFor('some-future-role', 20), null)
})

/**
 * Second drift seam: the build check must name the same key the running app will choose, or it
 * teaches maintainers the wrong thing about their own ambiguity.
 */
const LOOKUP_CORPUS = [
  ['common:actions.close', 'common:auto.eqpopover.close'],
  ['common:auto.eqpopover.close', 'common:actions.close'],
  ['settings:title', 'common:auto.sidebar.settings'],
  ['common:runtime.foo.label_x', 'common:states.off'],
  ['library:auto.a.b', 'library:auto.a.c'],
  ['common:states.off', 'settings:sections.audio'],
  ['common:auto.a.b', 'common:runtime.a.b'],
  ['errors:generic', 'errors:generic'],
]

test('script and runtime candidate ordering agree', () => {
  for (const [left, right] of LOOKUP_CORPUS) {
    assert.equal(
      Math.sign(scriptCompare(left, right)),
      Math.sign(compareSourceLookupCandidates(left, right)),
      `diverged on ${left} vs ${right}`
    )
  }
})

test('hand-written keys win over generated ones regardless of namespace order', () => {
  const sorted = [
    'common:auto.analyzereditoverlay.settings',
    'settings:title',
    'common:auto.sidebar.settings',
  ].sort(compareSourceLookupCandidates)
  assert.equal(sorted[0], 'settings:title')
})

test('candidate ordering is total and stable', () => {
  const candidates = ['common:auto.z.a', 'common:actions.b', 'library:auto.a.a', 'common:actions.a']
  const once = [...candidates].sort(compareSourceLookupCandidates)
  const twice = [...candidates].reverse().sort(compareSourceLookupCandidates)
  assert.deepEqual(once, twice, 'sort must not depend on input order')
  assert.deepEqual(once, ['common:actions.a', 'common:actions.b', 'common:auto.z.a', 'library:auto.a.a'])
})

/**
 * Third drift seam. The in-app translation studio validates with src/shared/i18n/rules.ts while
 * CI validates with rules.mjs. A translator typing inside Astra must be held to exactly the same
 * standard as the gate that will review their pull request.
 */
const APP_RULES = await import('../../../src/shared/i18n/rules.ts')

const CHECK_CORPUS: [string, unknown, { role?: string }][] = [
  ['Rescan library', 'Bibliothek neu einlesen', { role: 'body' }],
  ['Playing {{count}} tracks', 'Titel werden abgespielt', {}],
  ['Playing {{count}} tracks', '{{count}} Titel', { role: 'button' }],
  ['Copied {{count}} of {{total}}', '{{total}} davon {{count}} kopiert', {}],
  ["Don't stop", 'Nicht &apos;anhalten&apos;', {}],
  ['Play', '   ', {}],
  ['Play', undefined, {}],
  ['Play', 'Wiedergabe starten und fortsetzen', { role: 'button' }],
  ['On', 'Encendido', { role: 'button' }],
  ['Short source', 'x'.repeat(400), { role: 'body' }],
  ['Short source', 'x'.repeat(400), { role: 'heading' }],
  ['Tab', 'Tabulator', { role: 'menu-item' }],
  ['Search', 'Suchen', { role: 'keywords' }],
]

test('the in-app studio and the CI gate judge every message identically', () => {
  for (const [source, translated, meta] of CHECK_CORPUS) {
    assert.deepEqual(
      APP_RULES.checkMessage(source, translated, meta),
      checkMessage(source, translated, meta),
      `diverged on ${JSON.stringify(source)} -> ${JSON.stringify(translated)}`
    )
  }
})

test('length budgets agree between studio and gate for every known role', () => {
  const roles = [...new Set([...Object.keys(APP_RULES.LENGTH_BUDGET_BY_ROLE), 'made-up', undefined])]
  for (const role of roles) {
    for (const length of [1, 2, 5, 20, 80, 400]) {
      assert.equal(
        APP_RULES.lengthBudgetFor(role as string | undefined, length),
        lengthBudgetFor(role, length),
        `diverged for role ${role} at length ${length}`
      )
    }
  }
})

test('placeholder extraction agrees across all three implementations', () => {
  for (const sample of CORPUS) {
    assert.deepEqual(APP_RULES.placeholdersOf(sample), placeholdersOf(sample), sample)
    assert.deepEqual(APP_RULES.placeholdersOf(sample), extractInterpolationVariables(sample), sample)
  }
})
