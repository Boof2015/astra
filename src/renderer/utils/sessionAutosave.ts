import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistStore } from '../stores/playlistStore'
import { useUIStore } from '../stores/uiStore'
import {
  SESSION_POSITION_CHECKPOINT_KIND,
  SESSION_POSITION_CHECKPOINT_SCHEMA_VERSION,
  SESSION_STATE_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  clearSessionPositionCheckpoint,
  clearSessionSnapshot,
  writeSessionPositionCheckpoint,
  writeSessionSnapshot,
  type SessionPositionCheckpointV1,
  type SessionSnapshotV1
} from './sessionState'

const SESSION_FULL_SAVE_SETTLE_MS = 1500
const SESSION_FULL_SAVE_LOADING_RETRY_MS = 500
const SESSION_TIME_SAVE_THROTTLE_MS = 2000

let installed = false
let suppressSavesUntilMs = 0
let lastSessionRecordSavedAt = -1
let lastPersistedFullSessionSavedAt: number | null = null

function createMonotonicSessionSavedAt(after: number | null = null): number {
  const savedAt = Math.max(
    Date.now(),
    lastSessionRecordSavedAt + 1,
    after === null ? 0 : after + 1
  )
  lastSessionRecordSavedAt = savedAt
  return savedAt
}

export function createCurrentSessionSnapshot(): SessionSnapshotV1 {
  return {
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: createMonotonicSessionSavedAt(),
    player: usePlayerStore.getState().getSessionSnapshot(),
    ui: useUIStore.getState().getSessionSnapshot(),
    library: useLibraryStore.getState().getSessionSnapshot(),
    playlist: usePlaylistStore.getState().getSessionSnapshot()
  }
}

export function createCurrentSessionPositionCheckpoint(): SessionPositionCheckpointV1 | null {
  const player = usePlayerStore.getState()
  const baseSessionSavedAt = lastPersistedFullSessionSavedAt
  if (!player.currentTrack || baseSessionSavedAt === null) return null

  return {
    kind: SESSION_POSITION_CHECKPOINT_KIND,
    schemaVersion: SESSION_POSITION_CHECKPOINT_SCHEMA_VERSION,
    savedAt: createMonotonicSessionSavedAt(baseSessionSavedAt),
    baseSessionSavedAt,
    currentTrackPath: player.currentTrack.path,
    currentQueueItemId: player.currentQueueItemId,
    currentTrackSource: player.currentTrackSource,
    currentTime: player.currentTime
  }
}

export function saveCurrentSessionSnapshot(): boolean {
  if (Date.now() < suppressSavesUntilMs) return false
  // Until this write succeeds, live state is no longer known to match the previous base.
  // This also protects direct/internal checkpoint calls outside the installed scheduler.
  lastPersistedFullSessionSavedAt = null
  try {
    const snapshot = createCurrentSessionSnapshot()
    writeSessionSnapshot(snapshot)
    lastPersistedFullSessionSavedAt = snapshot.savedAt
    // An older checkpoint can no longer contribute anything once the authoritative
    // snapshot has landed. Keep removal separate so a failed full write never discards it.
    try {
      clearSessionPositionCheckpoint()
    } catch (error) {
      console.warn('Failed to clear Astra session position checkpoint:', error)
    }
    return true
  } catch (error) {
    console.warn('Failed to persist Astra session state:', error)
    return false
  }
}

export function saveCurrentSessionPositionCheckpoint(): boolean {
  if (Date.now() < suppressSavesUntilMs) return false
  const checkpoint = createCurrentSessionPositionCheckpoint()
  if (!checkpoint) return false

  try {
    writeSessionPositionCheckpoint(checkpoint)
    return true
  } catch (error) {
    console.warn('Failed to persist Astra session position checkpoint:', error)
    return false
  }
}

export function clearPersistedSessionStateForReset(): void {
  suppressSavesUntilMs = Date.now() + 2000
  lastPersistedFullSessionSavedAt = null
  try {
    clearSessionSnapshot()
  } catch {
    // Ignore storage failures during reset.
  }
}

