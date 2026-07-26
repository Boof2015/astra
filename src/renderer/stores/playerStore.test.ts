import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceRecentPlayAccumulation,
  createQueueEntriesFromPaths,
  createQueueEntryFromTrack,
  GAPLESS_PREBUFFER_LEAD_SECONDS,
  getGaplessPrebufferDelayMs,
  getRecentPlayThresholdSecondsForDuration,
  MAX_PLAYBACK_HISTORY,
  mergeAssociatedTrackMetadata,
  RECENT_PLAY_MIN_SECONDS,
  resolvePositiveDuration,
  shouldApplyDurationChange,
  usePlayerStore,
  type QueueItem,
  type QueueTrackEntry
} from './playerStore.ts'
import { useLibraryStore, type DbTrack } from './libraryStore.ts'
import type { Track } from '../types/audio.ts'
import { resolveCollectionTrackPaths } from '../utils/collectionQueue.ts'
import { FAVORITES_PLAYLIST_ID } from '../utils/playlistSystem.ts'
import type { PlayerSessionSnapshot } from '../utils/sessionState.ts'
import { audioEngine } from '../audio/AudioEngine.ts'

function makeTrack(path: string, overrides: Partial<Track> = {}): Track {
  return {
    id: overrides.id ?? path,
    path,
    origin: overrides.origin,
    title: overrides.title ?? path,
    artist: overrides.artist ?? 'Artist',
    artistNames: overrides.artistNames,
    album: overrides.album ?? 'Album',
    albumArtist: overrides.albumArtist,
    albumArtistNames: overrides.albumArtistNames,
    albumIdentityKey: overrides.albumIdentityKey,
    duration: overrides.duration ?? 180,
    trackNumber: overrides.trackNumber,
    discNumber: overrides.discNumber,
    year: overrides.year,
    genre: overrides.genre,
    genres: overrides.genres,
    artworkData: overrides.artworkData,
    artworkHash: overrides.artworkHash,
    format: overrides.format ?? 'flac',
    sampleRate: overrides.sampleRate,
    bitDepth: overrides.bitDepth,
    bitrate: overrides.bitrate,
    channels: overrides.channels,
    codec: overrides.codec,
    codecProfile: overrides.codecProfile,
    isAtmosJoc: overrides.isAtmosJoc,
    replayGainTrackDb: overrides.replayGainTrackDb,
    replayGainAlbumDb: overrides.replayGainAlbumDb,
    sourceType: overrides.sourceType,
    sourceId: overrides.sourceId,
    sourceTrackId: overrides.sourceTrackId,
    sourcePath: overrides.sourcePath,
    isAvailable: overrides.isAvailable,
    availabilityReason: overrides.availabilityReason
  }
}

function makeDbTrack(path: string, overrides: Partial<DbTrack> = {}): DbTrack {
  return {
    id: overrides.id ?? Math.abs(path.split('').reduce((total, char) => total + char.charCodeAt(0), 0)),
    path,
    album_identity_key: overrides.album_identity_key ?? 'album:key',
    is_new: overrides.is_new ?? false,
    title: overrides.title ?? path,
    artist: overrides.artist ?? 'Artist',
    artist_names: overrides.artist_names ?? ['Artist'],
    album: overrides.album ?? 'Album',
    album_artist: overrides.album_artist ?? 'Artist',
    album_artist_names: overrides.album_artist_names ?? ['Artist'],
    duration: overrides.duration ?? 180,
    track_number: overrides.track_number ?? 1,
    disc_number: overrides.disc_number ?? 1,
    year: overrides.year ?? 2026,
    genre: overrides.genre ?? null,
    genres: overrides.genres ?? (overrides.genre ? [overrides.genre] : []),
    artwork_hash: overrides.artwork_hash ?? null,
    base_artwork_hash: overrides.base_artwork_hash ?? null,
    format: overrides.format ?? 'flac',
    sample_rate: overrides.sample_rate ?? 44100,
    bit_depth: overrides.bit_depth ?? 16,
    bitrate: overrides.bitrate ?? null,
    channels: overrides.channels ?? 2,
    codec: overrides.codec ?? null,
    codec_profile: overrides.codec_profile ?? null,
    is_atmos_joc: overrides.is_atmos_joc ?? 0,
    is_iamf: overrides.is_iamf ?? 0,
    bpm: overrides.bpm ?? null,
    musical_key: overrides.musical_key ?? null,
    source_type: overrides.source_type ?? 'local',
    source_id: overrides.source_id ?? null,
    source_track_id: overrides.source_track_id ?? null,
    source_path: overrides.source_path ?? null,
    is_available: overrides.is_available ?? 1,
    availability_reason: overrides.availability_reason ?? null,
    file_created_at: overrides.file_created_at ?? null,
    play_count: overrides.play_count ?? 0,
    last_played_at: overrides.last_played_at ?? null,
    replaygain_track_gain_db: overrides.replaygain_track_gain_db ?? null,
    replaygain_album_gain_db: overrides.replaygain_album_gain_db ?? null,
    added_at: overrides.added_at ?? 1,
    modified_at: overrides.modified_at ?? 1
  }
}

