import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findFuzzyMatch,
  getFuzzyFieldScore,
  matchesFuzzyFields,
  multiFieldScore,
  rankFuzzyMatches,
  type FuzzyMatchKind
} from './fuzzySearch.ts'

function requireMatch(query: string, candidate: string, kind: FuzzyMatchKind): number {
  const match = findFuzzyMatch(query, candidate)
  if (!match) assert.fail(`Expected ${JSON.stringify(query)} to match ${JSON.stringify(candidate)}`)
  assert.equal(match.kind, kind)
  return match.score
}

test('classifies each accepted match shape by relevance', () => {
  const exact = requireMatch('Radiohead', 'Radiohead', 'exact')
  const prefix = requireMatch('Radio', 'Radiohead', 'prefix')
  const wordPrefix = requireMatch('Radio', 'The Radio Dept.', 'word-prefix')
  const substring = requireMatch('radio', 'Piradio Signal', 'substring')
  const initialism = requireMatch('rhc', 'Red Hot Chili Peppers', 'initialism')
  const compact = requireMatch('rdio', 'Radiohead', 'compact')

  assert.ok(exact > prefix)
  assert.ok(prefix > wordPrefix)
  assert.ok(wordPrefix > substring)
  assert.ok(substring > initialism)
  assert.ok(initialism > compact)
})

test('keeps short queries strict while allowing consecutive initials', () => {
  assert.equal(findFuzzyMatch('rd', 'Radiohead'), null)
  assert.equal(findFuzzyMatch('io', 'Radiohead'), null)
  requireMatch('ra', 'Radiohead', 'prefix')
  requireMatch('de', 'The Department', 'word-prefix')
  requireMatch('rh', 'Red Hot Chili Peppers', 'initialism')
})

test('rejects scattered subsequences, typos, and incomplete matches', () => {
  assert.equal(findFuzzyMatch('rhd', 'Radiohead'), null)
  assert.equal(findFuzzyMatch('the', 'Everything in Its Right Place'), null)
  assert.equal(findFuzzyMatch('kid', 'Knights of Cydonia'), null)
  assert.equal(findFuzzyMatch('love', 'Long Drive Home'), null)
  assert.equal(findFuzzyMatch('raido', 'Radiohead'), null)
  assert.equal(findFuzzyMatch('radioz', 'Radiohead'), null)
})

test('normalizes case and repeated whitespace without broadening eligibility', () => {
  requireMatch('  RADIO   DEPT  ', 'Radio Dept', 'exact')
  requireMatch('bjork', 'Björk', 'exact')
  assert.equal(findFuzzyMatch('r d', 'Radiohead'), null)
})

test('field weights rank eligible matches but cannot revive rejected fields', () => {
  assert.equal(multiFieldScore('kid', [
    { value: 'Knights of Cydonia', weight: 999 }
  ]), null)

  const exactLowWeight = getFuzzyFieldScore('radio', [
    { value: 'Radio', weight: 0.1 }
  ])
  const prefixHighWeight = getFuzzyFieldScore('radio', [
    { value: 'Radiohead', weight: 9 }
  ])

  assert.notEqual(exactLowWeight, null)
  assert.notEqual(prefixHighWeight, null)
  assert.ok((exactLowWeight ?? 0) > (prefixHighWeight ?? 0))
})

test('matches across metadata fields using the strongest eligible field', () => {
  const fields = [
    { value: 'Everything in Its Right Place', weight: 1.5 },
    { value: 'Red Hot Chili Peppers', weight: 1.2 },
    { value: 'Kid A', weight: 1.0 }
  ]

  assert.equal(matchesFuzzyFields('rhc', fields), true)
  assert.equal(matchesFuzzyFields('zzzz', fields), false)
})

test('rankFuzzyMatches orders by match class, field weight, and stable input order', () => {
  const matches = [
    { id: 'compact', name: 'Rxaudio', weight: 1 },
    { id: 'initialism', name: 'Rhythm And Dreams In Orbit', weight: 1 },
    { id: 'substring', name: 'Piradio Signal', weight: 1 },
    { id: 'word-prefix', name: 'The Radio Dept.', weight: 1 },
    { id: 'prefix-low-weight', name: 'Radio Alpha', weight: 1 },
    { id: 'prefix-high-weight', name: 'Radio Beta', weight: 1.5 },
    { id: 'exact-first', name: 'Radio', weight: 1 },
    { id: 'exact-second', name: 'Radio', weight: 1 }
  ]

  const ranked = rankFuzzyMatches(matches, 'radio', (match) => [
    { value: match.name, weight: match.weight }
  ])

  assert.deepEqual(ranked.map((match) => match.id), [
    'exact-first',
    'exact-second',
    'prefix-high-weight',
    'prefix-low-weight',
    'word-prefix',
    'substring',
    'initialism',
    'compact'
  ])
})
