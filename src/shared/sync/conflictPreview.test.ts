import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSyncConflictResolutionPreview,
  buildSyncPlaylistEntryDiff,
  mergePlaylistEntriesForPreview,
  syncPlaylistToSnapshot
} from './conflictPreview.ts'
import type { SyncPlaylist, SyncPlaylistEntry } from '../../types/phoneSync.ts'

function entry(title: string, position: number, overrides: Partial<SyncPlaylistEntry> = {}): SyncPlaylistEntry {
  return {
    title,
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 180,
    position,
    addedAt: 1_000 + position,
    sourcePath: null,
    ...overrides
  }
}

function playlist(overrides: Partial<SyncPlaylist> = {}): SyncPlaylist {
  return {
    syncUid: 'uid',
    name: 'Playlist',
    kind: 'normal',
    dynamicRules: null,
    createdAt: 1,
    updatedAt: 2,
    entries: [],
    ...overrides
  }
}

test('entry diff reports moved and side-only tracks', () => {
  const diff = buildSyncPlaylistEntryDiff(
    [entry('A', 0), entry('B', 1), entry('Desktop only', 2)],
    [entry('B', 0), entry('A', 1), entry('Phone only', 2)]
  )

  assert.equal(diff.movedCount, 2)
  assert.equal(diff.desktopOnlyCount, 1)
  assert.equal(diff.phoneOnlyCount, 1)
  assert.deepEqual(
    diff.rows.map((row) => row.status),
    ['moved', 'moved', 'desktop-only', 'phone-only']
  )
})

test('entry diff treats duplicate occurrences independently', () => {
  const diff = buildSyncPlaylistEntryDiff(
    [entry('A', 0), entry('A', 1)],
    [entry('A', 0)]
  )

  assert.equal(diff.sameCount, 1)
  assert.equal(diff.desktopOnlyCount, 1)
})

test('merge preview keeps newer order and appends missing older tracks', () => {
  const merged = mergePlaylistEntriesForPreview(
    [entry('B', 1), entry('A', 0)],
    [entry('A', 0), entry('C', 1)]
  )

  assert.deepEqual(
    merged.map((item) => item.title),
    ['A', 'B', 'C']
  )
  assert.deepEqual(
    merged.map((item) => item.position),
    [0, 1, 2]
  )
})

test('merge preview preserves authored repeats and appends only missing occurrences', () => {
  const merged = mergePlaylistEntriesForPreview(
    [entry('A', 0), entry('A', 1), entry('B', 2)],
    [entry('A', 0), entry('B', 1), entry('B', 2)]
  )

  assert.deepEqual(
    merged.map((item) => item.title),
    ['A', 'A', 'B', 'B']
  )
  assert.deepEqual(
    merged.map((item) => item.position),
    [0, 1, 2, 3]
  )
})

test('resolution preview uses newer side for merge result name', () => {
  const desktop = syncPlaylistToSnapshot(playlist({
    name: 'Desktop Mix',
    updatedAt: 20,
    entries: [entry('Desktop Track', 0)]
  }))
  const phone = syncPlaylistToSnapshot(playlist({
    name: 'Phone Mix',
    updatedAt: 10,
    entries: [entry('Phone Track', 0)]
  }))

  const preview = buildSyncConflictResolutionPreview('merge', desktop, phone)
  assert.equal(preview.resultName, 'Desktop Mix')
  assert.equal(preview.resultTrackCount, 2)
})
