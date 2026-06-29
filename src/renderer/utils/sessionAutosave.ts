import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistStore } from '../stores/playlistStore'
import { useUIStore } from '../stores/uiStore'
import {
  SESSION_STATE_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  clearSessionSnapshot,
  writeSessionSnapshot,
  type SessionSnapshotV1
} from './sessionState'

const SESSION_SAVE_DEBOUNCE_MS = 250
const SESSION_TIME_SAVE_THROTTLE_MS = 2000

let installed = false
let suppressSavesUntilMs = 0

export function createCurrentSessionSnapshot(): SessionSnapshotV1 {
  return {
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
    player: usePlayerStore.getState().getSessionSnapshot(),
    ui: useUIStore.getState().getSessionSnapshot(),
    library: useLibraryStore.getState().getSessionSnapshot(),
    playlist: usePlaylistStore.getState().getSessionSnapshot()
  }
}

export function saveCurrentSessionSnapshot(): void {
  if (Date.now() < suppressSavesUntilMs) return
  try {
    writeSessionSnapshot(createCurrentSessionSnapshot())
  } catch (error) {
    console.warn('Failed to persist Astra session state:', error)
  }
}

export function clearPersistedSessionStateForReset(): void {
  suppressSavesUntilMs = Date.now() + 2000
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

export function installSessionPersistence(): () => void {
  if (installed) return () => {}
  installed = true

  let saveTimer: number | null = null
  let lastSaveAt = 0

  const clearSaveTimer = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  const saveNow = () => {
    clearSaveTimer()
    lastSaveAt = Date.now()
    saveCurrentSessionSnapshot()
  }

  const scheduleSave = (delayMs: number) => {
    if (saveTimer !== null) return
    saveTimer = window.setTimeout(saveNow, delayMs)
  }

  const scheduleDebouncedSave = () => {
    const elapsedMs = Date.now() - lastSaveAt
    scheduleSave(Math.max(SESSION_SAVE_DEBOUNCE_MS, SESSION_SAVE_DEBOUNCE_MS - elapsedMs))
  }

  const scheduleTimeSave = () => {
    const elapsedMs = Date.now() - lastSaveAt
    scheduleSave(Math.max(0, SESSION_TIME_SAVE_THROTTLE_MS - elapsedMs))
  }

  const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
    if (
      state.playbackState !== previous.playbackState
      && (state.playbackState === 'paused' || state.playbackState === 'stopped')
    ) {
      saveNow()
      return
    }

    if (didPlayerStructureChange(state, previous)) {
      scheduleDebouncedSave()
      return
    }

    if (state.currentTime !== previous.currentTime) {
      scheduleTimeSave()
    }
  })
  const unsubscribeUI = useUIStore.subscribe(scheduleDebouncedSave)
  const unsubscribeLibrary = useLibraryStore.subscribe(scheduleDebouncedSave)
  const unsubscribePlaylist = usePlaylistStore.subscribe(scheduleDebouncedSave)

  window.addEventListener('beforeunload', saveNow)
  saveNow()

  return () => {
    installed = false
    clearSaveTimer()
    unsubscribePlayer()
    unsubscribeUI()
    unsubscribeLibrary()
    unsubscribePlaylist()
    window.removeEventListener('beforeunload', saveNow)
    saveCurrentSessionSnapshot()
  }
}
