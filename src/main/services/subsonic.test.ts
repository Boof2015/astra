import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSubsonicArtworkHash,
  buildSubsonicStreamUrl,
  mapSongToCatalogTrack,
  parseSubsonicArtworkHash
} from './subsonic.ts'

test('original streaming explicitly disables server transcoding and bitrate limits', () => {
  const connection = { baseUrl: 'https://music.example', username: 'listener', password: 'test' }
  const original = new URL(buildSubsonicStreamUrl(connection, 'track/id', { original: true, maxBitRateKbps: 256 }))
  assert.equal(original.searchParams.get('format'), 'raw')
  assert.equal(original.searchParams.get('maxBitRate'), '0')
  assert.equal(original.searchParams.get('id'), 'track/id')
  const limited = new URL(buildSubsonicStreamUrl(connection, 'track/id', { maxBitRateKbps: 128 }))
  assert.equal(limited.searchParams.get('maxBitRate'), '128')
  assert.equal(limited.searchParams.has('format'), false)
})

test('subsonic artwork hashes round-trip source and cover art ids', () => {
  const hash = buildSubsonicArtworkHash(42, 'album/cover id')

  assert.equal(hash, 'subsonic-artwork:42:album%2Fcover%20id')
  assert.deepEqual(parseSubsonicArtworkHash(hash), {
    sourceId: 42,
    artworkId: 'album/cover id'
  })
  assert.equal(parseSubsonicArtworkHash('cached-cover.jpg'), null)
  assert.equal(parseSubsonicArtworkHash('subsonic-artwork:0:cover'), null)
})

test('OpenSubsonic structured artist arrays remain distinct catalog credits', () => {
  const track = mapSongToCatalogTrack(7, {
    id: 'song-1',
    title: 'Structured Song',
    artist: 'Earth, Wind & Fire & The Emotions',
    artists: [{ name: 'Earth, Wind & Fire' }, { name: 'The Emotions' }],
    album: 'Structured Album',
    albumArtist: 'Curator & Orchestra',
    albumArtists: [{ name: 'Curator' }, { name: 'Orchestra' }]
  }, null)

  assert.ok(track)
  assert.deepEqual(track.artist_names, ['Earth, Wind & Fire', 'The Emotions'])
  assert.deepEqual(track.album_artist_names, ['Curator', 'Orchestra'])
})
