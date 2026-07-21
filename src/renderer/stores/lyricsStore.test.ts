import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LYRICS_RESULT_CACHE_LIMIT,
  putLyricsResultInCache,
  useLyricsStore
} from './lyricsStore.ts'
import type { LyricsLookupResult, LyricsStatus, LyricsTrackQuery } from '../../types/lyrics.ts'

function makeStatus(): LyricsStatus {
  return {
    enabled: true,
    provider: 'lrclib',
    lrclibBaseUrl: 'https://lrclib.net',
    statusMessage: 'Lyrics ready.',
    lastError: null
  }
}

function makeResult(path: string): LyricsLookupResult {
  return {
    status: 'hit',
    cached: false,
    lyrics: {
      source: 'manual',
      provider: null,
      format: 'plain',
      plainLyrics: `Lyrics for ${path}`,
      syncedLyrics: null,
      syncedLines: []
    }
  }
}

function makeProviderUnavailableResult(): LyricsLookupResult {
  return {
    status: 'not_found',
    reason: 'provider-unavailable'
  }
}

function makeTransientErrorResult(): LyricsLookupResult {
  return {
    status: 'transient_error',
    message: 'LRCLIB metadata lookup failed due to a transient network error.',
    code: 'lrclib_get_timeout'
  }
}

function makeQuery(path: string): LyricsTrackQuery {
  return {
    path,
    title: path,
    artist: 'Artist'
  }
}

function resetLyricsStore(): void {
  useLyricsStore.setState({
    status: null,
    resultByTrackPath: {},
    currentTrackPath: null,
    currentResult: null,
    isLoading: false,
    isInitialized: false,
    errorMessage: ''
  })
}

type LyricsApiMock = {
  getStatus: () => Promise<LyricsStatus>
  setEnabled: () => Promise<LyricsStatus>
  setLrclibBaseUrl: (baseUrl: string) => Promise<LyricsStatus>
  getForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
  refreshForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
  resetToDefaults: () => Promise<LyricsStatus>
  onStatus: () => () => void
}

function installLyricsApiMock(overrides: Partial<LyricsApiMock> = {}): void {
  const lyricsApi: LyricsApiMock = {
    getStatus: async () => makeStatus(),
    setEnabled: async () => makeStatus(),
    setLrclibBaseUrl: async (baseUrl: string) => ({ ...makeStatus(), lrclibBaseUrl: baseUrl }),
    getForTrack: async (query: LyricsTrackQuery) => makeResult(query.path),
    refreshForTrack: async (query: LyricsTrackQuery) => makeResult(query.path),
    resetToDefaults: async () => makeStatus(),
    onStatus: () => () => {},
    ...overrides
  }

  const globalWithWindow = globalThis as unknown as {
    window: { electronAPI: { lyrics: typeof lyricsApi } }
  }
  globalWithWindow.window = {
    electronAPI: {
      lyrics: lyricsApi
    }
  }
}

test('setLrclibBaseUrl applies the canonical endpoint returned by main', async () => {
  installLyricsApiMock({
    setLrclibBaseUrl: async () => ({
      ...makeStatus(),
      lrclibBaseUrl: 'http://lyrics.local:8080/mirror'
    })
  })
  resetLyricsStore()

  const status = await useLyricsStore.getState().setLrclibBaseUrl('http://lyrics.local:8080/mirror/')

  assert.equal(status?.lrclibBaseUrl, 'http://lyrics.local:8080/mirror')
  assert.equal(useLyricsStore.getState().status?.lrclibBaseUrl, 'http://lyrics.local:8080/mirror')
})