function hasArtworkData(entry: QueueTrackEntry): boolean {
  return Object.hasOwn(entry.snapshot as Record<string, unknown>, 'artworkData')
}

function makeQueueItem(entry: QueueTrackEntry, queueId: string, origin: 'context' | 'manual' = 'manual'): QueueItem {
  return {
    queueId,
    entry,
    origin,
    sourcePlaylistId: null,
    sourceContext: null,
    contextLabel: origin === 'context' ? 'Test Context' : null
  }
}

function installMockTrackFetch(handler: (trackPaths: string[]) => Promise<DbTrack[]> | DbTrack[]): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => handler(trackPaths)
        }
      }
    }
  })
}

function resetStores(): void {
  useLibraryStore.setState({
    trackByPath: new Map<string, DbTrack>(),
    trackCacheVersion: 0
  })

  usePlayerStore.setState({
    currentTrack: null,
    currentTrackSource: 'standalone',
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    queueItems: [],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: null,
    queueSourcePlaylistId: null,
    queueSourceContext: null,
    queueContextLabel: null,
    shuffle: false,
    repeat: 'none',
    playbackHistory: [],
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null
  })
}

function installLoadedTrackStub(): () => void {
  const original = usePlayerStore.getState()._loadAndPlayTrack
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      usePlayerStore.setState({ currentTrack: track, playbackState: 'paused' })
      return 'loaded'
    }
  })
  return () => usePlayerStore.setState({ _loadAndPlayTrack: original })
}

function resolvedUpcomingPaths(): string[] {
  return usePlayerStore.getState().getResolvedUpcomingEntries().map((entry) => entry.track.path)
}

test('queue entries strip artworkData from retained snapshots', () => {
  resetStores()

  const entry = createQueueEntryFromTrack(makeTrack('/external/track.flac', {
    artworkData: 'data:image/jpeg;base64,large',
    artworkHash: 'cached-hash'
  }))

  assert.equal(entry.path, '/external/track.flac')
  assert.equal(hasArtworkData(entry), false)
  assert.equal(entry.snapshot.artworkHash, 'cached-hash')
})

test('path queue entries hydrate snapshots from cached library metadata', () => {
  resetStores()

  const dbTrack = makeDbTrack('/music/a.flac', {
    title: 'Cached Title',
    artist: 'Cached Artist',
    artist_names: ['Cached Artist', 'Featured Artist'],
    album_artist_names: ['Cached Artist', 'Featured Artist'],
    artwork_hash: 'art-hash'
  })
  useLibraryStore.setState({
    trackByPath: new Map([[dbTrack.path, dbTrack]])
  })

  const [entry] = createQueueEntriesFromPaths([dbTrack.path])
  assert.ok(entry)
  assert.equal(entry.snapshot.title, 'Cached Title')
  assert.equal(entry.snapshot.artist, 'Cached Artist')
  assert.deepEqual(entry.snapshot.artistNames, ['Cached Artist', 'Featured Artist'])
  assert.deepEqual(entry.snapshot.albumArtistNames, ['Cached Artist', 'Featured Artist'])
  assert.equal(entry.snapshot.artworkHash, 'art-hash')
  assert.equal(hasArtworkData(entry), false)

  const item = makeQueueItem(entry, 'cached')
  usePlayerStore.setState({ queueItems: [item], baseUpcomingQueueIds: [item.queueId], upcomingQueueIds: [item.queueId] })
  const [resolved] = usePlayerStore.getState().getResolvedUpcomingEntries()
  assert.equal(resolved?.track.title, 'Cached Title')
  assert.deepEqual(resolved?.track.artistNames, ['Cached Artist', 'Featured Artist'])
  assert.deepEqual(resolved?.track.albumArtistNames, ['Cached Artist', 'Featured Artist'])
  assert.equal(resolved?.track.artworkHash, 'art-hash')
})

test('path queue actions fetch missing library metadata before queueing', async () => {
  resetStores()

  const dbTrack = makeDbTrack('/music/fetched.mp3', {
    title: 'Fetched Title',
    artist: 'Fetched Artist',
    album: 'Fetched Album',
    duration: 245,
    artwork_hash: 'fetched-art',
    codec: 'mp3',
    codec_profile: 'mpeg layer iii',
    is_atmos_joc: 1
  })
  let requestedPaths: string[] = []
  installMockTrackFetch((trackPaths) => {
    requestedPaths = trackPaths
    return [dbTrack]
  })

  await usePlayerStore.getState().enqueueTrackPaths([dbTrack.path], 'end')

  assert.deepEqual(requestedPaths, [dbTrack.path])
  assert.equal(useLibraryStore.getState().trackByPath.get(dbTrack.path), dbTrack)

  const [item] = usePlayerStore.getState().queueItems
  assert.ok(item)
  assert.equal(item.entry.snapshot.title, 'Fetched Title')
  assert.equal(item.entry.snapshot.artist, 'Fetched Artist')
  assert.equal(item.entry.snapshot.album, 'Fetched Album')
  assert.equal(item.entry.snapshot.duration, 245)
  assert.equal(item.entry.snapshot.artworkHash, 'fetched-art')
  assert.equal(item.entry.snapshot.codec, 'mp3')
  assert.equal(item.entry.snapshot.codecProfile, 'mpeg layer iii')
  assert.equal(item.entry.snapshot.isAtmosJoc, true)
  assert.equal(hasArtworkData(item.entry), false)

  const [resolved] = usePlayerStore.getState().getResolvedUpcomingEntries()
  assert.equal(resolved?.track.title, 'Fetched Title')
  assert.equal(resolved?.track.duration, 245)
})

