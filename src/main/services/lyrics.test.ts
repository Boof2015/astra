import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  LyricsService,
  resolveEmbeddedLyrics,
  resolveEmbeddedLyricsMetadata,
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
  embeddedResolver?: (trackPath: string) => Promise<LyricsPayload | null>
  xlrcdbProvider: LyricsOnlineLookupProvider
  lrclibProvider: LyricsOnlineLookupProvider
}): LyricsService {
  return new LyricsService({
    enabled: true,
    appVersion: '0.6.1-beta',
    libraryApi: options.libraryApi ?? createLibraryApi(),
    sidecarLookup: async () => null,
    embeddedResolver: options.embeddedResolver ?? (async () => null),
    xlrcdbProvider: options.xlrcdbProvider,
    lrclibProvider: options.lrclibProvider
  })
}

function asEmbeddedMetadata(
  metadata: unknown
): Parameters<typeof resolveEmbeddedLyricsMetadata>[0] {
  return metadata as Parameters<typeof resolveEmbeddedLyricsMetadata>[0]
}

const embeddedEnhancedLrc = [
  '[00:02.25] <00:02.25> I  <00:02.49> know  ',
  '[00:04.00] <00:04.00> Next'
].join('\n')

function assertEnhancedEmbeddedPayload(payload: LyricsPayload | null): void {
  assert.ok(payload)
  assert.equal(payload.source, 'embedded')
  assert.equal(payload.format, 'lrc')
  assert.equal(payload.plainLyrics, 'I   know\nNext')
  assert.deepEqual(payload.syncedLines, [
    {
      timestampMs: 2_250,
      text: 'I   know',
      words: [
        { timestampMs: 2_250, text: 'I  ' },
        { timestampMs: 2_490, text: ' know' }
      ]
    },
    {
      timestampMs: 4_000,
      text: 'Next',
      words: [{ timestampMs: 4_000, text: 'Next' }]
    }
  ])
}

test('resolveEmbeddedLyricsMetadata parses recognized native textual lyric tags', () => {
  const cases = [
    { tagType: 'vorbis', id: 'LYRICS', value: embeddedEnhancedLrc },
    { tagType: 'APEv2', id: 'Lyrics', value: embeddedEnhancedLrc },
    { tagType: 'iTunes', id: '©lyr', value: embeddedEnhancedLrc },
    { tagType: 'asf', id: 'WM/Lyrics', value: embeddedEnhancedLrc },
    {
      tagType: 'ID3v2.4',
      id: 'USLT',
      value: { language: 'eng', descriptor: '', text: embeddedEnhancedLrc }
    }
  ]

  for (const fixture of cases) {
    const payload = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
      native: {
        [fixture.tagType]: [{ id: fixture.id, value: fixture.value }]
      },
      common: { lyrics: [] }
    }))
    assertEnhancedEmbeddedPayload(payload)
  }
})

test('resolveEmbeddedLyricsMetadata reconstructs leaked common Enhanced LRC sync text', () => {
  const payload = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: {},
    common: {
      lyrics: [{
        text: '<00:02.25> I  <00:02.49> know\n<00:04.00> Next',
        syncText: [
          { timestamp: 2_250, text: '<00:02.25> I  <00:02.49> know' },
          { timestamp: 4_000, text: '<00:04.00> Next' }
        ]
      }]
    }
  }))

  assertEnhancedEmbeddedPayload(payload)
})

test('resolveEmbeddedLyricsMetadata retains structured and plain common lyric fallbacks', () => {
  const structured = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: {},
    common: {
      lyrics: [{
        text: 'First line\nSecond line',
        syncText: [
          { timestamp: 1_000, text: 'First line' },
          { timestamp: 2_000, text: 'Second line' }
        ]
      }]
    }
  }))
  assert.deepEqual(structured?.syncedLines, [
    { timestampMs: 1_000, text: 'First line' },
    { timestampMs: 2_000, text: 'Second line' }
  ])

  const plain = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: {},
    common: { lyrics: [{ text: 'Plain embedded lyrics', syncText: [] }] }
  }))
  assert.equal(plain?.format, 'plain')
  assert.equal(plain?.plainLyrics, 'Plain embedded lyrics')
})

