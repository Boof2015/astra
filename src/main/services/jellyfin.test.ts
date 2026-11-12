import assert from 'node:assert/strict'
import test from 'node:test'
import { mapJellyfinItemToCatalogTrack } from './jellyfin.ts'

test('Jellyfin artwork carries the image revision so a changed cover bypasses a fresh cache entry', () => {
  const album = mapJellyfinItemToCatalogTrack(9, { Id: 'song', Name: 'Song', AlbumId: 'album', AlbumPrimaryImageTag: 'revision-2' })
  assert.equal(album?.artwork_source_id, 'album')
  assert.equal(album?.artwork_revision, 'revision-2')
  const own = mapJellyfinItemToCatalogTrack(9, { Id: 'song', Name: 'Song', ImageTags: { Primary: 'revision-3' } })
  assert.equal(own?.artwork_source_id, 'song')
  assert.equal(own?.artwork_revision, 'revision-3')
})

test('Jellyfin artist arrays remain distinct catalog credits', () => {
  const track = mapJellyfinItemToCatalogTrack(9, {
    Id: 'song-1',
    Name: 'Structured Song',
    Artists: ['Earth, Wind & Fire', 'The Emotions'],
    Album: 'Structured Album',
    AlbumArtist: 'Curator & Orchestra',
    AlbumArtists: ['Curator', 'Orchestra']
  })

  assert.ok(track)
  assert.deepEqual(track.artist_names, ['Earth, Wind & Fire', 'The Emotions'])
  assert.deepEqual(track.album_artist_names, ['Curator', 'Orchestra'])
})