function didPlayerStructureChange(
  state: ReturnType<typeof usePlayerStore.getState>,
  previous: ReturnType<typeof usePlayerStore.getState>
): boolean {
  return state.currentTrack?.path !== previous.currentTrack?.path
    || state.currentQueueItemId !== previous.currentQueueItemId
    || state.currentTrackSource !== previous.currentTrackSource
    || state.queueItems !== previous.queueItems
    || state.baseUpcomingQueueIds !== previous.baseUpcomingQueueIds
    || state.upcomingQueueIds !== previous.upcomingQueueIds
    || state.playbackHistory !== previous.playbackHistory
    || state.queueSourcePlaylistId !== previous.queueSourcePlaylistId
    || state.queueSourceContext !== previous.queueSourceContext
    || state.queueContextLabel !== previous.queueContextLabel
    || state.shuffle !== previous.shuffle
    || state.repeat !== previous.repeat
    || state.duration !== previous.duration
    || state.restoredTrackNeedsLoad !== previous.restoredTrackNeedsLoad
}

function didUISessionStateChange(
  state: ReturnType<typeof useUIStore.getState>,
  previous: ReturnType<typeof useUIStore.getState>
): boolean {
  return state.activeView !== previous.activeView
    || state.showQueue !== previous.showQueue
    || state.showInfoSidebar !== previous.showInfoSidebar
    || state.showPipelineShelf !== previous.showPipelineShelf
    || state.showLyricsShelf !== previous.showLyricsShelf
    || state.lyricsShelfExpanded !== previous.lyricsShelfExpanded
    || state.fullscreenLyricsVisible !== previous.fullscreenLyricsVisible
}

function didSortStateChange(
  state: { key: string; direction: string } | null,
  previous: { key: string; direction: string } | null
): boolean {
  return state?.key !== previous?.key || state?.direction !== previous?.direction
}

function didStringSetChange(state: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  if (state === previous) return false
  if (state.size !== previous.size) return true
  for (const value of state) {
    if (!previous.has(value)) return true
  }
  return false
}

function didLibrarySessionStateChange(
  state: ReturnType<typeof useLibraryStore.getState>,
  previous: ReturnType<typeof useLibraryStore.getState>
): boolean {
  return state.viewMode !== previous.viewMode
    || state.selectedAlbum?.identity_key !== previous.selectedAlbum?.identity_key
    || state.selectedAlbum?.album !== previous.selectedAlbum?.album
    || state.selectedAlbum?.artist !== previous.selectedAlbum?.artist
    || state.selectedAlbum?.is_new !== previous.selectedAlbum?.is_new
    || state.selectedArtist !== previous.selectedArtist
    || state.selectedGenre !== previous.selectedGenre
    || state.selectedYear !== previous.selectedYear
    || didSortStateChange(state.trackListSortState, previous.trackListSortState)
    || didSortStateChange(state.tracksViewSortState, previous.tracksViewSortState)
    || didStringSetChange(state.selectedSourceFilters, previous.selectedSourceFilters)
    || state.albumSortMode !== previous.albumSortMode
    || state.includeSinglesInAlbums !== previous.includeSinglesInAlbums
    || state.includeCollabArtists !== previous.includeCollabArtists
    || state.artistRootViewMode !== previous.artistRootViewMode
}

function didPlaylistSessionStateChange(
  state: ReturnType<typeof usePlaylistStore.getState>,
  previous: ReturnType<typeof usePlaylistStore.getState>
): boolean {
  return state.selectedPlaylistId !== previous.selectedPlaylistId
    || didSortStateChange(state.sortState, previous.sortState)
}

