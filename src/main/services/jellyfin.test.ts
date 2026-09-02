import assert from 'node:assert/strict'
import test from 'node:test'
import { mapJellyfinItemToCatalogTrack } from './jellyfin.ts'

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
