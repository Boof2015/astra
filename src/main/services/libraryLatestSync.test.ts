import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLatestLibrarySyncSummary,
  isAlbumNewForLatestSync,
  isTrackNewForLatestSync,
  LibraryLatestSyncCoordinator,
  type LatestLibrarySyncSummary
} from './libraryLatestSync.ts'

test('buildLatestLibrarySyncSummary marks only newly introduced albums', () => {
  const summary = buildLatestLibrarySyncSummary(
    'session-1',
    ['album:a', 'album:existing'],
    ['album:a', 'album:existing', 'album:new'],
    101
  )

  assert.deepEqual(summary, {
    sessionKey: 'session-1',
    completedAt: 101,
    newAlbumIdentityKeys: ['album:new']
  })
  assert.equal(isAlbumNewForLatestSync('album:new', summary), true)
  assert.equal(isAlbumNewForLatestSync('album:existing', summary), false)
})

test('track new state follows the latest published session key', () => {
  const summary: LatestLibrarySyncSummary = {
    sessionKey: 'session-2',
    completedAt: 200,
    newAlbumIdentityKeys: []
  }

  assert.equal(isTrackNewForLatestSync('session-2', summary), true)
  assert.equal(isTrackNewForLatestSync('older-session', summary), false)
  assert.equal(isTrackNewForLatestSync(null, summary), false)
})

test('track new state clears once the track is played after the latest sync', () => {
  const summary: LatestLibrarySyncSummary = {
    sessionKey: 'session-2',
    completedAt: 200,
    newAlbumIdentityKeys: []
  }

  assert.equal(isTrackNewForLatestSync('session-2', summary, 199), true)
  assert.equal(isTrackNewForLatestSync('session-2', summary, 200), false)
  assert.equal(isTrackNewForLatestSync('session-2', summary, 250), false)
})

test('album new state clears once it has no unplayed latest-sync tracks left', () => {
  const summary: LatestLibrarySyncSummary = {
    sessionKey: 'session-4',
    completedAt: 450,
    newAlbumIdentityKeys: ['album:new']
  }

  assert.equal(isAlbumNewForLatestSync('album:new', summary, true), true)
  assert.equal(isAlbumNewForLatestSync('album:new', summary, false), false)
})

test('successful no-op sync publishes an empty latest summary', async () => {
  const albumIdentityKeys = new Set(['album:a'])
  const published: LatestLibrarySyncSummary[] = []
  const coordinator = new LibraryLatestSyncCoordinator({
    getCurrentAlbumIdentityKeys: () => albumIdentityKeys,
    publishSummary: (summary) => {
      published.push(summary)
    },
    now: () => 300,
    createSessionKey: () => 'session-3'
  })

  const sessionKey = coordinator.beginOperation()
  const summary = await coordinator.endOperation(sessionKey, true)

  assert.deepEqual(summary, {
    sessionKey: 'session-3',
    completedAt: 300,
    newAlbumIdentityKeys: []
  })
  assert.deepEqual(published, [summary])
})

test('failed sessions do not replace the previously published summary', async () => {
  const albumIdentityKeys = new Set(['album:before'])
  const published: LatestLibrarySyncSummary[] = []
  const coordinator = new LibraryLatestSyncCoordinator({
    getCurrentAlbumIdentityKeys: () => albumIdentityKeys,
    publishSummary: (summary) => {
      published.push(summary)
    },
    now: () => 400
  })

  const sessionKey = coordinator.beginOperation('failed-session')
  albumIdentityKeys.add('album:after')
  const summary = await coordinator.endOperation(sessionKey, false)

  assert.equal(summary, null)
  assert.deepEqual(published, [])
})

test('shared session across parallel sync operations publishes one combined summary', async () => {
  const albumIdentityKeys = new Set(['album:existing'])
  const published: LatestLibrarySyncSummary[] = []
  const coordinator = new LibraryLatestSyncCoordinator({
    getCurrentAlbumIdentityKeys: () => albumIdentityKeys,
    publishSummary: (summary) => {
      published.push(summary)
    },
    now: () => 500
  })

  const sessionKey = coordinator.beginOperation('shared-session')
  const secondOperationKey = coordinator.beginOperation('shared-session')
  assert.equal(secondOperationKey, sessionKey)

  albumIdentityKeys.add('album:subsonic')
  const firstCompletion = await coordinator.endOperation(sessionKey, true)
  assert.equal(firstCompletion, null)

  albumIdentityKeys.add('album:jellyfin')
  const finalSummary = await coordinator.endOperation(sessionKey, true)

  assert.deepEqual(finalSummary, {
    sessionKey: 'shared-session',
    completedAt: 500,
    newAlbumIdentityKeys: ['album:jellyfin', 'album:subsonic']
  })
  assert.deepEqual(published, [finalSummary])
})
