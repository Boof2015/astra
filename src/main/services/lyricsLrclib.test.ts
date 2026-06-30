import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  LrclibLookupCoordinator,
  createLrclibClientConfig,
  createLrclibClientHeaders,
  fetchLrclibJson,
  normalizeLrclibMetadataText
} from './lyricsLrclib.ts'
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

function createAbortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
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

test('createLrclibClientHeaders sends current LRCLIB client identity', () => {
  const headers = createLrclibClientHeaders(createLrclibClientConfig({
    appVersion: '0.6.1 beta'
  }))

  assert.equal(headers['Lrclib-Client'], 'Astra/0.6.1-beta (https://github.com/Boof2015/astra)')
  assert.equal(headers['User-Agent'], headers['Lrclib-Client'])
  assert.equal(headers.Accept, 'application/json')
})

test('fetchLrclibJson sends LRCLIB client headers', async () => {
  let capturedHeaders: HeadersInit | undefined
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedHeaders = init?.headers
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const result = await fetchLrclibJson('https://lrclib.test/api/get', createLrclibClientConfig({
    appVersion: '0.6.1-beta'
  }))

  assert.equal(result.kind, 'ok')
  assert.deepEqual(capturedHeaders, {
    Accept: 'application/json',
    'Lrclib-Client': 'Astra/0.6.1-beta (https://github.com/Boof2015/astra)',
    'User-Agent': 'Astra/0.6.1-beta (https://github.com/Boof2015/astra)'
  })
})

test('normalizeLrclibMetadataText strips controls and normalizes whitespace', () => {
  assert.equal(normalizeLrclibMetadataText('  Track\u0000\u000f\n\tName  '), 'Track Name')
  assert.equal(normalizeLrclibMetadataText('\u0000\t'), null)
  assert.equal(normalizeLrclibMetadataText(null), null)
})

test('fetchLrclibJson classifies request aborts as timeouts', async () => {
  installAbortingFetch()

  const result = await fetchLrclibJson('https://lrclib.test/api/get', createLrclibClientConfig({
    appVersion: '0.6.1-beta',
    requestTimeoutMs: 1
  }))

  assert.equal(result.kind, 'timeout')
})

test('LrclibLookupCoordinator cools down automatic lookups and lets manual refresh bypass cooldown', async () => {
  let now = 1_000
  const fetchMock = installAbortingFetch()
  const coordinator = new LrclibLookupCoordinator(createLrclibClientConfig({
    appVersion: '0.6.1-beta',
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
  assert.equal(manualResult.status === 'transient_error' ? manualResult.code : '', 'lrclib_get_timeout')
  assert.equal(fetchMock.calls(), 2)

  now += 31_000
  assert.deepEqual(await coordinator.lookup(makeQuery(), 'track:4'), { status: 'provider_unavailable' })
  assert.equal(fetchMock.calls(), 3)
})

test('LrclibLookupCoordinator deduplicates concurrent lookups for the same metadata', async () => {
  let callCount = 0
  let resolveFetch: (response: Response) => void = () => {}
  globalThis.fetch = (async (): Promise<Response> => {
    callCount += 1
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
  }) as typeof fetch

  const coordinator = new LrclibLookupCoordinator(createLrclibClientConfig({
    appVersion: '0.6.1-beta'
  }))
  const firstLookup = coordinator.lookup(makeQuery(), 'same-track')
  const secondLookup = coordinator.lookup(makeQuery(), 'same-track')

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(callCount, 1)

  resolveFetch(new Response(JSON.stringify({
    id: 1,
    trackName: 'Track',
    artistName: 'Artist',
    albumName: 'Album',
    duration: 180,
    instrumental: false,
    plainLyrics: 'Plain lyrics',
    syncedLyrics: null
  }), { status: 200 }))

  const [firstResult, secondResult] = await Promise.all([firstLookup, secondLookup])
  assert.equal(firstResult.status, 'hit')
  assert.equal(secondResult.status, 'hit')
  assert.equal(callCount, 1)
})
