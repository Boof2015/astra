import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricsLookupResult, LyricsTrackQuery } from '../../types/lyrics.ts'
import type {
  LyricsPopoutSnapshot,
  LyricsPopoutTrackSnapshot
} from '../../types/lyricsPopout.ts'
import {
  LYRICS_POPOUT_RESYNC_INTERVAL_MS,
  getLyricsPopoutPublishReason
} from './lyricsPopoutBridge.ts'

function createTrackSnapshot(
  overrides: Partial<LyricsPopoutTrackSnapshot> = {}
): LyricsPopoutTrackSnapshot {
  return {
    path: '/music/track-1.flac',
    title: 'Track One',
    artist: 'Artist',
    album: 'Album',
    ...overrides
  }
}

function createLyricsQuery(
  overrides: Partial<LyricsTrackQuery> = {}
): LyricsTrackQuery {
  return {
    path: '/music/track-1.flac',
    title: 'Track One',
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 180,
    ...overrides
  }
}

function createLyricsResult(): LyricsLookupResult {
  return {
    status: 'hit',
    cached: false,
    lyrics: {
      source: 'embedded',
      provider: null,
      format: 'lrc',
      plainLyrics: 'plain lyrics',
      syncedLyrics: '[00:01.00]line 1',
      syncedLines: [{ timestampMs: 1000, text: 'line 1' }]
    }
  }
}

function createSnapshot(
  overrides: Partial<LyricsPopoutSnapshot> = {}
): LyricsPopoutSnapshot {
  return {
    capturedAt: 10_000,
    preferredExpanded: true,
    playbackState: 'playing',
    currentTime: 42,
    duration: 180,
    effectiveDelayMs: 0,
    currentTrack: createTrackSnapshot(),
    lyricsQuery: createLyricsQuery(),
    lyricsResult: createLyricsResult(),
    isLoading: false,
    errorMessage: '',
    ...overrides
  }
}

test('getLyricsPopoutPublishReason skips publishing while the popout window is closed', () => {
  const nextSnapshot = createSnapshot()

  const reason = getLyricsPopoutPublishReason({
    trigger: 'state-change',
    isWindowOpen: false,
    wasWindowOpen: false,
    nextSnapshot,
    lastPublishedSnapshot: null
  })

  assert.equal(reason, 'closed')
})

test('getLyricsPopoutPublishReason publishes immediately when the popout opens', () => {
  const nextSnapshot = createSnapshot()
  const lastPublishedSnapshot = createSnapshot({
    capturedAt: 8_000,
    currentTime: 30
  })

  const reason = getLyricsPopoutPublishReason({
    trigger: 'state-change',
    isWindowOpen: true,
    wasWindowOpen: false,
    nextSnapshot,
    lastPublishedSnapshot
  })

  assert.equal(reason, 'window-opened')
})

test('getLyricsPopoutPublishReason forces a publish when semantic snapshot data changes', () => {
  const lastPublishedSnapshot = createSnapshot()
  const nextSnapshot = createSnapshot({
    preferredExpanded: false
  })

  const reason = getLyricsPopoutPublishReason({
    trigger: 'state-change',
    isWindowOpen: true,
    wasWindowOpen: true,
    nextSnapshot,
    lastPublishedSnapshot
  })

  assert.equal(reason, 'semantic-change')
})

test('getLyricsPopoutPublishReason forces a publish when lyric delay compensation changes', () => {
  const lastPublishedSnapshot = createSnapshot({
    effectiveDelayMs: 0
  })
  const nextSnapshot = createSnapshot({
    effectiveDelayMs: 240
  })

  const reason = getLyricsPopoutPublishReason({
    trigger: 'state-change',
    isWindowOpen: true,
    wasWindowOpen: true,
    nextSnapshot,
    lastPublishedSnapshot
  })

  assert.equal(reason, 'semantic-change')
})

test('getLyricsPopoutPublishReason forces a publish when playback time jumps materially', () => {
  const lyricsResult = createLyricsResult()
  const lastPublishedSnapshot = createSnapshot({
    capturedAt: 10_000,
    currentTime: 42,
    lyricsResult
  })
  const nextSnapshot = createSnapshot({
    capturedAt: 10_300,
    currentTime: 17,
    lyricsResult
  })

  const reason = getLyricsPopoutPublishReason({
    trigger: 'state-change',
    isWindowOpen: true,
    wasWindowOpen: true,
    nextSnapshot,
    lastPublishedSnapshot,
    now: 10_300
  })

  assert.equal(reason, 'time-jump')
})

test('getLyricsPopoutPublishReason only requests resync ticks while open and playing after the interval elapses', () => {
  const lyricsResult = createLyricsResult()
  const lastPublishedSnapshot = createSnapshot({
    capturedAt: 10_000,
    currentTime: 42,
    playbackState: 'playing',
    lyricsResult
  })
  const nextSnapshot = createSnapshot({
    capturedAt: 11_100,
    currentTime: 43.1,
    playbackState: 'playing',
    lyricsResult
  })

  const shouldResync = getLyricsPopoutPublishReason({
    trigger: 'resync-tick',
    isWindowOpen: true,
    wasWindowOpen: true,
    nextSnapshot,
    lastPublishedSnapshot,
    now: 10_000 + LYRICS_POPOUT_RESYNC_INTERVAL_MS + 50
  })

  const shouldSkipPaused = getLyricsPopoutPublishReason({
    trigger: 'resync-tick',
    isWindowOpen: true,
    wasWindowOpen: true,
    nextSnapshot: {
      ...nextSnapshot,
      playbackState: 'paused'
    },
    lastPublishedSnapshot: {
      ...lastPublishedSnapshot,
      playbackState: 'paused'
    },
    now: 10_000 + LYRICS_POPOUT_RESYNC_INTERVAL_MS + 50
  })

  assert.equal(shouldResync, 'resync')
  assert.equal(shouldSkipPaused, 'not-needed')
})