test('path queue actions keep filename fallback for tracks missing from the library', async () => {
  resetStores()
  installMockTrackFetch(() => [])

  await usePlayerStore.getState().enqueueTrackPaths(['/missing/No Metadata.mp3'], 'end')

  const [item] = usePlayerStore.getState().queueItems
  assert.ok(item)
  assert.equal(item.entry.snapshot.title, 'No Metadata')
  assert.equal(item.entry.snapshot.artist, 'Unknown Artist')
  assert.equal(item.entry.snapshot.album, 'Unknown Album')
  assert.equal(item.entry.snapshot.duration, 0)
  assert.equal(item.entry.snapshot.format, 'mp3')
})

test('duplicate cleanup replacement remaps stopped current, queue, and playback history paths', async () => {
  resetStores()
  const removedPath = '/music/remove.flac'
  const keepPath = '/music/keep.flac'
  const keepTrack = makeDbTrack(keepPath, { title: 'Kept Duplicate' })
  installMockTrackFetch((trackPaths) => trackPaths.includes(keepPath) ? [keepTrack] : [])
  const removedEntry = createQueueEntryFromTrack(makeTrack(removedPath, { title: 'Removed Duplicate' }))
  const queueItem = makeQueueItem(removedEntry, 'duplicate-queue')
  const historyItem = makeQueueItem(removedEntry, 'duplicate-history')
  usePlayerStore.setState({
    currentTrack: makeTrack(removedPath, { title: 'Removed Duplicate' }),
    playbackState: 'stopped',
    queueItems: [queueItem],
    baseUpcomingQueueIds: [queueItem.queueId],
    upcomingQueueIds: [queueItem.queueId],
    playbackHistory: [{ item: historyItem }]
  })

  await usePlayerStore.getState().replaceLocalTrackPaths({ [removedPath]: keepPath })

  const state = usePlayerStore.getState()
  assert.equal(state.currentTrack?.path, keepPath)
  assert.equal(state.currentTrack?.title, 'Kept Duplicate')
  assert.equal(state.queueItems[0]?.entry.path, keepPath)
  assert.equal(state.playbackHistory[0]?.item.entry.path, keepPath)
})

test('associated external queue entries use sanitized snapshots instead of library hydration', () => {
  resetStores()

  const trackPath = '/music/opened.flac'
  useLibraryStore.setState({
    trackByPath: new Map([[trackPath, makeDbTrack(trackPath, { title: 'Library Title' })]])
  })

  const entry = createQueueEntryFromTrack(makeTrack(trackPath, {
    origin: 'associated-external',
    title: 'Opened File Title',
    artworkData: 'data:image/png;base64,large'
  }))
  const item = makeQueueItem(entry, 'associated')
  usePlayerStore.setState({ queueItems: [item], baseUpcomingQueueIds: [item.queueId], upcomingQueueIds: [item.queueId] })

  const [resolved] = usePlayerStore.getState().getResolvedUpcomingEntries()
  assert.equal(hasArtworkData(entry), false)
  assert.equal(resolved?.track.title, 'Opened File Title')
  assert.equal(resolved?.track.origin, 'associated-external')
  assert.equal(Object.hasOwn(resolved?.track as unknown as Record<string, unknown>, 'artworkData'), false)
})

test('associated metadata prefers cached artwork hashes over embedded data URLs', () => {
  const merged = mergeAssociatedTrackMetadata(makeTrack('/external/opened.flac', {
    origin: 'associated-external',
    artworkData: 'data:image/png;base64,large-old'
  }), {
    title: 'Opened Title',
    artworkHash: 'cached-cover.png',
    artwork: 'data:image/png;base64,large-new'
  })

  assert.equal(merged.title, 'Opened Title')
  assert.equal(merged.artworkHash, 'cached-cover.png')
  assert.equal(Object.hasOwn(merged as unknown as Record<string, unknown>, 'artworkData'), false)
})

