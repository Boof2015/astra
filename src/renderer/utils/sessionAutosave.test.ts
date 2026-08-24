import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY,
  ASTRA_SESSION_STATE_STORAGE_KEY
} from '../constants/settingsStorageKeys.ts'
import { usePlayerStore } from '../stores/playerStore.ts'
import type { Track } from '../types/audio.ts'
import {
  installSessionPersistence,
  saveCurrentSessionPositionCheckpoint,
  saveCurrentSessionSnapshot
} from './sessionAutosave.ts'

class RecordingStorage {
  readonly values = new Map<string, string>()
  readonly writes: string[] = []
  failFullWrites = false
  failCheckpointWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes.push(key)
    if (key === ASTRA_SESSION_STATE_STORAGE_KEY && this.failFullWrites) {
      throw new Error('full session quota failure')
    }
    if (key === ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY && this.failCheckpointWrites) {
      throw new Error('checkpoint quota failure')
    }
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function createTrack(): Track {
  return {
    id: 'track-a',
    path: '/music/a.flac',
    title: 'A',
    artist: 'Artist',
    album: 'Album',
    duration: 120,
    format: 'flac'
  }
}

function installGlobalValue(name: 'localStorage' | 'window', value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete (globalThis as Record<string, unknown>)[name]
    }
  }
}

test('a position save does not build or rewrite the full queue snapshot', () => {
  const storage = new RecordingStorage()
  const restoreStorage = installGlobalValue('localStorage', storage)
  const originalPlayerState = usePlayerStore.getState()

  try {
    usePlayerStore.setState({
      currentTrack: createTrack(),
      currentTrackSource: 'standalone',
      currentQueueItemId: null,
      currentTime: 10
    })
    assert.equal(saveCurrentSessionSnapshot(), true)

    let fullPlayerSnapshotCalls = 0
    usePlayerStore.setState({
      currentTime: 42,
      getSessionSnapshot: () => {
        fullPlayerSnapshotCalls += 1
        throw new Error('position save requested a full player snapshot')
      }
    })
    storage.writes.length = 0

    assert.equal(saveCurrentSessionPositionCheckpoint(), true)
    assert.equal(fullPlayerSnapshotCalls, 0)
    assert.deepEqual(storage.writes, [ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY])

    const full = JSON.parse(storage.values.get(ASTRA_SESSION_STATE_STORAGE_KEY) ?? '{}') as { savedAt?: number }
    const checkpoint = JSON.parse(
      storage.values.get(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY) ?? '{}'
    ) as Record<string, unknown>
    assert.equal(checkpoint.baseSessionSavedAt, full.savedAt)
    assert.deepEqual(Object.keys(checkpoint).sort(), [
      'baseSessionSavedAt',
      'currentQueueItemId',
      'currentTime',
      'currentTrackPath',
      'currentTrackSource',
      'kind',
      'savedAt',
      'schemaVersion'
    ])
  } finally {
    usePlayerStore.setState(originalPlayerState, true)
    restoreStorage()
  }
})

