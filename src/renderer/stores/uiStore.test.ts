import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_JUMP_TO_PLAYING_DESTINATION,
  DEFAULT_UI_SCALE_PERCENT,
  JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
  MAX_UI_SCALE_PERCENT,
  MIN_UI_SCALE_PERCENT,
  UI_SCALE_STEP_PERCENT,
  getNextUIScalePercent,
  normalizeJumpToPlayingDestination,
  useUIStore
} from './uiStore.ts'

test('getNextUIScalePercent increases and decreases by the configured UI scale step', () => {
  assert.equal(
    getNextUIScalePercent(DEFAULT_UI_SCALE_PERCENT, 'increase'),
    DEFAULT_UI_SCALE_PERCENT + UI_SCALE_STEP_PERCENT
  )
  assert.equal(
    getNextUIScalePercent(DEFAULT_UI_SCALE_PERCENT, 'decrease'),
    DEFAULT_UI_SCALE_PERCENT - UI_SCALE_STEP_PERCENT
  )
})

test('getNextUIScalePercent clamps to the configured UI scale bounds', () => {
  assert.equal(getNextUIScalePercent(MAX_UI_SCALE_PERCENT, 'increase'), MAX_UI_SCALE_PERCENT)
  assert.equal(getNextUIScalePercent(MIN_UI_SCALE_PERCENT, 'decrease'), MIN_UI_SCALE_PERCENT)
})

test('getNextUIScalePercent resets to the default UI scale', () => {
  assert.equal(getNextUIScalePercent(MAX_UI_SCALE_PERCENT, 'reset'), DEFAULT_UI_SCALE_PERCENT)
})

test('normalizeJumpToPlayingDestination accepts known destinations and defaults unknown values', () => {
  assert.equal(normalizeJumpToPlayingDestination('smart-source'), 'smart-source')
  assert.equal(normalizeJumpToPlayingDestination('library-tracks'), 'library-tracks')
  assert.equal(normalizeJumpToPlayingDestination('album'), 'album')
  assert.equal(normalizeJumpToPlayingDestination('artist'), 'artist')
  assert.equal(normalizeJumpToPlayingDestination('queue'), 'queue')
  assert.equal(normalizeJumpToPlayingDestination('unknown'), DEFAULT_JUMP_TO_PLAYING_DESTINATION)
  assert.equal(normalizeJumpToPlayingDestination(null), DEFAULT_JUMP_TO_PLAYING_DESTINATION)
})

test('jump to playing destination updates state and persists to localStorage', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })

  try {
    useUIStore.getState().setJumpToPlayingDestination('queue')
    assert.equal(useUIStore.getState().jumpToPlayingDestination, 'queue')
    assert.equal(values.get(JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY), 'queue')

    useUIStore.getState().resetJumpToPlayingDestination()
    assert.equal(useUIStore.getState().jumpToPlayingDestination, DEFAULT_JUMP_TO_PLAYING_DESTINATION)
    assert.equal(values.get(JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY), DEFAULT_JUMP_TO_PLAYING_DESTINATION)
  } finally {
    useUIStore.setState({ jumpToPlayingDestination: DEFAULT_JUMP_TO_PLAYING_DESTINATION })
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
})

test('track reveal requests clear only after the matching request id is consumed', () => {
  const ui = useUIStore.getState()

  ui.requestLibraryTrackReveal('/music/current.flac')
  const libraryRequest = useUIStore.getState().libraryTrackRevealRequest
  assert.ok(libraryRequest)

  ui.clearLibraryTrackRevealRequest(libraryRequest.id + 1)
  assert.equal(useUIStore.getState().libraryTrackRevealRequest?.id, libraryRequest.id)

  ui.clearLibraryTrackRevealRequest(libraryRequest.id)
  assert.equal(useUIStore.getState().libraryTrackRevealRequest, null)

  ui.requestPlaylistTrackReveal(42, '/music/current.flac')
  const playlistRequest = useUIStore.getState().playlistTrackRevealRequest
  assert.ok(playlistRequest)

  ui.clearPlaylistTrackRevealRequest(playlistRequest.id + 1)
  assert.equal(useUIStore.getState().playlistTrackRevealRequest?.id, playlistRequest.id)

  ui.clearPlaylistTrackRevealRequest(playlistRequest.id)
  assert.equal(useUIStore.getState().playlistTrackRevealRequest, null)

  ui.requestQueueNowPlayingReveal()
  const queueRequest = useUIStore.getState().queueNowPlayingRevealRequest
  assert.ok(queueRequest)

  ui.clearQueueNowPlayingRevealRequest(queueRequest.id + 1)
  assert.equal(useUIStore.getState().queueNowPlayingRevealRequest?.id, queueRequest.id)

  ui.clearQueueNowPlayingRevealRequest(queueRequest.id)
  assert.equal(useUIStore.getState().queueNowPlayingRevealRequest, null)
})