test('gapless prebuffer delay waits until the late handoff window', () => {
  assert.equal(getGaplessPrebufferDelayMs(0, 180), 165_000)
  assert.equal(getGaplessPrebufferDelayMs(164.6, 180), 400)
  assert.equal(getGaplessPrebufferDelayMs(165, 180), 0)
  assert.equal(getGaplessPrebufferDelayMs(0, GAPLESS_PREBUFFER_LEAD_SECONDS), 0)
  assert.equal(getGaplessPrebufferDelayMs(0, 0), 0)
})

test('duration helpers preserve positive track durations through zero engine values', () => {
  assert.equal(resolvePositiveDuration(0, 185), 185)
  assert.equal(resolvePositiveDuration(192, 185), 192)
  assert.equal(resolvePositiveDuration(Number.NaN, 0), 0)

  assert.equal(shouldApplyDurationChange(0, makeTrack('/music/a.flac', { duration: 185 }), 'playing'), false)
  assert.equal(shouldApplyDurationChange(0, null, 'playing'), true)
  assert.equal(shouldApplyDurationChange(0, makeTrack('/music/a.flac', { duration: 185 }), 'stopped'), true)
  assert.equal(shouldApplyDurationChange(0, makeTrack('/music/a.flac', { duration: 0 }), 'playing'), true)
  assert.equal(shouldApplyDurationChange(190, makeTrack('/music/a.flac', { duration: 185 }), 'playing'), true)
})

test('recent play threshold uses fifteen seconds or full short-track duration', () => {
  assert.equal(RECENT_PLAY_MIN_SECONDS, 15)
  assert.equal(getRecentPlayThresholdSecondsForDuration(180), 15)
  assert.equal(getRecentPlayThresholdSecondsForDuration(4), 4)
  assert.equal(getRecentPlayThresholdSecondsForDuration(0), 15)
  assert.equal(getRecentPlayThresholdSecondsForDuration(null), 15)
})

test('recent play accumulation only counts elapsed playing time', () => {
  let state = { accumulatedSeconds: 0, lastAccumulatedAtMs: null as number | null }

  state = advanceRecentPlayAccumulation(state, 'playing', 1_000)
  assert.equal(state.accumulatedSeconds, 0)
  assert.equal(state.lastAccumulatedAtMs, 1_000)

  state = advanceRecentPlayAccumulation(state, 'playing', 15_900)
  assert.equal(state.accumulatedSeconds, 14.9)
  assert.equal(state.accumulatedSeconds < RECENT_PLAY_MIN_SECONDS, true)

  state = advanceRecentPlayAccumulation(state, 'playing', 16_000)
  assert.equal(state.accumulatedSeconds, 15)
  assert.equal(state.accumulatedSeconds >= RECENT_PLAY_MIN_SECONDS, true)
})

test('recent play accumulation ignores paused gaps and position jumps', () => {
  let state = { accumulatedSeconds: 0, lastAccumulatedAtMs: null as number | null }

  state = advanceRecentPlayAccumulation(state, 'playing', 1_000)
  state = advanceRecentPlayAccumulation(state, 'playing', 6_000)
  assert.equal(state.accumulatedSeconds, 5)

  state = advanceRecentPlayAccumulation(state, 'paused', 20_000)
  assert.equal(state.accumulatedSeconds, 5)
  assert.equal(state.lastAccumulatedAtMs, null)

  state = advanceRecentPlayAccumulation(state, 'playing', 25_000)
  assert.equal(state.accumulatedSeconds, 5)
  assert.equal(state.lastAccumulatedAtMs, 25_000)

  state = advanceRecentPlayAccumulation(state, 'playing', 34_000)
  assert.equal(state.accumulatedSeconds, 14)

  const shortTrackThreshold = getRecentPlayThresholdSecondsForDuration(4)
  let shortTrackState = { accumulatedSeconds: 0, lastAccumulatedAtMs: null as number | null }
  shortTrackState = advanceRecentPlayAccumulation(shortTrackState, 'playing', 0)
  shortTrackState = advanceRecentPlayAccumulation(shortTrackState, 'playing', 4_000)
  assert.equal(shortTrackState.accumulatedSeconds >= shortTrackThreshold, true)
})

test('playback history is capped and stores sanitized queue entries', async () => {
  resetStores()

  const originalLoadAndPlayTrack = usePlayerStore.getState()._loadAndPlayTrack
  usePlayerStore.setState({
    _loadAndPlayTrack: async () => 'loaded'
  })

  try {
    const iterations = MAX_PLAYBACK_HISTORY + 5
    for (let index = 0; index < iterations; index += 1) {
      usePlayerStore.setState({
        currentTrack: makeTrack(`/history/current-${index}.flac`, {
          artworkData: `data:image/jpeg;base64,${index}`
        }),
        currentTrackSource: 'standalone',
        currentQueueItemId: null
      })

      await usePlayerStore.getState().startPlaybackContext([
        makeTrack(`/history/next-${index}.flac`)
      ], 0)
    }

    const history = usePlayerStore.getState().playbackHistory
    assert.equal(history.length, MAX_PLAYBACK_HISTORY)
    assert.equal(history[0]?.item.entry.path, '/history/current-5.flac')
    assert.equal(history.every((entry) => !hasArtworkData(entry.item.entry)), true)
  } finally {
    usePlayerStore.setState({
      _loadAndPlayTrack: originalLoadAndPlayTrack
    })
  }
})

