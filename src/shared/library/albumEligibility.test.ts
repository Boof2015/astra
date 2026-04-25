import assert from 'node:assert/strict'
import test from 'node:test'
import { isAlbumGroupEligible, type AlbumEligibilityGroupLike } from './albumEligibility.ts'

function createGroup(overrides: Partial<AlbumEligibilityGroupLike> = {}): AlbumEligibilityGroupLike {
  return {
    albumKey: 'test album',
    trackCount: 2,
    ...overrides
  }
}

test('excludes one-track named albums by default', () => {
  assert.equal(isAlbumGroupEligible(createGroup({ trackCount: 1 })), false)
})

test('includes one-track named albums when singles are enabled', () => {
  assert.equal(isAlbumGroupEligible(createGroup({ trackCount: 1 }), { includeSingles: true }), true)
})

test('excludes unknown albums even when singles are enabled', () => {
  assert.equal(
    isAlbumGroupEligible(createGroup({ albumKey: 'unknown album', trackCount: 1 }), { includeSingles: true }),
    false
  )
  assert.equal(isAlbumGroupEligible(createGroup({ albumKey: 'unknown album', trackCount: 3 })), false)
})

test('includes multi-track named albums', () => {
  assert.equal(isAlbumGroupEligible(createGroup({ trackCount: 2 })), true)
})
