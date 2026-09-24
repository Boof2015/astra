import assert from 'node:assert/strict'
import test from 'node:test'
import {
  albumCardPlaybackSource,
  createLibraryCardPlaybackActions,
  getAlbumCardPlaybackState,
  getLibraryCardPlaybackState,
  type LibraryCardSource,
  type LibraryCardPlaybackFilters,
  type AlbumPlaybackTarget
} from './libraryCardPlayback.ts'

const album: AlbumPlaybackTarget = { album: 'One', artist: 'Artist', identity_key: 'release:one' }
const source = albumCardPlaybackSource(album)
const target = { source, title: album.album }
const filters: LibraryCardPlaybackFilters = { sourceFilters: new Set(), hiddenFolderPrefixes: [], platform: 'darwin' }
const track = (path: string) => ({ path, is_available: 1, source_type: 'local' as const, source_id: null })
type Actions = Parameters<typeof createLibraryCardPlaybackActions>[0]

function setup(overrides: Partial<Actions> = {}) {
  const starts: Array<Parameters<Actions['start']>> = []
  const pending: Array<string | null> = []
  const errors: Array<string | null> = []
  const fetched: LibraryCardSource[] = []
  const controller = createLibraryCardPlaybackActions({
    getContext: () => ({ currentSource: null, currentTrackPath: null, loading: false }),
    getTracks: async (target) => { fetched.push(target); return [track('/one.flac')] },
    toggle: async () => { assert.fail('must start an inactive album') },
    start: async (...args) => { starts.push(args) },
    onPendingChange: (key) => pending.push(key),
    onError: (error) => errors.push(error),
    ...overrides
  })
  return { controller, starts, pending, errors, fetched }
}

test('album cards start the entire release in returned multi-disc order with shuffle explicitly off', async () => {
  const tracks = [track('/disc1/01.flac'), track('/disc1/02.flac'), track('/disc2/01.flac')]
  const { controller, starts } = setup({ getTracks: async (target) => { assert.deepEqual(target, source); return tracks } })
  await controller.play(target, filters)
  assert.deepEqual(starts, [[tracks.map((entry) => entry.path), 0, { sourceContext: source, contextLabel: 'One', shuffle: false }]])
})

test('pause and resume preserve queue and position without fetching the active album', async () => {
  const queue = ['/one.flac', '/manual.flac', '/two.flac']
  const player = { queue, position: 42, playing: true }
  const { controller, starts, fetched } = setup({
    getContext: () => ({ currentSource: source, currentTrackPath: '/one.flac', loading: false }),
    toggle: async () => { player.playing = !player.playing }
  })
  await controller.play(target, filters)
  assert.equal(player.playing, false)
  await controller.play(target, filters)
  assert.equal(player.playing, true)
  assert.equal(player.queue, queue)
  assert.equal(player.position, 42)
  assert.equal(starts.length, 0)
  assert.equal(fetched.length, 0)
})

test('playlist membership and identically titled releases do not activate an album card', async () => {
  for (const currentSource of [{ type: 'playlist' as const, playlistId: 4 }, { ...source, identityKey: 'release:two' }]) {
    const snapshot = { currentSource, currentTrackPath: '/one.flac', playbackState: 'playing', pendingKey: null }
    assert.equal(getAlbumCardPlaybackState(album, snapshot).active, false)
    const { controller, starts, fetched } = setup({ getContext: () => ({ ...snapshot, loading: false }) })
    await controller.play(target, filters)
    assert.equal(starts.length, 1)
    assert.deepEqual(fetched, [source])
  }
})

test('album playback applies availability, hidden-folder and source filters without changing order', async () => {
  const tracks = [
    track('/Music/Hidden/a.flac'), track('/music/hidden-extra/keep.flac'),
    { ...track('/unavailable.flac'), is_available: 0 },
    { ...track('subsonic:keep'), source_type: 'subsonic' as const, source_id: 2 },
    { ...track('subsonic:other'), source_type: 'subsonic' as const, source_id: 3 },
    { ...track('subsonic:missing-source'), source_type: 'subsonic' as const },
    { ...track('jellyfin:keep'), source_type: 'jellyfin' as const, source_id: 5 },
    { ...track('jellyfin:other'), source_type: 'jellyfin' as const, source_id: 6 }
  ]
  const { controller, starts } = setup({ getTracks: async () => tracks })
  await controller.play(target, {
    sourceFilters: new Set(['local', 'subsonic:2', 'jellyfin:5']), hiddenFolderPrefixes: ['/music/hidden'], platform: 'darwin'
  })
  assert.deepEqual(starts[0][0], ['/music/hidden-extra/keep.flac', 'subsonic:keep', 'jellyfin:keep'])
})

test('rapid duplicate and cross-card clicks are locked until the request finishes', async () => {
  let release!: (tracks: ReturnType<typeof track>[]) => void
  let requests = 0
  const result = setup({ getTracks: () => { requests++; return new Promise((resolve) => { release = resolve }) } })
  const first = result.controller.play(target, filters)
  await result.controller.play(target, filters)
  await result.controller.play({ ...target, source: { ...source, identityKey: 'release:two' } }, filters)
  assert.equal(requests, 1)
  assert.deepEqual(result.pending, ['album:release:one'])
  release([track('/one.flac')])
  await first
  assert.equal(result.starts.length, 1)
  assert.deepEqual(result.pending, ['album:release:one', null])
})