test('resolveEmbeddedLyricsMetadata prefers native parsing when synced line counts tie', () => {
  const payload = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: {
      vorbis: [{ id: 'LYRICS', value: '[00:01.00]<00:01.00>Native' }]
    },
    common: {
      lyrics: [{
        text: 'Common',
        syncText: [{ timestamp: 1_000, text: 'Common' }]
      }]
    }
  }))

  assert.equal(payload?.plainLyrics, 'Native')
  assert.deepEqual(payload?.syncedLines[0]?.words, [
    { timestampMs: 1_000, text: 'Native' }
  ])
})

test('resolveEmbeddedLyrics parses a synthetic FLAC Enhanced LRC tag end to end', async (t) => {
  const fixtureBase64 = await readFile(
    new URL('./test-fixtures/embedded-enhanced-lrc.flac.base64', import.meta.url),
    'utf8'
  )
  const fixtureDir = await mkdtemp(join(tmpdir(), 'astra-embedded-elrc-'))
  t.after(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
  })
  const fixturePath = join(fixtureDir, 'embedded-enhanced-lrc.flac')
  await writeFile(fixturePath, Buffer.from(fixtureBase64.trim(), 'base64'))

  assertEnhancedEmbeddedPayload(await resolveEmbeddedLyrics(fixturePath))
})

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

test('LyricsService refreshes legacy embedded caches with leaked word timestamps', async () => {
  const refreshedPayload = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: { vorbis: [{ id: 'LYRICS', value: embeddedEnhancedLrc }] },
    common: { lyrics: [] }
  }))
  assert.ok(refreshedPayload)

  const upserts: LyricsCacheUpsertInput[] = []
  let embeddedCalls = 0
  const service = createService({
    libraryApi: createLibraryApi({
      cache: {
        trackPath: '/music/track.flac',
        metadataSignature: 'legacy-signature',
        status: 'hit',
        source: 'embedded',
        provider: null,
        format: 'lrc',
        plainLyrics: '<00:02.25> I  <00:02.49> know',
        syncedLyrics: '<00:02.25> I  <00:02.49> know',
        syncedLines: [
          { timestampMs: 2_250, text: '<00:02.25> I  <00:02.49> know' }
        ],
        updatedAt: 1_000
      },
      upserts
    }),
    embeddedResolver: async () => {
      embeddedCalls += 1
      return refreshedPayload
    },
    xlrcdbProvider: createProvider([]),
    lrclibProvider: createProvider([])
  })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.cached : true, false)
  assert.equal(embeddedCalls, 1)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.source, 'embedded')
  assertEnhancedEmbeddedPayload(result.status === 'hit' ? result.lyrics : null)
})

test('LyricsService keeps valid Enhanced LRC embedded caches cache-first', async () => {
  const cachedPayload = resolveEmbeddedLyricsMetadata(asEmbeddedMetadata({
    native: { vorbis: [{ id: 'LYRICS', value: embeddedEnhancedLrc }] },
    common: { lyrics: [] }
  }))
  assert.ok(cachedPayload)

  let embeddedCalls = 0
  const service = createService({
    libraryApi: createLibraryApi({
      cache: {
        trackPath: '/music/track.flac',
        metadataSignature: 'current-signature',
        status: 'hit',
        source: 'embedded',
        provider: null,
        format: 'lrc',
        plainLyrics: cachedPayload.plainLyrics,
        syncedLyrics: cachedPayload.syncedLyrics,
        syncedLines: cachedPayload.syncedLines,
        updatedAt: 1_000
      }
    }),
    embeddedResolver: async () => {
      embeddedCalls += 1
      return null
    },
    xlrcdbProvider: createProvider([]),
    lrclibProvider: createProvider([])
  })

  const result = await service.getForTrack(makeQuery())

  assert.equal(result.status, 'hit')
  assert.equal(result.status === 'hit' ? result.cached : false, true)
  assert.equal(embeddedCalls, 0)
  assertEnhancedEmbeddedPayload(result.status === 'hit' ? result.lyrics : null)
})
