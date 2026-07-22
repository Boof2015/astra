import assert from 'node:assert/strict'
import test from 'node:test'
import type { IntegrityDuplicateGroup } from '../../../types/libraryIntegrity'
import { buildDuplicateTrashActions } from './duplicateCleanup'

function duplicateGroup(id: string, paths: string[]): IntegrityDuplicateGroup {
  return {
    id,
    evidence: 'possible',
    members: paths.map((path) => ({
      path,
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      duration: 180,
      format: 'flac',
      sizeBytes: 1_024,
      bitrate: 900,
      sampleRate: 48_000,
      bitDepth: 24,
      channels: 2,
      withinScope: true
    }))
  }
}

test('choosing one copy stages every other member in the group', () => {
  const group = duplicateGroup('group-1', ['/music/keep.flac', '/music/copy.flac', '/archive/copy.flac'])

  assert.deepEqual(buildDuplicateTrashActions([group], { 'group-1': '/music/keep.flac' }), [{
    groupId: 'group-1',
    keepPath: '/music/keep.flac',
    trashPaths: ['/music/copy.flac', '/archive/copy.flac']
  }])
})

test('groups without a valid Keep choice remain untouched', () => {
  const undecided = duplicateGroup('undecided', ['/music/a.flac', '/music/b.flac'])
  const stale = duplicateGroup('stale', ['/music/c.flac', '/music/d.flac'])

  assert.deepEqual(buildDuplicateTrashActions([undecided, stale], {
    stale: '/music/no-longer-in-group.flac'
  }), [])
})

test('choices across groups produce independent cleanup actions', () => {
  const first = duplicateGroup('first', ['/music/a.flac', '/music/b.flac'])
  const second = duplicateGroup('second', ['/music/c.flac', '/music/d.flac'])

  assert.deepEqual(buildDuplicateTrashActions([first, second], {
    first: '/music/b.flac',
    second: '/music/c.flac'
  }), [
    { groupId: 'first', keepPath: '/music/b.flac', trashPaths: ['/music/a.flac'] },
    { groupId: 'second', keepPath: '/music/c.flac', trashPaths: ['/music/d.flac'] }
  ])
})