test('shuffle mixes manual and context items and unshuffle restores canonical order', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random

  try {
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0)
    usePlayerStore.getState().enqueueTrack(makeTrack('/queue/manual.flac'), 'end')

    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/b.flac',
      '/queue/c.flac',
      '/queue/manual.flac'
    ])

    Math.random = () => 0
    usePlayerStore.getState().toggleShuffle()
    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/c.flac',
      '/queue/manual.flac',
      '/queue/b.flac'
    ])
    assert.deepEqual(
      usePlayerStore.getState().getResolvedUpcomingEntries().map((entry) => entry.origin),
      ['context', 'manual', 'context']
    )

    const manualEntry = usePlayerStore.getState().getResolvedUpcomingEntries()
      .find((entry) => entry.origin === 'manual')
    assert.ok(manualEntry)
    usePlayerStore.getState().moveUpcomingItem(manualEntry.queueId, 0)

    usePlayerStore.getState().toggleShuffle()
    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/manual.flac',
      '/queue/b.flac',
      '/queue/c.flac'
    ])
  } finally {
    Math.random = originalRandom
    restoreLoad()
  }
})

test('startShuffled is ignored while shuffle is off', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random
  Math.random = () => 0

  try {
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0, { startShuffled: true })

    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/a.flac')
    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/b.flac',
      '/queue/c.flac'
    ])
    assert.equal(usePlayerStore.getState().shuffle, false)
  } finally {
    Math.random = originalRandom
    restoreLoad()
  }
})

test('startShuffled picks a non-first current item when global shuffle starts from play', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random
  Math.random = () => 0

  try {
    usePlayerStore.setState({ shuffle: true })
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0, { startShuffled: true })

    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/b.flac')
    assert.notEqual(usePlayerStore.getState().currentTrack?.path, '/queue/a.flac')
    assert.deepEqual(
      new Set(resolvedUpcomingPaths()),
      new Set(['/queue/a.flac', '/queue/c.flac'])
    )
    assert.equal(usePlayerStore.getState().shuffle, true)
  } finally {
    Math.random = originalRandom
    restoreLoad()
  }
})

test('global shuffle without startShuffled keeps the requested current item', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random
  Math.random = () => 0

  try {
    usePlayerStore.setState({ shuffle: true })
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0)

    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/a.flac')
    assert.deepEqual(
      new Set(resolvedUpcomingPaths()),
      new Set(['/queue/b.flac', '/queue/c.flac'])
    )
    assert.equal(usePlayerStore.getState().shuffle, true)
  } finally {
    Math.random = originalRandom
    restoreLoad()
  }
})

test('play next, add, move, and remove operate on the unified upcoming order', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()

  try {
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0)
    usePlayerStore.getState().enqueueTrack(makeTrack('/queue/end.flac'), 'end')
    usePlayerStore.getState().enqueueTrack(makeTrack('/queue/next.flac'), 'next')
    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/next.flac',
      '/queue/b.flac',
      '/queue/c.flac',
      '/queue/end.flac'
    ])

    const entries = usePlayerStore.getState().getResolvedUpcomingEntries()
    const contextEntry = entries.find((entry) => entry.track.path === '/queue/c.flac')
    const nextEntry = entries.find((entry) => entry.track.path === '/queue/next.flac')
    assert.ok(contextEntry)
    assert.ok(nextEntry)
    usePlayerStore.getState().moveUpcomingItem(contextEntry.queueId, 0)
    usePlayerStore.getState().removeUpcomingItem(nextEntry.queueId)
    assert.deepEqual(resolvedUpcomingPaths(), [
      '/queue/c.flac',
      '/queue/b.flac',
      '/queue/end.flac'
    ])
  } finally {
    restoreLoad()
  }
})

test('duplicate queue paths retain independent stable IDs', async () => {
  resetStores()
  installMockTrackFetch(() => [])

  await usePlayerStore.getState().enqueueTrackPaths(['/queue/duplicate.flac', '/queue/duplicate.flac'])
  const entries = usePlayerStore.getState().getResolvedUpcomingEntries()
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0]?.queueId, entries[1]?.queueId)

  usePlayerStore.getState().removeUpcomingItem(entries[0]!.queueId)
  assert.deepEqual(resolvedUpcomingPaths(), ['/queue/duplicate.flac'])
})

