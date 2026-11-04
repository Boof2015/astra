import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSubsonicArtworkHash,
  buildSubsonicStreamUrl,
  mapSongToCatalogTrack,
  parseSubsonicArtworkHash,
  syncSubsonicCatalog,
  type SubsonicCatalogSyncProgress
} from './subsonic.ts'

test('OpenSubsonic ReplayGain imports finite server values without inventing gains for missing tags', () => {
  const track = mapSongToCatalogTrack(7, { id: 'song', replayGain: { trackGain: -5.4, albumGain: 0 } }, null)!
  assert.equal(track.replaygain_track_gain_db, -5.4)
  assert.equal(track.replaygain_album_gain_db, 0)
  const missing = mapSongToCatalogTrack(7, { id: 'song', replayGain: { trackGain: NaN, albumGain: '3' } }, null)!
  assert.equal(missing.replaygain_track_gain_db, null)
  assert.equal(missing.replaygain_album_gain_db, null)
})

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

test('large catalog progress counts unique tracks rather than albums and yields while mapping', async t => {
  const trackCount = 11_000
  const albumCount = 2_980
  const progress: SubsonicCatalogSyncProgress[] = []
  let yieldedDuringTracks = false
  let pulse: ReturnType<typeof setImmediate> | undefined
  t.after(() => { if (pulse) clearImmediate(pulse) })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input))
    let payload: Record<string, unknown>
    if (url.pathname.endsWith('/getArtists.view')) {
      payload = { artists: { index: [{ artist: [{ id: 'artist' }] }] } }
    } else if (url.pathname.endsWith('/getArtist.view')) {
      payload = { artist: { album: Array.from({ length: albumCount }, (_, i) => ({ id: String(i) })) } }
    } else {
      assert.ok(url.pathname.endsWith('/getAlbum.view'))
      const album = Number(url.searchParams.get('id'))
      const start = Math.floor(album * trackCount / albumCount)
      const end = Math.floor((album + 1) * trackCount / albumCount)
      const song = Array.from({ length: end - start }, (_, i) => ({
        id: String(start + i), title: `Track ${start + i}`, artist: 'Artist', album: `Album ${album}`
      }))
      // Repeated IDs across albums must not inflate either the import or its progress.
      if (album > 0) song.push({ id: '0', title: 'Track 0', artist: 'Artist', album: 'Album 0' })
      payload = { album: { song } }
    }
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...payload } }))
  })
  const result = await syncSubsonicCatalog(1, {
    baseUrl: 'https://music.example.test', username: 'test', password: 'test'
  }, { retries: 0, onProgress: value => {
    if (value.phase !== 'tracks') return
    progress.push(value)
    if (value.current === 0) pulse = setImmediate(() => { yieldedDuringTracks = true })
  } })
  assert.equal(result.tracksScanned, trackCount)
  assert.equal(result.tracks.length, trackCount)
  assert.equal(result.albumsScanned, albumCount)
  assert.equal(new Set(result.tracks.map(track => track.source_track_id)).size, trackCount)
  assert.ok(progress.every(value => value.total === trackCount))
  assert.equal(progress.at(-1)?.current, trackCount)
  assert.ok(yieldedDuringTracks, 'catalog mapping must let the main process handle other work')
})
