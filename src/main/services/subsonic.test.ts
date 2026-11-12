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

test('OpenSubsonic audio properties import under the names the spec gives them', () => {
  const track = mapSongToCatalogTrack(7, { id: 'song', samplingRate: 96_000, bitDepth: 24, channelCount: 2, bitRate: 2_890 }, null)!
  assert.equal(track.sample_rate, 96_000)
  assert.equal(track.bit_depth, 24)
  assert.equal(track.channels, 2)
  assert.equal(track.bitrate, 2_890)
  assert.equal(mapSongToCatalogTrack(7, { id: 'song' }, null)!.sample_rate, null, 'a classic Subsonic server sends none')
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

const connection = { baseUrl: 'https://music.example.test', username: 'test', password: 'test' }
const subsonicResponse = (payload: Record<string, unknown>) =>
  new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', ...payload } }))
const endpointOf = (input: string | URL | Request) => new URL(String(input)).pathname.split('/').pop()!.replace('.view', '')

test('OpenSubsonic catalogs are paged with empty searches instead of crawled', async t => {
  const albumCount = 120
  // The first song is listed twice, as a server may do while its library changes.
  const listed = [...Array.from({ length: 1_203 }, (_, id) => id), 0]
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(endpointOf(input))
    assert.equal(endpointOf(input), 'search3', 'no request per artist or album')
    assert.equal(url.searchParams.get('query'), '')
    assert.equal(url.searchParams.get('artistCount'), '0')
    const page = (count: string, offset: string, total: number) => {
      const start = Number(url.searchParams.get(offset))
      return Array.from({ length: Math.max(0, Math.min(Number(url.searchParams.get(count)), total - start)) }, (_, i) => start + i)
    }
    return subsonicResponse({ searchResult3: {
      song: page('songCount', 'songOffset', listed.length).map(index => {
        const id = listed[index]
        return { id: String(id), title: `Track ${id}`, artist: 'Artist', album: `Album ${id % albumCount}`,
          albumId: `al-${id % albumCount}`, ...(id % 2 ? { coverArt: `mf-${id}` } : {}) }
      }),
      album: page('albumCount', 'albumOffset', albumCount).map(id => ({ id: `al-${id}`, coverArt: `cover-${id}` }))
    } })
  })
  const progress: SubsonicCatalogSyncProgress[] = []
  const result = await syncSubsonicCatalog(1, connection, { retries: 0, openSubsonic: true, onProgress: value => progress.push(value) })

  assert.deepEqual(requests, ['search3', 'search3', 'search3', 'search3'], 'three pages of songs and the empty one that ends them')
  assert.equal(result.tracks.length, 1_203)
  assert.equal(result.tracksScanned, 1_203)
  assert.equal(new Set(result.tracks.map(track => track.source_track_id)).size, 1_203)
  assert.equal(result.albumsScanned, albumCount)
  const byId = new Map(result.tracks.map(track => [track.source_track_id, track]))
  assert.equal(byId.get('7')?.artwork_source_id, 'mf-7', 'a song keeps its own cover')
  assert.equal(byId.get('8')?.artwork_source_id, 'cover-8', 'a song without one takes its album cover')
  assert.equal(byId.get('128')?.artwork_source_id, 'cover-8')
  assert.ok(progress.every(value => value.phase === 'tracks'))
  assert.equal(progress.at(-1)?.current, 1_203)
  assert.equal(progress.at(-1)?.total, 1_203)
})

test('a server that cannot page its catalog is crawled instead', async t => {
  for (const [reason, search3] of [
    ['has no searchResult3', () => subsonicResponse({})],
    ['rejects the request', () => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'no' } } }))],
    ['ignores the offset', () => subsonicResponse({ searchResult3: { song: [{ id: 'same', title: 'Same', albumId: 'a' }] } })],
    ['returns nothing', () => subsonicResponse({ searchResult3: {} })],
    // Tracks missing from a catalog are marked unavailable, so a listing cut short must not be used.
    ['lists fewer songs than its albums hold', (url: URL) => subsonicResponse({ searchResult3: url.searchParams.get('songOffset') === '0'
      ? { song: [{ id: 'only', title: 'Only', albumId: 'a' }], album: [{ id: 'a', songCount: 40 }] } : {} })]
  ] as const) {
    const requests: string[] = []
    const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const endpoint = endpointOf(input)
      requests.push(endpoint)
      if (endpoint === 'search3') return search3(new URL(String(input)))
      if (endpoint === 'getArtists') return subsonicResponse({ artists: { index: [{ artist: [{ id: 'artist' }] }] } })
      if (endpoint === 'getArtist') return subsonicResponse({ artist: { album: [{ id: 'album' }] } })
      assert.equal(endpoint, 'getAlbum')
      return subsonicResponse({ album: { coverArt: 'cover', song: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] } })
    })
    const result = await syncSubsonicCatalog(1, connection, { retries: 0, openSubsonic: true })
    assert.deepEqual(result.tracks.map(track => track.source_track_id), ['one', 'two'], reason)
    assert.equal(result.albumsScanned, 1, reason)
    assert.deepEqual(requests.slice(-3), ['getArtists', 'getArtist', 'getAlbum'], reason)
    mock.mock.restore()
  }
})

test('a listing with far fewer tracks than the library already has is crawled instead', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const endpoint = endpointOf(input)
    requests.push(endpoint)
    if (endpoint === 'search3') {
      return subsonicResponse({ searchResult3: new URL(String(input)).searchParams.get('songOffset') === '0'
        ? { song: Array.from({ length: 80 }, (_, id) => ({ id: String(id), title: `Track ${id}` })) } : {} })
    }
    if (endpoint === 'getArtists') return subsonicResponse({ artists: { index: [{ artist: [{ id: 'artist' }] }] } })
    if (endpoint === 'getArtist') return subsonicResponse({ artist: { album: [{ id: 'album' }] } })
    return subsonicResponse({ album: { song: Array.from({ length: 100 }, (_, id) => ({ id: String(id), title: `Track ${id}` })) } })
  })
  const listed = await syncSubsonicCatalog(1, connection, { retries: 0, openSubsonic: true, knownTrackCount: 85 })
  assert.equal(listed.tracks.length, 80, 'a library that shrank a little is still listed')
  assert.ok(!requests.includes('getArtists'))

  const crawled = await syncSubsonicCatalog(1, connection, { retries: 0, openSubsonic: true, knownTrackCount: 100 })
  assert.equal(crawled.tracks.length, 100)
  assert.deepEqual(requests.slice(-3), ['getArtists', 'getArtist', 'getAlbum'])
})

test('a cancelled catalog listing is not retried as a crawl', async t => {
  const controller = new AbortController()
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(endpointOf(input))
    controller.abort()
    throw new Error('aborted')
  })
  await assert.rejects(syncSubsonicCatalog(1, connection, { retries: 0, openSubsonic: true, signal: controller.signal }))
  assert.deepEqual(requests, ['search3'])
})
