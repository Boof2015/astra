import assert from 'node:assert/strict'
import test from 'node:test'
import { partitionArtistDiscography } from './artistDiscography.ts'

interface TestRelease {
  identity_key: string
  track_count: number
}

function release(identityKey: string, trackCount: number): TestRelease {
  return {
    identity_key: identityKey,
    track_count: trackCount
  }
}

test('partitions primary albums, primary singles, and featured releases', () => {
  const primaryAlbum = release('album', 8)
  const primarySingle = release('single', 1)
  const featuredAlbum = release('featured-album', 6)
  const featuredSingle = release('featured-single', 1)

  const result = partitionArtistDiscography([
    { release: primaryAlbum, isPrimary: true },
    { release: primarySingle, isPrimary: true },
    { release: featuredAlbum, isPrimary: false },
    { release: featuredSingle, isPrimary: false }
  ])

  assert.deepEqual(result.albums, [primaryAlbum])
  assert.deepEqual(result.singles, [primarySingle])
  assert.deepEqual(result.featured, [featuredAlbum, featuredSingle])
  assert.equal(result.singles.includes(featuredSingle), false)
})
