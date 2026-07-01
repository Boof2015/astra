import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LyricsService,
  type LyricsOnlineLookupProvider,
  type LyricsServiceLibraryApi
} from './lyrics.ts'
import type {
  LyricsCacheEntry,
  LyricsCacheUpsertInput,
  LyricsTrackOverrideEntry
} from './library.ts'
import type { LyricsPayload, LyricsTrackQuery } from '../../types/lyrics.ts'

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

function makePayload(source: 'lrclib' | 'xlrcdb', text: string): LyricsPayload {
  return {
    source,
    provider: source,
    format: source === 'xlrcdb' ? 'xlrc' : 'plain',
    plainLyrics: text,
    syncedLyrics: null,
    syncedLines: []
  }
}

function makeCacheEntry(source: 'lrclib' | 'xlrcdb', text: string): LyricsCacheEntry {
  return {
    trackPath: '/music/track.flac',
    metadataSignature: 'signature',
    status: 'hit',
    source,
    provider: source,
    format: source === 'xlrcdb' ? 'xlrc' : 'plain',
    plainLyrics: text,
    syncedLyrics: null,
    syncedLines: [],
    updatedAt: 1_000
  }
}

function makeCacheNotFoundEntry(source: 'lrclib' | 'xlrcdb'): LyricsCacheEntry {
  return {
    trackPath: '/music/track.flac',
    metadataSignature: 'signature',
    status: 'not_found',
    source,
    provider: source,
    format: 'plain',
    plainLyrics: null,
    syncedLyrics: null,
    syncedLines: [],
    updatedAt: 1_000
  }
}

function createLibraryApi(options: {
  cache?: LyricsCacheEntry | null
  upserts?: LyricsCacheUpsertInput[]
} = {}): LyricsServiceLibraryApi {
  const upserts = options.upserts ?? []
  return {
    getLyricsTrackOverride: (): LyricsTrackOverrideEntry | null => null,
    upsertLyricsTrackManual: async () => 0,
    clearLyricsTrackManual: async () => 0,
    setLyricsTrackSyncOffset: async () => 0,
    getLyricsCache: () => options.cache ?? null,
    upsertLyricsCache: async (entry) => {
      upserts.push(entry)
    }
  }
}

function createProvider(
  results: Array<Awaited<ReturnType<LyricsOnlineLookupProvider['lookup']>>>
): LyricsOnlineLookupProvider & { calls: LyricsTrackQuery[] } {
  const calls: LyricsTrackQuery[] = []
  return {
    calls,
    lookup: async (query) => {
      calls.push(query)
      const result = results.shift()
      if (!result) throw new Error('Unexpected provider lookup')
      return result
    }
  }
}

function createService(options: {
  libraryApi?: LyricsServiceLibraryApi
  xlrcdbProvider: LyricsOnlineLookupProvider
  lrclibProvider: LyricsOnlineLookupProvider
}): LyricsService {
  return new LyricsService({
    enabled: true,
    appVersion: '0.6.1-beta',
    libraryApi: options.libraryApi ?? createLibraryApi(),
    sidecarLookup: async () => null,
    embeddedResolver: async () => null,
    xlrcdbProvider: options.xlrcdbProvider,
    lrclibProvider: options.lrclibProvider
  })
}

test('LyricsService tries XLRCDB before LRCLIB and caches XLRCDB hits', async () => {
  const upserts: LyricsCacheUpsertInput[] = []
  const xlrcdbProvider = createProvider([{ status: 'hit', lyrics: makePayload('xlrcdb', 'XLRCDB lyrics') }])
  const lrclibProvider = createProvider([])
  const service = createService({
    libraryApi: createLibraryApi({ upserts }),
    xlrcdbProvider,
    lrclibProvider
  })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.lyrics.source : '', 'xlrcdb')
  assert.equal(result.status === 'hit' ? result.cached : true, false)
  assert.equal(xlrcdbProvider.calls.length, 1)
  assert.equal(lrclibProvider.calls.length, 0)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.source, 'xlrcdb')
  assert.equal(upserts[0]?.provider, 'xlrcdb')
})

test('LyricsService falls back to LRCLIB when XLRCDB misses', async () => {
  const upserts: LyricsCacheUpsertInput[] = []
  const xlrcdbProvider = createProvider([{ status: 'not_found' }])
  const lrclibProvider = createProvider([{ status: 'hit', lyrics: makePayload('lrclib', 'LRCLIB lyrics') }])
  const service = createService({
    libraryApi: createLibraryApi({ upserts }),
    xlrcdbProvider,
    lrclibProvider
  })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.lyrics.source : '', 'lrclib')
  assert.equal(xlrcdbProvider.calls.length, 1)
  assert.equal(lrclibProvider.calls.length, 1)
  assert.equal(upserts[0]?.source, 'lrclib')
})

