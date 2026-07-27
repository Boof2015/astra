/**
 * Script-side mirror of compareSourceLookupCandidates in src/shared/i18n/core.ts.
 *
 * The build check has to report the same key the app will actually pick, otherwise it teaches
 * maintainers the wrong thing about their own ambiguity. The two implementations are held
 * together by the drift-guard corpus in rules.test.ts, for the same reason the placeholder
 * matcher is: a .mjs toolchain module cannot import the TypeScript runtime helper.
 */

export function isGeneratedKey(qualifiedKey) {
  const key = qualifiedKey.slice(qualifiedKey.indexOf(':') + 1)
  return key.startsWith('auto.') || key.startsWith('runtime.')
}

export function compareSourceLookupCandidates(left, right) {
  const leftGenerated = isGeneratedKey(left)
  const rightGenerated = isGeneratedKey(right)
  if (leftGenerated !== rightGenerated) return leftGenerated ? 1 : -1
  return left < right ? -1 : left > right ? 1 : 0
}