export function installSessionPersistence(options: { persistedSessionSavedAt?: number | null } = {}): () => void {
  if (installed) return () => {}
  installed = true

  let fullSaveTimer: number | null = null
  let positionSaveTimer: number | null = null
  let lastPositionSaveAttemptAt = 0
  let fullStateDirty = true
  let failedFullSaveQueueItems: ReturnType<typeof usePlayerStore.getState>['queueItems'] | null = null

  const clearFullSaveTimer = () => {
    if (fullSaveTimer !== null) {
      window.clearTimeout(fullSaveTimer)
      fullSaveTimer = null
    }
  }

  const clearPositionSaveTimer = () => {
    if (positionSaveTimer !== null) {
      window.clearTimeout(positionSaveTimer)
      positionSaveTimer = null
    }
  }

  const saveFullNow = (options: { force?: boolean } = {}) => {
    clearFullSaveTimer()
    clearPositionSaveTimer()
    fullStateDirty = true
    if (!options.force && usePlayerStore.getState().playbackState === 'loading') {
      fullSaveTimer = window.setTimeout(saveFullNow, SESSION_FULL_SAVE_LOADING_RETRY_MS)
      return
    }

    const fullSaveAttemptAt = Date.now()
    const queueItemsAtAttempt = usePlayerStore.getState().queueItems
    if (saveCurrentSessionSnapshot()) {
      fullStateDirty = false
      failedFullSaveQueueItems = null
      lastPositionSaveAttemptAt = fullSaveAttemptAt
    } else {
      // A very large queue can exceed localStorage quota. Do not repeatedly pay the
      // clone/stringify cost on every skip; retry once queue composition changes.
      failedFullSaveQueueItems = queueItemsAtAttempt
    }
  }

  const savePositionNow = () => {
    clearPositionSaveTimer()
    lastPositionSaveAttemptAt = Date.now()
    if (fullStateDirty) return
    saveCurrentSessionPositionCheckpoint()
  }

  const scheduleFullSave = (delayMs: number) => {
    fullStateDirty = true
    clearPositionSaveTimer()
    if (failedFullSaveQueueItems === usePlayerStore.getState().queueItems) return
    // This is deliberately trailing-edge: a burst of queue transitions should produce
    // one snapshot after it settles, never one giant serialization in the middle.
    clearFullSaveTimer()
    fullSaveTimer = window.setTimeout(saveFullNow, delayMs)
  }

  const scheduleDebouncedFullSave = () => {
    // Structural state is authoritative. Do not let a previously queued position-only
    // write defer it or leave a newer checkpoint referring to the old structure.
    scheduleFullSave(SESSION_FULL_SAVE_SETTLE_MS)
  }

  const scheduleTimeCheckpoint = () => {
    if (fullStateDirty) return
    if (fullSaveTimer !== null || positionSaveTimer !== null) return
    const elapsedMs = Date.now() - lastPositionSaveAttemptAt
    positionSaveTimer = window.setTimeout(
      savePositionNow,
      Math.max(0, SESSION_TIME_SAVE_THROTTLE_MS - elapsedMs)
    )
  }

  const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
    if (
      state.playbackState !== previous.playbackState
      && (state.playbackState === 'paused' || state.playbackState === 'stopped')
    ) {
      if (fullStateDirty) {
        scheduleFullSave(SESSION_FULL_SAVE_SETTLE_MS)
      } else {
        savePositionNow()
      }
      return
    }

    if (didPlayerStructureChange(state, previous)) {
      scheduleDebouncedFullSave()
      return
    }

    if (state.currentTime !== previous.currentTime) {
      scheduleTimeCheckpoint()
    }
  })
  const unsubscribeUI = useUIStore.subscribe((state, previous) => {
    if (didUISessionStateChange(state, previous)) scheduleDebouncedFullSave()
  })
  const unsubscribeLibrary = useLibraryStore.subscribe((state, previous) => {
    if (didLibrarySessionStateChange(state, previous)) scheduleDebouncedFullSave()
  })
  const unsubscribePlaylist = usePlaylistStore.subscribe((state, previous) => {
    if (didPlaylistSessionStateChange(state, previous)) scheduleDebouncedFullSave()
  })

  const forceFullSave = () => saveFullNow({ force: true })
  window.addEventListener('beforeunload', forceFullSave)
  const persistedSessionSavedAt = typeof options.persistedSessionSavedAt === 'number'
    && Number.isFinite(options.persistedSessionSavedAt)
    && options.persistedSessionSavedAt >= 0
    ? options.persistedSessionSavedAt
    : null
  if (persistedSessionSavedAt !== null) {
    lastPersistedFullSessionSavedAt = persistedSessionSavedAt
    lastSessionRecordSavedAt = Math.max(lastSessionRecordSavedAt, persistedSessionSavedAt)
    // Session restoration can filter stale tracks and update derived state. Persist that
    // authoritative result after startup settles instead of immediately reserializing a
    // potentially enormous restored queue on the launch critical path.
    scheduleFullSave(SESSION_FULL_SAVE_SETTLE_MS)
  } else {
    saveFullNow()
  }

  return () => {
    installed = false
    clearFullSaveTimer()
    clearPositionSaveTimer()
    unsubscribePlayer()
    unsubscribeUI()
    unsubscribeLibrary()
    unsubscribePlaylist()
    window.removeEventListener('beforeunload', forceFullSave)
    forceFullSave()
  }
}