test('atomic shuffled context includes every non-current item and repeat all includes manual items', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random
  Math.random = () => 0

  try {
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 1, { shuffle: true })
    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/b.flac')
    assert.deepEqual(new Set(resolvedUpcomingPaths()), new Set(['/queue/a.flac', '/queue/c.flac']))

    usePlayerStore.getState().enqueueTrack(makeTrack('/queue/manual.flac'), 'end')
    usePlayerStore.setState({ repeat: 'all' })
    await usePlayerStore.getState().playQueuedItem(
      usePlayerStore.getState().getResolvedUpcomingEntries().find((entry) => entry.track.path === '/queue/a.flac')!.queueId
    )
    await usePlayerStore.getState().playQueuedItem(
      usePlayerStore.getState().getResolvedUpcomingEntries().find((entry) => entry.track.path === '/queue/c.flac')!.queueId
    )
    await usePlayerStore.getState().playQueuedItem(
      usePlayerStore.getState().getResolvedUpcomingEntries().find((entry) => entry.track.path === '/queue/manual.flac')!.queueId
    )
    assert.equal(resolvedUpcomingPaths().includes('/queue/manual.flac'), false)
    assert.deepEqual(
      new Set(resolvedUpcomingPaths()),
      new Set(['/queue/a.flac', '/queue/b.flac', '/queue/c.flac'])
    )
  } finally {
    Math.random = originalRandom
    restoreLoad()
  }
})

test('previous restores the former current item at the front of the actual queue', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()

  try {
    await usePlayerStore.getState().startPlaybackContext([
      makeTrack('/queue/a.flac'),
      makeTrack('/queue/b.flac'),
      makeTrack('/queue/c.flac')
    ], 0)
    await usePlayerStore.getState().playNext()
    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/b.flac')
    await usePlayerStore.getState().playPrevious()
    assert.equal(usePlayerStore.getState().currentTrack?.path, '/queue/a.flac')
    assert.equal(usePlayerStore.getState().getResolvedNextTrack()?.path, '/queue/b.flac')
  } finally {
    restoreLoad()
  }
})

test('collection queue resolution preserves album, playlist, favorite, and duplicate order', async () => {
  resetStores()
  const albumTracks = [makeDbTrack('/album/1.flac'), makeDbTrack('/album/1.flac'), makeDbTrack('/album/2.flac')]
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByAlbum: async () => albumTracks,
          getPlaylistTrackEntries: async () => [
            { track_path: '/playlist/1.flac', missing: false, track: makeDbTrack('/playlist/1.flac') },
            { track_path: '/playlist/missing.flac', missing: true, track: null },
            { track_path: '/playlist/1.flac', missing: false, track: makeDbTrack('/playlist/1.flac') }
          ]
        }
      }
    }
  })
  useLibraryStore.setState({ favoriteTrackPaths: ['/favorite/2.flac', '/favorite/1.flac'] })

  assert.deepEqual(await resolveCollectionTrackPaths({
    kind: 'album',
    album: 'Album',
    artist: 'Artist',
    identityKey: 'album:key'
  }), ['/album/1.flac', '/album/1.flac', '/album/2.flac'])
  assert.deepEqual(await resolveCollectionTrackPaths({
    kind: 'playlist',
    playlistId: 42,
    name: 'Playlist'
  }), ['/playlist/1.flac', '/playlist/1.flac'])
  assert.deepEqual(await resolveCollectionTrackPaths({
    kind: 'playlist',
    playlistId: FAVORITES_PLAYLIST_ID,
    name: 'Favorites'
  }), ['/favorite/2.flac', '/favorite/1.flac'])
})

test('session restore filters stale library queue items and advances queue ids', async () => {
  resetStores()
  const validTrack = makeTrack('/session/valid.flac', { sourceType: 'local', title: 'Valid' })
  const staleTrack = makeTrack('/session/stale.flac', { sourceType: 'local', title: 'Stale' })
  installMockTrackFetch((paths) => paths.includes(validTrack.path) ? [makeDbTrack(validTrack.path, { title: 'Valid' })] : [])

  const validEntry = createQueueEntryFromTrack(validTrack)
  const staleEntry = createQueueEntryFromTrack(staleTrack)
  const snapshot: PlayerSessionSnapshot = {
    currentTrack: validEntry.snapshot,
    currentTrackSource: 'context',
    savedPlaybackState: 'playing',
    currentTime: 42,
    duration: 120,
    queueItems: [
      {
        queueId: 'queue-9000',
        entry: validEntry,
        origin: 'context',
        sourcePlaylistId: null,
        sourceContext: { type: 'genre', genre: 'Electronic' },
        contextLabel: 'Electronic'
      },
      {
        queueId: 'queue-9001',
        entry: staleEntry,
        origin: 'manual',
        sourcePlaylistId: null,
        sourceContext: null,
        contextLabel: null
      }
    ],
    baseUpcomingQueueIds: ['queue-9000', 'queue-9001'],
    upcomingQueueIds: ['queue-9000', 'queue-9001'],
    currentQueueItemId: 'queue-9000',
    queueSourcePlaylistId: null,
    queueSourceContext: { type: 'genre', genre: 'Electronic' },
    queueContextLabel: 'Electronic',
    shuffle: true,
    repeat: 'all',
    playbackHistory: []
  }

  await usePlayerStore.getState().restoreSession(snapshot)

  assert.equal(usePlayerStore.getState().currentTrack?.path, validTrack.path)
  assert.equal(usePlayerStore.getState().playbackState, 'paused')
  assert.equal(usePlayerStore.getState().restoredTrackNeedsLoad, true)
  assert.equal(usePlayerStore.getState().currentTime, 42)
  assert.deepEqual(usePlayerStore.getState().upcomingQueueIds, ['queue-9000'])
  assert.deepEqual(usePlayerStore.getState().queueSourceContext, { type: 'genre', genre: 'Electronic' })
  assert.deepEqual(usePlayerStore.getState().queueItems[0]?.sourceContext, { type: 'genre', genre: 'Electronic' })

  usePlayerStore.getState().enqueueTrack(makeTrack('/session/manual.flac'), 'end')
  assert.equal(usePlayerStore.getState().upcomingQueueIds.at(-1), 'queue-9001')
})

