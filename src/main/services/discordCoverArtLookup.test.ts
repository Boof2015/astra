import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  buildCoverArtAlbumCandidates,
  resolveDiscordCoverArtUrl
} from './discordCoverArtLookup.ts'

const originalFetch = globalThis.fetch

interface MockFetchResponse {
  status?: number
  payload: unknown
}

function installMockFetch(handler: (url: URL) => MockFetchResponse): URL[] {
  const calls: URL[] = []

  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(url)

    const response = handler(url)
    const status = response.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.payload
    } as Response
  }) as typeof fetch

  return calls
}

function emptyProviderPayload(url: URL): MockFetchResponse {
  if (url.hostname === 'itunes.apple.com') return { payload: { results: [] } }
  if (url.hostname === 'musicbrainz.org') return { payload: { releases: [] } }
  if (url.hostname === 'www.theaudiodb.com') return { payload: { album: [] } }
  if (url.hostname === 'coverartarchive.org') return { status: 404, payload: {} }
  return { status: 404, payload: {} }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('builds album candidates with featured-artist cleanup', () => {
  assert.deepEqual(
    buildCoverArtAlbumCandidates('tumult feat. Aile The Shota'),
    ['tumult feat. Aile The Shota', 'tumult']
  )
})

test('keeps the original album first and ignores duplicate or blank variants', () => {
  assert.deepEqual(
    buildCoverArtAlbumCandidates('tumult feat. Aile The Shota', '  tumult  '),
    ['tumult feat. Aile The Shota', 'tumult']
  )

  assert.deepEqual(
    buildCoverArtAlbumCandidates('Album', '   '),
    ['Album']
  )
})

test('itunes retries cleaned album candidates after original album misses', async () => {
  const calls = installMockFetch((url) => {
    if (url.hostname !== 'itunes.apple.com') return emptyProviderPayload(url)

    const term = url.searchParams.get('term')
    if (url.searchParams.get('entity') === 'album' && term === 'tumult Sheeno Mirin') {
      return {
        payload: {
          results: [
            {
              collectionName: 'tumult',
              artistName: 'Sheeno Mirin',
              artworkUrl100: 'http://img.example.com/100x100bb.jpg'
            }
          ]
        }
      }
    }

    return { payload: { results: [] } }
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'tumult feat. Aile The Shota',
    artist: 'Sheeno Mirin'
  })

  assert.deepEqual(result, {
    status: 'hit',
    url: 'https://img.example.com/600x600bb.jpg'
  })
  assert.deepEqual(
    calls
      .filter((url) => url.hostname === 'itunes.apple.com')
      .map((url) => url.searchParams.get('term')),
    [
      'tumult feat. Aile The Shota Sheeno Mirin',
      'tumult Sheeno Mirin'
    ]
  )
  assert.equal(calls.some((url) => url.hostname === 'musicbrainz.org'), false)
})

test('musicbrainz retries cleaned album candidates after original album misses', async () => {
  const calls = installMockFetch((url) => {
    if (url.hostname === 'itunes.apple.com') return { payload: { results: [] } }
    if (url.hostname === 'coverartarchive.org') {
      return {
        payload: {
          images: [
            {
              front: true,
              thumbnails: {
                '500': 'http://img.example.com/musicbrainz-500.jpg'
              }
            }
          ]
        }
      }
    }
    if (url.hostname !== 'musicbrainz.org') return emptyProviderPayload(url)

    const query = url.searchParams.get('query') ?? ''
    if (query.includes('release:"tumult"')) {
      return {
        payload: {
          releases: [
            {
              id: 'release-hit',
              title: '喧騒',
              score: '100',
              'artist-credit': [
                { name: '椎乃味醂 feat. Aile The Shota' }
              ]
            }
          ]
        }
      }
    }

    return { payload: { releases: [] } }
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'tumult feat. Aile The Shota',
    artist: 'Sheeno Mirin'
  })

  assert.deepEqual(result, {
    status: 'hit',
    url: 'https://img.example.com/musicbrainz-500.jpg'
  })
  assert.deepEqual(
    calls
      .filter((url) => url.hostname === 'musicbrainz.org')
      .map((url) => url.searchParams.get('query')),
    [
      'release:"tumult feat. Aile The Shota" AND artist:"Sheeno Mirin"',
      'release:"tumult" AND artist:"Sheeno Mirin"'
    ]
  )
})

test('itunes track fallback accepts matching track and artist when collection differs', async () => {
  const calls = installMockFetch((url) => {
    if (url.hostname !== 'itunes.apple.com') return emptyProviderPayload(url)
    if (url.searchParams.get('entity') === 'song') {
      return {
        payload: {
          results: [
            {
              trackName: 'Tumult',
              collectionName: 'Harmony - EP',
              artistName: 'Sheeno Mirin',
              artworkUrl100: 'http://img.example.com/100x100bb.jpg'
            }
          ]
        }
      }
    }
    return { payload: { results: [] } }
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'Wrong Album',
    artist: 'Sheeno Mirin',
    title: 'Tumult'
  })

  assert.deepEqual(result, {
    status: 'hit',
    url: 'https://img.example.com/600x600bb.jpg'
  })
  assert.equal(
    calls.some((url) => url.hostname === 'itunes.apple.com' && url.searchParams.get('entity') === 'song'),
    true
  )
})

test('itunes track fallback rejects matching track with wrong artist', async () => {
  installMockFetch((url) => {
    if (url.hostname === 'itunes.apple.com' && url.searchParams.get('entity') === 'song') {
      return {
        payload: {
          results: [
            {
              trackName: 'Tumult',
              collectionName: 'Harmony - EP',
              artistName: 'Other Artist',
              artworkUrl100: 'http://img.example.com/100x100bb.jpg'
            }
          ]
        }
      }
    }

    return emptyProviderPayload(url)
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'Wrong Album',
    artist: 'Sheeno Mirin',
    title: 'Tumult'
  })

  assert.deepEqual(result, { status: 'not_found' })
})

test('itunes album lookup accepts short reversed romanized artist names', async () => {
  installMockFetch((url) => {
    if (url.hostname !== 'itunes.apple.com') return emptyProviderPayload(url)

    if (url.searchParams.get('entity') === 'album') {
      return {
        payload: {
          results: [
            {
              collectionName: 'I Found It Out',
              artistName: 'Mirin Sheeno',
              artworkUrl100: 'http://img.example.com/100x100bb.jpg'
            }
          ]
        }
      }
    }

    return { payload: { results: [] } }
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'I Found It Out',
    artist: 'Sheeno Mirin'
  })

  assert.deepEqual(result, {
    status: 'hit',
    url: 'https://img.example.com/600x600bb.jpg'
  })
})

test('itunes track fallback accepts short reversed romanized artist names', async () => {
  installMockFetch((url) => {
    if (url.hostname !== 'itunes.apple.com') return emptyProviderPayload(url)

    if (url.searchParams.get('entity') === 'song') {
      return {
        payload: {
          results: [
            {
              trackName: 'Mosaic feat. Reol',
              collectionName: 'Harmony - EP',
              artistName: 'Mirin Sheeno',
              artworkUrl100: 'http://img.example.com/100x100bb.jpg'
            }
          ]
        }
      }
    }

    return { payload: { results: [] } }
  })

  const result = await resolveDiscordCoverArtUrl({
    album: 'Harmony',
    artist: 'Sheeno Mirin feat. Reol',
    title: 'Mosaic feat. Reol'
  })

  assert.deepEqual(result, {
    status: 'hit',
    url: 'https://img.example.com/600x600bb.jpg'
  })
})
