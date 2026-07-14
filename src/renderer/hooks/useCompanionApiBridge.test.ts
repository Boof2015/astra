import assert from 'node:assert/strict'
import test from 'node:test'
import { useLibraryStore } from '../stores/libraryStore.ts'
import { usePlayerStore } from '../stores/playerStore.ts'
import { usePlaylistStore } from '../stores/playlistStore.ts'
import { useUIStore } from '../stores/uiStore.ts'
import { executeCompanionApiRendererCommand } from './useCompanionApiBridge.ts'

test('renderer bridge applies state-setting playback commands idempotently', async () => {
  let muteToggles = 0
  let shuffleToggles = 0
  let volume = -1
  usePlayerStore.setState({
    duration: 120,
    isMuted: true,
    shuffle: false,
    setVolume: (value) => { volume = value },
    toggleMute: () => { muteToggles += 1; usePlayerStore.setState({ isMuted: !usePlayerStore.getState().isMuted }) },
    toggleShuffle: () => { shuffleToggles += 1; usePlayerStore.setState({ shuffle: !usePlayerStore.getState().shuffle }) }
  })

  await executeCompanionApiRendererCommand({
    type: 'playback-action',
    action: { action: 'set-muted', muted: true }
  })
  await executeCompanionApiRendererCommand({
    type: 'playback-action',
    action: { action: 'set-muted', muted: false }
  })
  await executeCompanionApiRendererCommand({
    type: 'playback-action',
    action: { action: 'set-shuffle', enabled: false }
  })
  await executeCompanionApiRendererCommand({
    type: 'playback-action',
    action: { action: 'set-shuffle', enabled: true }
  })
  await executeCompanionApiRendererCommand({
    type: 'playback-action',
    action: { action: 'set-volume', volume: 0.35 }
  })

  assert.equal(muteToggles, 1)
  assert.equal(shuffleToggles, 1)
  assert.equal(volume, 0.35)
})

test('renderer bridge plays and enqueues already-resolved collection paths', async () => {
  const calls: unknown[] = []
  usePlayerStore.setState({
    startPlaybackContextByPaths: async (paths, index, options) => {
      calls.push(['play', paths, index, options?.contextLabel])
    },
    enqueueTrackPaths: async (paths, position) => {
      calls.push(['enqueue', paths, position])
    }
  })

  await executeCompanionApiRendererCommand({
    type: 'play-paths',
    trackPaths: ['/music/a.flac', '/music/b.flac'],
    contextLabel: 'API album'
  })
  await executeCompanionApiRendererCommand({
    type: 'enqueue-paths',
    trackPaths: ['/music/c.flac'],
    position: 'next'
  })

  assert.deepEqual(calls, [
    ['play', ['/music/a.flac', '/music/b.flac'], 0, 'API album'],
    ['enqueue', ['/music/c.flac'], 'next']
  ])
})

test('renderer bridge opens each supported target and mutates only upcoming queue items', async () => {
  const calls: unknown[] = []
  useLibraryStore.setState({
    setViewMode: (mode) => { calls.push(['view-mode', mode]) },
    clearSelection: async () => { calls.push(['clear-selection']) },
    selectAlbum: async (...args) => { calls.push(['album', ...args]) },
    selectArtist: async (...args) => { calls.push(['artist', ...args]) }
  })
  usePlaylistStore.setState({
    selectPlaylist: async (id) => { calls.push(['playlist', id]) }
  })
  useUIStore.setState({
    requestLibraryTrackReveal: (path) => { calls.push(['track', path]) },
    setActiveView: (view) => { calls.push(['active-view', view]) }
  })
  usePlayerStore.setState({
    moveUpcomingItem: (id, position) => { calls.push(['move', id, position]) },
    removeUpcomingItem: (id) => { calls.push(['remove', id]) },
    clearAllQueues: () => { calls.push(['clear-upcoming']) }
  })

  await executeCompanionApiRendererCommand({ type: 'open-target', target: { type: 'track', trackPath: '/music/a.flac' } })
  await executeCompanionApiRendererCommand({ type: 'open-target', target: { type: 'album', album: 'Album', artist: 'Artist', identityKey: 'album:key' } })
  await executeCompanionApiRendererCommand({ type: 'open-target', target: { type: 'artist', artist: 'Artist' } })
  await executeCompanionApiRendererCommand({ type: 'open-target', target: { type: 'playlist', playlistId: 8 } })
  await executeCompanionApiRendererCommand({ type: 'move-queue-item', queueItemId: 'q2', position: 0 })
  await executeCompanionApiRendererCommand({ type: 'remove-queue-item', queueItemId: 'q3' })
  await executeCompanionApiRendererCommand({ type: 'clear-upcoming-queue' })

  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(['track', '/music/a.flac'])))
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'album'))
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'artist'))
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(['playlist', 8])))
  assert.deepEqual(calls.slice(-3), [['move', 'q2', 0], ['remove', 'q3'], ['clear-upcoming']])
})