test('playing a restored session lazily loads from the saved position', async () => {
  resetStores()
  const track = makeTrack('/session/resume.flac', { sourceType: 'local', title: 'Resume' })
  installMockTrackFetch(() => [makeDbTrack(track.path, { title: 'Resume' })])
  const entry = createQueueEntryFromTrack(track)
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  let capturedStartTime: number | undefined

  usePlayerStore.setState({
    _loadAndPlayTrack: async (loadedTrack, options) => {
      capturedStartTime = options?.startTime
      usePlayerStore.setState({
        currentTrack: loadedTrack,
        playbackState: 'playing',
        restoredTrackNeedsLoad: false,
        restoredPlaybackTime: null
      })
      return 'loaded'
    }
  })

  try {
    await usePlayerStore.getState().restoreSession({
      currentTrack: entry.snapshot,
      currentTrackSource: 'standalone',
      savedPlaybackState: 'playing',
      currentTime: 37,
      duration: 180,
      queueItems: [],
      baseUpcomingQueueIds: [],
      upcomingQueueIds: [],
      currentQueueItemId: null,
      queueSourcePlaylistId: null,
      queueSourceContext: null,
      queueContextLabel: null,
      shuffle: false,
      repeat: 'none',
      playbackHistory: []
    })

    await usePlayerStore.getState().play()
    assert.equal(capturedStartTime, 37)
    assert.equal(usePlayerStore.getState().restoredTrackNeedsLoad, false)
    assert.equal(usePlayerStore.getState().playbackState, 'playing')
  } finally {
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
  }
})

