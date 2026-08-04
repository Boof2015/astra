import test from 'node:test'
import assert from 'node:assert/strict'
import { compareBaseLocaleText } from './localeSort.ts'

function comparisonSign(value: number): number {
  return value === 0 ? 0 : value < 0 ? -1 : 1
}

test('cached base-locale comparison preserves localeCompare ordering semantics', () => {
  const values = [
    '',
    'A Song',
    'a song',
    'Ångström',
    'angstrom',
    'Étude',
    'etude',
    'Track 2',
    'Track 10',
    'Zebra',
    'ζέβρα',
    '日本語'
  ]

  for (const left of values) {
    for (const right of values) {
      const expected = left.localeCompare(right, undefined, { sensitivity: 'base' })
      const actual = compareBaseLocaleText(left, right)
      assert.equal(
        comparisonSign(actual),
        comparisonSign(expected),
        `comparison mismatch for ${JSON.stringify(left)} and ${JSON.stringify(right)}`
      )
    }
  }
})
