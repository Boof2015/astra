import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderSyncDifference } from '../../../../types/providerSync.ts'
import { resolveProviderChoice } from '../../../../shared/sync/providerState.ts'
import {
  agreeingTracks, compareSummary, DEFAULT_COMPARE, formatProviderValue, isClash, resolveChoices, rowKind, rowOptions, ruleChoice
} from './compareModel.ts'

let n = 0
const row = (field: 'favorite' | 'rating', local: ProviderSyncDifference['local'], server: ProviderSyncDifference['server'],
  path = `/t/${n}`): ProviderSyncDifference => ({
  key: `k${n++}`, path, id: String(n), title: 'Song', artist: 'Artist', field, local, server, reason: 'initial'
})

test('rows sort into favorites, ratings and half stars the server cannot store', () => {
  assert.equal(rowKind(row('favorite', true, false), 'subsonic'), 'favorite')
  assert.equal(rowKind(row('rating', 4, null), 'subsonic'), 'rating')
  assert.equal(rowKind(row('rating', 3.5, null), 'subsonic'), 'half')
  assert.equal(rowKind(row('rating', 3.5, null), 'plex'), 'rating', 'Plex stores half stars')
  assert.equal(isClash(row('rating', 3, 4)), true)
  assert.equal(isClash(row('rating', 3, null)), false)
})

test('Keep both: favorites survive on either side, one-sided ratings copy, clashes follow the clash choice', () => {
  const s = DEFAULT_COMPARE
  assert.equal(ruleChoice(row('favorite', true, false), 'subsonic', s), 'local')
  assert.equal(ruleChoice(row('favorite', false, true), 'subsonic', s), 'server')
  assert.equal(ruleChoice(row('rating', 4, null), 'subsonic', s), 'local')
  assert.equal(ruleChoice(row('rating', null, 2), 'subsonic', s), 'server')
  assert.equal(ruleChoice(row('rating', 3, 5), 'plex', s), 'local')
  assert.equal(ruleChoice(row('rating', 3, 5), 'plex', { ...s, clash: 'server' }), 'server')
})

test('Use Astra / Use the server apply to every row; half stars round unless the server wins', () => {
  const half = row('rating', 3.5, null)
  assert.equal(ruleChoice(row('favorite', false, true), 'subsonic', { ...DEFAULT_COMPARE, rule: 'astra' }), 'local')
  assert.equal(ruleChoice(row('rating', null, 4), 'subsonic', { ...DEFAULT_COMPARE, rule: 'astra' }), 'local')
  assert.equal(ruleChoice(row('favorite', true, false), 'subsonic', { ...DEFAULT_COMPARE, rule: 'server' }), 'server')
  assert.equal(ruleChoice(half, 'subsonic', { ...DEFAULT_COMPARE, rule: 'astra', round: 'down' }), 'down')
  assert.equal(ruleChoice(half, 'subsonic', { ...DEFAULT_COMPARE, rule: 'server' }), 'server')
  assert.equal(ruleChoice(half, 'subsonic', DEFAULT_COMPARE), 'up')
  // A half star against a server rating is a clash under Keep both.
  assert.equal(ruleChoice(row('rating', 3.5, 2), 'subsonic', { ...DEFAULT_COMPARE, clash: 'server' }), 'server')
  assert.equal(ruleChoice(row('rating', 3.5, 2), 'subsonic', DEFAULT_COMPARE), 'up')
})

test('every resolved choice is one the main process accepts, and picks override the rule', () => {
  const rows = [row('favorite', true, false), row('rating', 3.5, 4), row('rating', null, 2), row('rating', 4.5, null), row('favorite', false, true)]
  for (const rule of ['both', 'astra', 'server'] as const) {
    for (const clash of ['local', 'server'] as const) {
      for (const round of ['up', 'down'] as const) {
        const choices = resolveChoices(rows, 'subsonic', { rule, clash, round }, {})
        for (const item of rows) assert.doesNotThrow(() => resolveProviderChoice(item, choices[item.key], 'subsonic'))
      }
    }
  }
  const picked = resolveChoices(rows, 'subsonic', DEFAULT_COMPARE, { [rows[0].key]: 'server', [rows[1].key]: 'local' })
  assert.equal(picked[rows[0].key], 'server', 'a valid pick wins')
  assert.equal(picked[rows[1].key], 'up', 'an invalid pick (an unstorable half star) falls back to the rule')
})