test('loading disables new requests and state marks only the matching pending/playing album', async () => {
  const result = setup({ getContext: () => ({ currentSource: source, currentTrackPath: '/one.flac', loading: true }) })
  await result.controller.play(target, filters)
  assert.equal(result.fetched.length, 0)
  assert.equal(result.pending.length, 0)
  assert.deepEqual(getAlbumCardPlaybackState(album, {
    currentSource: source, currentTrackPath: '/one.flac', playbackState: 'playing', pendingKey: null
  }), { active: true, playing: true, pending: false, disabled: false })
  assert.deepEqual(getAlbumCardPlaybackState(album, {
    currentSource: source, currentTrackPath: '/one.flac', playbackState: 'loading', pendingKey: null
  }), { active: true, playing: false, pending: true, disabled: true })
  assert.deepEqual(getAlbumCardPlaybackState(album, {
    currentSource: null, currentTrackPath: null, playbackState: 'paused', pendingKey: 'album:release:one'
  }), { active: false, playing: false, pending: true, disabled: true })
})

test('empty, failed fetch and failed playback release the lock and allow retry', async () => {
  for (const failure of ['empty', 'fetch', 'start'] as const) {
    let fail = true
    const result = setup({
      getTracks: async () => {
        if (fail && failure === 'fetch') throw new Error('Server unavailable')
        return fail && failure === 'empty' ? [{ ...track('/missing.flac'), is_available: 0 }] : [track('/one.flac')]
      },
      start: async () => { if (fail && failure === 'start') throw new Error('Device unavailable') }
    })
    await result.controller.play(target, filters)
    assert.equal(result.errors.at(-1), failure === 'empty' ? 'No available tracks in One.' : failure === 'fetch' ? 'Server unavailable' : 'Device unavailable')
    assert.equal(result.pending.at(-1), null)
    fail = false
    await result.controller.play(target, filters)
    assert.equal(result.errors.at(-1), null)
    assert.equal(result.pending.at(-1), null)
    assert.equal(result.pending.length, 4)
  }
})


const collectionSources: LibraryCardSource[] = [
  { type: 'artist', artist: 'Artist' }, { type: 'genre', genre: 'Rock' }, { type: 'year', year: 2025 }, { type: 'year', year: 'unknown' }
]

test('artist, genre and year cards use the full collection and honor the player shuffle setting', async () => {
  for (const source of collectionSources) {
    const { controller, starts, fetched } = setup()
    await controller.play({ source, title: 'Collection' }, filters)
    assert.deepEqual(fetched, [source])
    assert.deepEqual(starts, [[['/one.flac'], 0, { sourceContext: source, contextLabel: 'Collection', startShuffled: true }]])
    assert.equal('shuffle' in starts[0][2], false)
  }
})

test('active collection sources toggle without fetching and playlist membership does not activate them', async () => {
  for (const source of collectionSources) {
    let toggles = 0
    const snapshot = { currentSource: source, currentTrackPath: '/one.flac', playbackState: 'playing', pendingKey: null }
    const { controller, fetched, starts } = setup({
      getContext: () => ({ ...snapshot, loading: false }), toggle: async () => { toggles++ }
    })
    await controller.play({ source, title: 'Collection' }, filters)
    assert.equal(toggles, 1)
    assert.deepEqual(fetched, [])
    assert.deepEqual(starts, [])
    assert.equal(getLibraryCardPlaybackState(source, snapshot).playing, true)
    assert.equal(getLibraryCardPlaybackState(source, { ...snapshot, currentSource: { type: 'playlist', playlistId: 3 } }).active, false)
  }
})

test('year playback respects eligible album identities, availability and hidden folders in returned order', async () => {
  const { controller, starts } = setup({ getTracks: async () => [
    { ...track('/two.flac'), album_identity_key: 'two' },
    { ...track('/single.flac'), album_identity_key: 'single' },
    { ...track('/hidden/one.flac'), album_identity_key: 'one' },
    { ...track('/unavailable.flac'), album_identity_key: 'one', is_available: 0 },
    { ...track('/one.flac'), album_identity_key: 'one' }
  ] })
  await controller.play({ source: { type: 'year', year: 2025 }, title: '2025' }, {
    ...filters, albumIdentityKeys: new Set(['one', 'two']), hiddenFolderPrefixes: ['/hidden']
  })
  assert.deepEqual(starts[0][0], ['/two.flac', '/one.flac'])
})

test('album and collection cards share the immediate request lock and recover across surfaces', async () => {
  let finish!: (tracks: ReturnType<typeof track>[]) => void
  const { controller, starts, pending, errors } = setup({ getTracks: () => new Promise(resolve => { finish = resolve }) })
  const first = controller.play(target, filters)
  for (const source of collectionSources) await controller.play({ source, title: 'Collection' }, filters)
  assert.deepEqual(pending, ['album:release:one'])
  finish([])
  await first
  assert.equal(errors.at(-1), 'No available tracks in One.')
  const retry = controller.play({ source: collectionSources[0], title: 'Artist' }, filters)
  finish([track('/artist.flac')])
  await retry
  assert.equal(errors.at(-1), null)
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0][2].sourceContext, collectionSources[0])
})
