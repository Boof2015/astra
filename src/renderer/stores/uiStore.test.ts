import assert from 'node:assert/strict'
import test from 'node:test'
import { TRANSPORT_INFO_LINE_MODE_STORAGE_KEY } from '../constants/settingsStorageKeys.ts'
import {
  DEFAULT_HOME_GREETING_TEXT_MODE,
  DEFAULT_JUMP_TO_PLAYING_DESTINATION,
  DEFAULT_TRANSPORT_INFO_LINE_MODE,
  DEFAULT_UI_SCALE_PERCENT,
  HOME_GREETING_TEXT_MODE_STORAGE_KEY,
  JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
  MAX_UI_SCALE_PERCENT,
  MIN_UI_SCALE_PERCENT,
  UI_SCALE_STEP_PERCENT,
  getNextUIScalePercent,
  normalizeHomeGreetingTextMode,
  normalizeJumpToPlayingDestination,
  normalizeTransportInfoLineMode,
  resolveAppViewTransitionDirection,
  useUIStore
} from './uiStore.ts'

test('normalizeHomeGreetingTextMode accepts binary clock and defaults unknown values', () => {
  assert.equal(normalizeHomeGreetingTextMode('messages'), 'messages')
  assert.equal(normalizeHomeGreetingTextMode('clock'), 'clock')
  assert.equal(normalizeHomeGreetingTextMode('binary-clock'), 'binary-clock')
  assert.equal(normalizeHomeGreetingTextMode('off'), 'off')
  assert.equal(normalizeHomeGreetingTextMode('unknown'), DEFAULT_HOME_GREETING_TEXT_MODE)
  assert.equal(normalizeHomeGreetingTextMode(null), DEFAULT_HOME_GREETING_TEXT_MODE)
})

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

test('normalizeTransportInfoLineMode accepts known modes and defaults unknown values', () => {
  assert.equal(normalizeTransportInfoLineMode('output'), 'output')
  assert.equal(normalizeTransportInfoLineMode('album'), 'album')
  assert.equal(normalizeTransportInfoLineMode('hidden'), 'hidden')
  assert.equal(normalizeTransportInfoLineMode('unknown'), DEFAULT_TRANSPORT_INFO_LINE_MODE)
  assert.equal(normalizeTransportInfoLineMode(null), DEFAULT_TRANSPORT_INFO_LINE_MODE)
})

test('resolveAppViewTransitionDirection follows sidebar order', () => {
  assert.equal(resolveAppViewTransitionDirection('library', 'stats'), 'down')
  assert.equal(resolveAppViewTransitionDirection('stats', 'library'), 'up')
  assert.equal(resolveAppViewTransitionDirection('library', 'eq'), 'down')
  assert.equal(resolveAppViewTransitionDirection('eq', 'library'), 'up')
  assert.equal(resolveAppViewTransitionDirection('library', 'library'), null)
  assert.equal(resolveAppViewTransitionDirection(null, 'library'), null)
  assert.equal(resolveAppViewTransitionDirection('library', undefined), null)
})

test('setActiveView commits navigation when the View Transition API is unavailable', () => {
  useUIStore.setState({ activeView: 'home', viewBackHistory: [], viewForwardHistory: [] })

  useUIStore.getState().setActiveView('library')
  assert.equal(useUIStore.getState().activeView, 'library')

  useUIStore.getState().setActiveView('home')
  assert.equal(useUIStore.getState().activeView, 'home')
})

