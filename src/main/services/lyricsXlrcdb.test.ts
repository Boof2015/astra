import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  XLRCDB_SOURCE_URL,
  XlrcdbLookupCoordinator,
  createXlrcdbClientConfig
} from './lyricsXlrcdb.ts'
import type { LyricsTrackQuery } from '../../types/lyrics.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeQuery(overrides: Partial<LyricsTrackQuery> = {}): LyricsTrackQuery {
  return {
    path: '/music/track.flac',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 180,
    ...overrides
  }
}

function createJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

function createTextResponse(value: string): Response {
  return new Response(value, { status: 200 })
}

function createAbortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function installSuccessfulXlrcdbFetch(options: {
  aliases?: Record<string, string>
  tracks?: Array<{ id: string; title: string; length: number; path: string }>
  lyricText?: string
} = {}): { urls: string[] } {
  const urls: string[] = []
  const aliases = options.aliases ?? { artist: 'art_1234567890' }
  const tracks = options.tracks ?? [
    { id: 'trk_1', title: 'Track', length: 180, path: 'lyrics/track.xlrc' }
  ]
  const lyricText = options.lyricText ?? [
    '[ti:Track]',
    '[ar:Artist]',
    '[length:3:00]',
    '',
    '[00:01.00]First line',
    '[00:02.00]漢字[かんじ]',
    '[>en]Kanji'
  ].join('\n')

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/index/aliases.json')) {
      return createJsonResponse({ version: 1, aliases })
    }
    if (url.includes('/index/artists/')) {
      return createJsonResponse({
        version: 1,
        id: 'art_1234567890',
        canonical_name: 'Artist',
        tracks
      })
    }
    if (url.endsWith('/lyrics/track.xlrc')) {
      return createTextResponse(lyricText)
    }
    return new Response('', { status: 404 })
  }) as typeof fetch

  return { urls }
}

function installAbortingFetch(): { calls: () => number } {
  let callCount = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    callCount += 1
    const signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError())
        return
      }

      signal?.addEventListener('abort', () => {
        reject(createAbortError())
      }, { once: true })
    })
  }) as typeof fetch

  return {
    calls: () => callCount
  }
}

test('XlrcdbLookupCoordinator returns XLRCDB payloads from the official source', async () => {
  const fetchMock = installSuccessfulXlrcdbFetch()
  const coordinator = new XlrcdbLookupCoordinator(createXlrcdbClientConfig({
    requestTimeoutMs: 1_000
  }))

  const result = await coordinator.lookup(makeQuery(), 'track:1')

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.lyrics.source : '', 'xlrcdb')
  assert.equal(result.status === 'hit' ? result.lyrics.provider : null, 'xlrcdb')
  assert.equal(result.status === 'hit' ? result.lyrics.format : '', 'xlrc')
  assert.equal(result.status === 'hit' ? result.lyrics.plainLyrics : '', 'First line\n漢字')
  assert.deepEqual(fetchMock.urls, [
    `${XLRCDB_SOURCE_URL}/index/aliases.json`,
    `${XLRCDB_SOURCE_URL}/index/artists/12/34/art_1234567890.json`,
    `${XLRCDB_SOURCE_URL}/lyrics/track.xlrc`
  ])
})

test('XlrcdbLookupCoordinator reports artist and track misses as not found', async () => {
  installSuccessfulXlrcdbFetch({ aliases: {} })
  const artistMiss = new XlrcdbLookupCoordinator(createXlrcdbClientConfig())
  assert.deepEqual(await artistMiss.lookup(makeQuery(), 'artist-miss'), { status: 'not_found' })

  installSuccessfulXlrcdbFetch({
    tracks: [{ id: 'trk_1', title: 'Other Track', length: 180, path: 'lyrics/track.xlrc' }]
  })
  const trackMiss = new XlrcdbLookupCoordinator(createXlrcdbClientConfig())
  assert.deepEqual(await trackMiss.lookup(makeQuery(), 'track-miss'), { status: 'not_found' })
})

test('XlrcdbLookupCoordinator surfaces manual fetch errors as transient errors', async () => {
  let callCount = 0
  globalThis.fetch = (async (): Promise<Response> => {
    callCount += 1
    throw new Error('network down')
  }) as typeof fetch

  const coordinator = new XlrcdbLookupCoordinator(createXlrcdbClientConfig())
  const result = await coordinator.lookup(makeQuery(), 'track:1', { forceRefresh: true })

  assert.equal(result.status, 'transient_error')
  assert.equal(result.status === 'transient_error' ? result.code : '', 'xlrcdb_network_error')
  assert.equal(callCount, 1)
})

test('XlrcdbLookupCoordinator skips lookups when duration is missing', async () => {
  let callCount = 0
  globalThis.fetch = (async (): Promise<Response> => {
    callCount += 1
    return createJsonResponse({})
  }) as typeof fetch

  const coordinator = new XlrcdbLookupCoordinator(createXlrcdbClientConfig())
  assert.deepEqual(await coordinator.lookup(makeQuery({ durationSeconds: undefined }), 'track:no-duration'), {
    status: 'skipped',
    reason: 'duration_missing'
  })
  assert.equal(callCount, 0)
})

test('XlrcdbLookupCoordinator cools down automatic timeout failures and lets manual refresh bypass cooldown', async () => {
  let now = 1_000
  const fetchMock = installAbortingFetch()
  const coordinator = new XlrcdbLookupCoordinator(createXlrcdbClientConfig({
    requestTimeoutMs: 1,
    now: () => now
  }))

  assert.deepEqual(await coordinator.lookup(makeQuery(), 'track:1'), { status: 'provider_unavailable' })
  assert.equal(fetchMock.calls(), 1)

  now += 30_000
  assert.deepEqual(await coordinator.lookup(makeQuery(), 'track:2'), { status: 'provider_unavailable' })
  assert.equal(fetchMock.calls(), 1)

  const manualResult = await coordinator.lookup(makeQuery(), 'track:3', { forceRefresh: true })
  assert.equal(manualResult.status, 'transient_error')
  assert.equal(manualResult.status === 'transient_error' ? manualResult.code : '', 'xlrcdb_timeout')
  assert.equal(fetchMock.calls(), 2)
})

test('XlrcdbLookupCoordinator deduplicates concurrent lookups for the same metadata', async () => {
  let callCount = 0
  let resolveAliases: (response: Response) => void = () => {}
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    callCount += 1
    const url = String(input)
    if (url.endsWith('/index/aliases.json')) {
      return new Promise<Response>((resolve) => {
        resolveAliases = resolve
      })
    }
    if (url.includes('/index/artists/')) {
      return createJsonResponse({
        version: 1,
        id: 'art_1234567890',
        canonical_name: 'Artist',
        tracks: [{ id: 'trk_1', title: 'Track', length: 180, path: 'lyrics/track.xlrc' }]
      })
    }
    return createTextResponse('[00:01.00]Shared lookup')
  }) as typeof fetch

  const coordinator = new XlrcdbLookupCoordinator(createXlrcdbClientConfig())
  const firstLookup = coordinator.lookup(makeQuery(), 'same-track')
  const secondLookup = coordinator.lookup(makeQuery(), 'same-track')

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(callCount, 1)

  resolveAliases(createJsonResponse({
    version: 1,
    aliases: { artist: 'art_1234567890' }
  }))

  const [firstResult, secondResult] = await Promise.all([firstLookup, secondLookup])
  assert.equal(firstResult.status, 'hit')
  assert.equal(secondResult.status, 'hit')
  assert.equal(callCount, 3)
})