test('putLyricsResultInCache caps entries and keeps the current track result', () => {
  const currentPath = '/music/current.flac'
  let cache: Record<string, LyricsLookupResult> = {}
  cache = putLyricsResultInCache(cache, currentPath, makeResult(currentPath), currentPath)

  for (let index = 0; index < LYRICS_RESULT_CACHE_LIMIT; index += 1) {
    const path = `/music/${index}.flac`
    cache = putLyricsResultInCache(cache, path, makeResult(path), currentPath)
  }

  assert.equal(Object.keys(cache).length, LYRICS_RESULT_CACHE_LIMIT)
  assert.ok(cache[currentPath])
  assert.equal(cache['/music/0.flac'], undefined)
})

test('loadForTrack keeps renderer lyrics results bounded after many tracks', async () => {
  installLyricsApiMock()
  resetLyricsStore()

  const iterations = LYRICS_RESULT_CACHE_LIMIT + 20
  for (let index = 0; index < iterations; index += 1) {
    await useLyricsStore.getState().loadForTrack(makeQuery(`/music/${index}.flac`))
  }

  const state = useLyricsStore.getState()
  const currentPath = `/music/${iterations - 1}.flac`
  assert.equal(Object.keys(state.resultByTrackPath).length, LYRICS_RESULT_CACHE_LIMIT)
  assert.equal(state.currentTrackPath, currentPath)
  assert.equal(state.currentResult, state.resultByTrackPath[currentPath])
  assert.equal(state.currentResult?.status, 'hit')
  assert.equal(state.resultByTrackPath['/music/0.flac'], undefined)
})

test('loadForTrack keeps cached lyrics visible while a lookup is pending', async () => {
  let resolveLookup: (result: LyricsLookupResult) => void = () => {}
  const lookupPromise = new Promise<LyricsLookupResult>((resolve) => {
    resolveLookup = resolve
  })

  installLyricsApiMock({
    getForTrack: async () => lookupPromise
  })
  resetLyricsStore()

  const path = '/music/cached.flac'
  const cachedResult = makeResult(`${path}:cached`)
  useLyricsStore.setState({
    resultByTrackPath: {
      [path]: cachedResult
    }
  })

  const pendingLoad = useLyricsStore.getState().loadForTrack(makeQuery(path))
  assert.equal(useLyricsStore.getState().currentResult, cachedResult)
  assert.equal(useLyricsStore.getState().isLoading, true)

  resolveLookup(makeResult(`${path}:fresh`))
  await pendingLoad

  assert.equal(useLyricsStore.getState().isLoading, false)
  assert.notEqual(useLyricsStore.getState().currentResult, cachedResult)
})

test('loadForTrack keeps cached lyrics visible when LRCLIB is unavailable', async () => {
  installLyricsApiMock({
    getForTrack: async () => makeProviderUnavailableResult()
  })
  resetLyricsStore()

  const path = '/music/cached-provider-unavailable.flac'
  const cachedResult = makeResult(`${path}:cached`)
  useLyricsStore.setState({
    resultByTrackPath: {
      [path]: cachedResult
    }
  })

  const result = await useLyricsStore.getState().loadForTrack(makeQuery(path))
  const state = useLyricsStore.getState()

  assert.deepEqual(result, makeProviderUnavailableResult())
  assert.equal(state.isLoading, false)
  assert.equal(state.errorMessage, '')
  assert.equal(state.currentResult, cachedResult)
  assert.equal(state.resultByTrackPath[path], cachedResult)
})

test('refreshForTrack surfaces explicit transient LRCLIB errors', async () => {
  const transientResult = makeTransientErrorResult()
  installLyricsApiMock({
    refreshForTrack: async () => transientResult
  })
  resetLyricsStore()

  const path = '/music/manual-refresh.flac'
  const cachedResult = makeResult(`${path}:cached`)
  useLyricsStore.setState({
    resultByTrackPath: {
      [path]: cachedResult
    },
    currentTrackPath: path,
    currentResult: cachedResult
  })

  await useLyricsStore.getState().refreshForTrack(makeQuery(path))
  const state = useLyricsStore.getState()

  assert.deepEqual(state.currentResult, transientResult)
  assert.equal(state.errorMessage, transientResult.status === 'transient_error' ? transientResult.message : '')
})