test('view navigation tracks back and forward history and clears forward on fresh navigation', () => {
  useUIStore.setState({ activeView: 'home', viewBackHistory: [], viewForwardHistory: [] })

  useUIStore.getState().setActiveView('library')
  useUIStore.getState().setActiveView('settings')
  assert.deepEqual(useUIStore.getState().viewBackHistory, ['home', 'library'])

  assert.equal(useUIStore.getState().navigateViewBack(), true)
  assert.equal(useUIStore.getState().activeView, 'library')
  assert.deepEqual(useUIStore.getState().viewForwardHistory, ['settings'])

  assert.equal(useUIStore.getState().navigateViewForward(), true)
  assert.equal(useUIStore.getState().activeView, 'settings')

  useUIStore.getState().navigateViewBack()
  useUIStore.getState().setActiveView('playlist')
  assert.deepEqual(useUIStore.getState().viewForwardHistory, [])
  assert.equal(useUIStore.getState().navigateViewForward(), false)
})

test('track drag sessions keep stable occurrence payloads and semantic drop state', () => {
  const ui = useUIStore.getState()
  ui.startTrackDrag(
    [{
      key: 'playlist-entry:42',
      path: '/music/repeated.flac',
      title: 'Repeated',
      artist: 'Artist',
      track: null,
      playlistEntryId: 42,
      missing: true
    }],
    { kind: 'track-list', playlistId: 7 },
    {
      activeView: 'playlist',
      showQueue: false,
      selectedPlaylistId: 7,
      playlistSortState: { key: 'title', direction: 'asc' }
    },
    3,
    100,
    200
  )

  useUIStore.getState().setTrackDragDropTarget('playlist', {
    surface: 'playlist',
    kind: 'insert',
    playlistId: 7,
    index: 5
  })
  useUIStore.getState().setTrackDragItems([
    {
      key: 'playlist-entry:42',
      path: '/music/repeated.flac',
      title: 'Repeated',
      artist: 'Artist',
      track: null,
      playlistEntryId: 42,
      missing: true
    },
    {
      key: 'playlist-entry:43',
      path: '/music/next.flac',
      title: 'Next',
      artist: 'Artist',
      track: null,
      playlistEntryId: 43,
      missing: true
    }
  ])
  useUIStore.getState().setTrackDragPhase('dropping')

  const drag = useUIStore.getState().trackDrag
  assert.equal(drag?.items[0]?.key, 'playlist-entry:42')
  assert.equal(drag?.items[0]?.playlistEntryId, 42)
  assert.equal(drag?.items[1]?.key, 'playlist-entry:43')
  assert.deepEqual(drag?.dropTarget, { surface: 'playlist', kind: 'insert', playlistId: 7, index: 5 })
  assert.equal(drag?.phase, 'dropping')
  ui.clearTrackDrag()
})

