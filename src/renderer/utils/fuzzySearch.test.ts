import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getFuzzyFieldScore,
  matchesFuzzyFields,
  multiFieldScore,
  rankFuzzyMatches
} from './fuzzySearch.ts'

function requireScore(score: number | null): number {
  if (score === null) {
    assert.fail('Expected fuzzy score')
  }
  return score
}

test('scores exact, prefix, substring, and sequential fuzzy matches', () => {
  const exact = requireScore(getFuzzyFieldScore('Radiohead', [
    { value: 'Radiohead', weight: 1 }
  ]))
  const longerPrefix = requireScore(getFuzzyFieldScore('Radiohead', [
    { value: 'Radiohead Live', weight: 1 }
  ]))
  const prefix = requireScore(getFuzzyFieldScore('Radio', [
    { value: 'Radiohead', weight: 1 }
  ]))
  const substring = requireScore(getFuzzyFieldScore('head', [
    { value: 'Radiohead', weight: 1 }
  ]))
  const sequential = requireScore(getFuzzyFieldScore('rhd', [
    { value: 'Radiohead', weight: 1 }
  ]))

  assert.ok(exact > longerPrefix)
  assert.ok(prefix > 0)
  assert.ok(substring > 0)
  assert.ok(sequential > 0)
})

test('short queries require prefix or word-start matches', () => {
  assert.equal(multiFieldScore('rd', [
    { value: 'Radiohead', weight: 1 }
  ]), null)
  assert.notEqual(multiFieldScore('ra', [
    { value: 'Radiohead', weight: 1 }
  ]), null)
})

test('matchesFuzzyFields matches across media metadata fields', () => {
  const fields = [
    { value: 'Everything in Its Right Place', weight: 1.5 },
    { value: 'Radiohead', weight: 1.2 },
    { value: 'Kid A', weight: 1.0 }
  ]

  assert.equal(matchesFuzzyFields('rhd', fields), true)
  assert.equal(matchesFuzzyFields('zzzz', fields), false)
})

test('rankFuzzyMatches orders stronger picker matches first', () => {
  const playlists = [
    { id: 'substring', name: 'The Radio Dept.' },
    { id: 'prefix', name: 'Radiohead' },
    { id: 'miss', name: 'Portishead' }
  ]

  const ranked = rankFuzzyMatches(playlists, 'radio', (playlist) => [
    { value: playlist.name, weight: 1.5 }
  ])

  assert.deepEqual(ranked.map((playlist) => playlist.id), ['prefix', 'substring'])
})
