import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlaybackSourceContext } from '../../types/playbackSource.ts'
import type { HomePlaybackSourceSummary } from '../../types/home.ts'
import { buildHomeSourceCards, normalizePlaybackSourceContext, playbackSourceKey, resolveCurrentPlaybackSource } from './playbackSources.ts'

function summary(source: PlaybackSourceContext, lastPlayedAt: number): HomePlaybackSourceSummary {
  return { key: playbackSourceKey(source), source, title: 'Source', subtitle: '', detail: '', artwork_hash: null, last_played_at: lastPlayedAt }
}

test('source identities distinguish explicit tracks and collections and normalize artist, genre, and year keys', () => {
  assert.equal(playbackSourceKey({ type: 'artist', artist: '  REOL ' }), playbackSourceKey({ type: 'artist', artist: 'Reol' }))
  assert.equal(playbackSourceKey({ type: 'genre', genre: ' Electronic ' }), 'genre:electronic')
  assert.equal(playbackSourceKey({ type: 'year', year: 'unknown' }), 'year:unknown')
  assert.notEqual(playbackSourceKey({ type: 'track', trackPath: '/music/single.flac' }), playbackSourceKey({ type: 'album', album: 'single' }))
  for (const invalid of [null, {}, { type: 'playlist', playlistId: 0 }, { type: 'playlist', playlistId: -2 }, { type: 'year', year: Infinity }, { type: 'track', trackPath: '' }]) {
    assert.equal(normalizePlaybackSourceContext(invalid), null)
  }
  assert.deepEqual(normalizePlaybackSourceContext({ type: 'playlist', playlistId: -1 }), { type: 'playlist', playlistId: -1 })
})

test('the actual item owns attribution during manual interruptions and automatic continuation', () => {
  const source = { type: 'playlist', playlistId: 4 } as const
  const queueItems = [
    { queueId: 'playlist', entry: { path: '/one' }, sourceContext: source, sourcePlaylistId: 4 },
    { queueId: 'manual', entry: { path: '/two' }, sourceContext: { type: 'track', trackPath: '/two' } as const, sourcePlaylistId: null },
    { queueId: 'automatic', entry: { path: '/three' }, sourceContext: null, sourcePlaylistId: null }
  ]
  const state = { currentTrack: { path: '/one' }, currentQueueItemId: 'playlist', queueItems }
  assert.deepEqual(resolveCurrentPlaybackSource(state), source)
  assert.deepEqual(resolveCurrentPlaybackSource({ ...state, currentQueueItemId: 'manual', currentTrack: { path: '/two' } }), { type: 'track', trackPath: '/two' })
  assert.equal(resolveCurrentPlaybackSource({ ...state, currentQueueItemId: 'automatic', currentTrack: { path: '/three' } }), null)
  assert.equal(resolveCurrentPlaybackSource({ ...state, currentQueueItemId: 'manual' }), null, 'a pending item must not misattribute the old track')
  assert.equal(resolveCurrentPlaybackSource({ ...state, currentTrack: { path: '/one', origin: 'associated-external' } }), null)
  assert.deepEqual(resolveCurrentPlaybackSource({ ...state, currentQueueItemId: null }), { type: 'track', trackPath: '/one' })
})

test('Home pins only the current source, deduplicates, keeps independent history, and ignores stale active summaries', () => {
  const playlist = summary({ type: 'playlist', playlistId: 1 }, 200)
  const album = summary({ type: 'album', album: 'Single', identityKey: 'single' }, 100)
  const track = summary({ type: 'track', trackPath: '/single' }, 300)
  const cards = buildHomeSourceCards([track, playlist, album], playlist.source, playlist, 30)
  assert.deepEqual(cards.map((card) => card.key), [playlist.key, track.key, album.key])
  assert.deepEqual(cards.map((card) => card.active), [true, false, false])
  assert.equal(buildHomeSourceCards([playlist], null, album, 30).length, 1)
  assert.equal(buildHomeSourceCards([playlist, track], track.source, track, 1)[0]?.key, track.key)
})