test('committed spring navigation restores the complete drag origin on Back', () => {
  useUIStore.setState({
    activeView: 'playlist',
    viewBackHistory: [],
    viewForwardHistory: [],
    showQueue: true,
    playlistNavigationRestoreRequest: null,
    trackDragCommittedNavigation: null
  })
  useUIStore.getState().commitTransientView({
    activeView: 'playlist',
    showQueue: false,
    selectedPlaylistId: 17,
    playlistSortState: { key: 'artist', direction: 'desc' }
  })

  assert.deepEqual(useUIStore.getState().viewBackHistory, ['playlist'])
  assert.equal(useUIStore.getState().navigateViewBack(), true)
  assert.equal(useUIStore.getState().activeView, 'playlist')
  assert.equal(useUIStore.getState().showQueue, false)
  const request = useUIStore.getState().playlistNavigationRestoreRequest
  assert.equal(request?.playlistId, 17)
  assert.deepEqual(request?.sortState, { key: 'artist', direction: 'desc' })
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

test('transport info line mode updates state, persists, and resets to output', () => {
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
    useUIStore.getState().setTransportInfoLineMode('album')
    assert.equal(useUIStore.getState().transportInfoLineMode, 'album')
    assert.equal(values.get(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY), 'album')

    useUIStore.getState().resetTransportInfoLineMode()
    assert.equal(useUIStore.getState().transportInfoLineMode, DEFAULT_TRANSPORT_INFO_LINE_MODE)
    assert.equal(values.get(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY), DEFAULT_TRANSPORT_INFO_LINE_MODE)
  } finally {
    useUIStore.setState({ transportInfoLineMode: DEFAULT_TRANSPORT_INFO_LINE_MODE })
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
})

test('Home greeting text mode persists binary clock and resets to messages', () => {
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
    useUIStore.getState().setHomeGreetingTextMode('binary-clock')
    assert.equal(useUIStore.getState().homeGreetingTextMode, 'binary-clock')
    assert.equal(values.get(HOME_GREETING_TEXT_MODE_STORAGE_KEY), 'binary-clock')

    useUIStore.getState().resetHomeGreetingTextMode()
    assert.equal(useUIStore.getState().homeGreetingTextMode, DEFAULT_HOME_GREETING_TEXT_MODE)
    assert.equal(values.get(HOME_GREETING_TEXT_MODE_STORAGE_KEY), DEFAULT_HOME_GREETING_TEXT_MODE)
  } finally {
    useUIStore.setState({ homeGreetingTextMode: DEFAULT_HOME_GREETING_TEXT_MODE })
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

test('fullscreen lyrics visibility toggles independently of fullscreen state', () => {
  useUIStore.setState({ fullscreenLyricsVisible: false, isFullscreen: true })

  useUIStore.getState().toggleFullscreenLyricsVisible()
  assert.equal(useUIStore.getState().fullscreenLyricsVisible, true)

  useUIStore.getState().setFullscreen(false)
  assert.equal(useUIStore.getState().fullscreenLyricsVisible, true)

  useUIStore.getState().setFullscreenLyricsVisible(false)
  assert.equal(useUIStore.getState().fullscreenLyricsVisible, false)
})

test('Signal sharing freezes a metadata-only target until the modal closes', () => {
  const target = { artist: 'ナナツカゼ', title: 'Replay', duration: 213.6 }

  useUIStore.getState().openSignalShare(target)
  target.title = 'Changed after opening'

  assert.deepEqual(useUIStore.getState().signalShareTarget, {
    artist: 'ナナツカゼ',
    title: 'Replay',
    duration: 213.6
  })

  useUIStore.getState().closeSignalShare()
  assert.equal(useUIStore.getState().signalShareTarget, null)
})

test('session restore applies core view state without transient history or overlays', () => {
  useUIStore.setState({
    activeView: 'home',
    viewBackHistory: ['library'],
    viewForwardHistory: ['settings'],
    showQueue: false,
    showInfoSidebar: false,
    showPipelineShelf: false,
    showLyricsShelf: false,
    lyricsShelfExpanded: false,
    fullscreenLyricsVisible: false,
    isFullscreen: true,
    isQuickLaunchOpen: true,
    pendingLibrarySearchQuery: 'query'
  })

  useUIStore.getState().restoreSession({
    activeView: 'library',
    showQueue: true,
    showInfoSidebar: true,
    showPipelineShelf: true,
    showLyricsShelf: true,
    lyricsShelfExpanded: true,
    fullscreenLyricsVisible: true
  })

  const state = useUIStore.getState()
  assert.equal(state.activeView, 'library')
  assert.deepEqual(state.viewBackHistory, [])
  assert.deepEqual(state.viewForwardHistory, [])
  assert.equal(state.showQueue, true)
  assert.equal(state.showInfoSidebar, true)
  assert.equal(state.showPipelineShelf, true)
  assert.equal(state.showLyricsShelf, true)
  assert.equal(state.lyricsShelfExpanded, true)
  assert.equal(state.fullscreenLyricsVisible, true)
  assert.equal(state.isFullscreen, false)
  assert.equal(state.isQuickLaunchOpen, false)
  assert.equal(state.pendingLibrarySearchQuery, null)
  assert.deepEqual(state.getSessionSnapshot(), {
    activeView: 'library',
    showQueue: true,
    showInfoSidebar: true,
    showPipelineShelf: true,
    showLyricsShelf: true,
    lyricsShelfExpanded: true,
    fullscreenLyricsVisible: true
  })
})