test('detailed listening checkpoints exclude paused time, flush boundaries, and skip associated external files', async () => {
  resetStores()
  const checkpointCalls: Array<Record<string, unknown>> = []
  const historyStatus = { generation: 'generation-a', startedAt: null }
  const windowListeners = new Map<string, EventListener>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: (event: string, listener: EventListener) => windowListeners.set(event, listener),
      removeEventListener: (event: string) => windowListeners.delete(event),
      electronAPI: {
        library: {
          getListeningHistoryStatus: async () => historyStatus,
          checkpointListeningSession: async (checkpoint: Record<string, unknown>) => {
            checkpointCalls.push(checkpoint)
            return { accepted: true, qualifiedNow: false, status: historyStatus }
          },
          markTrackLatestSyncSeen: async () => undefined
        },
        onProgressiveLoadProgress: () => () => undefined
      }
    }
  })

  let monotonicNow = 0
  let wallNow = 10_000_000
  const originalDateNow = Date.now
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  const originalPlay = audioEngine.play
  const originalStop = audioEngine.stop
  const emitAudioEvent = (event: string, ...args: unknown[]) => {
    ;(audioEngine as unknown as { emit: (name: string, ...values: unknown[]) => void }).emit(event, ...args)
  }

  Date.now = () => wallNow
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonicNow }
  })
  audioEngine.play = async () => emitAudioEvent('stateChange', 'playing')
  audioEngine.stop = () => emitAudioEvent('stateChange', 'stopped')

  const flushCheckpoints = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  try {
    usePlayerStore.getState()._initListeners()
    usePlayerStore.setState({
      currentTrack: makeTrack('/library/tracked.flac', { origin: 'library', duration: 180 }),
      playbackState: 'loading',
      duration: 180
    })
    await usePlayerStore.getState().play()

    monotonicNow = 5_000
    wallNow += 5_000
    emitAudioEvent('stateChange', 'paused')
    await flushCheckpoints()
    assert.equal(checkpointCalls.length, 1)
    assert.equal(checkpointCalls[0]?.sessionListenedSeconds, 5)
    assert.equal(checkpointCalls[0]?.finalizeSegment, true)

    monotonicNow = 25_000
    wallNow += 20_000
    emitAudioEvent('timeUpdate', 90)
    await flushCheckpoints()
    assert.equal(checkpointCalls.length, 1, 'paused wall time must not create listening time')

    emitAudioEvent('stateChange', 'playing')
    monotonicNow = 36_000
    wallNow += 11_000
    emitAudioEvent('timeUpdate', 101)
    await flushCheckpoints()
    assert.equal(checkpointCalls.length, 2)
    assert.equal(checkpointCalls[1]?.sessionListenedSeconds, 16)
    assert.equal(checkpointCalls[1]?.segmentListenedSeconds, 11)

    usePlayerStore.getState().stop()
    await flushCheckpoints()
    assert.equal(checkpointCalls.at(-1)?.finalizeSession, true)
    assert.equal(checkpointCalls.at(-1)?.completedNaturally, false)

    usePlayerStore.setState({
      currentTrack: makeTrack('/library/natural-ended.flac', { origin: 'library', duration: 5 }),
      playbackState: 'loading',
      duration: 5
    })
    await usePlayerStore.getState().play()
    monotonicNow += 4_500
    wallNow += 4_500
    emitAudioEvent('ended')
    await flushCheckpoints()
    const naturalEndedCheckpoint = checkpointCalls.find(
      (checkpoint) => checkpoint.trackPath === '/library/natural-ended.flac'
        && checkpoint.finalizeSession === true
    )
    assert.equal(naturalEndedCheckpoint?.completedNaturally, true)
    assert.equal(naturalEndedCheckpoint?.sessionListenedSeconds, 4.5)

    usePlayerStore.setState({
      currentTrack: makeTrack('/library/natural-gapless.flac', { origin: 'library', duration: 5 }),
      playbackState: 'loading',
      duration: 5,
      queueItems: [],
      baseUpcomingQueueIds: [],
      upcomingQueueIds: [],
      currentQueueItemId: null
    })
    await usePlayerStore.getState().play()
    monotonicNow += 4_500
    wallNow += 4_500
    emitAudioEvent('gaplessTransition')
    await flushCheckpoints()
    const naturalGaplessCheckpoint = checkpointCalls.find(
      (checkpoint) => checkpoint.trackPath === '/library/natural-gapless.flac'
        && checkpoint.finalizeSession === true
    )
    assert.equal(naturalGaplessCheckpoint?.completedNaturally, true)

    const manualCurrentTrack = makeTrack('/library/manual-gapless.flac', { origin: 'library', duration: 5 })
    const manualNextTrack = makeTrack('/library/manual-gapless-next.flac', { origin: 'library', duration: 5 })
    const currentItem = makeQueueItem(createQueueEntryFromTrack(manualCurrentTrack), 'manual-gapless-current')
    const nextItem = makeQueueItem(createQueueEntryFromTrack(manualNextTrack), 'manual-gapless-next')
    usePlayerStore.setState({
      currentTrack: manualCurrentTrack,
      playbackState: 'loading',
      duration: 5,
      queueItems: [],
      baseUpcomingQueueIds: [],
      upcomingQueueIds: [],
      currentQueueItemId: null
    })
    await usePlayerStore.getState().play()
    usePlayerStore.setState({
      queueItems: [currentItem, nextItem],
      baseUpcomingQueueIds: [nextItem.queueId],
      upcomingQueueIds: [nextItem.queueId],
      currentQueueItemId: currentItem.queueId
    })
    monotonicNow += 4_500
    wallNow += 4_500

    const originalSkipToPreBuffered = audioEngine.skipToPreBuffered
    const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
    Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
      configurable: true,
      get: () => manualNextTrack.path
    })
    audioEngine.skipToPreBuffered = () => {
      emitAudioEvent('gaplessTransition')
      return true
    }
    try {
      await usePlayerStore.getState().playNext()
    } finally {
      audioEngine.skipToPreBuffered = originalSkipToPreBuffered
      if (ownNextBufferedTrackPath) {
        Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
      } else {
        delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
      }
    }
    await flushCheckpoints()
    const manualGaplessCheckpoint = checkpointCalls.find(
      (checkpoint) => checkpoint.trackPath === manualCurrentTrack.path
        && checkpoint.finalizeSession === true
    )
    assert.equal(manualGaplessCheckpoint?.completedNaturally, false)

    usePlayerStore.getState().stop()
    await flushCheckpoints()
    const trackedCallCount = checkpointCalls.length
    usePlayerStore.setState({
      currentTrack: makeTrack('/external/associated.flac', { origin: 'associated-external', duration: 180 }),
      playbackState: 'loading',
      duration: 180
    })
    await usePlayerStore.getState().play()
    monotonicNow = 52_000
    wallNow += 16_000
    emitAudioEvent('timeUpdate', 16)
    usePlayerStore.getState().stop()
    await flushCheckpoints()
    assert.equal(checkpointCalls.length, trackedCallCount)
  } finally {
    usePlayerStore.getState()._cleanupListeners()
    Date.now = originalDateNow
    if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance)
    audioEngine.play = originalPlay
    audioEngine.stop = originalStop
  }
})
