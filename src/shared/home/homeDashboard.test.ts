import assert from 'node:assert/strict'
import test from 'node:test'
import type { HomeReleaseSummary } from '../../types/home.ts'
import { formatHomeRediscoveryAge, getLocalDayKey, selectHomeRediscovery } from './homeDashboard.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 11, 12)

function release(overrides: Partial<HomeReleaseSummary> & Pick<HomeReleaseSummary, 'identity_key'>): HomeReleaseSummary {
  return {
    identity_key: overrides.identity_key,
    album: overrides.album ?? overrides.identity_key,
    artist: overrides.artist ?? 'Artist',
    year: overrides.year ?? 2020,
    artwork_hash: overrides.artwork_hash ?? null,
    track_count: overrides.track_count ?? 10,
    available_track_count: overrides.available_track_count ?? 10,
    play_count: overrides.play_count ?? 1,
    favorite_track_count: overrides.favorite_track_count ?? 0,
    last_played_at: Object.prototype.hasOwnProperty.call(overrides, 'last_played_at')
      ? overrides.last_played_at ?? null
      : NOW - 120 * DAY,
    latest_added_at: overrides.latest_added_at ?? NOW - 365 * DAY
  }
}

test('rediscovery is stable for the same day and rotation and changes on refresh', () => {
  const releases = Array.from({ length: 20 }, (_, index) => release({ identity_key: `album-${index}` }))
  const options = { now: NOW, dayKey: '2026-08-11', rotation: 0, limit: 8 }
  const first = selectHomeRediscovery(releases, options).map((entry) => entry.identity_key)
  assert.deepEqual(selectHomeRediscovery(releases, options).map((entry) => entry.identity_key), first)
  assert.notDeepEqual(
    selectHomeRediscovery(releases, { ...options, rotation: 1 }).map((entry) => entry.identity_key),
    first
  )
})

test('rediscovery uses exclusive favorite, never-played, and long-unheard reasons', () => {
  const selected = selectHomeRediscovery([
    release({ identity_key: 'favorite', favorite_track_count: 2, last_played_at: NOW - 40 * DAY }),
    release({ identity_key: 'never', play_count: 0, last_played_at: null, latest_added_at: NOW - 20 * DAY }),
    release({ identity_key: 'old', last_played_at: NOW - 180 * DAY })
  ], { now: NOW, dayKey: '2026-08-11', rotation: 0, limit: 3 })

  assert.deepEqual(new Set(selected.map((entry) => entry.reason_kind)), new Set([
    'favorite', 'never-played', 'long-unheard'
  ]))
  assert.equal(selected.find((entry) => entry.identity_key === 'never')?.reason, 'Added 20 days ago')
  assert.equal(selected.find((entry) => entry.identity_key === 'favorite')?.reason, 'Favorite · 40 days ago')
})

test('unheard favorites do not repeat the generic unplayed reason', () => {
  const selected = selectHomeRediscovery([
    release({ identity_key: 'favorite', favorite_track_count: 1, play_count: 0, last_played_at: null })
  ], { now: NOW, dayKey: '2026-08-11', rotation: 0, limit: 1 })
  assert.equal(selected[0]?.reason, 'Favorite')
})

test('rediscovery interleaves exclusive pools instead of showing one repeated reason', () => {
  const selected = selectHomeRediscovery([
    release({ identity_key: 'old', last_played_at: NOW - 180 * DAY }),
    release({ identity_key: 'never', play_count: 0, last_played_at: null, latest_added_at: NOW - 20 * DAY }),
    release({ identity_key: 'favorite-b', favorite_track_count: 1, last_played_at: NOW - 40 * DAY }),
    release({ identity_key: 'favorite-a', favorite_track_count: 1, last_played_at: NOW - 50 * DAY })
  ], { now: NOW, dayKey: '2026-08-11', rotation: 0, limit: 3 })

  assert.deepEqual(selected.map((entry) => entry.reason_kind), [
    'favorite',
    'never-played',
    'long-unheard'
  ])
})

test('rediscovery excludes requested and unavailable releases and fills from the library', () => {
  const selected = selectHomeRediscovery([
    release({ identity_key: 'excluded' }),
    release({ identity_key: 'unavailable', available_track_count: 0 }),
    release({ identity_key: 'fallback', last_played_at: NOW - 45 * DAY }),
    release({ identity_key: 'recent', last_played_at: NOW - DAY })
  ], {
    now: NOW,
    dayKey: '2026-08-11',
    rotation: 0,
    limit: 3,
    excludedIdentityKeys: new Set(['excluded'])
  })
  assert.deepEqual(selected.map((entry) => entry.identity_key), ['fallback'])
  assert.equal(selected[0]?.reason_kind, 'fallback')
})

test('relative ages and local day keys are human-readable and stable', () => {
  assert.equal(formatHomeRediscoveryAge(NOW - DAY, NOW), '1 day ago')
  assert.equal(formatHomeRediscoveryAge(NOW - 90 * DAY, NOW), '3 months ago')
  assert.equal(formatHomeRediscoveryAge(NOW - 800 * DAY, NOW), '2 years ago')
  assert.equal(getLocalDayKey(new Date(2026, 7, 11, 23, 59)), '2026-08-11')
})