test('structural saves coalesce after playback settles and failed large queues are not retried on every skip', () => {
  let now = 1_000
  let nextTimerId = 1
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const fakeWindow = {
    setTimeout: (callback: () => void, delayMs = 0): number => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimeout: (id: number): void => {
      timers.delete(id)
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {}
  }
  const runOnlyTimer = () => {
    assert.equal(timers.size, 1)
    const [id, timer] = [...timers.entries()][0]!
    timers.delete(id)
    timer.callback()
  }

  const storage = new RecordingStorage()
  const restoreStorage = installGlobalValue('localStorage', storage)
  const restoreWindow = installGlobalValue('window', fakeWindow)
  const originalDateNow = Date.now
  const originalWarn = console.warn
  const originalPlayerState = usePlayerStore.getState()
  Date.now = () => now
  console.warn = () => {}
  let cleanup: (() => void) | null = null

  try {
    usePlayerStore.setState({
      currentTrack: createTrack(),
      currentTrackSource: 'standalone',
      currentQueueItemId: null,
      currentTime: 0,
      queueContextLabel: null,
      playbackState: 'playing'
    })
    cleanup = installSessionPersistence()
    storage.writes.length = 0

    now = 1_100
    usePlayerStore.setState({ currentTime: 1 })
    assert.equal([...timers.values()][0]?.delayMs, 1_900)

    now = 1_150
    usePlayerStore.setState({ queueContextLabel: 'changed structure' })
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0]?.delayMs, 1_500)

    // A second queue transition replaces the first timer instead of allowing a
    // full snapshot to land in the middle of a skip burst.
    now = 1_200
    usePlayerStore.setState({ queueContextLabel: 'changed structure again' })
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0]?.delayMs, 1_500)

    storage.writes.length = 0
    now = 1_300
    usePlayerStore.setState({ playbackState: 'loading' })
    now = 2_700
    runOnlyTimer()
    assert.equal(storage.writes.length, 0)
    assert.equal([...timers.values()][0]?.delayMs, 500)

    // AudioEngine emits a transient stopped state immediately before play. It must
    // not synchronously serialize the full queue between decode and first audio.
    now = 2_750
    usePlayerStore.setState({ playbackState: 'stopped' })
    assert.equal(storage.writes.length, 0)
    assert.equal([...timers.values()][0]?.delayMs, 1_500)
    usePlayerStore.setState({ playbackState: 'playing' })

    now = 4_250
    runOnlyTimer()
    assert.deepEqual(storage.writes, [ASTRA_SESSION_STATE_STORAGE_KEY])
    const full = JSON.parse(storage.values.get(ASTRA_SESSION_STATE_STORAGE_KEY) ?? '{}') as { savedAt?: number }

    now = 4_350
    usePlayerStore.setState({ currentTime: 3 })
    assert.equal([...timers.values()][0]?.delayMs, 1_900)

    // If an oversized queue exceeds quota, keep checkpoints suppressed but do not
    // pay the same clone/stringify cost again until queueItems actually changes.
    const failedQueueItems = [...usePlayerStore.getState().queueItems]
    storage.failFullWrites = true
    now = 4_400
    usePlayerStore.setState({ queueItems: failedQueueItems })
    assert.equal([...timers.values()][0]?.delayMs, 1_500)
    now = 5_900
    runOnlyTimer()
    assert.equal(storage.writes.at(-1), ASTRA_SESSION_STATE_STORAGE_KEY)
    assert.equal(saveCurrentSessionPositionCheckpoint(), false)

    storage.writes.length = 0
    now = 6_000
    usePlayerStore.setState({ queueContextLabel: 'same failed queue, later skip' })
    assert.equal(timers.size, 0)
    usePlayerStore.setState({ currentTime: 4 })
    assert.equal(timers.size, 0)

    storage.failFullWrites = false
    now = 6_100
    usePlayerStore.setState({ queueItems: [...failedQueueItems] })
    assert.equal([...timers.values()][0]?.delayMs, 1_500)
    now = 7_600
    runOnlyTimer()

    now = 7_700
    usePlayerStore.setState({ currentTime: 5 })
    assert.equal([...timers.values()][0]?.delayMs, 1_900)
    storage.failCheckpointWrites = true
    now = 9_600
    runOnlyTimer()

    now = 9_700
    usePlayerStore.setState({ currentTime: 6 })
    assert.equal([...timers.values()][0]?.delayMs, 1_900)
    assert.equal(storage.values.has(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY), false)

    storage.failCheckpointWrites = false
    now = 11_600
    runOnlyTimer()
    const checkpoint = JSON.parse(
      storage.values.get(ASTRA_SESSION_POSITION_CHECKPOINT_STORAGE_KEY) ?? '{}'
    ) as { baseSessionSavedAt?: number; currentTime?: number }
    const latestFull = JSON.parse(
      storage.values.get(ASTRA_SESSION_STATE_STORAGE_KEY) ?? '{}'
    ) as { savedAt?: number }
    assert.notEqual(latestFull.savedAt, full.savedAt)
    assert.equal(checkpoint.baseSessionSavedAt, latestFull.savedAt)
    assert.equal(checkpoint.currentTime, 6)
  } finally {
    storage.failFullWrites = false
    storage.failCheckpointWrites = false
    cleanup?.()
    usePlayerStore.setState(originalPlayerState, true)
    Date.now = originalDateNow
    console.warn = originalWarn
    restoreWindow()
    restoreStorage()
  }
})
