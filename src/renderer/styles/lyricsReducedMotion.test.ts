import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const stylesheet = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
const REDUCED_MOTION_QUERY = '@media (prefers-reduced-motion: reduce)'
const FUNCTIONAL_TRANSFORM_SELECTORS = [
  '.transport-lyrics-shelf',
  '.transport-lyrics-focus-track'
]

function getAtRuleBodies(source: string, atRule: string): string[] {
  const bodies: string[] = []
  let searchFrom = 0

  while (searchFrom < source.length) {
    const atRuleIndex = source.indexOf(atRule, searchFrom)
    if (atRuleIndex === -1) break

    const openBraceIndex = source.indexOf('{', atRuleIndex + atRule.length)
    assert.notEqual(openBraceIndex, -1, `${atRule} must have a block`)

    let depth = 1
    let cursor = openBraceIndex + 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      if (source[cursor] === '}') depth -= 1
      cursor += 1
    }

    assert.equal(depth, 0, `${atRule} must have balanced braces`)
    bodies.push(source.slice(openBraceIndex + 1, cursor - 1))
    searchFrom = cursor
  }

  return bodies
}

test('reduced motion preserves functional transport lyrics transforms without animation', () => {
  const reducedMotionCss = getAtRuleBodies(stylesheet, REDUCED_MOTION_QUERY).join('\n')
  const rules = reducedMotionCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)

  for (const match of rules) {
    const selectors = match[1] ?? ''
    const declarations = match[2] ?? ''
    if (!/transform\s*:\s*none\s*!important\s*;/.test(declarations)) continue

    for (const selector of FUNCTIONAL_TRANSFORM_SELECTORS) {
      assert.equal(
        selectors.includes(selector),
        false,
        `${selector} must not lose its functional transform under reduced motion`
      )
    }
  }

  for (const selector of FUNCTIONAL_TRANSFORM_SELECTORS) {
    assert.match(
      reducedMotionCss,
      new RegExp(`${selector.replaceAll('.', '\\.')}[^{}]*\\{[^{}]*transition\\s*:\\s*none\\s*!important\\s*;`, 's'),
      `${selector} should reposition instantly under reduced motion`
    )
  }
})
