import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getArtistImageKey,
  pickBestArtistImageCandidate,
  resolveArtistArtwork
} from './artistImages.ts'

test('resolveArtistArtwork prefers manual, detected, then track artwork', () => {
  assert.deepEqual(resolveArtistArtwork('manual.jpg', 'detected.jpg', 'track.jpg'), {
    artwork_hash: 'manual.jpg',
    artwork_source: 'manual'
  })
  assert.deepEqual(resolveArtistArtwork(null, 'detected.jpg', 'track.jpg'), {
    artwork_hash: 'detected.jpg',
    artwork_source: 'detected'
  })
  assert.deepEqual(resolveArtistArtwork(null, null, 'track.jpg'), {
    artwork_hash: 'track.jpg',
    artwork_source: 'track'
  })
  assert.deepEqual(resolveArtistArtwork(null, null, null), {
    artwork_hash: null,
    artwork_source: null
  })
})

test('pickBestArtistImageCandidate prefers exact artist files over artist and poster files', () => {
  const best = pickBestArtistImageCandidate([
    { path: '/music/Example/poster.jpg', baseName: 'poster', extension: '.jpg', mtimeMs: 300 },
    { path: '/music/Example/artist.jpg', baseName: 'artist', extension: '.jpg', mtimeMs: 400 },
    { path: '/music/Example/Example Artist.png', baseName: 'Example Artist', extension: '.png', mtimeMs: 100 }
  ], 'Example Artist')

  assert.equal(best?.path, '/music/Example/Example Artist.png')
  assert.equal(best?.kind, 'exact')
})

test('pickBestArtistImageCandidate matches filesystem-safe exact artist names', () => {
  const best = pickBestArtistImageCandidate([
    { path: '/music/AC DC/AC_DC.jpg', baseName: 'AC_DC', extension: '.jpg', mtimeMs: 100 }
  ], 'AC/DC')

  assert.equal(best?.kind, 'exact')
})

test('pickBestArtistImageCandidate ignores generic album cover names', () => {
  const best = pickBestArtistImageCandidate([
    { path: '/music/Example/cover.jpg', baseName: 'cover', extension: '.jpg', mtimeMs: 500 },
    { path: '/music/Example/folder.png', baseName: 'folder', extension: '.png', mtimeMs: 500 }
  ], 'Example Artist')

  assert.equal(best, null)
})

test('pickBestArtistImageCandidate breaks same-kind ties by newest mtime then path', () => {
  const newest = pickBestArtistImageCandidate([
    { path: '/music/Example/b/artist.jpg', baseName: 'artist', extension: '.jpg', mtimeMs: 200 },
    { path: '/music/Example/a/artist.jpg', baseName: 'artist', extension: '.jpg', mtimeMs: 200 },
    { path: '/music/Example/c/artist.jpg', baseName: 'artist', extension: '.jpg', mtimeMs: 100 }
  ], 'Example Artist')

  assert.equal(newest?.path, '/music/Example/a/artist.jpg')
})

test('getArtistImageKey normalizes displayed artist names for browse-mode keys', () => {
  assert.equal(getArtistImageKey('  Example   Artist  '), 'example artist')
  assert.equal(getArtistImageKey('Example-Artist'), 'example-artist')
})

test('artist image identity includes caller browse mode plus displayed artist key', () => {
  const strictIdentity = { mode: 'strict', key: getArtistImageKey('Example Artist feat Guest') }
  const canonicalIdentity = { mode: 'canonical', key: getArtistImageKey('Example Artist') }

  assert.notDeepEqual(strictIdentity, canonicalIdentity)
})
