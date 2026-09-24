import assert from 'node:assert/strict'
import test from 'node:test'
import { activateHomePlayback, isHomePlaybackTargetActive } from './homePlayback.ts'
import { resolveCurrentPlaybackSource } from '../../shared/home/playbackSources.ts'
import type { PlaybackSourceContext } from '../../types/playbackSource.ts'

const album: PlaybackSourceContext = { type: 'album', album: 'One', albumArtist: 'Artist', identityKey: 'release:one' }
const playlist: PlaybackSourceContext = { type: 'playlist', playlistId: 4 }

test('Home collections match the actual queue source, not membership of the playing track', () => {
  const currentSource = resolveCurrentPlaybackSource({
    currentTrack: { path: '/one.flac', albumIdentityKey: 'release:one' },
    currentQueueItemId: 'queue:one',
    queueItems: [{ queueId: 'queue:one', entry: { path: '/one.flac' }, sourceContext: playlist, sourcePlaylistId: 4 }]
  })
  const context = { currentSource, currentTrackPath: '/one.flac' }
  assert.equal(isHomePlaybackTargetActive(playlist, context), true)
  assert.equal(isHomePlaybackTargetActive(album, context), false)
  assert.equal(isHomePlaybackTargetActive({ type: 'playlist', playlistId: -1 }, context), false)
  assert.equal(isHomePlaybackTargetActive({ type: 'track', trackPath: '/one.flac' }, context), true)
  assert.equal(isHomePlaybackTargetActive({ type: 'track', trackPath: '/two.flac' }, context), false)
  assert.equal(isHomePlaybackTargetActive(album, { currentSource: null, currentTrackPath: '/one.flac' }), false)
})

test('Home distinguishes different releases with the same album title', () => {
  assert.equal(isHomePlaybackTargetActive(album, { currentSource: { ...album, identityKey: 'release:two' }, currentTrackPath: '/two.flac' }), false)
  assert.equal(isHomePlaybackTargetActive(album, { currentSource: { ...album, album: 'Retagged title' }, currentTrackPath: '/one.flac' }), true)
})

test('pausing and resuming a collection or its current track preserves queue and position', async () => {
  const queue = ['/one.flac', '/two.flac']
  const player = { queue, position: 42, playing: true }
  let starts = 0
  const actions = {
    toggle: async () => { player.playing = !player.playing },
    start: async () => { starts++; player.queue = []; player.position = 0 }
  }
  const context = { currentSource: playlist, currentTrackPath: '/one.flac' }
  await activateHomePlayback(playlist, context, actions)
  assert.equal(player.playing, false)
  await activateHomePlayback({ type: 'track', trackPath: '/one.flac' }, context, actions)
  assert.equal(player.playing, true)
  assert.equal(player.queue, queue)
  assert.equal(player.position, 42)
  assert.equal(starts, 0)
})

test('an inactive selection uses its existing start action and failures remain reportable', async () => {
  let started = 0
  const context = { currentSource: playlist, currentTrackPath: '/one.flac' }
  await activateHomePlayback(album, context, {
    toggle: async () => { assert.fail('must not pause an unrelated collection') },
    start: async () => { started++ }
  })
  assert.equal(started, 1)
  await assert.rejects(activateHomePlayback(playlist, context, {
    toggle: async () => { throw new Error('Device unavailable') }, start: async () => {}
  }), /Device unavailable/)
  await assert.rejects(activateHomePlayback(album, context, {
    toggle: async () => {}, start: async () => { throw new Error('No available tracks') }
  }), /No available tracks/)
})
