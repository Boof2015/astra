import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bindLibraryScrollRestoration,
  clearRememberedLibraryScrollPositions,
  getRememberedLibraryScrollPosition,
  rememberLibraryScrollPosition,
  resolveLibraryScrollContextKey,
  restoreLibraryScrollPosition,
  type LibraryScrollViewport
} from './libraryScrollRestoration.ts'

function createFrameScheduler() {
  let nextFrameId = 1
  const callbacks = new Map<number, FrameRequestCallback>()

  return {
    cancelFrame(frameId: number) {
      callbacks.delete(frameId)
    },
    flushFrame() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(0))
    },
    get pendingCount() {
      return callbacks.size
    },
    requestFrame(callback: FrameRequestCallback) {
      const frameId = nextFrameId
      nextFrameId += 1
      callbacks.set(frameId, callback)
      return frameId
    }
  }
}

test.beforeEach(() => {
  clearRememberedLibraryScrollPositions()
})

test('builds stable and independent root/detail scroll context keys', () => {
  const rootTracks = resolveLibraryScrollContextKey({
    viewMode: 'tracks',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null
  })
  const albumDetail = resolveLibraryScrollContextKey({
    viewMode: 'years',
    selectedAlbum: { identity_key: 'album-id', album: 'Album', artist: 'Artist' },
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null
  })
  const normalizedArtistDetail = resolveLibraryScrollContextKey({
    viewMode: 'artists',
    selectedAlbum: null,
    selectedArtist: '  ARTIST   Name ',
    selectedGenre: null,
    selectedYear: null
  })

  assert.equal(rootTracks, 'root:tracks')
  assert.equal(albumDetail, 'detail:album:album-id')
  assert.equal(normalizedArtistDetail, 'detail:artist:artist name')
})

test('keeps positions isolated and normalizes invalid offsets', () => {
  rememberLibraryScrollPosition('root:tracks', 412.5)
  rememberLibraryScrollPosition('root:albums', Number.NaN)
  rememberLibraryScrollPosition('root:artists', -20)

  assert.equal(getRememberedLibraryScrollPosition('root:tracks'), 412.5)
  assert.equal(getRememberedLibraryScrollPosition('root:albums'), 0)
  assert.equal(getRememberedLibraryScrollPosition('root:artists'), 0)
})

test('waits for a virtualized viewport to expose enough range before restoring', () => {
  const scheduler = createFrameScheduler()
  const viewport: LibraryScrollViewport = { clientHeight: 500, scrollHeight: 500, scrollTop: 0 }
  let settled = false

  restoreLibraryScrollPosition(viewport, 640, {
    cancelFrame: scheduler.cancelFrame,
    onSettled: () => { settled = true },
    requestFrame: scheduler.requestFrame
  })

  assert.equal(viewport.scrollTop, 0)
  assert.equal(scheduler.pendingCount, 1)

  viewport.scrollHeight = 1600
  scheduler.flushFrame()
  assert.equal(viewport.scrollTop, 640)
  assert.equal(settled, false)

  scheduler.flushFrame()
  assert.equal(viewport.scrollTop, 640)
  assert.equal(settled, true)
})

test('clamps to the available range when content remains shorter', () => {
  const scheduler = createFrameScheduler()
  const viewport: LibraryScrollViewport = { clientHeight: 400, scrollHeight: 550, scrollTop: 0 }

  restoreLibraryScrollPosition(viewport, 500, {
    cancelFrame: scheduler.cancelFrame,
    maxAttempts: 2,
    requestFrame: scheduler.requestFrame
  })

  scheduler.flushFrame()
  assert.equal(viewport.scrollTop, 150)
  assert.equal(scheduler.pendingCount, 0)
})

test('cancels stale retries and preserves an interrupted non-zero target', () => {
  const scheduler = createFrameScheduler()
  const viewport: LibraryScrollViewport = { clientHeight: 500, scrollHeight: 500, scrollTop: 0 }
  rememberLibraryScrollPosition('root:tracks', 700)

  const unbind = bindLibraryScrollRestoration('root:tracks', viewport, {
    cancelFrame: scheduler.cancelFrame,
    requestFrame: scheduler.requestFrame
  })
  assert.equal(scheduler.pendingCount, 1)

  unbind()
  assert.equal(scheduler.pendingCount, 0)
  assert.equal(getRememberedLibraryScrollPosition('root:tracks'), 700)
})

test('captures the final scroll offset when a context unmounts', () => {
  const viewport: LibraryScrollViewport = { clientHeight: 500, scrollHeight: 1400, scrollTop: 275 }
  const unbind = bindLibraryScrollRestoration('root:albums', viewport)

  viewport.scrollTop = 431
  unbind()

  assert.equal(getRememberedLibraryScrollPosition('root:albums'), 431)
})

test('resets a never-seen context when it reuses an existing scroll element', () => {
  const viewport: LibraryScrollViewport = { clientHeight: 500, scrollHeight: 1400, scrollTop: 431 }
  const unbind = bindLibraryScrollRestoration('detail:album:new-album', viewport)

  assert.equal(viewport.scrollTop, 0)
  unbind()
})