test('LyricsService falls back to LRCLIB when XLRCDB is unavailable', async () => {
  const xlrcdbProvider = createProvider([{ status: 'provider_unavailable' }])
  const lrclibProvider = createProvider([{ status: 'hit', lyrics: makePayload('lrclib', 'LRCLIB lyrics') }])
  const service = createService({ xlrcdbProvider, lrclibProvider })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.lyrics.source : '', 'lrclib')
  assert.equal(xlrcdbProvider.calls.length, 1)
  assert.equal(lrclibProvider.calls.length, 1)
})

test('LyricsService uses legacy LRCLIB cache only after XLRCDB fails to hit', async () => {
  const xlrcdbMiss = createProvider([{ status: 'not_found' }])
  const lrclibProvider = createProvider([])
  const serviceWithMiss = createService({
    libraryApi: createLibraryApi({ cache: makeCacheEntry('lrclib', 'Cached LRCLIB lyrics') }),
    xlrcdbProvider: xlrcdbMiss,
    lrclibProvider
  })

  const fallbackResult = await serviceWithMiss.getForTrack(makeQuery())

  assert.equal(fallbackResult.status, 'hit')
  assert.equal(fallbackResult.status === 'hit' ? fallbackResult.lyrics.source : '', 'lrclib')
  assert.equal(fallbackResult.status === 'hit' ? fallbackResult.cached : false, true)
  assert.equal(xlrcdbMiss.calls.length, 1)
  assert.equal(lrclibProvider.calls.length, 0)

  const xlrcdbHit = createProvider([{ status: 'hit', lyrics: makePayload('xlrcdb', 'Fresh XLRCDB lyrics') }])
  const serviceWithHit = createService({
    libraryApi: createLibraryApi({ cache: makeCacheEntry('lrclib', 'Cached LRCLIB lyrics') }),
    xlrcdbProvider: xlrcdbHit,
    lrclibProvider: createProvider([])
  })

  const freshResult = await serviceWithHit.getForTrack(makeQuery())

  assert.equal(freshResult.status, 'hit')
  assert.equal(freshResult.status === 'hit' ? freshResult.lyrics.source : '', 'xlrcdb')
  assert.equal(freshResult.status === 'hit' ? freshResult.cached : true, false)
  assert.equal(xlrcdbHit.calls.length, 1)
})

test('LyricsService keeps XLRCDB cache hits cache-first', async () => {
  const xlrcdbProvider = createProvider([])
  const lrclibProvider = createProvider([])
  const service = createService({
    libraryApi: createLibraryApi({ cache: makeCacheEntry('xlrcdb', 'Cached XLRCDB lyrics') }),
    xlrcdbProvider,
    lrclibProvider
  })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.lyrics.source : '', 'xlrcdb')
  assert.equal(result.status === 'hit' ? result.cached : false, true)
  assert.equal(xlrcdbProvider.calls.length, 0)
  assert.equal(lrclibProvider.calls.length, 0)
})

test('LyricsService caches online not found only when XLRCDB and LRCLIB both miss definitively', async () => {
  const upserts: LyricsCacheUpsertInput[] = []
  const service = createService({
    libraryApi: createLibraryApi({ upserts }),
    xlrcdbProvider: createProvider([{ status: 'not_found' }]),
    lrclibProvider: createProvider([{ status: 'not_found' }])
  })

  const result = await service.getForTrack(makeQuery())

  assert.deepEqual(result, { status: 'not_found', reason: 'provider-not-found' })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.status, 'not_found')
  assert.equal(upserts[0]?.source, 'xlrcdb')

  const unavailableUpserts: LyricsCacheUpsertInput[] = []
  const unavailableService = createService({
    libraryApi: createLibraryApi({ upserts: unavailableUpserts }),
    xlrcdbProvider: createProvider([{ status: 'provider_unavailable' }]),
    lrclibProvider: createProvider([{ status: 'not_found' }])
  })

  const unavailableResult = await unavailableService.getForTrack(makeQuery())

  assert.deepEqual(unavailableResult, { status: 'not_found', reason: 'provider-not-found' })
  assert.equal(unavailableUpserts.length, 0)
})

test('LyricsService rewrites legacy LRCLIB miss cache after a definitive XLRCDB miss', async () => {
  const upserts: LyricsCacheUpsertInput[] = []
  const service = createService({
    libraryApi: createLibraryApi({
      cache: makeCacheNotFoundEntry('lrclib'),
      upserts
    }),
    xlrcdbProvider: createProvider([{ status: 'not_found' }]),
    lrclibProvider: createProvider([])
  })

  const result = await service.getForTrack(makeQuery())

  assert.deepEqual(result, { status: 'not_found', reason: 'provider-not-found' })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.status, 'not_found')
  assert.equal(upserts[0]?.source, 'xlrcdb')
  assert.equal(upserts[0]?.provider, 'xlrcdb')
})
