import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createThrottledLibraryScanProgressReporter,
  type LibraryScanProgressUpdate
} from './libraryScanProgress.ts'

test('scan progress sends first, sampled, and terminal updates', () => {
  let timestamp = 0
  const updates: LibraryScanProgressUpdate[] = []
  const report = createThrottledLibraryScanProgressReporter(
    (update) => updates.push(update),
    { minIntervalMs: 100, now: () => timestamp }
  )

  report(1, 1_000, 'track-1')
  timestamp = 25
  report(100, 1_000, 'track-100')
  timestamp = 99
  report(400, 1_000, 'track-400')
  timestamp = 100
  report(500, 1_000, 'track-500')
  timestamp = 120
  report(1_000, 1_000, 'track-1000')

  assert.deepEqual(updates, [
    { current: 1, total: 1_000, file: 'track-1' },
    { current: 500, total: 1_000, file: 'track-500' },
    { current: 1_000, total: 1_000, file: 'track-1000' }
  ])
})

test('scan progress does not emit duplicate terminal updates', () => {
  let timestamp = 0
  const updates: LibraryScanProgressUpdate[] = []
  const report = createThrottledLibraryScanProgressReporter(
    (update) => updates.push(update),
    { minIntervalMs: 100, now: () => timestamp }
  )

  report(1, 1, 'only-track')
  timestamp = 200
  report(1, 1, 'only-track')

  assert.deepEqual(updates, [
    { current: 1, total: 1, file: 'only-track' }
  ])
})