test('the summary counts tracks, not fields, by the values each choice actually produces', () => {
  const a = row('favorite', true, false, '/a'), b = row('rating', 4, null, '/a'), c = row('rating', null, 3, '/c'), d = row('rating', 2.5, null, '/d')
  const choices = { [a.key]: 'local', [b.key]: 'local', [c.key]: 'server', [d.key]: 'up' } as const
  // /a changes the server twice but counts once; /d's rounding writes 3 to both sides.
  assert.deepEqual(compareSummary([a, b, c, d], choices, 'subsonic'), { serverTracks: 2, astraTracks: 2 })
})

test('rounding to the server\'s existing rating changes only Astra, in both directions', () => {
  const up = row('rating', 3.5, 4), down = row('rating', 3.5, 3)
  assert.deepEqual(compareSummary([up], { [up.key]: 'up' }, 'subsonic'), { serverTracks: 0, astraTracks: 1 })
  assert.deepEqual(compareSummary([down], { [down.key]: 'down' }, 'subsonic'), { serverTracks: 0, astraTracks: 1 })
  assert.deepEqual(compareSummary([down], { [down.key]: 'up' }, 'subsonic'), { serverTracks: 1, astraTracks: 1 })
})

test('Clear is offered only when both sides have a rating, clears both, and reaches the choices', () => {
  const both = row('rating', 3, 5), one = row('rating', 4, null), half = row('rating', 3.5, 2)
  assert.deepEqual(rowOptions(both, 'plex').map(o => o.value), ['local', 'server', 'clear'])
  assert.deepEqual(rowOptions(half, 'subsonic').map(o => o.value), ['up', 'down', 'server', 'clear'])
  assert.deepEqual(rowOptions(one, 'subsonic').map(o => o.value), ['local', 'server'])
  assert.equal(resolveProviderChoice(both, 'clear', 'plex'), null)
  assert.deepEqual(compareSummary([both], { [both.key]: 'clear' }, 'plex'), { serverTracks: 1, astraTracks: 1 })
  const choices = resolveChoices([both], 'plex', DEFAULT_COMPARE, { [both.key]: 'clear' })
  assert.equal(choices[both.key], 'clear', 'a manual Clear survives resolution')
})

test('"already match" leaves out the tracks that differ, counting a track with two differences once', () => {
  const rows = [row('favorite', true, false, '/x'), row('rating', 4, null, '/x'), row('rating', null, 2, '/y')]
  assert.equal(agreeingTracks(2, rows.slice(2)), 1)
  assert.equal(agreeingTracks(12840, rows), 12838)
  assert.equal(agreeingTracks(1, rows), 0, 'never negative')
})

test('row options label the value each side keeps', () => {
  assert.deepEqual(rowOptions(row('favorite', true, false), 'jellyfin').map(o => o.label), ['Astra · Favorite', 'Server · Not a favorite'])
  assert.deepEqual(rowOptions(row('rating', 4, null), 'subsonic').map(o => o.label), ['Astra · ★★★★', 'Server · Unrated'])
  assert.deepEqual(rowOptions(row('rating', 3.5, null), 'subsonic').map(o => o.label), ['Up · ★★★★', 'Down · ★★★', 'Server · Unrated'])
  assert.deepEqual(rowOptions(row('rating', 3.5, 2), 'subsonic').map(o => o.label), ['Up · ★★★★', 'Down · ★★★', 'Server · ★★', 'Clear'])
  assert.deepEqual(rowOptions(row('rating', 0.5, null), 'subsonic').map(o => o.label)[1], 'Down · ★')
  assert.equal(formatProviderValue(4.5), '★★★★½')
})
