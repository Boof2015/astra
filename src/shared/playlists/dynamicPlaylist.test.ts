import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDynamicPlaylistRules } from './dynamicPlaylist.ts'

test('dynamic playlist date conditions preserve positive fractional day values', () => {
  const rules = normalizeDynamicPlaylistRules({
    version: 1,
    conditions: [
      { kind: 'date', field: 'added_at', operator: 'within_days', value: 0.5 },
      { kind: 'date', field: 'added_at', operator: 'older_than_days', value: 1.75 },
      { kind: 'date', field: 'last_played_at', operator: 'within_days', value: 0.25 },
      { kind: 'date', field: 'last_played_at', operator: 'not_within_days', value: 1.75 }
    ],
    sort: { field: 'title', direction: 'asc' },
    limit: null
  })

  assert.deepEqual(
    rules.conditions.map((condition) => condition.kind === 'date' ? condition.value : null),
    [0.5, 1.75, 0.25, 1.75]
  )
})

test('dynamic playlist date conditions reject non-positive and non-finite day values', () => {
  for (const value of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.throws(
      () => normalizeDynamicPlaylistRules({
        version: 1,
        conditions: [
          { kind: 'date', field: 'added_at', operator: 'within_days', value }
        ],
        sort: { field: 'title', direction: 'asc' },
        limit: null
      }),
      /Day value must be a positive number/
    )
  }
})

test('dynamic playlist result limits retain positive whole-number normalization', () => {
  assert.equal(normalizeDynamicPlaylistRules({
    version: 1,
    conditions: [],
    sort: { field: 'title', direction: 'asc' },
    limit: 1.75
  }).limit, 1)

  assert.throws(
    () => normalizeDynamicPlaylistRules({
      version: 1,
      conditions: [],
      sort: { field: 'title', direction: 'asc' },
      limit: 0.5
    }),
    /Result limit must be a positive number/
  )
})
