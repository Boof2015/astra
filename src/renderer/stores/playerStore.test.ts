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
import { audioEngine, type StandardPcmLoadOutcome } from '../audio/AudioEngine.ts'
import { useAudioSettingsStore } from './audioSettingsStore.ts'
import { useParallaxStore } from './parallaxStore.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushAsyncWork(rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

interface MatchingPrebufferHarness {
  currentTrack: Track
  targetTrack: Track
  currentItem: QueueItem
  targetItem: QueueItem
  prebufferGate: Deferred<void>
  metrics: {
    prebufferStarted: boolean
    prebufferCompleted: boolean
    prebufferReady: boolean
    promotionCalls: number
    clearNextBufferCalls: number
    pauseCalls: number
    stopCalls: number
    seekCalls: number[]
    loadedTracks: Track[]
  }
  setPrebufferCompletionHook: (callback: (() => void) | null) => void
  restore: () => Promise<void>
}

async function installMatchingPrebufferHarness(): Promise<MatchingPrebufferHarness> {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

  const currentTrack = makeTrack('/interrupt/current.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const targetTrack = makeTrack('/interrupt/target.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'interrupt-current', 'context')
  const targetItem = makeQueueItem(createQueueEntryFromTrack(targetTrack), 'interrupt-target', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 10,
    duration: 180,
    queueItems: [currentItem, targetItem],
    baseUpcomingQueueIds: [targetItem.queueId],
    upcomingQueueIds: [targetItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async () => null,
        loadAudioFile: async () => ({ data: new ArrayBuffer(16) })
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false,
    normalizationEnabled: false
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNext = audioEngine.preBufferNext
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalSkipToPreBuffered = audioEngine.skipToPreBuffered
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalPause = audioEngine.pause
  const originalStop = audioEngine.stop
  const originalSeek = audioEngine.seek
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const prebufferGate = createDeferred<void>()
  let prebufferCompletionHook: (() => void) | null = null
  const metrics: MatchingPrebufferHarness['metrics'] = {
    prebufferStarted: false,
    prebufferCompleted: false,
    prebufferReady: false,
    promotionCalls: 0,
    clearNextBufferCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    seekCalls: [],
    loadedTracks: []
  }

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      metrics.loadedTracks.push(track)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'paused' })
      return 'loaded'
    }
  })
  audioEngine.getBufferMemoryStats = async () => ({ currentBytes: 0, nextBytes: 0, totalBytes: 0 })
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.preBufferNext = async () => {
    metrics.prebufferStarted = true
    await prebufferGate.promise
    metrics.prebufferReady = true
    metrics.prebufferCompleted = true
    prebufferCompletionHook?.()
  }
  audioEngine.clearNextBuffer = () => {
    metrics.clearNextBufferCalls += 1
    metrics.prebufferReady = false
  }
  audioEngine.skipToPreBuffered = () => {
    metrics.promotionCalls += 1
    return true
  }
  audioEngine.pause = () => {
    metrics.pauseCalls += 1
  }
  audioEngine.stop = () => {
    metrics.stopCalls += 1
    usePlayerStore.setState({ playbackState: 'stopped' })
  }
  audioEngine.seek = async (time) => {
    metrics.seekCalls.push(time)
  }
  audioEngine.cancelPendingNativeDecode = () => undefined
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => metrics.prebufferReady ? targetTrack.path : null
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 170 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })

  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  await flushAsyncWork()
  assert.equal(metrics.prebufferStarted, true)

  return {
    currentTrack,
    targetTrack,
    currentItem,
    targetItem,
    prebufferGate,
    metrics,
    setPrebufferCompletionHook: (callback) => {
      prebufferCompletionHook = callback
    },
    restore: async () => {
      prebufferGate.resolve()
      await flushAsyncWork()
      usePlayerStore.setState({
        currentTrack: null,
        playbackState: 'stopped',
        _loadAndPlayTrack: originalLoad
      })
      usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
      audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
      audioEngine.preBufferNext = originalPreBufferNext
      audioEngine.clearNextBuffer = originalClearNextBuffer
      audioEngine.skipToPreBuffered = originalSkipToPreBuffered
      audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
      audioEngine.pause = originalPause
      audioEngine.stop = originalStop
      audioEngine.seek = originalSeek
      audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
      if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
      else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
      if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
      else delete (audioEngine as unknown as Record<string, unknown>).currentTime
      if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
      else delete (audioEngine as unknown as Record<string, unknown>).duration
      useAudioSettingsStore.setState({
        playbackOutputMode: originalSettings.playbackOutputMode,
        disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev,
        normalizationEnabled: originalSettings.normalizationEnabled
      })
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  }
}

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
      location: { search: '?window=test' },
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

interface StandardPcmRouteMetrics {
  pcmCalls: Array<{ path: string; priority: string | undefined }>
  fileReadCalls: number
  chromiumDecodeCalls: number
  compatibilityFallbackCalls: number
  backendPlayCalls: number
}

async function exerciseStandardPcmRoute(
  pcmOutcome: StandardPcmLoadOutcome
): Promise<{ loadOutcome: 'loaded' | 'failed' | 'superseded'; metrics: StandardPcmRouteMetrics }> {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const track = makeTrack(`/pcm-route/${pcmOutcome}.flac`, {
    sourceType: 'local',
    duration: 180,
    sampleRate: 44_100,
    channels: 2
  })
  const metrics: StandardPcmRouteMetrics = {
    pcmCalls: [],
    fileReadCalls: 0,
    chromiumDecodeCalls: 0,
    compatibilityFallbackCalls: 0,
    backendPlayCalls: 0
  }

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        onProgressiveLoadProgress: () => () => undefined,
        supersedeTrackLoudness: async () => undefined,
        getAudioFileStat: async () => null,
        // Presence of the bridge opts an eligible local track into the native
        // PCM route. The AudioEngine method itself is stubbed below.
        decodeLocalAudioToPcm: async () => null,
        cancelLocalAudioDecode: async () => undefined,
        loadAudioFile: async () => {
          metrics.fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        },
        decodeAudioWithFfmpeg: async () => {
          metrics.compatibilityFallbackCalls += 1
          return null
        },
        library: {
          getListeningHistoryStatus: async () => ({
            generation: `pcm-route-${pcmOutcome}`,
            startedAt: null
          }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: `pcm-route-${pcmOutcome}`, startedAt: null }
          }),
          markTrackLatestSyncSeen: async () => undefined
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    normalizationEnabled: false,
    disableGaplessPrebufferDev: false
  })
  const originalOn = audioEngine.on
  const originalLoadStandardTrackFromPath = audioEngine.loadStandardTrackFromPath
  const originalLoadAudioData = audioEngine.loadAudioData
  const originalPlay = audioEngine.play
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalGetCurrentTrackChannelCount = audioEngine.getCurrentTrackChannelCount
  const originalGetLastLoadTimings = audioEngine.getLastLoadTimings
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const originalParallax = useParallaxStore.getState()
  const stateChangeListeners: Array<(state: string) => void> = []

  audioEngine.on = (event, callback) => {
    if (event === 'stateChange') stateChangeListeners.push(callback)
    return () => undefined
  }
  audioEngine.loadStandardTrackFromPath = async (candidate, options) => {
    metrics.pcmCalls.push({ path: candidate.path, priority: options?.priority })
    if (pcmOutcome === 'loaded') {
      stateChangeListeners.forEach((listener) => listener('stopped'))
    }
    return pcmOutcome
  }
  audioEngine.loadAudioData = async () => {
    metrics.chromiumDecodeCalls += 1
    stateChangeListeners.forEach((listener) => listener('stopped'))
  }
  audioEngine.play = async () => {
    metrics.backendPlayCalls += 1
    stateChangeListeners.forEach((listener) => listener('playing'))
  }
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.getCurrentTrackChannelCount = () => 2
  audioEngine.getLastLoadTimings = () => ({
    decodeMs: pcmOutcome === 'loaded' ? 24 : 12,
    analysisMs: 0,
    ...(pcmOutcome === 'loaded' ? { nativeDecodeMs: 18 } : {})
  })
  audioEngine.getPlaybackOutputMode = () => 'standard'
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 0 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => null
  })

  try {
    usePlayerStore.getState()._cleanupListeners()
    const loadOutcome = await usePlayerStore.getState()._loadAndPlayTrack(track)
    await flushAsyncWork()
    return { loadOutcome, metrics }
  } finally {
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    await flushAsyncWork()
    audioEngine.on = originalOn
    audioEngine.loadStandardTrackFromPath = originalLoadStandardTrackFromPath
    audioEngine.loadAudioData = originalLoadAudioData
    audioEngine.play = originalPlay
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    audioEngine.getCurrentTrackChannelCount = originalGetCurrentTrackChannelCount
    audioEngine.getLastLoadTimings = originalGetLastLoadTimings
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      normalizationEnabled: originalSettings.normalizationEnabled,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
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

test('queue length stays constant-time for a large queue without resolving tracks', () => {
  resetStores()

  const originalResolveTrackPaths = useLibraryStore.getState().resolveTrackPaths
  let resolvedPathCount = 0
  useLibraryStore.setState({
    resolveTrackPaths: (trackPaths) => {
      resolvedPathCount += trackPaths.length
      return originalResolveTrackPaths(trackPaths)
    }
  })

  try {
    const entry = createQueueEntryFromTrack(makeTrack('/queue/shared.flac'))
    const queueItems = Array.from(
      { length: 21_500 },
      (_, index) => makeQueueItem(entry, `large-queue-${index}`, 'context')
    )
    const upcomingQueueIds = queueItems.map((item) => item.queueId)

    usePlayerStore.setState({
      currentTrack: makeTrack('/queue/current.flac'),
      queueItems,
      baseUpcomingQueueIds: upcomingQueueIds,
      upcomingQueueIds,
      playbackHistory: [{ item: makeQueueItem(entry, 'large-history', 'context') }]
    })

    assert.equal(usePlayerStore.getState().getResolvedQueueLength(), 21_502)
    assert.equal(resolvedPathCount, 0)
  } finally {
    useLibraryStore.setState({ resolveTrackPaths: originalResolveTrackPaths })
    resetStores()
  }
})

test('next-track lookup resolves only the first playable entry in a large queue', () => {
  resetStores()

  const queueItems = Array.from({ length: 21_500 }, (_, index) => {
    const entry = createQueueEntryFromTrack(makeTrack(`/queue/${index}.flac`))
    return makeQueueItem(entry, `lazy-next-${index}`, 'context')
  })
  const upcomingQueueIds = queueItems.map((item) => item.queueId)
  usePlayerStore.setState({
    queueItems,
    baseUpcomingQueueIds: upcomingQueueIds,
    upcomingQueueIds
  })

  const originalResolveTrackPaths = useLibraryStore.getState().resolveTrackPaths
  let resolvedPathCount = 0
  useLibraryStore.setState({
    resolveTrackPaths: (trackPaths) => {
      resolvedPathCount += trackPaths.length
      return originalResolveTrackPaths(trackPaths)
    }
  })

  try {
    assert.equal(usePlayerStore.getState().getResolvedNextTrack()?.path, '/queue/0.flac')
    assert.equal(resolvedPathCount, 1)
  } finally {
    useLibraryStore.setState({ resolveTrackPaths: originalResolveTrackPaths })
    resetStores()
  }
})

test('bounded upcoming resolution stops at the requested cap and preserves entry order and shape', () => {
  resetStores()

  const queueItems = Array.from({ length: 250 }, (_, index) => {
    const entry = createQueueEntryFromTrack(makeTrack(`/queue/${index}.flac`, {
      title: `Track ${index}`
    }))
    return makeQueueItem(entry, `bounded-queue-${index}`, index % 2 === 0 ? 'context' : 'manual')
  })
  const orderedItems = [...queueItems].reverse()
  const upcomingQueueIds = orderedItems.map((item) => item.queueId)
  usePlayerStore.setState({
    queueItems,
    baseUpcomingQueueIds: upcomingQueueIds,
    upcomingQueueIds
  })

  const originalResolveTrackPaths = useLibraryStore.getState().resolveTrackPaths
  let resolvedPathCount = 0
  useLibraryStore.setState({
    resolveTrackPaths: (trackPaths) => {
      resolvedPathCount += trackPaths.length
      return originalResolveTrackPaths(trackPaths)
    }
  })

  try {
    assert.deepEqual(usePlayerStore.getState().getResolvedUpcomingEntries(0), [])
    assert.equal(resolvedPathCount, 0)

    const boundedEntries = usePlayerStore.getState().getResolvedUpcomingEntries(200)
    assert.equal(resolvedPathCount, 200)
    assert.deepEqual(
      boundedEntries.map((entry) => ({
        queueId: entry.queueId,
        source: entry.source,
        origin: entry.origin,
        path: entry.track.path,
        title: entry.track.title,
        index: entry.index
      })),
      orderedItems.slice(0, 200).map((item, index) => ({
        queueId: item.queueId,
        source: 'upcoming',
        origin: item.origin,
        path: item.entry.path,
        title: item.entry.snapshot.title,
        index
      }))
    )

    resolvedPathCount = 0
    const allEntries = usePlayerStore.getState().getResolvedUpcomingEntries()
    assert.equal(resolvedPathCount, 250)
    assert.deepEqual(allEntries.map((entry) => entry.queueId), upcomingQueueIds)
  } finally {
    useLibraryStore.setState({ resolveTrackPaths: originalResolveTrackPaths })
    resetStores()
  }
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

test('path context playback fetches only the selected track before preserving the full queue', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const originalRandom = Math.random
  const selectedPath = '/context/selected.flac'
  const contextPaths = [
    '/context/duplicate.flac',
    selectedPath,
    '/context/next.flac',
    '/context/duplicate.flac'
  ]
  const selectedFetch = createDeferred<DbTrack[]>()
  const backgroundFetch = createDeferred<DbTrack[]>()
  const fetchCalls: string[][] = []

  installMockTrackFetch((trackPaths) => {
    fetchCalls.push([...trackPaths])
    return fetchCalls.length === 1 ? selectedFetch.promise : backgroundFetch.promise
  })
  Math.random = () => 0
  usePlayerStore.getState().enqueueTrack(makeTrack('/context/manual.flac'), 'end')

  try {
    const start = usePlayerStore.getState().startPlaybackContextByPaths(
      contextPaths,
      1,
      { shuffle: true }
    )

    await flushAsyncWork(1)
    assert.deepEqual(fetchCalls[0], [selectedPath], 'the first metadata request must contain only the selected track')

    selectedFetch.resolve([makeDbTrack(selectedPath, { title: 'Selected Metadata' })])
    await start
    await flushAsyncWork(1)

    const state = usePlayerStore.getState()
    assert.equal(state.currentTrack?.path, selectedPath)
    assert.equal(state.currentTrack?.title, 'Selected Metadata')
    assert.equal(state.shuffle, true)
    assert.equal(state.queueItems.length, contextPaths.length + 1)
    assert.equal(state.queueItems.filter((item) => item.origin === 'manual').length, 1)

    const duplicateItems = state.queueItems.filter((item) => item.entry.path === '/context/duplicate.flac')
    assert.equal(duplicateItems.length, 2)
    assert.notEqual(duplicateItems[0]?.queueId, duplicateItems[1]?.queueId)
    assert.deepEqual(
      new Set(state.getResolvedUpcomingEntries().map((entry) => entry.track.path)),
      new Set(['/context/duplicate.flac', '/context/next.flac', '/context/manual.flac'])
    )
  } finally {
    selectedFetch.resolve([])
    backgroundFetch.resolve([])
    await flushAsyncWork()
    Math.random = originalRandom
    restoreLoad()
    resetStores()
  }
})

test('path context metadata hydration uses bounded idle batches after the next entry', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const contextPaths = Array.from({ length: 452 }, (_, index) => `/idle-context/${index}.flac`)
  const selectedTrack = makeDbTrack(contextPaths[0]!, { title: 'Cached Current' })
  useLibraryStore.setState({ trackByPath: new Map([[selectedTrack.path, selectedTrack]]) })

  const fetchCalls: string[][] = []
  installMockTrackFetch((trackPaths) => {
    fetchCalls.push([...trackPaths])
    return trackPaths.map((trackPath) => makeDbTrack(trackPath, { title: `Hydrated ${trackPath}` }))
  })

  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const idleCallbacks = new Map<number, IdleRequestCallback>()
  let nextIdleId = 0
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback: IdleRequestCallback) => {
      const id = ++nextIdleId
      idleCallbacks.set(id, callback)
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })

  const runNextIdleCallback = (): boolean => {
    const next = idleCallbacks.entries().next().value as [number, IdleRequestCallback] | undefined
    if (!next) return false
    idleCallbacks.delete(next[0])
    next[1]({ didTimeout: false, timeRemaining: () => 50 })
    return true
  }

  try {
    await usePlayerStore.getState().startPlaybackContextByPaths(contextPaths, 0)
    await flushAsyncWork()

    assert.deepEqual(fetchCalls[0], [contextPaths[1]], 'the immediately upcoming entry hydrates outside idle work')

    for (let batch = 0; batch < 10 && runNextIdleCallback(); batch += 1) {
      await flushAsyncWork()
    }

    const idleFetchCalls = fetchCalls.slice(1)
    assert.ok(idleFetchCalls.length >= 3)
    assert.equal(idleFetchCalls.every((paths) => paths.length <= 200), true)
    assert.deepEqual(idleFetchCalls.flat(), contextPaths.slice(2))
  } finally {
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    restoreLoad()
    resetStores()
  }
})

test('immediate Next, Previous, Pause, and Stop keep unresolved context idle hydration alive', async () => {
  resetStores()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPause = audioEngine.pause
  const originalStop = audioEngine.stop
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalSettings = useAudioSettingsStore.getState()
  const idleCallbacks = new Map<number, IdleRequestCallback>()
  let nextIdleId = 0
  let loadedTracks: Track[] = []

  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback: IdleRequestCallback) => {
      const id = ++nextIdleId
      idleCallbacks.set(id, callback)
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  audioEngine.getPlaybackOutputMode = () => 'standard'
  audioEngine.pause = () => undefined
  audioEngine.stop = () => undefined
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.cancelPendingNativeDecode = () => undefined
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTracks.push(track)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'paused' })
      return 'loaded'
    }
  })

  const runNextIdleCallback = (): boolean => {
    const next = idleCallbacks.entries().next().value as [number, IdleRequestCallback] | undefined
    if (!next) return false
    idleCallbacks.delete(next[0])
    next[1]({ didTimeout: false, timeRemaining: () => 50 })
    return true
  }

  try {
    for (const action of ['Next', 'NextPrevious', 'Pause', 'Stop'] as const) {
      resetStores()
      idleCallbacks.clear()
      loadedTracks = []
      const actionPathSegment = action.replace(/[A-Z]/g, (letter, offset) => (
        offset === 0 ? letter.toLowerCase() : `-${letter.toLowerCase()}`
      ))
      const contextPaths = Array.from(
        { length: 405 },
        (_, index) => `/superseded-idle/${actionPathSegment}/${index}.flac`
      )
      const selectedPath = contextPaths[0]!
      const nextPath = contextPaths[1]!
      const remainingPaths = contextPaths.slice(2)
      const remainingPathSet = new Set(remainingPaths)
      const selectedFetch = createDeferred<DbTrack[]>()
      const selectedMetadata = makeDbTrack(selectedPath, {
        title: `Hydrated ${action} selected`,
        source_type: 'subsonic',
        source_id: 17,
        source_track_id: `${actionPathSegment}-selected`,
        source_path: selectedPath
      })
      const fetchCalls: string[][] = []

      installMockTrackFetch((trackPaths) => {
        fetchCalls.push([...trackPaths])
        if (trackPaths.length === 1 && trackPaths[0] === selectedPath) {
          return selectedFetch.promise
        }
        return trackPaths.map((trackPath) => makeDbTrack(trackPath, {
          title: `Hydrated ${action} ${trackPath}`
        }))
      })

      let contextStart: Promise<void> | null = null
      let supersedingAction: Promise<void> = Promise.resolve()
      let selectedResolved = false
      try {
        contextStart = usePlayerStore.getState().startPlaybackContextByPaths(contextPaths, 0)
        assert.equal(
          usePlayerStore.getState().currentTrack,
          null,
          `${action} must supersede a genuinely cold context before its selected metadata resolves`
        )

        if (action === 'Next' || action === 'NextPrevious') {
          const nextAction = usePlayerStore.getState().playNext()
          const selectedHistoryItem = usePlayerStore.getState().playbackHistory
            .find((entry) => entry.item.entry.path === selectedPath)
          assert.ok(selectedHistoryItem, 'cold selected context item must be preserved immediately')
          if (action === 'NextPrevious') {
            const previousAction = usePlayerStore.getState().playPrevious()
            supersedingAction = Promise.all([nextAction, previousAction]).then(() => undefined)
            const previousState = usePlayerStore.getState()
            assert.equal(previousState.currentQueueItemId, selectedHistoryItem.item.queueId)
            assert.equal(previousState.getResolvedNextTrack()?.path, nextPath, 'B should return to upcoming')
          } else {
            supersedingAction = nextAction
          }
        } else if (action === 'Pause') {
          usePlayerStore.getState().pause()
        } else {
          usePlayerStore.getState().stop()
        }

        assert.equal(
          idleCallbacks.size,
          1,
          `${action} must not strand the already-committed context's remaining hydration work`
        )
        await flushAsyncWork()
        assert.ok(fetchCalls.some((paths) => paths.length === 1 && paths[0] === selectedPath))
        assert.ok(fetchCalls.some((paths) => paths.length === 1 && paths[0] === nextPath))

        for (let batch = 0; batch < 10 && runNextIdleCallback(); batch += 1) {
          await flushAsyncWork()
        }

        const idleFetchCalls = fetchCalls.filter((paths) => paths.some((path) => remainingPathSet.has(path)))
        assert.ok(idleFetchCalls.length >= 3, `${action} should retain multiple idle hydration batches`)
        assert.equal(idleFetchCalls.every((paths) => paths.length <= 200), true)
        assert.deepEqual(idleFetchCalls.flat(), remainingPaths)
        assert.equal(idleCallbacks.size, 0)

        const hydratedItems = new Map(
          usePlayerStore.getState().queueItems.map((item) => [item.entry.path, item])
        )
        assert.equal(remainingPaths.every((path) => (
          hydratedItems.get(path)?.entry.snapshot.title === `Hydrated ${action} ${path}`
        )), true, `${action} should eventually patch every remaining context item`)

        selectedFetch.resolve([selectedMetadata])
        selectedResolved = true
        await Promise.all([contextStart, supersedingAction])

        if (action === 'Next') {
          const selectedHistoryItem = usePlayerStore.getState().playbackHistory
            .find((entry) => entry.item.entry.path === selectedPath)
          assert.ok(selectedHistoryItem, 'cold selected context item must be preserved in playback history')
          assert.equal(selectedHistoryItem.item.entry.snapshot.title, `Hydrated ${action} selected`)
          assert.equal(selectedHistoryItem.item.entry.snapshot.sourceType, 'subsonic')

          await usePlayerStore.getState().playPrevious()
          assert.equal(loadedTracks.at(-1)?.path, selectedPath)
          assert.equal(loadedTracks.at(-1)?.sourceType, 'subsonic', 'Previous must retain remote classification')
        } else if (action === 'NextPrevious') {
          assert.equal(loadedTracks.length, 1, 'superseded B must never load before Previous returns to A')
          assert.equal(loadedTracks[0]?.path, selectedPath)
          assert.equal(loadedTracks[0]?.title, `Hydrated ${action} selected`)
          assert.equal(loadedTracks[0]?.sourceType, 'subsonic')
          assert.equal(usePlayerStore.getState().getResolvedNextTrack()?.path, nextPath)
        }
      } finally {
        if (!selectedResolved) selectedFetch.resolve([selectedMetadata])
        await Promise.allSettled([contextStart, supersedingAction].filter(
          (pending): pending is Promise<void> => pending !== null
        ))
      }
    }
  } finally {
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.pause = originalPause
    audioEngine.stop = originalStop
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('stale path hydration cannot patch a newer playback context', async () => {
  resetStores()
  const restoreLoad = installLoadedTrackStub()
  const sharedPath = '/stale-context/shared.flac'
  const firstCurrent = makeDbTrack('/stale-context/first.flac', { title: 'First Current' })
  const secondCurrent = makeDbTrack('/stale-context/second.flac', { title: 'Second Current' })
  useLibraryStore.setState({
    trackByPath: new Map([
      [firstCurrent.path, firstCurrent],
      [secondCurrent.path, secondCurrent]
    ])
  })

  const staleHydration = createDeferred<DbTrack[]>()
  const freshHydration = createDeferred<DbTrack[]>()
  let sharedFetchCount = 0
  installMockTrackFetch((trackPaths) => {
    assert.deepEqual(trackPaths, [sharedPath])
    sharedFetchCount += 1
    return sharedFetchCount === 1 ? staleHydration.promise : freshHydration.promise
  })

  try {
    await usePlayerStore.getState().startPlaybackContextByPaths([firstCurrent.path, sharedPath], 0)
    await flushAsyncWork()
    assert.equal(sharedFetchCount, 1)

    await usePlayerStore.getState().startPlaybackContextByPaths([secondCurrent.path, sharedPath], 0)
    await flushAsyncWork()
    assert.equal(sharedFetchCount, 2)

    staleHydration.resolve([makeDbTrack(sharedPath, { title: 'Stale Metadata' })])
    await flushAsyncWork()
    const sharedEntryBeforeFreshHydration = usePlayerStore.getState().queueItems
      .find((item) => item.entry.path === sharedPath)
    assert.equal(sharedEntryBeforeFreshHydration?.entry.snapshot.title, 'shared')

    freshHydration.resolve([makeDbTrack(sharedPath, { title: 'Fresh Metadata' })])
    await flushAsyncWork()
    const sharedEntryAfterFreshHydration = usePlayerStore.getState().queueItems
      .find((item) => item.entry.path === sharedPath)
    assert.equal(sharedEntryAfterFreshHydration?.entry.snapshot.title, 'Fresh Metadata')
  } finally {
    staleHydration.resolve([])
    freshHydration.resolve([])
    await flushAsyncWork()
    restoreLoad()
    resetStores()
  }
})

test('late replaced-context hydration patches only its preserved history item', async () => {
  resetStores()
  const firstPath = '/replaced-context/a.flac'
  const replacementPath = '/replaced-context/c.flac'
  const replacementTrack = makeDbTrack(replacementPath, {
    title: 'Authoritative C',
    source_type: 'local'
  })
  useLibraryStore.setState({ trackByPath: new Map([[replacementPath, replacementTrack]]) })

  const firstHydration = createDeferred<DbTrack[]>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            assert.deepEqual(trackPaths, [firstPath])
            return firstHydration.promise
          }
        }
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const loadedTracks: Track[] = []
  let firstContext: Promise<void> | null = null

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTracks.push(track)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    }
  })
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'standard'

  const hydratedFirst = makeDbTrack(firstPath, {
    title: 'Authoritative Remote A',
    source_type: 'subsonic',
    source_id: 31,
    source_track_id: 'remote-a',
    source_path: firstPath
  })

  try {
    firstContext = usePlayerStore.getState().startPlaybackContextByPaths([firstPath], 0)
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentTrack, null)

    await usePlayerStore.getState().startPlaybackContextByPaths([replacementPath], 0)
    await flushAsyncWork()
    const replacedState = usePlayerStore.getState()
    assert.equal(replacedState.currentTrack?.path, replacementPath)
    assert.equal(replacedState.playbackHistory.length, 1)
    assert.equal(replacedState.playbackHistory[0]?.item.entry.path, firstPath)
    assert.equal(replacedState.playbackHistory[0]?.item.entry.snapshot.sourceType, undefined)

    firstHydration.resolve([hydratedFirst])
    await firstContext
    await flushAsyncWork()

    const hydratedState = usePlayerStore.getState()
    const historyItem = hydratedState.playbackHistory[0]?.item
    assert.equal(historyItem?.entry.path, firstPath)
    assert.equal(historyItem?.entry.snapshot.title, 'Authoritative Remote A')
    assert.equal(historyItem?.entry.snapshot.sourceType, 'subsonic')
    const liveReplacement = hydratedState.queueItems.find((item) => item.entry.path === replacementPath)
    assert.equal(liveReplacement?.entry.snapshot.title, 'Authoritative C')
    assert.equal(liveReplacement?.entry.snapshot.sourceType, 'local')
    assert.deepEqual(loadedTracks.map((track) => track.path), [replacementPath])

    await usePlayerStore.getState().playPrevious()
    assert.deepEqual(loadedTracks.map((track) => track.path), [replacementPath, firstPath])
    assert.equal(loadedTracks[1]?.title, 'Authoritative Remote A')
    assert.equal(loadedTracks[1]?.sourceType, 'subsonic')
    assert.equal(usePlayerStore.getState().getResolvedNextTrack()?.path, replacementPath)
  } finally {
    firstHydration.resolve([hydratedFirst])
    if (firstContext) await Promise.allSettled([firstContext])
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Previous reuses deferred metadata for a replaced uncached context item', async () => {
  resetStores()
  const firstPath = '/replaced-context-reuse/uncached.flac'
  const replacementPath = '/replaced-context-reuse/cached.flac'
  const replacementTrack = makeDbTrack(replacementPath, {
    title: 'Cached Replacement',
    source_type: 'local'
  })
  useLibraryStore.setState({ trackByPath: new Map([[replacementPath, replacementTrack]]) })

  const firstHydration = createDeferred<DbTrack[]>()
  const fetchCalls: string[][] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  installMockTrackFetch((trackPaths) => {
    fetchCalls.push([...trackPaths])
    assert.deepEqual(trackPaths, [firstPath])
    return firstHydration.promise
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalSupersedeCurrentLoadPreservingPrebuffer = audioEngine.supersedeCurrentLoadPreservingPrebuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const loadedTracks: Track[] = []
  let firstContext: Promise<void> | null = null
  let previous: Promise<void> | null = null
  let previousSettled = false

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTracks.push(track)
      usePlayerStore.setState({
        currentTrack: track,
        playbackState: 'playing',
        currentTime: 0,
        duration: track.duration
      })
      return 'loaded'
    }
  })
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.supersedeCurrentLoadPreservingPrebuffer = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'standard'
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 0 })

  const hydratedFirst = makeDbTrack(firstPath, {
    title: 'Authoritative Remote First',
    source_type: 'subsonic',
    source_id: 42,
    source_track_id: 'replaced-context-reuse-first',
    source_path: firstPath
  })

  try {
    firstContext = usePlayerStore.getState().startPlaybackContextByPaths([firstPath], 0)
    await flushAsyncWork()
    assert.deepEqual(fetchCalls, [[firstPath]])

    await usePlayerStore.getState().startPlaybackContextByPaths([replacementPath], 0)
    assert.deepEqual(loadedTracks.map((track) => track.path), [replacementPath])
    assert.equal(usePlayerStore.getState().playbackHistory[0]?.item.entry.path, firstPath)

    previous = usePlayerStore.getState().playPrevious().then(() => {
      previousSettled = true
    })
    await flushAsyncWork()
    assert.equal(previousSettled, false, 'Previous must wait for the existing authoritative metadata request')
    assert.deepEqual(
      loadedTracks.map((track) => track.path),
      [replacementPath],
      'the fallback path must not be cold-loaded while metadata is already in flight'
    )

    firstHydration.resolve([hydratedFirst])
    await Promise.all([firstContext, previous])
    assert.deepEqual(loadedTracks.map((track) => track.path), [replacementPath, firstPath])
    assert.equal(loadedTracks[1]?.title, 'Authoritative Remote First')
    assert.equal(loadedTracks[1]?.sourceType, 'subsonic')
  } finally {
    firstHydration.resolve([hydratedFirst])
    await Promise.allSettled([firstContext, previous].filter(
      (pending): pending is Promise<void> => pending !== null
    ))
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.supersedeCurrentLoadPreservingPrebuffer = originalSupersedeCurrentLoadPreservingPrebuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Stop supersedes a selected-track fetch before the old context can load', async () => {
  resetStores()
  const selectedPath = '/superseded-context/selected.flac'
  const selectedFetch = createDeferred<DbTrack[]>()
  const requestedPaths: string[][] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            requestedPaths.push([...trackPaths])
            return selectedFetch.promise
          }
        }
      }
    }
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalStop = audioEngine.stop
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const loadedPaths: string[] = []
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedPaths.push(track.path)
      return 'loaded'
    }
  })
  audioEngine.stop = () => undefined
  audioEngine.cancelPendingNativeDecode = () => undefined

  try {
    const contextStart = usePlayerStore.getState().startPlaybackContextByPaths([selectedPath], 0)
    await flushAsyncWork(1)
    assert.deepEqual(requestedPaths, [[selectedPath]])

    usePlayerStore.getState().stop()
    selectedFetch.resolve([makeDbTrack(selectedPath, { title: 'Too Late' })])
    await contextStart

    assert.deepEqual(loadedPaths, [], 'a stopped context must not begin loading after metadata returns')
    assert.equal(usePlayerStore.getState().playbackState, 'stopped')
  } finally {
    selectedFetch.resolve([])
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.stop = originalStop
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Pause supersedes deferred hydration for a duplicate-path context target with a new queue ID', async () => {
  resetStores()
  const sharedPath = '/duplicate-context/same.flac'
  const oldTrack = makeTrack(sharedPath, { title: 'Already Playing', sourceType: 'local' })
  const oldItem = makeQueueItem(createQueueEntryFromTrack(oldTrack), 'duplicate-context-old', 'context')
  usePlayerStore.setState({
    currentTrack: oldTrack,
    playbackState: 'playing',
    currentTime: 24,
    duration: oldTrack.duration,
    queueItems: [oldItem],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: oldItem.queueId,
    playbackHistory: []
  })

  const hydration = createDeferred<DbTrack[]>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            assert.deepEqual(trackPaths, [sharedPath])
            return hydration.promise
          }
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPause = audioEngine.pause
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalSupersedeCurrentLoadPreservingPrebuffer = audioEngine.supersedeCurrentLoadPreservingPrebuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const loadedTracks: Track[] = []
  let pauseCalls = 0
  let contextStart: Promise<void> | null = null

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTracks.push(track)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    }
  })
  audioEngine.pause = () => {
    pauseCalls += 1
    usePlayerStore.setState({ playbackState: 'paused' })
  }
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.supersedeCurrentLoadPreservingPrebuffer = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'standard'

  const hydratedTrack = makeDbTrack(sharedPath, {
    title: 'Hydrated Duplicate Target',
    source_type: 'local'
  })

  try {
    contextStart = usePlayerStore.getState().startPlaybackContextByPaths([sharedPath], 0)
    await flushAsyncWork(1)

    const committedState = usePlayerStore.getState()
    assert.notEqual(committedState.currentQueueItemId, oldItem.queueId)
    assert.equal(committedState.currentTrack?.path, sharedPath)
    assert.deepEqual(
      committedState.playbackHistory.map((entry) => entry.item.queueId),
      [oldItem.queueId]
    )

    usePlayerStore.getState().pause()
    assert.equal(pauseCalls, 1)
    assert.equal(usePlayerStore.getState().playbackState, 'paused')

    hydration.resolve([hydratedTrack])
    await contextStart
    await flushAsyncWork()

    const pausedState = usePlayerStore.getState()
    assert.deepEqual(loadedTracks, [], 'hydration must not start playback after Pause supersedes the context intent')
    assert.equal(pausedState.currentQueueItemId, committedState.currentQueueItemId)
    assert.equal(pausedState.currentTrack?.path, sharedPath)
    assert.equal(pausedState.currentTrack?.title, 'Hydrated Duplicate Target')
    assert.equal(pausedState.playbackState, 'paused')
    assert.equal(pausedState.restoredTrackNeedsLoad, true)
  } finally {
    hydration.resolve([hydratedTrack])
    if (contextStart) await Promise.allSettled([contextStart])
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.pause = originalPause
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.supersedeCurrentLoadPreservingPrebuffer = originalSupersedeCurrentLoadPreservingPrebuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a superseded remote load does not mark its track unavailable', async () => {
  resetStores()
  const remoteTrack = makeTrack('/superseded-remote/track.flac', {
    sourceType: 'subsonic',
    sourceId: 7,
    sourceTrackId: 'superseded-remote-track',
    isAvailable: true
  })
  const remoteItem = makeQueueItem(createQueueEntryFromTrack(remoteTrack), 'superseded-remote-item', 'context')
  usePlayerStore.setState({
    currentTrack: remoteTrack,
    playbackState: 'stopped',
    queueItems: [remoteItem],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: remoteItem.queueId
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        onProgressiveLoadProgress: () => () => undefined,
        supersedeTrackLoudness: async () => undefined,
        library: {
          getListeningHistoryStatus: async () => ({
            generation: 'superseded-remote',
            startedAt: null
          }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'superseded-remote', startedAt: null }
          })
        }
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const originalOn = audioEngine.on
  const originalLoadRemoteStream = audioEngine.loadRemoteStream
  const originalStop = audioEngine.stop
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const remoteGate = createDeferred<Awaited<ReturnType<typeof audioEngine.loadRemoteStream>>>()
  let remoteLoadStarted = false

  audioEngine.on = () => () => undefined
  audioEngine.loadRemoteStream = async () => {
    remoteLoadStarted = true
    return remoteGate.promise
  }
  audioEngine.stop = () => undefined
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'standard'

  try {
    usePlayerStore.getState()._cleanupListeners()
    const load = usePlayerStore.getState()._loadAndPlayTrack(remoteTrack)
    await flushAsyncWork()
    assert.equal(remoteLoadStarted, true)

    usePlayerStore.getState().stop()
    remoteGate.reject(new Error('obsolete remote request failed after supersession'))
    assert.equal(await load, 'superseded')

    const retainedItem = usePlayerStore.getState().queueItems.find((item) => item.queueId === remoteItem.queueId)
    assert.equal(retainedItem?.entry.snapshot.isAvailable, true)
    assert.equal(retainedItem?.entry.snapshot.availabilityReason, undefined)
    assert.equal(usePlayerStore.getState().currentTrack?.isAvailable, true)
  } finally {
    remoteGate.reject(new Error('test cleanup'))
    await flushAsyncWork()
    usePlayerStore.getState()._cleanupListeners()
    audioEngine.on = originalOn
    audioEngine.loadRemoteStream = originalLoadRemoteStream
    audioEngine.stop = originalStop
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('an uncached path-only remote Next waits for metadata without local prebuffering', async () => {
  resetStores()
  const currentPath = '/path-only/current.flac'
  const remotePath = '/path-only/remote.flac'
  const currentDbTrack = makeDbTrack(currentPath, { title: 'Current Local', source_type: 'local' })
  useLibraryStore.setState({ trackByPath: new Map([[currentPath, currentDbTrack]]) })

  const remoteHydration = createDeferred<DbTrack[]>()
  const requestedPaths: string[][] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            requestedPaths.push([...trackPaths])
            return remoteHydration.promise
          }
        }
      }
    }
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPrebuffer = usePlayerStore.getState()._preBufferNextTrack
  const loadedTracks: Track[] = []
  let localPrebufferCalls = 0
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTracks.push(track)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    },
    _preBufferNextTrack: async () => {
      localPrebufferCalls += 1
    }
  })

  try {
    await usePlayerStore.getState().startPlaybackContextByPaths([currentPath, remotePath], 0)
    await flushAsyncWork()
    assert.deepEqual(requestedPaths, [[remotePath]])
    assert.equal(loadedTracks.length, 1)
    assert.equal(loadedTracks[0]?.path, currentPath)

    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.equal(localPrebufferCalls, 0, 'unknown path-only metadata must not be assumed local')

    const targetQueueId = usePlayerStore.getState().upcomingQueueIds[0]
    assert.ok(targetQueueId)
    let nextFinished = false
    const next = usePlayerStore.getState().playNext().then(() => {
      nextFinished = true
    })
    await flushAsyncWork()

    assert.equal(usePlayerStore.getState().currentQueueItemId, targetQueueId, 'the queue transition commits immediately')
    assert.equal(nextFinished, false, 'Next must await the in-progress metadata request')
    assert.equal(loadedTracks.length, 1)
    usePlayerStore.getState()._schedulePreBufferNextTrack()
    assert.equal(localPrebufferCalls, 0)

    remoteHydration.resolve([makeDbTrack(remotePath, {
      title: 'Hydrated Remote',
      source_type: 'subsonic',
      source_id: 7,
      source_track_id: 'remote-42'
    })])
    await next

    assert.equal(nextFinished, true)
    assert.equal(loadedTracks.length, 2)
    assert.equal(loadedTracks[1]?.path, remotePath)
    assert.equal(loadedTracks[1]?.title, 'Hydrated Remote')
    assert.equal(loadedTracks[1]?.sourceType, 'subsonic')
    assert.equal(localPrebufferCalls, 0, 'hydrated remote tracks must remain excluded from local prebuffering')
  } finally {
    remoteHydration.resolve([])
    await flushAsyncWork()
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      _loadAndPlayTrack: originalLoad,
      _preBufferNextTrack: originalPrebuffer
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

for (const interruption of ['Pause', 'Stop'] as const) {
  test(`${interruption} then quick Play waits for authoritative remote Next metadata`, async () => {
    resetStores()
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    const currentPath = `/remote-resume-${interruption.toLowerCase()}/a.flac`
    const remotePath = `/remote-resume-${interruption.toLowerCase()}/c.flac`
    const currentDbTrack = makeDbTrack(currentPath, { title: 'Current Local', source_type: 'local' })
    useLibraryStore.setState({ trackByPath: new Map([[currentPath, currentDbTrack]]) })

    const remoteHydration = createDeferred<DbTrack[]>()
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?window=test' },
        electronAPI: {
          library: {
            getTracksByPaths: async (trackPaths: string[]) => {
              assert.deepEqual(trackPaths, [remotePath])
              return remoteHydration.promise
            }
          }
        }
      }
    })

    const originalSettings = useAudioSettingsStore.getState()
    useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
    const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
    const originalPause = audioEngine.pause
    const originalStop = audioEngine.stop
    const originalClearNextBuffer = audioEngine.clearNextBuffer
    const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
    const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
    const loadedTracks: Track[] = []
    let next: Promise<void> | null = null
    let resumed: Promise<void> | null = null

    usePlayerStore.setState({
      _loadAndPlayTrack: async (track) => {
        loadedTracks.push(track)
        usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
        return 'loaded'
      }
    })
    audioEngine.pause = () => undefined
    audioEngine.stop = () => undefined
    audioEngine.clearNextBuffer = () => undefined
    audioEngine.cancelPendingNativeDecode = () => undefined
    audioEngine.getPlaybackOutputMode = () => 'standard'

    const hydratedRemote = makeDbTrack(remotePath, {
      title: 'Authoritative Remote C',
      source_type: 'subsonic',
      source_id: 23,
      source_track_id: `remote-${interruption.toLowerCase()}-c`,
      source_path: remotePath
    })

    try {
      await usePlayerStore.getState().startPlaybackContextByPaths([currentPath, remotePath], 0)
      await flushAsyncWork()
      assert.deepEqual(loadedTracks.map((track) => track.path), [currentPath])

      next = usePlayerStore.getState().playNext()
      await flushAsyncWork()
      const committedQueueId = usePlayerStore.getState().queueItems
        .find((item) => item.entry.path === remotePath)?.queueId
      assert.ok(committedQueueId)
      assert.equal(usePlayerStore.getState().currentQueueItemId, committedQueueId)

      if (interruption === 'Pause') usePlayerStore.getState().pause()
      else usePlayerStore.getState().stop()
      const interruptedState = usePlayerStore.getState()
      assert.equal(interruptedState.currentTrack?.path, remotePath)
      assert.equal(interruptedState.currentTrack?.sourceType, undefined, 'fallback metadata is not authoritative')
      assert.equal(interruptedState.playbackState, interruption === 'Pause' ? 'paused' : 'stopped')
      assert.equal(interruptedState.restoredTrackNeedsLoad, true)

      let resumedFinished = false
      resumed = usePlayerStore.getState().togglePlay().then(() => {
        resumedFinished = true
      })
      await flushAsyncWork()
      assert.equal(resumedFinished, false)
      assert.deepEqual(
        loadedTracks.map((track) => track.path),
        [currentPath],
        'quick Play must not load the fallback C snapshot while hydration is unresolved'
      )

      remoteHydration.resolve([hydratedRemote])
      await Promise.all([next, resumed])

      assert.deepEqual(loadedTracks.map((track) => track.path), [currentPath, remotePath])
      assert.equal(loadedTracks[1]?.title, 'Authoritative Remote C')
      assert.equal(loadedTracks[1]?.sourceType, 'subsonic')
      const resumedState = usePlayerStore.getState()
      assert.equal(resumedState.currentTrack?.path, remotePath)
      assert.equal(resumedState.currentTrack?.title, 'Authoritative Remote C')
      assert.equal(resumedState.currentTrack?.sourceType, 'subsonic')
      assert.equal(resumedState.restoredTrackNeedsLoad, false)
      assert.equal(resumedState.restoredPlaybackTime, null)
      assert.equal(resumedState.currentQueueItemId, committedQueueId)
    } finally {
      remoteHydration.resolve([hydratedRemote])
      await Promise.allSettled([next, resumed].filter(
        (pending): pending is Promise<void> => pending !== null
      ))
      usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
      audioEngine.pause = originalPause
      audioEngine.stop = originalStop
      audioEngine.clearNextBuffer = originalClearNextBuffer
      audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
      audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
      useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  })
}

test('starting a new context clears stale Standard prebuffer state before selected metadata resolves', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const oldCurrent = makeTrack('/context-clear/old-current.flac', { duration: 180, sourceType: 'local' })
  const oldNext = makeTrack('/context-clear/old-next.flac', { duration: 180, sourceType: 'local' })
  const oldCurrentItem = makeQueueItem(createQueueEntryFromTrack(oldCurrent), 'context-clear-current', 'context')
  const oldNextItem = makeQueueItem(createQueueEntryFromTrack(oldNext), 'context-clear-next', 'context')
  usePlayerStore.setState({
    currentTrack: oldCurrent,
    playbackState: 'playing',
    currentTime: 10,
    duration: 180,
    queueItems: [oldCurrentItem, oldNextItem],
    baseUpcomingQueueIds: [oldNextItem.queueId],
    upcomingQueueIds: [oldNextItem.queueId],
    currentQueueItemId: oldCurrentItem.queueId
  })

  const selectedPath = '/context-clear/new-selected.flac'
  const selectedHydration = createDeferred<DbTrack[]>()
  const requestedPaths: string[][] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            requestedPaths.push([...trackPaths])
            return selectedHydration.promise
          }
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard', disableGaplessPrebufferDev: false })
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const timers = new Map<number, { callback: TimerHandler; delay: number }>()
  let nextTimerId = 0
  let staleBufferReady = false
  let clearNextBufferCalls = 0
  const loadedPaths: string[] = []

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedPaths.push(track.path)
      return 'loaded'
    }
  })
  audioEngine.clearNextBuffer = () => {
    clearNextBufferCalls += 1
    staleBufferReady = false
  }
  audioEngine.getPlaybackOutputMode = () => 'standard'
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => staleBufferReady ? oldNext.path : null
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 10 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number)
  }) as typeof clearTimeout

  try {
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.ok([...timers.values()].some((timer) => timer.delay === 1_000))
    staleBufferReady = true

    const contextStart = usePlayerStore.getState().startPlaybackContextByPaths([selectedPath], 0)
    assert.equal(clearNextBufferCalls, 1, 'stale decoded state is cleared synchronously with the new context commit')
    assert.equal(staleBufferReady, false)
    assert.equal(timers.size, 0, 'the old adaptive prebuffer deadline must also be canceled')
    assert.equal(loadedPaths.length, 0)

    await flushAsyncWork()
    assert.deepEqual(requestedPaths, [[selectedPath]])
    assert.equal(loadedPaths.length, 0, 'selected metadata remains unresolved')

    selectedHydration.resolve([makeDbTrack(selectedPath, { title: 'New Selected' })])
    await contextStart
    assert.deepEqual(loadedPaths, [selectedPath])
  } finally {
    selectedHydration.resolve([])
    await flushAsyncWork()
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      _loadAndPlayTrack: originalLoad
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
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

test('standard local playback schedules eager prebuffering after one second of settling and idle time', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

  const currentTrack = makeTrack('/adaptive/current.flac', { duration: 180, sourceType: 'local' })
  const nextTrack = makeTrack('/adaptive/next.flac', { duration: 180, sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'adaptive-current', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'adaptive-next', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 10,
    duration: 180,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false
  })

  const originalPrebuffer = usePlayerStore.getState()._preBufferNextTrack
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const scheduledTimers = new Map<number, { callback: TimerHandler; delay: number }>()
  const idleCallbacks = new Map<number, { callback: IdleRequestCallback; timeout?: number }>()
  let nextTimerId = 0
  let nextIdleId = 0
  let prebufferCalls = 0

  usePlayerStore.setState({
    _preBufferNextTrack: async () => {
      prebufferCalls += 1
    }
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 10 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    scheduledTimers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(id as unknown as number)
  }) as typeof clearTimeout
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
      const id = ++nextIdleId
      idleCallbacks.set(id, { callback, timeout: options?.timeout })
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })

  try {
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

    assert.equal(prebufferCalls, 0)
    const settleTimer = [...scheduledTimers.entries()].find(([, timer]) => timer.delay === 1_000)
    assert.ok(settleTimer, 'adaptive prebuffering must wait one second before requesting idle work')
    scheduledTimers.delete(settleTimer[0])
    assert.equal(typeof settleTimer[1].callback, 'function')
    if (typeof settleTimer[1].callback === 'function') settleTimer[1].callback()

    assert.equal(prebufferCalls, 0)
    const idleWork = [...idleCallbacks.entries()].at(0)
    assert.ok(idleWork)
    assert.equal(idleWork[1].timeout, 2_000)
    idleCallbacks.delete(idleWork[0])
    idleWork[1].callback({ didTimeout: false, timeRemaining: () => 50 })
    await flushAsyncWork()
    assert.equal(prebufferCalls, 1)
  } finally {
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      _preBufferNextTrack: originalPrebuffer
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    resetStores()
  }
})

test('Next waits for and promotes a matching in-flight native PCM prebuffer without decoding twice', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

  const currentTrack = makeTrack('/reuse/current.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const nextTrack = makeTrack('/reuse/next.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'reuse-current', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'reuse-next', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 170,
    duration: 180,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  let fileReadCalls = 0
  let interactiveLoudnessCalls = 0
  const warmupLoudnessPaths: string[] = []
  const supersededLoudnessPaths: Array<string | null> = []
  const loudnessGate = createDeferred<{
    loudnessLufs: number
    peakLinear: number | null
    method: string
  } | null>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async () => null,
        decodeLocalAudioToPcm: async () => null,
        warmupTrackLoudness: async (trackPath: string) => {
          warmupLoudnessPaths.push(trackPath)
          return loudnessGate.promise
        },
        analyzeTrackLoudness: async () => {
          interactiveLoudnessCalls += 1
          return null
        },
        supersedeTrackLoudness: async (trackPath: string | null) => {
          supersededLoudnessPaths.push(trackPath)
          if (trackPath === nextTrack.path) {
            loudnessGate.resolve({
              loudnessLufs: -16.5,
              peakLinear: 0.8,
              method: 'ffmpeg-ebur128'
            })
          }
        },
        loadAudioFile: async () => {
          fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false,
    normalizationEnabled: true
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNextStandardTrackFromPath = audioEngine.preBufferNextStandardTrackFromPath
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalSkipToPreBuffered = audioEngine.skipToPreBuffered
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalPromoteMatchingPrebufferDecode = audioEngine.promoteMatchingPrebufferDecode
  const originalSupersedeCurrentLoadPreservingPrebuffer = audioEngine.supersedeCurrentLoadPreservingPrebuffer
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const prebufferGate = createDeferred<void>()
  let prebufferStarted = false
  let prebufferCompleted = false
  let prebufferReady = false
  let clearNextBufferCalls = 0
  let coldLoadCalls = 0
  let promotedSkipCalls = 0
  let currentLoadSupersessionCalls = 0
  const promotedDecodePaths: string[] = []

  usePlayerStore.setState({
    _loadAndPlayTrack: async () => {
      coldLoadCalls += 1
      return 'loaded'
    }
  })
  audioEngine.getBufferMemoryStats = async () => ({ currentBytes: 0, nextBytes: 0, totalBytes: 0 })
  audioEngine.needsLoudnessAnalysisForLoad = () => true
  audioEngine.preBufferNextStandardTrackFromPath = async (track, options) => {
    assert.equal(track.path, nextTrack.path)
    assert.equal(options?.priority, 'background')
    assert.ok(options?.loudnessAnalysis, 'native prebuffer should receive background loudness work')
    prebufferStarted = true
    const [, loudness] = await Promise.all([
      prebufferGate.promise,
      options.loudnessAnalysis
    ])
    assert.deepEqual(loudness, {
      loudnessLufs: -16.5,
      peakLinear: 0.8,
      method: 'ffmpeg-ebur128'
    })
    prebufferReady = true
    prebufferCompleted = true
    return 'loaded'
  }
  audioEngine.clearNextBuffer = () => {
    clearNextBufferCalls += 1
    prebufferReady = false
  }
  audioEngine.skipToPreBuffered = () => {
    assert.equal(prebufferCompleted, true, 'the real prebuffer operation must finish before promotion')
    assert.equal(prebufferReady, true, 'queue pre-application must not discard the completed buffer')
    promotedSkipCalls += 1
    return true
  }
  audioEngine.supersedeCurrentLoadPreservingPrebuffer = () => {
    currentLoadSupersessionCalls += 1
    originalSupersedeCurrentLoadPreservingPrebuffer.call(audioEngine)
  }
  audioEngine.promoteMatchingPrebufferDecode = (trackPath) => {
    promotedDecodePaths.push(trackPath)
    return true
  }
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => prebufferReady ? nextTrack.path : null
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 170 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })

  try {
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    await flushAsyncWork()
    assert.equal(prebufferStarted, true)
    assert.deepEqual(warmupLoudnessPaths, [nextTrack.path])
    assert.equal(interactiveLoudnessCalls, 0, 'prebuffering must not start interactive loudness work')

    let nextFinished = false
    const next = usePlayerStore.getState().playNext().then(() => {
      nextFinished = true
    })
    await flushAsyncWork()
    assert.equal(nextFinished, false, 'Next should wait for the matching decode')
    assert.equal(currentLoadSupersessionCalls, 1, 'the newer intent must supersede only current-load work')
    assert.deepEqual(supersededLoudnessPaths, [nextTrack.path])
    assert.deepEqual(promotedDecodePaths, [nextTrack.path])
    assert.equal(interactiveLoudnessCalls, 0, 'matching Next should promote, not duplicate, loudness work')
    assert.equal(coldLoadCalls, 0)

    prebufferGate.resolve()
    await next
    assert.equal(prebufferCompleted, true)
    assert.equal(prebufferReady, true)
    assert.equal(clearNextBufferCalls, 0, 'the matching in-flight result must survive queue pre-application')
    assert.equal(promotedSkipCalls, 1)
    assert.equal(coldLoadCalls, 0, 'the matching file must not be decoded twice')
    assert.equal(fileReadCalls, 0, 'the successful native PCM prebuffer must not read for Chromium fallback')
    assert.equal(usePlayerStore.getState().currentQueueItemId, nextItem.queueId)
  } finally {
    prebufferGate.resolve()
    loudnessGate.resolve(null)
    await flushAsyncWork()
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      _loadAndPlayTrack: originalLoad
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
    audioEngine.preBufferNextStandardTrackFromPath = originalPreBufferNextStandardTrackFromPath
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.skipToPreBuffered = originalSkipToPreBuffered
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    audioEngine.promoteMatchingPrebufferDecode = originalPromoteMatchingPrebufferDecode
    audioEngine.supersedeCurrentLoadPreservingPrebuffer = originalSupersedeCurrentLoadPreservingPrebuffer
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a natural gapless handoff during matching in-flight Next does not cold-load the promoted track', async () => {
  const harness = await installMatchingPrebufferHarness()
  const originalOn = audioEngine.on
  const gaplessTransitionListeners: Array<() => void> = []
  let next: Promise<void> | null = null

  Object.assign(window, {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  Object.assign(window.electronAPI, {
    onProgressiveLoadProgress: () => () => undefined,
    library: {
      getListeningHistoryStatus: async () => ({
        generation: 'natural-gapless-inflight',
        startedAt: null
      }),
      checkpointListeningSession: async () => ({
        accepted: true,
        qualifiedNow: false,
        status: {
          generation: 'natural-gapless-inflight',
          startedAt: null
        }
      })
    }
  })
  audioEngine.on = (event, callback) => {
    if (event === 'gaplessTransition') {
      gaplessTransitionListeners.push(callback as () => void)
    }
    return () => undefined
  }

  try {
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.getState()._initListeners()
    assert.equal(gaplessTransitionListeners.length, 1)

    harness.setPrebufferCompletionHook(() => {
      // AudioEngine promotes current/next paths before notifying the store.
      harness.metrics.prebufferReady = false
      gaplessTransitionListeners[0]()
    })

    next = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.targetItem.queueId)
    assert.deepEqual(
      usePlayerStore.getState().playbackHistory.map((entry) => entry.item.queueId),
      [harness.currentItem.queueId]
    )

    harness.prebufferGate.resolve()
    await next

    assert.equal(harness.metrics.prebufferCompleted, true)
    assert.equal(harness.metrics.promotionCalls, 0, 'the natural handoff already promoted the buffer')
    assert.deepEqual(harness.metrics.loadedTracks, [], 'the promoted track must not be decoded a second time')
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.targetItem.queueId)
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.targetTrack.path)
    assert.deepEqual(usePlayerStore.getState().upcomingQueueIds, [])
    assert.deepEqual(
      usePlayerStore.getState().playbackHistory.map((entry) => entry.item.queueId),
      [harness.currentItem.queueId],
      'the natural handoff must not append history twice'
    )
  } finally {
    harness.setPrebufferCompletionHook(null)
    harness.prebufferGate.resolve()
    if (next) await Promise.allSettled([next])
    usePlayerStore.getState()._cleanupListeners()
    audioEngine.on = originalOn
    await harness.restore()
  }
})

for (const stalePrebufferState of ['ready', 'in-flight'] as const) {
  test(`selecting uncached C clears a nonmatching ${stalePrebufferState} B before hydration`, async () => {
    resetStores()
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
    const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
    const originalSettings = useAudioSettingsStore.getState()
    const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
    const originalOn = audioEngine.on
    const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
    const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
    const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
    const originalPreBufferNext = audioEngine.preBufferNext
    const originalClearNextBuffer = audioEngine.clearNextBuffer
    const ownHasNextBuffered = Object.getOwnPropertyDescriptor(audioEngine, 'hasNextBuffered')
    const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
    const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
    const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
    const idleCallbacks = new Map<number, IdleRequestCallback>()
    const prebufferGate = createDeferred<void>()
    const targetHydration = createDeferred<DbTrack[]>()
    let nextIdleId = 0
    let prebufferStarted = false
    let prebufferReady = false
    let clearNextBufferCalls = 0
    const gaplessTransitionListeners: Array<() => void> = []
    let targetSelection: Promise<void> | null = null

    const paths = {
      a: `/stale-${stalePrebufferState}/a.flac`,
      b: `/stale-${stalePrebufferState}/b.flac`,
      c: `/stale-${stalePrebufferState}/c.flac`,
      d: `/stale-${stalePrebufferState}/d.flac`
    }
    const cachedTracks = [paths.a, paths.b, paths.d].map((path) => makeDbTrack(path, {
      duration: 180,
      source_type: 'local'
    }))
    useLibraryStore.setState({
      trackByPath: new Map(cachedTracks.map((track) => [track.path, track]))
    })

    Object.defineProperty(globalThis, 'requestIdleCallback', {
      configurable: true,
      value: (callback: IdleRequestCallback) => {
        const id = ++nextIdleId
        idleCallbacks.set(id, callback)
        return id
      }
    })
    Object.defineProperty(globalThis, 'cancelIdleCallback', {
      configurable: true,
      value: (id: number) => idleCallbacks.delete(id)
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?window=test' },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        electronAPI: {
          library: {
            getTracksByPaths: async (trackPaths: string[]) => {
              assert.deepEqual(trackPaths, [paths.c])
              return targetHydration.promise
            },
            getListeningHistoryStatus: async () => ({ generation: 'stale-prebuffer-test', startedAt: null }),
            checkpointListeningSession: async () => ({
              accepted: true,
              qualifiedNow: false,
              status: { generation: 'stale-prebuffer-test', startedAt: null }
            })
          },
          onProgressiveLoadProgress: () => () => undefined,
          getAudioFileStat: async () => null,
          loadAudioFile: async () => ({ data: new ArrayBuffer(16) })
        }
      }
    })
    useAudioSettingsStore.setState({
      playbackOutputMode: 'standard',
      disableGaplessPrebufferDev: false,
      normalizationEnabled: false
    })
    usePlayerStore.setState({
      _loadAndPlayTrack: async (track) => {
        usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
        return 'loaded'
      }
    })
    audioEngine.getPlaybackOutputMode = () => 'standard'
    audioEngine.getBufferMemoryStats = async () => ({ currentBytes: 0, nextBytes: 0, totalBytes: 0 })
    audioEngine.needsLoudnessAnalysisForLoad = () => false
    audioEngine.preBufferNext = async () => {
      prebufferStarted = true
      if (stalePrebufferState === 'in-flight') await prebufferGate.promise
      prebufferReady = true
    }
    audioEngine.clearNextBuffer = () => {
      clearNextBufferCalls += 1
      prebufferReady = false
    }
    audioEngine.on = (event, callback) => {
      if (event === 'gaplessTransition') gaplessTransitionListeners.push(callback)
      return () => undefined
    }
    Object.defineProperty(audioEngine, 'hasNextBuffered', {
      configurable: true,
      get: () => prebufferReady
    })
    Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
      configurable: true,
      get: () => prebufferReady ? paths.b : null
    })
    Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 170 })
    Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })

    const hydratedTarget = makeDbTrack(paths.c, { title: 'Hydrated C', source_type: 'local' })
    try {
      usePlayerStore.getState()._cleanupListeners()
      usePlayerStore.getState()._initListeners()
      assert.equal(gaplessTransitionListeners.length, 1)

      await usePlayerStore.getState().startPlaybackContextByPaths(
        [paths.a, paths.b, paths.c, paths.d],
        0
      )
      await flushAsyncWork()
      usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
      await flushAsyncWork()
      assert.equal(prebufferStarted, true)
      assert.equal(prebufferReady, stalePrebufferState === 'ready')

      const stateBeforeSelection = usePlayerStore.getState()
      const bItem = stateBeforeSelection.queueItems.find((item) => item.entry.path === paths.b)
      const cItem = stateBeforeSelection.queueItems.find((item) => item.entry.path === paths.c)
      const dItem = stateBeforeSelection.queueItems.find((item) => item.entry.path === paths.d)
      assert.ok(bItem && cItem && dItem)

      const clearCallsBeforeSelection = clearNextBufferCalls
      targetSelection = usePlayerStore.getState().playQueuedItem(cItem.queueId)
      assert.equal(
        clearNextBufferCalls,
        clearCallsBeforeSelection + 1,
        'B must be evicted synchronously before C metadata can yield'
      )
      assert.equal(prebufferReady, false)
      assert.equal(usePlayerStore.getState().currentQueueItemId, cItem.queueId)
      await flushAsyncWork()

      const queuedStaleGaplessTransition = gaplessTransitionListeners[0]
      assert.ok(queuedStaleGaplessTransition)
      queuedStaleGaplessTransition()
      const stateAfterStaleTransition = usePlayerStore.getState()
      assert.equal(stateAfterStaleTransition.currentQueueItemId, cItem.queueId)
      assert.deepEqual(stateAfterStaleTransition.upcomingQueueIds, [bItem.queueId, dItem.queueId])

      prebufferGate.resolve()
      targetHydration.resolve([hydratedTarget])
      await targetSelection
      assert.equal(usePlayerStore.getState().currentQueueItemId, cItem.queueId)
      assert.equal(usePlayerStore.getState().currentTrack?.title, 'Hydrated C')
    } finally {
      prebufferGate.resolve()
      targetHydration.resolve([hydratedTarget])
      if (targetSelection) await Promise.allSettled([targetSelection])
      usePlayerStore.getState()._cleanupListeners()
      usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
      audioEngine.on = originalOn
      audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
      audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
      audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
      audioEngine.preBufferNext = originalPreBufferNext
      audioEngine.clearNextBuffer = originalClearNextBuffer
      if (ownHasNextBuffered) Object.defineProperty(audioEngine, 'hasNextBuffered', ownHasNextBuffered)
      else delete (audioEngine as unknown as Record<string, unknown>).hasNextBuffered
      if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
      else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
      if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
      else delete (audioEngine as unknown as Record<string, unknown>).currentTime
      if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
      else delete (audioEngine as unknown as Record<string, unknown>).duration
      useAudioSettingsStore.setState({
        playbackOutputMode: originalSettings.playbackOutputMode,
        disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev,
        normalizationEnabled: originalSettings.normalizationEnabled
      })
      if (originalRequestIdleCallback) {
        Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
      } else {
        delete (globalThis as Record<string, unknown>).requestIdleCallback
      }
      if (originalCancelIdleCallback) {
        Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
      } else {
        delete (globalThis as Record<string, unknown>).cancelIdleCallback
      }
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  })
}

test('Pause during matching in-flight promotion keeps the committed target paused for reload', async () => {
  const harness = await installMatchingPrebufferHarness()

  try {
    const next = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.targetItem.queueId)
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.currentTrack.path)

    usePlayerStore.getState().pause()
    const pausedState = usePlayerStore.getState()
    assert.equal(harness.metrics.pauseCalls, 1)
    assert.equal(pausedState.currentQueueItemId, harness.targetItem.queueId)
    assert.equal(pausedState.currentTrack?.path, harness.targetTrack.path)
    assert.equal(pausedState.playbackState, 'paused')
    assert.equal(pausedState.restoredTrackNeedsLoad, true)
    assert.equal(pausedState.restoredPlaybackTime, 0)

    harness.prebufferGate.resolve()
    await next
    assert.equal(harness.metrics.prebufferCompleted, true)
    assert.equal(harness.metrics.promotionCalls, 0)
    assert.deepEqual(harness.metrics.loadedTracks, [])
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'paused')
  } finally {
    await harness.restore()
  }
})

test('Stop during matching in-flight promotion preserves the target without late promotion', async () => {
  const harness = await installMatchingPrebufferHarness()

  try {
    const next = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.targetItem.queueId)

    usePlayerStore.getState().stop()
    const stoppedState = usePlayerStore.getState()
    assert.equal(harness.metrics.stopCalls, 1)
    assert.equal(stoppedState.currentQueueItemId, harness.targetItem.queueId)
    assert.equal(stoppedState.currentTrack?.path, harness.targetTrack.path)
    assert.equal(stoppedState.playbackState, 'stopped')

    harness.prebufferGate.resolve()
    await next
    assert.equal(harness.metrics.promotionCalls, 0)
    assert.deepEqual(harness.metrics.loadedTracks, [])
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'stopped')
  } finally {
    await harness.restore()
  }
})

test('Previous during matching in-flight promotion bypasses restart and returns to the prior track', async () => {
  const harness = await installMatchingPrebufferHarness()

  try {
    const next = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentTime > 3, true)
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.targetItem.queueId)

    await usePlayerStore.getState().playPrevious()
    assert.deepEqual(harness.metrics.seekCalls, [], 'a committed transition must bypass the three-second restart rule')
    assert.deepEqual(harness.metrics.loadedTracks.map((track) => track.path), [harness.currentTrack.path])
    assert.equal(usePlayerStore.getState().currentQueueItemId, harness.currentItem.queueId)
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.currentTrack.path)
    assert.equal(usePlayerStore.getState().getResolvedNextTrack()?.path, harness.targetTrack.path)

    harness.prebufferGate.resolve()
    await next
    assert.equal(harness.metrics.promotionCalls, 0)
    assert.equal(usePlayerStore.getState().currentTrack?.path, harness.currentTrack.path)
  } finally {
    await harness.restore()
  }
})

test('adaptive prebuffering excludes repeat-one, remote, disabled, and bit-perfect playback', () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

  const currentTrack = makeTrack('/excluded/current.flac', { duration: 180, sourceType: 'local' })
  const localNextTrack = makeTrack('/excluded/next.flac', { duration: 180, sourceType: 'local' })
  const remoteNextTrack = makeTrack('/excluded/remote.flac', { duration: 180, sourceType: 'subsonic' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'excluded-current', 'context')
  const localNextItem = makeQueueItem(createQueueEntryFromTrack(localNextTrack), 'excluded-next', 'context')
  const remoteNextItem = makeQueueItem(createQueueEntryFromTrack(remoteNextTrack), 'excluded-remote', 'context')
  const setQueue = (nextItem: QueueItem): void => {
    usePlayerStore.setState({
      currentTrack,
      playbackState: 'playing',
      currentTime: 0,
      duration: 180,
      queueItems: [currentItem, nextItem],
      baseUpcomingQueueIds: [nextItem.queueId],
      upcomingQueueIds: [nextItem.queueId],
      currentQueueItemId: currentItem.queueId
    })
  }
  setQueue(localNextItem)

  const originalSettings = useAudioSettingsStore.getState()
  const originalPrebuffer = usePlayerStore.getState()._preBufferNextTrack
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const timerDelays = new Map<number, number>()
  const idleCallbacks = new Set<number>()
  let nextTimerId = 0
  let nextIdleId = 0
  let prebufferCalls = 0

  usePlayerStore.setState({
    _preBufferNextTrack: async () => {
      prebufferCalls += 1
    }
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 0 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  globalThis.setTimeout = ((_callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    timerDelays.set(id, delay)
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timerDelays.delete(id as unknown as number)
  }) as typeof clearTimeout
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: () => {
      const id = ++nextIdleId
      idleCallbacks.add(id)
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })

  try {
    useAudioSettingsStore.setState({ playbackOutputMode: 'standard', disableGaplessPrebufferDev: false })
    audioEngine.getPlaybackOutputMode = () => 'standard'
    usePlayerStore.setState({ repeat: 'one' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.equal(timerDelays.size, 0)
    assert.equal(idleCallbacks.size, 0)

    usePlayerStore.setState({ repeat: 'none' })
    setQueue(remoteNextItem)
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.equal(timerDelays.size, 0)
    assert.equal(idleCallbacks.size, 0)

    setQueue(localNextItem)
    useAudioSettingsStore.setState({ disableGaplessPrebufferDev: true })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.equal(timerDelays.size, 0)
    assert.equal(idleCallbacks.size, 0)

    useAudioSettingsStore.setState({
      playbackOutputMode: 'bitperfect',
      disableGaplessPrebufferDev: false
    })
    audioEngine.getPlaybackOutputMode = () => 'bitperfect'
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    assert.equal([...timerDelays.values()].includes(1_000), false)
    assert.equal(idleCallbacks.size, 0)
    assert.equal(prebufferCalls, 0)
  } finally {
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      repeat: 'none',
      _preBufferNextTrack: originalPrebuffer
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    resetStores()
  }
})

test('bit-perfect playback does no eager file or decode work for an IAMF next track', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })

  const currentTrack = makeTrack('/iamf-prebuffer/current.flac', {
    duration: 180,
    sourceType: 'local'
  })
  const iamfNextTrack = makeTrack('/iamf-prebuffer/next.iamf', {
    duration: 180,
    sourceType: 'local',
    isIamf: true
  })
  const currentItem = makeQueueItem(
    createQueueEntryFromTrack(currentTrack),
    'iamf-prebuffer-current',
    'context'
  )
  const nextItem = makeQueueItem(
    createQueueEntryFromTrack(iamfNextTrack),
    'iamf-prebuffer-next',
    'context'
  )
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 170,
    duration: currentTrack.duration,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSettings = useAudioSettingsStore.getState()
  const originalParallaxStatus = useParallaxStore.getState().status
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNextTrackFromPath = audioEngine.preBufferNextTrackFromPath
  const originalPreBufferNext = audioEngine.preBufferNext
  let statCalls = 0
  let fileReadCalls = 0
  let memoryStatCalls = 0
  let nativePrebufferCalls = 0
  let standardPrebufferCalls = 0

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async () => {
          statCalls += 1
          return { size: 16 }
        },
        loadAudioFile: async () => {
          fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        }
      }
    }
  })
  useAudioSettingsStore.setState({
    playbackOutputMode: 'bitperfect',
    disableGaplessPrebufferDev: false,
    normalizationEnabled: false
  })
  useParallaxStore.setState({ status: null })
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  audioEngine.getBufferMemoryStats = async () => {
    memoryStatCalls += 1
    return { currentBytes: 0, nextBytes: 0, totalBytes: 0 }
  }
  audioEngine.preBufferNextTrackFromPath = async () => {
    nativePrebufferCalls += 1
    return {
      playbackSequence: 1,
      sampleRate: 48_000,
      channels: 12,
      sampleFormat: 'f32',
      duration: iamfNextTrack.duration
    }
  }
  audioEngine.preBufferNext = async () => {
    standardPrebufferCalls += 1
  }

  try {
    await usePlayerStore.getState()._preBufferNextTrack()

    assert.equal(statCalls, 0)
    assert.equal(fileReadCalls, 0)
    assert.equal(memoryStatCalls, 0)
    assert.equal(nativePrebufferCalls, 0)
    assert.equal(standardPrebufferCalls, 0)
  } finally {
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
    audioEngine.preBufferNextTrackFromPath = originalPreBufferNextTrackFromPath
    audioEngine.preBufferNext = originalPreBufferNext
    useParallaxStore.setState({ status: originalParallaxStatus })
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a nonmatching native queue mutation cancels decode and serializes clear before the replacement prebuffer', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: { getAudioFileStat: async () => null }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'bitperfect',
    disableGaplessPrebufferDev: false
  })

  const currentTrack = makeTrack('/native-prebuffer-barrier/current.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 96_000,
    channels: 2
  })
  const firstNextTrack = makeTrack('/native-prebuffer-barrier/first.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 96_000,
    channels: 2
  })
  const replacementTrack = makeTrack('/native-prebuffer-barrier/replacement.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 96_000,
    channels: 2
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'native-prebuffer-current', 'context')
  const firstNextItem = makeQueueItem(createQueueEntryFromTrack(firstNextTrack), 'native-prebuffer-first', 'context')
  const replacementItem = makeQueueItem(createQueueEntryFromTrack(replacementTrack), 'native-prebuffer-replacement', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 170,
    duration: 180,
    queueItems: [currentItem, firstNextItem, replacementItem],
    baseUpcomingQueueIds: [firstNextItem.queueId, replacementItem.queueId],
    upcomingQueueIds: [firstNextItem.queueId, replacementItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  const originalPrebuffer = audioEngine.preBufferNextTrackFromPath
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownHasNextBuffered = Object.getOwnPropertyDescriptor(audioEngine, 'hasNextBuffered')
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const firstGate = createDeferred<void>()
  const clearGate = createDeferred<void>()
  const replacementGate = createDeferred<void>()
  const order: string[] = []
  let cancelCalls = 0
  let nativeConcurrency = 0
  let maxNativeConcurrency = 0

  const beginNativeCall = (label: string): void => {
    order.push(label)
    nativeConcurrency += 1
    maxNativeConcurrency = Math.max(maxNativeConcurrency, nativeConcurrency)
  }
  const endNativeCall = (): void => {
    nativeConcurrency -= 1
  }

  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  audioEngine.preBufferNextTrackFromPath = async (track) => {
    beginNativeCall(`prebuffer:${track.path}`)
    try {
      if (track.path === firstNextTrack.path) await firstGate.promise
      else if (track.path === replacementTrack.path) await replacementGate.promise
    } finally {
      endNativeCall()
    }
    return {
      playbackSequence: track.path === firstNextTrack.path ? 1 : 2,
      sampleRate: track.sampleRate ?? 96_000,
      channels: track.channels ?? 2,
      sampleFormat: 's24',
      duration: track.duration
    }
  }
  audioEngine.clearNextBuffer = async () => {
    beginNativeCall('clear')
    try {
      await clearGate.promise
    } finally {
      endNativeCall()
    }
  }
  audioEngine.cancelPendingNativeDecode = () => {
    cancelCalls += 1
  }
  Object.defineProperty(audioEngine, 'hasNextBuffered', { configurable: true, get: () => false })
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', { configurable: true, get: () => null })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 170 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })

  try {
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    await flushAsyncWork()
    assert.deepEqual(order, [`prebuffer:${firstNextTrack.path}`])
    assert.equal(nativeConcurrency, 1)

    usePlayerStore.getState().moveUpcomingItem(replacementItem.queueId, 0)
    assert.equal(cancelCalls, 1, 'a nonmatching queue mutation must cancel native decode immediately')
    assert.equal(order.includes('clear'), false, 'clear must wait for the active native prebuffer operation')
    assert.equal(
      order.includes(`prebuffer:${replacementTrack.path}`),
      false,
      'replacement prebuffer must wait for clear-next'
    )

    firstGate.resolve()
    await flushAsyncWork()
    assert.deepEqual(order, [`prebuffer:${firstNextTrack.path}`, 'clear'])
    assert.equal(nativeConcurrency, 1)

    clearGate.resolve()
    await flushAsyncWork()
    assert.deepEqual(order, [
      `prebuffer:${firstNextTrack.path}`,
      'clear',
      `prebuffer:${replacementTrack.path}`
    ])
    assert.equal(maxNativeConcurrency, 1, 'native preload and clear calls must never overlap')

    replacementGate.resolve()
    await flushAsyncWork()
    assert.equal(nativeConcurrency, 0)
  } finally {
    firstGate.resolve()
    clearGate.resolve()
    replacementGate.resolve()
    await flushAsyncWork()
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.preBufferNextTrackFromPath = originalPrebuffer
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownHasNextBuffered) Object.defineProperty(audioEngine, 'hasNextBuffered', ownHasNextBuffered)
    else delete (audioEngine as unknown as Record<string, unknown>).hasNextBuffered
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Standard prebuffering excludes the 192 MiB decoded boundary and oversized local files', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const currentTrack = makeTrack('/prebuffer-size/current.flac', {
    duration: 180,
    sourceType: 'local'
  })
  const decodedBoundaryTrack = makeTrack('/prebuffer-size/decoded-boundary.flac', {
    duration: 524.288,
    sourceType: 'local',
    sampleRate: 48_000,
    channels: 2
  })
  const oversizedFileTrack = makeTrack('/prebuffer-size/oversized-file.flac', {
    duration: 180,
    sourceType: 'local'
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'prebuffer-size-current', 'context')

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let fileReadCalls = 0
  let fileStatCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async (path: string) => {
          fileStatCalls += 1
          return path === oversizedFileTrack.path
            ? { size: 128 * 1024 * 1024 }
            : null
        },
        loadAudioFile: async () => {
          fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        }
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false
  })
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNext = audioEngine.preBufferNext
  let decodeCalls = 0
  audioEngine.getBufferMemoryStats = async () => ({ currentBytes: 0, nextBytes: 0, totalBytes: 0 })
  audioEngine.preBufferNext = async () => {
    decodeCalls += 1
  }

  const setNextTrack = (track: Track, queueId: string): void => {
    const nextItem = makeQueueItem(createQueueEntryFromTrack(track), queueId, 'context')
    usePlayerStore.setState({
      currentTrack,
      playbackState: 'playing',
      currentTime: 0,
      duration: currentTrack.duration,
      queueItems: [currentItem, nextItem],
      baseUpcomingQueueIds: [nextItem.queueId],
      upcomingQueueIds: [nextItem.queueId],
      currentQueueItemId: currentItem.queueId
    })
  }

  try {
    setNextTrack(decodedBoundaryTrack, 'prebuffer-size-decoded-boundary')
    await usePlayerStore.getState()._preBufferNextTrack()
    assert.equal(fileStatCalls, 0, 'the exact 192 MiB decoded boundary must be excluded before file stat')
    assert.equal(fileReadCalls, 0)
    assert.equal(decodeCalls, 0)

    setNextTrack(oversizedFileTrack, 'prebuffer-size-oversized-file')
    await usePlayerStore.getState()._preBufferNextTrack()
    assert.equal(fileStatCalls, 1)
    assert.equal(fileReadCalls, 0, 'a 128 MiB local file must stay on the progressive path')
    assert.equal(decodeCalls, 0)
  } finally {
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
    audioEngine.preBufferNext = originalPreBufferNext
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Standard prebuffering retains the 384 MiB decoded-buffer budget', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const currentTrack = makeTrack('/budget/current.flac', { duration: 180, sourceType: 'local' })
  const nextTrack = makeTrack('/budget/next.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'budget-current', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'budget-next', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let fileReadCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async () => null,
        loadAudioFile: async () => {
          fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false
  })
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNext = audioEngine.preBufferNext
  let decodeCalls = 0
  audioEngine.getBufferMemoryStats = async () => ({
    currentBytes: 380 * 1024 * 1024,
    nextBytes: 0,
    totalBytes: 380 * 1024 * 1024
  })
  audioEngine.preBufferNext = async () => {
    decodeCalls += 1
  }

  try {
    await usePlayerStore.getState()._preBufferNextTrack()
    assert.equal(fileReadCalls, 0)
    assert.equal(decodeCalls, 0)
  } finally {
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
    audioEngine.preBufferNext = originalPreBufferNext
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('an eager decode that installs no buffer retries once in the final fifteen-second window', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const currentTrack = makeTrack('/retry/current.flac', { duration: 180, sourceType: 'local' })
  const nextTrack = makeTrack('/retry/next.flac', {
    duration: 180,
    sourceType: 'local',
    sampleRate: 44_100,
    channels: 2
  })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'retry-current', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'retry-next', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 10,
    duration: 180,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let fileReadCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {
        getAudioFileStat: async () => null,
        loadAudioFile: async () => {
          fileReadCalls += 1
          return { data: new ArrayBuffer(16) }
        }
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    disableGaplessPrebufferDev: false,
    normalizationEnabled: false
  })
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const originalGetBufferMemoryStats = audioEngine.getBufferMemoryStats
  const originalPreBufferNext = audioEngine.preBufferNext
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalPublishHostNextStream = useParallaxStore.getState().publishHostNextStream
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const timers = new Map<number, { callback: TimerHandler; delay: number }>()
  const idleCallbacks = new Map<number, IdleRequestCallback>()
  let nextTimerId = 0
  let nextIdleId = 0
  let engineCurrentTime = 10
  let decodeCalls = 0
  let bufferedTrackPath: string | null = null
  let publishedNextCalls = 0

  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number)
  }) as typeof clearTimeout
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback: IdleRequestCallback) => {
      const id = ++nextIdleId
      idleCallbacks.set(id, callback)
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => engineCurrentTime })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  audioEngine.getBufferMemoryStats = async () => ({ currentBytes: 0, nextBytes: 0, totalBytes: 0 })
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.preBufferNext = async () => {
    decodeCalls += 1
    if (decodeCalls === 2) bufferedTrackPath = nextTrack.path
  }
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => bufferedTrackPath
  })
  useParallaxStore.setState({
    publishHostNextStream: async () => {
      publishedNextCalls += 1
    }
  })

  try {
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    const settleTimer = [...timers.entries()].find(([, timer]) => timer.delay === 1_000)
    assert.ok(settleTimer)
    timers.delete(settleTimer[0])
    if (typeof settleTimer[1].callback === 'function') settleTimer[1].callback()
    const idleWork = [...idleCallbacks.entries()].at(0)
    assert.ok(idleWork)
    idleCallbacks.delete(idleWork[0])
    idleWork[1]({ didTimeout: false, timeRemaining: () => 50 })
    await flushAsyncWork()
    assert.equal(fileReadCalls, 1)
    assert.equal(decodeCalls, 1)
    assert.equal(bufferedTrackPath, null, 'the eager decode resolved without installing a buffer')
    assert.equal(publishedNextCalls, 0, 'an uninstalled buffer must not be published as ready')

    engineCurrentTime = 170
    usePlayerStore.getState()._schedulePreBufferNextTrack()
    await flushAsyncWork()
    assert.equal(fileReadCalls, 2)
    assert.equal(decodeCalls, 2)
    assert.equal(bufferedTrackPath, nextTrack.path)
    assert.equal(publishedNextCalls, 1)
  } finally {
    usePlayerStore.setState({ currentTrack: null, playbackState: 'stopped' })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    audioEngine.getBufferMemoryStats = originalGetBufferMemoryStats
    audioEngine.preBufferNext = originalPreBufferNext
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    useParallaxStore.setState({ publishHostNextStream: originalPublishHostNextStream })
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      disableGaplessPrebufferDev: originalSettings.disableGaplessPrebufferDev,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
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

test('an uncached Next supersedes an active Standard load before target metadata resolves', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalSettings = useAudioSettingsStore.getState()
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalLoadAudioData = audioEngine.loadAudioData
  const originalPlay = audioEngine.play
  const originalGetCurrentTrackChannelCount = audioEngine.getCurrentTrackChannelCount
  const originalOn = audioEngine.on
  const originalSupersedeCurrentLoadPreservingPrebuffer = audioEngine.supersedeCurrentLoadPreservingPrebuffer
  const firstFileRead = createDeferred<{ data: ArrayBuffer }>()
  const targetMetadata = createDeferred<DbTrack[]>()
  const idleCallbacks = new Map<number, IdleRequestCallback>()
  const fileReadPaths: string[] = []
  const decodedPaths: string[] = []
  const playedPaths: string[] = []
  let nextIdleId = 0
  let contextStart: Promise<void> | null = null
  let activeSkip: Promise<void> | null = null
  let metadataWaitingSkip: Promise<void> | null = null
  let currentLoadSupersessionCalls = 0

  const contextPaths = [
    '/active-load-context/a.flac',
    '/active-load-context/b.flac',
    '/active-load-context/c.flac'
  ]
  const [currentPath, activeLoadPath, uncachedTargetPath] = contextPaths as [string, string, string]
  const currentTrack = makeDbTrack(currentPath, { title: 'Current' })
  const activeLoadTrack = makeDbTrack(activeLoadPath, { title: 'Active load' })
  const hydratedTarget = makeDbTrack(uncachedTargetPath, { title: 'Hydrated final target' })
  useLibraryStore.setState({
    trackByPath: new Map([
      [currentPath, currentTrack],
      [activeLoadPath, activeLoadTrack]
    ])
  })

  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback: IdleRequestCallback) => {
      const id = ++nextIdleId
      idleCallbacks.set(id, callback)
      return id
    }
  })
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    value: (id: number) => idleCallbacks.delete(id)
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        library: {
          getTracksByPaths: async (trackPaths: string[]) => {
            assert.deepEqual(trackPaths, [uncachedTargetPath])
            return targetMetadata.promise
          },
          getListeningHistoryStatus: async () => ({ generation: 'active-load-test', startedAt: null }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'active-load-test', startedAt: null }
          })
        },
        onProgressiveLoadProgress: () => () => undefined,
        getAudioFileStat: async () => null,
        loadAudioFile: async (trackPath: string) => {
          fileReadPaths.push(trackPath)
          if (trackPath === activeLoadPath) return firstFileRead.promise
          if (trackPath === uncachedTargetPath) return { data: new ArrayBuffer(16) }
          throw new Error(`Unexpected file read: ${trackPath}`)
        },
        decodeAudioWithFfmpeg: async () => null
      }
    }
  })

  useAudioSettingsStore.setState({
    playbackOutputMode: 'standard',
    normalizationEnabled: false
  })
  audioEngine.getPlaybackOutputMode = () => 'standard'
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.loadAudioData = async (_data, options) => {
    decodedPaths.push(options?.trackPath ?? 'unknown')
  }
  audioEngine.play = async () => {
    playedPaths.push(usePlayerStore.getState().currentTrack?.path ?? 'none')
  }
  audioEngine.getCurrentTrackChannelCount = () => 2
  audioEngine.on = () => () => undefined
  audioEngine.supersedeCurrentLoadPreservingPrebuffer = () => {
    currentLoadSupersessionCalls += 1
    originalSupersedeCurrentLoadPreservingPrebuffer.call(audioEngine)
  }

  try {
    usePlayerStore.setState({
      _loadAndPlayTrack: async (track) => {
        assert.equal(track.path, currentPath)
        usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
        return 'loaded'
      }
    })
    contextStart = usePlayerStore.getState().startPlaybackContextByPaths(contextPaths, 0)
    await contextStart
    await flushAsyncWork()
    assert.equal(idleCallbacks.size, 1, 'uncached later metadata should still be waiting for idle hydration')

    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    activeSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.deepEqual(fileReadPaths, [activeLoadPath])

    const supersessionCallsBeforeUncachedTarget = currentLoadSupersessionCalls
    let metadataWaitingSkipSettled = false
    metadataWaitingSkip = usePlayerStore.getState().playNext().then(() => {
      metadataWaitingSkipSettled = true
    })
    assert.equal(
      currentLoadSupersessionCalls,
      supersessionCallsBeforeUncachedTarget + 1,
      'the uncached target must supersede AudioEngine current-load generation synchronously'
    )
    await flushAsyncWork()
    const committedTarget = usePlayerStore.getState()
    assert.equal(committedTarget.currentQueueItemId, committedTarget.queueItems
      .find((item) => item.entry.path === uncachedTargetPath)?.queueId)
    assert.equal(metadataWaitingSkipSettled, false)

    firstFileRead.resolve({ data: new ArrayBuffer(16) })
    await activeSkip
    await flushAsyncWork()

    assert.equal(metadataWaitingSkipSettled, false, 'final target should still be waiting on metadata')
    assert.deepEqual(decodedPaths, [], 'the stale Standard load must stop before decode')
    assert.deepEqual(playedPaths, [], 'the stale Standard load must never reach engine play')
    assert.equal(usePlayerStore.getState().currentQueueItemId, committedTarget.currentQueueItemId)

    targetMetadata.resolve([hydratedTarget])
    await metadataWaitingSkip
    assert.deepEqual(fileReadPaths, [activeLoadPath, uncachedTargetPath])
    assert.deepEqual(decodedPaths, [uncachedTargetPath])
    assert.deepEqual(playedPaths, [uncachedTargetPath])
    assert.equal(usePlayerStore.getState().currentTrack?.title, 'Hydrated final target')
  } finally {
    firstFileRead.resolve({ data: new ArrayBuffer(16) })
    targetMetadata.resolve([hydratedTarget])
    await Promise.allSettled([contextStart, activeSkip, metadataWaitingSkip].filter(
      (pending): pending is Promise<void> => pending !== null
    ))
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    audioEngine.loadAudioData = originalLoadAudioData
    audioEngine.play = originalPlay
    audioEngine.getCurrentTrackChannelCount = originalGetCurrentTrackChannelCount
    audioEngine.on = originalOn
    audioEngine.supersedeCurrentLoadPreservingPrebuffer = originalSupersedeCurrentLoadPreservingPrebuffer
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalRequestIdleCallback) {
      Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).requestIdleCallback
    }
    if (originalCancelIdleCallback) {
      Object.defineProperty(globalThis, 'cancelIdleCallback', originalCancelIdleCallback)
    } else {
      delete (globalThis as Record<string, unknown>).cancelIdleCallback
    }
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a Next supersedes paused resume while Parallax preparation is stalled', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const currentTrack = makeTrack('/parallax-resume/a.flac', { sourceType: 'local' })
  const nextTrack = makeTrack('/parallax-resume/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'parallax-resume-a', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'parallax-resume-b', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'paused',
    currentTime: 12,
    duration: currentTrack.duration,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: [],
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const diagnostics: Array<{ name: string; details?: Record<string, unknown> | null }> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      electronAPI: {
        diagnostics: {
          logEvent: async (event: { name: string; details?: Record<string, unknown> | null }) => {
            diagnostics.push(event)
          }
        }
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPlay = audioEngine.play
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const originalParallax = useParallaxStore.getState()
  const prepareGate = createDeferred<null>()
  const loadedPaths: string[] = []
  let ordinaryPlayCalls = 0
  let prepareCalls = 0
  let resume: Promise<void> | null = null

  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async (track) => {
      assert.equal(track.path, currentTrack.path)
      prepareCalls += 1
      return prepareGate.promise
    }
  })
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedPaths.push(track.path)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    }
  })
  audioEngine.play = async () => {
    ordinaryPlayCalls += 1
  }
  audioEngine.getPlaybackOutputMode = () => 'standard'
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => null
  })

  try {
    resume = usePlayerStore.getState().togglePlay()
    await flushAsyncWork()
    assert.equal(prepareCalls, 1)
    assert.equal(ordinaryPlayCalls, 0)

    await usePlayerStore.getState().playNext()
    assert.deepEqual(loadedPaths, [nextTrack.path])
    assert.equal(usePlayerStore.getState().currentQueueItemId, nextItem.queueId)

    prepareGate.resolve(null)
    await resume
    await flushAsyncWork()
    assert.equal(ordinaryPlayCalls, 0, 'stale A must not start after Parallax preparation resolves')
    assert.equal(usePlayerStore.getState().currentTrack?.path, nextTrack.path)

    const resumeCompletion = diagnostics.find((event) => (
      event.name === 'playback_attempt_completed'
      && event.details?.intent === 'resume'
      && event.details?.trackPath === currentTrack.path
    ))
    assert.ok(resumeCompletion)
    assert.equal(resumeCompletion.details?.outcome, 'superseded')
  } finally {
    prepareGate.resolve(null)
    if (resume) await Promise.allSettled([resume])
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.play = originalPlay
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Standard local playback uses native PCM without reading or Chromium-decoding the file', async () => {
  const { loadOutcome, metrics } = await exerciseStandardPcmRoute('loaded')

  assert.equal(loadOutcome, 'loaded')
  assert.deepEqual(metrics.pcmCalls, [{
    path: '/pcm-route/loaded.flac',
    priority: 'interactive'
  }])
  assert.equal(metrics.fileReadCalls, 0)
  assert.equal(metrics.chromiumDecodeCalls, 0)
  assert.equal(metrics.compatibilityFallbackCalls, 0)
  assert.equal(metrics.backendPlayCalls, 1)
})

test('a failed native PCM decode falls back through Chromium exactly once', async () => {
  const { loadOutcome, metrics } = await exerciseStandardPcmRoute('failed')

  assert.equal(loadOutcome, 'loaded')
  assert.deepEqual(metrics.pcmCalls, [{
    path: '/pcm-route/failed.flac',
    priority: 'interactive'
  }])
  assert.equal(metrics.fileReadCalls, 1)
  assert.equal(metrics.chromiumDecodeCalls, 1)
  assert.equal(metrics.compatibilityFallbackCalls, 0)
  assert.equal(metrics.backendPlayCalls, 1)
})

test('a cancelled native PCM decode is superseded without Chromium fallback', async () => {
  const { loadOutcome, metrics } = await exerciseStandardPcmRoute('cancelled')

  assert.equal(loadOutcome, 'superseded')
  assert.deepEqual(metrics.pcmCalls, [{
    path: '/pcm-route/cancelled.flac',
    priority: 'interactive'
  }])
  assert.equal(metrics.fileReadCalls, 0)
  assert.equal(metrics.chromiumDecodeCalls, 0)
  assert.equal(metrics.compatibilityFallbackCalls, 0)
  assert.equal(metrics.backendPlayCalls, 0)
})

test('successful Standard playback emits one complete playback-attempt timing event', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const track = makeTrack('/diagnostics/success.flac', {
    sourceType: 'local',
    duration: 180,
    sampleRate: 44_100,
    channels: 2
  })
  const diagnostics: Array<{
    name: string
    details?: Record<string, unknown> | null
    options?: { captureSample?: boolean }
  }> = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        diagnostics: {
          logEvent: async (
            event: { name: string; details?: Record<string, unknown> | null },
            options?: { captureSample?: boolean }
          ) => {
            diagnostics.push({ ...event, options })
          }
        },
        onProgressiveLoadProgress: () => () => undefined,
        supersedeTrackLoudness: async () => undefined,
        getAudioFileStat: async () => null,
        decodeLocalAudioToPcm: async () => null,
        loadAudioFile: async () => ({ data: new ArrayBuffer(16) }),
        decodeAudioWithFfmpeg: async () => null,
        library: {
          getListeningHistoryStatus: async () => ({
            generation: 'successful-playback-diagnostics',
            startedAt: null
          }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'successful-playback-diagnostics', startedAt: null }
          }),
          markTrackLatestSyncSeen: async () => undefined
        }
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard', normalizationEnabled: false })
  const originalOn = audioEngine.on
  const originalLoadStandardTrackFromPath = audioEngine.loadStandardTrackFromPath
  const originalLoadAudioData = audioEngine.loadAudioData
  const originalPlay = audioEngine.play
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalGetCurrentTrackChannelCount = audioEngine.getCurrentTrackChannelCount
  const originalGetLastLoadTimings = audioEngine.getLastLoadTimings
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const originalParallax = useParallaxStore.getState()
  const stateChangeListeners: Array<(state: string) => void> = []

  audioEngine.on = (event, callback) => {
    if (event === 'stateChange') stateChangeListeners.push(callback)
    return () => undefined
  }
  audioEngine.loadStandardTrackFromPath = async () => 'loaded'
  audioEngine.loadAudioData = async () => undefined
  audioEngine.play = async () => {
    stateChangeListeners.forEach((listener) => listener('playing'))
  }
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.getCurrentTrackChannelCount = () => 2
  audioEngine.getLastLoadTimings = () => ({
    decodeMs: 12,
    decodeWorkMs: 12,
    analysisMs: 34,
    decodeRequestId: 77,
    validPcmBytes: 72_300_000,
    backingBufferBytes: 72_400_000,
    allocationGrowthCount: 1,
    transportRoute: 'message_port_stream',
    mainHandlerMs: 160,
    binaryResolutionMs: 2,
    probeMs: 18,
    probeCacheStatus: 'hit',
    probeDecodeOverlapEnabled: true,
    probeFfmpegOverlapMs: 14,
    ffmpegMs: 130,
    ffmpegSpawnToFirstPcmMs: 31,
    ffmpegPcmOutputSpanMs: 92,
    ffmpegCloseTailMs: 7,
    pcmAllocationMs: 4,
    initialPcmAllocationMs: 3,
    growthPcmAllocationMs: 1,
    payloadFinalizationMs: 1,
    preloadInvokeMs: 340,
    rendererBridgeCallMs: 370,
    electronIpcResidualMs: 180,
    contextBridgeResidualMs: 30,
    streamChunkCount: 9,
    streamDispatchCopyMs: 8,
    streamDispatchPostMs: 4,
    streamTailMs: 11,
    rendererPcmAssemblyAllocationMs: 2,
    rendererPcmAssemblyCopyMs: 7,
    rendererPortRequestMs: 215,
    streamTransportResidualMs: 55,
    webAudioBufferAllocationMs: 3,
    pcmDeinterleaveMs: 9,
    pcmCommitMs: 2,
    postDeliveryCommitMs: 48,
    standardLoadPipelineMs: 372
  })
  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => 0 })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => null
  })

  try {
    usePlayerStore.getState()._cleanupListeners()
    assert.equal(await usePlayerStore.getState()._loadAndPlayTrack(track), 'loaded')
    await flushAsyncWork()

    const completions = diagnostics.filter((event) => (
      event.name === 'playback_attempt_completed'
      && event.details?.trackPath === track.path
    ))
    assert.equal(completions.length, 1)
    const details = completions[0]?.details
    assert.ok(details)
    assert.equal(details.intent, 'direct')
    assert.equal(details.outcome, 'loaded')
    assert.equal(details.sourceType, 'local')
    assert.equal(details.backend, 'standard')
    assert.equal(typeof details.decodeMs, 'number')
    assert.equal(details.decodeMs, details.standardLoadPipelineMs)
    assert.equal(details.decodeOnlyMs, 12)
    assert.equal(details.decodeWorkMs, 12)
    assert.equal(details.loudnessMs, 34)
    assert.equal(details.decodeRequestId, 77)
    assert.equal(details.probeCacheStatus, 'hit')
    assert.equal(details.probeDecodeOverlapEnabled, true)
    assert.equal(details.probeFfmpegOverlapMs, 14)
    assert.equal(details.ffmpegSpawnToFirstPcmMs, 31)
    assert.equal(details.ffmpegPcmOutputSpanMs, 92)
    assert.equal(details.ffmpegCloseTailMs, 7)
    assert.equal(typeof details.loadRequestId, 'number')
    assert.equal(details.prebufferRequestId, null)
    assert.equal(details.commandToScheduledPlayMs, details.totalCommandToPlayingMs)
    assert.equal(typeof details.totalCommandToPlayingMs, 'number')
    assert.equal(details.configuredOutputDelayMs, useAudioSettingsStore.getState().effectiveDelayMs)

    for (const field of [
      'attemptId',
      'loadRequestId',
      'prebufferRequestId',
      'decodeRequestId',
      'intent',
      'outcome',
      'trackPath',
      'sourceType',
      'backend',
      'queuePreparationMs',
      'selectedTrackHydrationMs',
      'supersededLoadWaitMs',
      'prebufferStatus',
      'fileReadMs',
      'decodeMs',
      'decodeOnlyMs',
      'standardLoadPipelineMs',
      'decodeWorkMs',
      'loudnessMs',
      'backendStartMs',
      'validPcmBytes',
      'backingBufferBytes',
      'allocationGrowthCount',
      'transportRoute',
      'mainHandlerMs',
      'binaryResolutionMs',
      'probeMs',
      'probeCacheStatus',
      'probeDecodeOverlapEnabled',
      'probeFfmpegOverlapMs',
      'ffmpegMs',
      'ffmpegSpawnToFirstPcmMs',
      'ffmpegPcmOutputSpanMs',
      'ffmpegCloseTailMs',
      'pcmAllocationMs',
      'initialPcmAllocationMs',
      'growthPcmAllocationMs',
      'payloadFinalizationMs',
      'preloadInvokeMs',
      'rendererBridgeCallMs',
      'electronIpcResidualMs',
      'contextBridgeResidualMs',
      'streamChunkCount',
      'streamDispatchCopyMs',
      'streamDispatchPostMs',
      'streamTailMs',
      'rendererPcmAssemblyAllocationMs',
      'rendererPcmAssemblyCopyMs',
      'rendererPortRequestMs',
      'streamTransportResidualMs',
      'webAudioBufferAllocationMs',
      'pcmDeinterleaveMs',
      'pcmCommitMs',
      'postDeliveryCommitMs',
      'nativeBinaryResolutionMs',
      'nativeProbeMs',
      'nativeDecodeMs',
      'nativeLoadMs',
      'nativeDeviceStartMs',
      'commandToScheduledPlayMs',
      'totalCommandToPlayingMs',
      'totalAttemptMs',
      'configuredOutputDelayMs'
    ]) {
      assert.equal(Object.hasOwn(details, field), true, `missing playback diagnostic field: ${field}`)
    }

    const trackLoad = diagnostics.find((event) => (
      event.name === 'track_load_success'
      && event.details?.trackPath === track.path
    ))
    assert.ok(trackLoad)
    assert.equal(trackLoad.options?.captureSample, false)
    assert.equal(trackLoad.details?.attemptId, details.attemptId)
    assert.equal(trackLoad.details?.loadRequestId, details.loadRequestId)
    assert.equal(trackLoad.details?.decodeRequestId, details.decodeRequestId)
    assert.equal(trackLoad.details?.probeCacheStatus, details.probeCacheStatus)
    assert.equal(
      trackLoad.details?.probeDecodeOverlapEnabled,
      details.probeDecodeOverlapEnabled
    )
    assert.equal(trackLoad.details?.probeFfmpegOverlapMs, details.probeFfmpegOverlapMs)
    assert.equal(
      trackLoad.details?.ffmpegSpawnToFirstPcmMs,
      details.ffmpegSpawnToFirstPcmMs
    )
    assert.equal(trackLoad.details?.ffmpegPcmOutputSpanMs, details.ffmpegPcmOutputSpanMs)
    assert.equal(trackLoad.details?.ffmpegCloseTailMs, details.ffmpegCloseTailMs)
    assert.equal(trackLoad.details?.decodeMs, trackLoad.details?.standardLoadPipelineMs)
    assert.equal(trackLoad.details?.decodeOnlyMs, trackLoad.details?.decodeWorkMs)
    assert.notEqual(completions[0]?.options?.captureSample, false)
  } finally {
    usePlayerStore.getState()._cleanupListeners()
    await flushAsyncWork()
    audioEngine.on = originalOn
    audioEngine.loadStandardTrackFromPath = originalLoadStandardTrackFromPath
    audioEngine.loadAudioData = originalLoadAudioData
    audioEngine.play = originalPlay
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    audioEngine.getCurrentTrackChannelCount = originalGetCurrentTrackChannelCount
    audioEngine.getLastLoadTimings = originalGetLastLoadTimings
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Pause after Standard decode stopped-state prevents the pending backend play', async () => {
  resetStores()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        library: {
          getListeningHistoryStatus: async () => ({ generation: 'standard-pause-race', startedAt: null }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'standard-pause-race', startedAt: null }
          }),
          markTrackLatestSyncSeen: async () => undefined
        },
        onProgressiveLoadProgress: () => () => undefined,
        getAudioFileStat: async () => null,
        loadAudioFile: async () => ({ data: new ArrayBuffer(16) }),
        decodeAudioWithFfmpeg: async () => null
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard', normalizationEnabled: false })
  const currentTrack = makeTrack('/standard-stopped-race/a.flac', { sourceType: 'local' })
  const targetTrack = makeTrack('/standard-stopped-race/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'standard-stopped-race-a', 'context')
  const targetItem = makeQueueItem(createQueueEntryFromTrack(targetTrack), 'standard-stopped-race-b', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 0,
    duration: currentTrack.duration,
    queueItems: [currentItem, targetItem],
    baseUpcomingQueueIds: [targetItem.queueId],
    upcomingQueueIds: [targetItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  const originalOn = audioEngine.on
  const originalLoadAudioData = audioEngine.loadAudioData
  const originalPlay = audioEngine.play
  const originalPause = audioEngine.pause
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalNeedsLoudness = audioEngine.needsLoudnessAnalysisForLoad
  const originalGetCurrentTrackChannelCount = audioEngine.getCurrentTrackChannelCount
  const ownHasNextBuffered = Object.getOwnPropertyDescriptor(audioEngine, 'hasNextBuffered')
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  const originalParallax = useParallaxStore.getState()
  const prepareGate = createDeferred<null>()
  const stateChangeListeners: Array<(state: string) => void> = []
  let backendPlayCalls = 0
  let pauseCalls = 0
  let prepareCalls = 0
  let transition: Promise<void> | null = null

  audioEngine.on = (event, callback) => {
    if (event === 'stateChange') stateChangeListeners.push(callback)
    return () => undefined
  }
  audioEngine.loadAudioData = async () => {
    stateChangeListeners[0]?.('stopped')
  }
  audioEngine.play = async () => {
    backendPlayCalls += 1
    stateChangeListeners[0]?.('playing')
  }
  audioEngine.pause = () => {
    pauseCalls += 1
    stateChangeListeners[0]?.('paused')
  }
  audioEngine.clearNextBuffer = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'standard'
  audioEngine.needsLoudnessAnalysisForLoad = () => false
  audioEngine.getCurrentTrackChannelCount = () => 2
  Object.defineProperty(audioEngine, 'hasNextBuffered', { configurable: true, get: () => false })
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', { configurable: true, get: () => null })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => {
      prepareCalls += 1
      return prepareGate.promise
    }
  })

  try {
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.getState()._initListeners()
    transition = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(prepareCalls, 1)
    assert.equal(usePlayerStore.getState().currentTrack?.path, targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'stopped')

    usePlayerStore.getState().pause()
    assert.equal(pauseCalls, 1)
    assert.equal(usePlayerStore.getState().playbackState, 'paused')

    prepareGate.resolve(null)
    await transition
    assert.equal(backendPlayCalls, 0, 'Pause must supersede the load before backend play starts')
    assert.equal(usePlayerStore.getState().currentTrack?.path, targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'paused')
  } finally {
    prepareGate.resolve(null)
    if (transition) await Promise.allSettled([transition])
    usePlayerStore.getState()._cleanupListeners()
    await flushAsyncWork()
    audioEngine.on = originalOn
    audioEngine.loadAudioData = originalLoadAudioData
    audioEngine.play = originalPlay
    audioEngine.pause = originalPause
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    audioEngine.needsLoudnessAnalysisForLoad = originalNeedsLoudness
    audioEngine.getCurrentTrackChannelCount = originalGetCurrentTrackChannelCount
    if (ownHasNextBuffered) Object.defineProperty(audioEngine, 'hasNextBuffered', ownHasNextBuffered)
    else delete (audioEngine as unknown as Record<string, unknown>).hasNextBuffered
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Pause after native load stopped-state prevents the pending device play', async () => {
  resetStores()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        library: {
          getListeningHistoryStatus: async () => ({ generation: 'native-pause-race', startedAt: null }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'native-pause-race', startedAt: null }
          }),
          markTrackLatestSyncSeen: async () => undefined
        },
        onProgressiveLoadProgress: () => () => undefined
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect', normalizationEnabled: false })
  const currentTrack = makeTrack('/native-stopped-race/a.flac', { sourceType: 'local' })
  const targetTrack = makeTrack('/native-stopped-race/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'native-stopped-race-a', 'context')
  const targetItem = makeQueueItem(createQueueEntryFromTrack(targetTrack), 'native-stopped-race-b', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 0,
    duration: currentTrack.duration,
    queueItems: [currentItem, targetItem],
    baseUpcomingQueueIds: [targetItem.queueId],
    upcomingQueueIds: [targetItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  const originalOn = audioEngine.on
  const originalLoadTrackFromPath = audioEngine.loadTrackFromPath
  const originalPlay = audioEngine.play
  const originalPause = audioEngine.pause
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownHasNextBuffered = Object.getOwnPropertyDescriptor(audioEngine, 'hasNextBuffered')
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const originalParallax = useParallaxStore.getState()
  const prepareGate = createDeferred<null>()
  const stateChangeListeners: Array<(state: string) => void> = []
  let backendPlayCalls = 0
  let pauseCalls = 0
  let prepareCalls = 0
  let transition: Promise<void> | null = null

  audioEngine.on = (event, callback) => {
    if (event === 'stateChange') stateChangeListeners.push(callback)
    return () => undefined
  }
  audioEngine.loadTrackFromPath = async () => {
    stateChangeListeners[0]?.('stopped')
    return {
      playbackSequence: 1,
      sampleRate: 96_000,
      channels: 2,
      sampleFormat: 's24',
      duration: 180
    }
  }
  audioEngine.play = async () => {
    backendPlayCalls += 1
    stateChangeListeners[0]?.('playing')
  }
  audioEngine.pause = async () => {
    pauseCalls += 1
    stateChangeListeners[0]?.('paused')
  }
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  Object.defineProperty(audioEngine, 'hasNextBuffered', { configurable: true, get: () => false })
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', { configurable: true, get: () => null })
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => {
      prepareCalls += 1
      return prepareGate.promise
    }
  })

  try {
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.getState()._initListeners()
    transition = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.equal(prepareCalls, 1)
    assert.equal(usePlayerStore.getState().currentTrack?.path, targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'stopped')

    usePlayerStore.getState().pause()
    await flushAsyncWork()
    assert.equal(pauseCalls, 0, 'native pause must remain serialized behind the active transition')

    prepareGate.resolve(null)
    await transition
    await flushAsyncWork()
    assert.equal(backendPlayCalls, 0, 'Pause must supersede native load before device play starts')
    assert.equal(pauseCalls, 1)
    assert.equal(usePlayerStore.getState().currentTrack?.path, targetTrack.path)
    assert.equal(usePlayerStore.getState().playbackState, 'paused')
  } finally {
    prepareGate.resolve(null)
    if (transition) await Promise.allSettled([transition])
    await flushAsyncWork()
    usePlayerStore.getState()._cleanupListeners()
    await flushAsyncWork()
    audioEngine.on = originalOn
    audioEngine.loadTrackFromPath = originalLoadTrackFromPath
    audioEngine.play = originalPlay
    audioEngine.pause = originalPause
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownHasNextBuffered) Object.defineProperty(audioEngine, 'hasNextBuffered', ownHasNextBuffered)
    else delete (audioEngine as unknown as Record<string, unknown>).hasNextBuffered
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({
      playbackOutputMode: originalSettings.playbackOutputMode,
      normalizationEnabled: originalSettings.normalizationEnabled
    })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('rapid Standard skips coalesce queued loads while preserving every queue transition', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })

  const tracks = ['a', 'b', 'c', 'd'].map((name) => makeTrack(`/rapid/${name}.flac`, {
    sourceType: 'local'
  }))
  const items = tracks.map((track, index) => makeQueueItem(
    createQueueEntryFromTrack(track),
    `rapid-${index}`,
    'context'
  ))
  usePlayerStore.setState({
    currentTrack: tracks[0]!,
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    queueItems: items,
    baseUpcomingQueueIds: items.slice(1).map((item) => item.queueId),
    upcomingQueueIds: items.slice(1).map((item) => item.queueId),
    currentQueueItemId: items[0]!.queueId,
    playbackHistory: []
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const firstLoad = createDeferred<'loaded' | 'superseded'>()
  const finalLoad = createDeferred<'loaded' | 'superseded'>()
  const loadCalls: string[] = []
  const scheduledTimers = new Map<number, { callback: TimerHandler; delay: number }>()
  let nextTimerId = 0

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadCalls.push(track.path)
      if (track.path === tracks[1]!.path) return firstLoad.promise
      if (track.path === tracks[3]!.path) return finalLoad.promise
      return 'loaded'
    }
  })
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    scheduledTimers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(id as unknown as number)
  }) as typeof clearTimeout

  try {
    const firstSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork(1)
    assert.deepEqual(loadCalls, [tracks[1]!.path], 'the first Standard target should start immediately')

    const intermediateSkip = usePlayerStore.getState().playNext()
    const finalSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork(1)
    assert.deepEqual(loadCalls, [tracks[1]!.path], 'follow-up targets should wait for the coalescing window')

    const coalescingTimer = [...scheduledTimers.entries()].find(([, timer]) => timer.delay === 75)
    assert.ok(coalescingTimer)
    scheduledTimers.delete(coalescingTimer[0])
    assert.equal(typeof coalescingTimer[1].callback, 'function')
    if (typeof coalescingTimer[1].callback === 'function') coalescingTimer[1].callback()
    await flushAsyncWork(1)

    assert.deepEqual(loadCalls, [tracks[1]!.path, tracks[3]!.path])
    assert.equal(loadCalls.includes(tracks[2]!.path), false, 'the replaced intermediate target must never load')
    assert.equal(usePlayerStore.getState().currentQueueItemId, items[3]!.queueId)
    assert.deepEqual(
      usePlayerStore.getState().playbackHistory.map((entry) => entry.item.entry.path),
      tracks.slice(0, 3).map((track) => track.path)
    )

    finalLoad.resolve('loaded')
    await finalSkip
    firstLoad.resolve('superseded')
    await firstSkip
    await intermediateSkip
  } finally {
    firstLoad.resolve('superseded')
    finalLoad.resolve('superseded')
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('Pause cancels active and coalesced Standard skips and reconciles the final committed target', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
  const tracks = ['a', 'b', 'c'].map((name) => makeTrack(`/pause-standard/${name}.flac`, {
    sourceType: 'local'
  }))
  const items = tracks.map((track, index) => makeQueueItem(
    createQueueEntryFromTrack(track),
    `pause-standard-${index}`,
    'context'
  ))
  usePlayerStore.setState({
    currentTrack: tracks[0]!,
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    queueItems: items,
    baseUpcomingQueueIds: items.slice(1).map((item) => item.queueId),
    upcomingQueueIds: items.slice(1).map((item) => item.queueId),
    currentQueueItemId: items[0]!.queueId,
    playbackHistory: []
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPause = audioEngine.pause
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const firstLoad = createDeferred<void>()
  const loadCalls: string[] = []
  const timers = new Map<number, { callback: TimerHandler; delay: number }>()
  let nextTimerId = 0
  let pauseCalls = 0
  let activeLoadObservedCancellation = false

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadCalls.push(track.path)
      if (track.path === tracks[1]!.path) {
        await firstLoad.promise
        activeLoadObservedCancellation = pauseCalls > 0
        return activeLoadObservedCancellation ? 'superseded' : 'loaded'
      }
      return 'loaded'
    }
  })
  audioEngine.pause = () => {
    pauseCalls += 1
  }
  audioEngine.getPlaybackOutputMode = () => 'standard'
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId
    timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number)
  }) as typeof clearTimeout

  try {
    const activeSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork(1)
    assert.deepEqual(loadCalls, [tracks[1]!.path])

    let pendingSkipFinished = false
    const pendingSkip = usePlayerStore.getState().playNext().then(() => {
      pendingSkipFinished = true
    })
    await flushAsyncWork(1)
    assert.equal(usePlayerStore.getState().currentQueueItemId, items[2]!.queueId)
    assert.ok([...timers.values()].some((timer) => timer.delay === 75))

    usePlayerStore.getState().pause()
    await flushAsyncWork(1)
    const pausedState = usePlayerStore.getState()
    assert.equal(pendingSkipFinished, true, 'the coalesced target must be canceled immediately')
    assert.equal(timers.size, 0)
    assert.deepEqual(loadCalls, [tracks[1]!.path], 'the pending final target must never start')
    assert.equal(pausedState.currentQueueItemId, items[2]!.queueId)
    assert.equal(pausedState.currentTrack?.path, tracks[2]!.path, 'the committed queue target wins over stale currentTrack')
    assert.equal(pausedState.playbackState, 'paused')
    assert.equal(pausedState.restoredTrackNeedsLoad, true)

    firstLoad.resolve()
    await Promise.all([activeSkip, pendingSkip])
    assert.equal(activeLoadObservedCancellation, true)
    assert.deepEqual(loadCalls, [tracks[1]!.path])
    assert.equal(usePlayerStore.getState().currentTrack?.path, tracks[2]!.path)
  } finally {
    firstLoad.resolve()
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.pause = originalPause
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

for (const interruption of ['Pause', 'Stop'] as const) {
  test(`rapid direct loads interrupted by ${interruption} retain the final standalone target`, async () => {
    resetStores()
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?window=test' },
        electronAPI: {}
      }
    })
    const originalSettings = useAudioSettingsStore.getState()
    useAudioSettingsStore.setState({ playbackOutputMode: 'standard' })
    const queueTrack = makeTrack(`/direct-${interruption.toLowerCase()}/a.flac`, { sourceType: 'local' })
    const activeDirectTrack = makeTrack(`/direct-${interruption.toLowerCase()}/b.flac`, { sourceType: 'local' })
    const finalDirectTrack = makeTrack(`/direct-${interruption.toLowerCase()}/c.flac`, { sourceType: 'local' })
    const queueItem = makeQueueItem(
      createQueueEntryFromTrack(queueTrack),
      `direct-${interruption.toLowerCase()}-queue`,
      'context'
    )
    usePlayerStore.setState({
      currentTrack: queueTrack,
      playbackState: 'playing',
      currentTime: 0,
      duration: queueTrack.duration,
      queueItems: [queueItem],
      baseUpcomingQueueIds: [],
      upcomingQueueIds: [],
      currentQueueItemId: queueItem.queueId,
      playbackHistory: []
    })

    const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
    const originalPause = audioEngine.pause
    const originalStop = audioEngine.stop
    const originalClearNextBuffer = audioEngine.clearNextBuffer
    const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
    const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
    const originalHasDecodedAudioBuffer = audioEngine.hasDecodedAudioBuffer
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const activeDirectGate = createDeferred<void>()
    const timers = new Map<number, { callback: TimerHandler; delay: number }>()
    const loadPaths: string[] = []
    let nextTimerId = 0
    let controlCalls = 0

    usePlayerStore.setState({
      _loadAndPlayTrack: async (track) => {
        loadPaths.push(track.path)
        if (track.path === activeDirectTrack.path) {
          usePlayerStore.setState({ currentTrack: track, playbackState: 'loading' })
          await activeDirectGate.promise
          return 'superseded'
        }
        assert.equal(track.path, finalDirectTrack.path)
        usePlayerStore.setState({
          currentTrack: track,
          playbackState: 'playing',
          restoredTrackNeedsLoad: false,
          restoredPlaybackTime: null
        })
        return 'loaded'
      }
    })
    const runControl = (): void => {
      controlCalls += 1
    }
    audioEngine.pause = runControl
    audioEngine.stop = runControl
    audioEngine.clearNextBuffer = () => undefined
    audioEngine.cancelPendingNativeDecode = () => undefined
    audioEngine.getPlaybackOutputMode = () => 'standard'
    audioEngine.hasDecodedAudioBuffer = () => false
    globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
      const id = ++nextTimerId
      timers.set(id, { callback, delay })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number)
    }) as typeof clearTimeout

    try {
      const activeDirect = usePlayerStore.getState().loadTrackFromPath(activeDirectTrack)
      await flushAsyncWork()
      assert.deepEqual(loadPaths, [activeDirectTrack.path])
      assert.equal(usePlayerStore.getState().currentTrack?.path, activeDirectTrack.path)

      const pendingFinalDirect = usePlayerStore.getState().loadTrackFromPath(finalDirectTrack)
      await flushAsyncWork()
      assert.ok([...timers.values()].some((timer) => timer.delay === 75))
      assert.deepEqual(loadPaths, [activeDirectTrack.path], 'C should remain the pending direct target')

      if (interruption === 'Pause') usePlayerStore.getState().pause()
      else usePlayerStore.getState().stop()
      assert.equal(await pendingFinalDirect, false)
      await flushAsyncWork()

      let interruptedState = usePlayerStore.getState()
      assert.equal(interruptedState.currentTrack?.path, finalDirectTrack.path)
      assert.equal(interruptedState.playbackState, interruption === 'Pause' ? 'paused' : 'stopped')
      assert.equal(interruptedState.restoredTrackNeedsLoad, true)
      assert.equal(timers.size, 0)

      // The canceled C promise settles on a microtask. Repeating the control after
      // that point proves it did not erase C's standalone identity and expose stale A.
      if (interruption === 'Pause') usePlayerStore.getState().pause()
      else usePlayerStore.getState().stop()
      interruptedState = usePlayerStore.getState()
      assert.equal(interruptedState.currentTrack?.path, finalDirectTrack.path)
      assert.notEqual(interruptedState.currentTrack?.path, queueTrack.path)

      activeDirectGate.resolve()
      assert.equal(await activeDirect, false)
      await flushAsyncWork()

      await usePlayerStore.getState().togglePlay()
      assert.deepEqual(loadPaths, [activeDirectTrack.path, finalDirectTrack.path])
      assert.equal(usePlayerStore.getState().currentTrack?.path, finalDirectTrack.path)
      assert.equal(usePlayerStore.getState().playbackState, 'playing')
      assert.ok(controlCalls >= 2)
    } finally {
      activeDirectGate.resolve()
      await flushAsyncWork()
      usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
      audioEngine.pause = originalPause
      audioEngine.stop = originalStop
      audioEngine.clearNextBuffer = originalClearNextBuffer
      audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
      audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
      audioEngine.hasDecodedAudioBuffer = originalHasDecodedAudioBuffer
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  })
}

test('rapid bit-perfect skips serialize native-style work and replace the pending target', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const tracks = ['a', 'b', 'c', 'd'].map((name) => makeTrack(`/rapid-native/${name}.flac`, {
    sourceType: 'local'
  }))
  const items = tracks.map((track, index) => makeQueueItem(
    createQueueEntryFromTrack(track),
    `rapid-native-${index}`,
    'context'
  ))
  usePlayerStore.setState({
    currentTrack: tracks[0]!,
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    queueItems: items,
    baseUpcomingQueueIds: items.slice(1).map((item) => item.queueId),
    upcomingQueueIds: items.slice(1).map((item) => item.queueId),
    currentQueueItemId: items[0]!.queueId,
    playbackHistory: []
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const firstHandshake = createDeferred<void>()
  const finalHandshake = createDeferred<void>()
  const loadCalls: string[] = []
  let activeLoads = 0
  let maxActiveLoads = 0
  let firstHandshakeSettled = false
  let finalStartedBeforeFirstSettled = false
  let cancellationCalls = 0

  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadCalls.push(track.path)
      activeLoads += 1
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
      try {
        if (track.path === tracks[1]!.path) {
          await firstHandshake.promise
          firstHandshakeSettled = true
        } else if (track.path === tracks[3]!.path) {
          finalStartedBeforeFirstSettled = !firstHandshakeSettled
          await finalHandshake.promise
        }
        return 'loaded'
      } finally {
        activeLoads -= 1
      }
    }
  })
  audioEngine.cancelPendingNativeDecode = () => {
    cancellationCalls += 1
  }

  try {
    const firstSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork(1)
    assert.deepEqual(loadCalls, [tracks[1]!.path])

    const intermediateSkip = usePlayerStore.getState().playNext()
    const finalSkip = usePlayerStore.getState().playNext()
    await flushAsyncWork()
    assert.deepEqual(loadCalls, [tracks[1]!.path], 'pending native targets must wait for the active handshake')
    assert.equal(loadCalls.includes(tracks[2]!.path), false)

    firstHandshake.resolve()
    await firstSkip
    await flushAsyncWork()
    assert.deepEqual(loadCalls, [tracks[1]!.path, tracks[3]!.path])
    assert.equal(finalStartedBeforeFirstSettled, false)
    assert.equal(maxActiveLoads, 1, 'native-style load/start calls must never overlap')

    finalHandshake.resolve()
    await Promise.all([intermediateSkip, finalSkip])
    assert.equal(activeLoads, 0)
    assert.ok(cancellationCalls >= 1, 'obsolete native decode work should receive cancellation')
  } finally {
    firstHandshake.resolve()
    finalHandshake.resolve()
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

for (const interruption of ['Pause', 'Stop'] as const) {
  test(`${interruption} defers native control until an active bit-perfect transition settles`, async () => {
    resetStores()
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?window=test' },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        electronAPI: {
          onProgressiveLoadProgress: () => () => undefined
        }
      }
    })

    const originalSettings = useAudioSettingsStore.getState()
    useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
    const currentTrack = makeTrack(`/native-${interruption.toLowerCase()}/current.flac`, {
      sourceType: 'local'
    })
    const targetTrack = makeTrack(`/native-${interruption.toLowerCase()}/target.flac`, {
      sourceType: 'local'
    })
    const currentItem = makeQueueItem(
      createQueueEntryFromTrack(currentTrack),
      `native-${interruption.toLowerCase()}-current`,
      'context'
    )
    const targetItem = makeQueueItem(
      createQueueEntryFromTrack(targetTrack),
      `native-${interruption.toLowerCase()}-target`,
      'context'
    )
    usePlayerStore.setState({
      currentTrack,
      playbackState: 'playing',
      currentTime: 0,
      duration: 180,
      queueItems: [currentItem, targetItem],
      baseUpcomingQueueIds: [targetItem.queueId],
      upcomingQueueIds: [targetItem.queueId],
      currentQueueItemId: currentItem.queueId,
      playbackHistory: [],
      restoredTrackNeedsLoad: false,
      restoredPlaybackTime: null
    })

    const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
    const originalPause = audioEngine.pause
    const originalStop = audioEngine.stop
    const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
    const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
    const originalOn = audioEngine.on
    const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
    const activeTransition = createDeferred<void>()
    let transitionSettled = false
    let nativeControlCalls = 0
    let nativeControlRanBeforeSettle = false
    let cancellationCalls = 0
    let stateChangeListener: ((...args: unknown[]) => void) | null = null

    usePlayerStore.setState({
      _loadAndPlayTrack: async () => {
        await activeTransition.promise
        transitionSettled = true
        return 'superseded'
      }
    })
    const emitStoppedState = (): void => {
      nativeControlCalls += 1
      nativeControlRanBeforeSettle = !transitionSettled
      stateChangeListener?.('stopped')
    }
    audioEngine.pause = emitStoppedState
    audioEngine.stop = emitStoppedState
    audioEngine.cancelPendingNativeDecode = () => {
      cancellationCalls += 1
    }
    audioEngine.getPlaybackOutputMode = () => 'bitperfect'
    audioEngine.on = (event, callback) => {
      if (event === 'stateChange') stateChangeListener = callback
      return () => undefined
    }
    Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
      configurable: true,
      get: () => null
    })

    try {
      usePlayerStore.getState()._initListeners()
      const skip = usePlayerStore.getState().playNext()
      await flushAsyncWork()
      assert.equal(usePlayerStore.getState().currentQueueItemId, targetItem.queueId)

      if (interruption === 'Pause') usePlayerStore.getState().pause()
      else usePlayerStore.getState().stop()
      await flushAsyncWork()
      assert.equal(nativeControlCalls, 0, 'native control must not overlap the active transition handshake')
      assert.equal(usePlayerStore.getState().currentTrack?.path, currentTrack.path)

      activeTransition.resolve()
      await skip
      await flushAsyncWork()
      const reconciledState = usePlayerStore.getState()
      assert.equal(nativeControlCalls, 1)
      assert.equal(nativeControlRanBeforeSettle, false)
      assert.ok(cancellationCalls >= 1)
      assert.equal(reconciledState.currentQueueItemId, targetItem.queueId)
      assert.equal(reconciledState.currentTrack?.path, targetTrack.path)
      assert.equal(reconciledState.playbackState, interruption === 'Pause' ? 'paused' : 'stopped')
      assert.equal(reconciledState.restoredTrackNeedsLoad, true)
      assert.equal(reconciledState.restoredPlaybackTime, 0)
    } finally {
      activeTransition.resolve()
      await flushAsyncWork()
      usePlayerStore.getState()._cleanupListeners()
      usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
      audioEngine.pause = originalPause
      audioEngine.stop = originalStop
      audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
      audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
      audioEngine.on = originalOn
      if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
      else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
      useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  })
}

for (const interruption of ['Pause', 'Stop'] as const) {
  test(`${interruption} native control Promise blocks a subsequent native load`, async () => {
    resetStores()
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?window=test' },
        electronAPI: {}
      }
    })

    const originalSettings = useAudioSettingsStore.getState()
    useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
    const tracks = ['a', 'b', 'c'].map((name) => makeTrack(
      `/native-control-${interruption.toLowerCase()}/${name}.flac`,
      { sourceType: 'local' }
    ))
    const items = tracks.map((track, index) => makeQueueItem(
      createQueueEntryFromTrack(track),
      `native-control-${interruption.toLowerCase()}-${index}`,
      'context'
    ))
    usePlayerStore.setState({
      currentTrack: tracks[0]!,
      playbackState: 'playing',
      currentTime: 0,
      duration: 180,
      queueItems: items,
      baseUpcomingQueueIds: items.slice(1).map((item) => item.queueId),
      upcomingQueueIds: items.slice(1).map((item) => item.queueId),
      currentQueueItemId: items[0]!.queueId,
      playbackHistory: [],
      restoredTrackNeedsLoad: false,
      restoredPlaybackTime: null
    })

    const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
    const originalPause = audioEngine.pause
    const originalStop = audioEngine.stop
    const originalPlay = audioEngine.play
    const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
    const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
    const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
    const activeTransition = createDeferred<void>()
    const nativeControl = createDeferred<void>()
    const operationOrder: string[] = []
    const loadPaths: string[] = []
    let initialLoad = true
    let nativeOperationCount = 0
    let maxNativeOperationCount = 0
    let nativeControlStarted = false
    let ordinaryPlayCalls = 0

    usePlayerStore.setState({
      _loadAndPlayTrack: async (track) => {
        nativeOperationCount += 1
        maxNativeOperationCount = Math.max(maxNativeOperationCount, nativeOperationCount)
        loadPaths.push(track.path)
        operationOrder.push(`load:${track.path}`)
        try {
          if (initialLoad) {
            initialLoad = false
            await activeTransition.promise
            return 'superseded'
          }
          return 'loaded'
        } finally {
          nativeOperationCount -= 1
        }
      }
    })
    const runDeferredControl = async (): Promise<void> => {
      nativeOperationCount += 1
      maxNativeOperationCount = Math.max(maxNativeOperationCount, nativeOperationCount)
      nativeControlStarted = true
      operationOrder.push(`control:${interruption}`)
      try {
        await nativeControl.promise
      } finally {
        nativeOperationCount -= 1
      }
    }
    audioEngine.pause = runDeferredControl
    audioEngine.stop = runDeferredControl
    audioEngine.play = async () => {
      ordinaryPlayCalls += 1
    }
    audioEngine.cancelPendingNativeDecode = () => undefined
    audioEngine.getPlaybackOutputMode = () => 'bitperfect'
    Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
      configurable: true,
      get: () => null
    })

    try {
      const firstSkip = usePlayerStore.getState().playNext()
      await flushAsyncWork()
      assert.deepEqual(loadPaths, [tracks[1]!.path])

      if (interruption === 'Pause') usePlayerStore.getState().pause()
      else usePlayerStore.getState().stop()
      activeTransition.resolve()
      await firstSkip
      await flushAsyncWork()
      assert.equal(nativeControlStarted, true)
      assert.equal(nativeOperationCount, 1)

      let followUpFinished = false
      const followUp = (
        interruption === 'Pause'
          ? usePlayerStore.getState().togglePlay()
          : usePlayerStore.getState().playNext()
      ).then(() => {
        followUpFinished = true
      })
      await flushAsyncWork()

      const expectedFollowUpPath = interruption === 'Pause' ? tracks[1]!.path : tracks[2]!.path
      assert.equal(followUpFinished, false)
      assert.deepEqual(loadPaths, [tracks[1]!.path], 'the follow-up load must wait behind native control')
      assert.equal(ordinaryPlayCalls, 0, 'quick resume must reload the committed target, not play the retained old buffer')

      nativeControl.resolve()
      await followUp
      assert.deepEqual(loadPaths, [tracks[1]!.path, expectedFollowUpPath])
      assert.equal(maxNativeOperationCount, 1)
      assert.deepEqual(operationOrder, [
        `load:${tracks[1]!.path}`,
        `control:${interruption}`,
        `load:${expectedFollowUpPath}`
      ])
      assert.equal(ordinaryPlayCalls, 0)
    } finally {
      activeTransition.resolve()
      nativeControl.resolve()
      await flushAsyncWork()
      usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
      audioEngine.pause = originalPause
      audioEngine.stop = originalStop
      audioEngine.play = originalPlay
      audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
      audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
      if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
      else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
      useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as Record<string, unknown>).window
      resetStores()
    }
  })
}

test('stale lifecycle events cannot double-advance a duplicate-path native target behind a barrier', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        library: {
          getListeningHistoryStatus: async () => ({ generation: 'duplicate-native-race', startedAt: null }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'duplicate-native-race', startedAt: null }
          })
        },
        onProgressiveLoadProgress: () => () => undefined
      }
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const duplicatePath = '/duplicate-native/same.flac'
  const firstDuplicate = makeTrack(duplicatePath, { id: 'duplicate-first', title: 'Duplicate first' })
  const secondDuplicate = makeTrack(duplicatePath, { id: 'duplicate-second', title: 'Duplicate second' })
  const followingTrack = makeTrack('/duplicate-native/following.flac', { title: 'Following' })
  const firstItem = makeQueueItem(createQueueEntryFromTrack(firstDuplicate), 'duplicate-native-first', 'context')
  const secondItem = makeQueueItem(createQueueEntryFromTrack(secondDuplicate), 'duplicate-native-second', 'context')
  const followingItem = makeQueueItem(createQueueEntryFromTrack(followingTrack), 'duplicate-native-following', 'context')
  usePlayerStore.setState({
    currentTrack: firstDuplicate,
    playbackState: 'playing',
    currentTime: 0,
    duration: firstDuplicate.duration,
    queueItems: [firstItem, secondItem, followingItem],
    baseUpcomingQueueIds: [secondItem.queueId, followingItem.queueId],
    upcomingQueueIds: [secondItem.queueId, followingItem.queueId],
    currentQueueItemId: firstItem.queueId,
    playbackHistory: []
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPause = audioEngine.pause
  const originalOn = audioEngine.on
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const originalParallaxStatus = useParallaxStore.getState().status
  const pauseGate = createDeferred<void>()
  const gaplessListeners: Array<() => void> = []
  const endedListeners: Array<() => void> = []
  const loadedTitles: string[] = []
  let transition: Promise<void> | null = null

  audioEngine.on = (event, callback) => {
    if (event === 'gaplessTransition') gaplessListeners.push(callback)
    if (event === 'ended') endedListeners.push(callback)
    return () => undefined
  }
  audioEngine.pause = async () => {
    await pauseGate.promise
  }
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', { configurable: true, get: () => null })
  useParallaxStore.setState({ status: null })
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      loadedTitles.push(track.title)
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    }
  })

  try {
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.getState()._initListeners()
    assert.equal(gaplessListeners.length, 1)
    assert.equal(endedListeners.length, 1)

    usePlayerStore.getState().pause()
    await flushAsyncWork()
    transition = usePlayerStore.getState().playNext()
    await flushAsyncWork()

    let committedState = usePlayerStore.getState()
    assert.equal(committedState.currentQueueItemId, secondItem.queueId)
    assert.deepEqual(committedState.upcomingQueueIds, [followingItem.queueId])
    assert.deepEqual(committedState.playbackHistory.map((entry) => entry.item.queueId), [firstItem.queueId])
    assert.deepEqual(loadedTitles, [])

    gaplessListeners[0]?.()
    endedListeners[0]?.()
    await flushAsyncWork()

    committedState = usePlayerStore.getState()
    assert.equal(committedState.currentQueueItemId, secondItem.queueId)
    assert.deepEqual(committedState.upcomingQueueIds, [followingItem.queueId])
    assert.deepEqual(committedState.playbackHistory.map((entry) => entry.item.queueId), [firstItem.queueId])
    assert.deepEqual(loadedTitles, [], 'stale callbacks must not start the following item')

    pauseGate.resolve()
    await transition
    assert.deepEqual(loadedTitles, ['Duplicate second'])
    assert.equal(usePlayerStore.getState().currentQueueItemId, secondItem.queueId)
  } finally {
    pauseGate.resolve()
    if (transition) await Promise.allSettled([transition])
    await flushAsyncWork()
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.pause = originalPause
    audioEngine.on = originalOn
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    useParallaxStore.setState({ status: originalParallaxStatus })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a stable native Pause Promise blocks the next bit-perfect load', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const currentTrack = makeTrack('/stable-native-pause/a.flac', { sourceType: 'local' })
  const nextTrack = makeTrack('/stable-native-pause/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'stable-native-pause-a', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'stable-native-pause-b', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    currentTime: 0,
    duration: currentTrack.duration,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: []
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPause = audioEngine.pause
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const pauseGate = createDeferred<void>()
  const operationOrder: string[] = []
  const loadPaths: string[] = []
  let activeNativeOperations = 0
  let maxNativeOperations = 0

  const enterNativeOperation = (): void => {
    activeNativeOperations += 1
    maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
  }
  audioEngine.pause = async () => {
    enterNativeOperation()
    operationOrder.push('pause')
    try {
      await pauseGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', {
    configurable: true,
    get: () => null
  })
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      enterNativeOperation()
      operationOrder.push(`load:${track.path}`)
      loadPaths.push(track.path)
      activeNativeOperations -= 1
      return 'loaded'
    }
  })

  try {
    usePlayerStore.getState().pause()
    await flushAsyncWork()
    assert.equal(activeNativeOperations, 1)
    assert.deepEqual(operationOrder, ['pause'])

    let nextFinished = false
    const next = usePlayerStore.getState().playNext().then(() => {
      nextFinished = true
    })
    await flushAsyncWork()
    assert.equal(nextFinished, false)
    assert.deepEqual(loadPaths, [], 'native Next must wait for a stable-track Pause Promise')

    pauseGate.resolve()
    await next
    assert.deepEqual(loadPaths, [nextTrack.path])
    assert.deepEqual(operationOrder, ['pause', `load:${nextTrack.path}`])
    assert.equal(maxNativeOperations, 1)
  } finally {
    pauseGate.resolve()
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.pause = originalPause
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('public bit-perfect loadTrack waits behind active native transition and control work', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      electronAPI: {
        library: {
          getListeningHistoryStatus: async () => ({ generation: 'public-native-barrier', startedAt: null }),
          checkpointListeningSession: async () => ({
            accepted: true,
            qualifiedNow: false,
            status: { generation: 'public-native-barrier', startedAt: null }
          })
        },
        onProgressiveLoadProgress: () => () => undefined,
        supersedeTrackLoudness: async () => undefined
      }
    }
  })

  const originalSettings = useAudioSettingsStore.getState()
  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalLoadTrackFromPath = audioEngine.loadTrackFromPath
  const originalPause = audioEngine.pause
  const originalStop = audioEngine.stop
  const originalOn = audioEngine.on
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalSupersedeCurrentLoadPreservingPrebuffer = audioEngine.supersedeCurrentLoadPreservingPrebuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const ownHasNextBuffered = Object.getOwnPropertyDescriptor(audioEngine, 'hasNextBuffered')
  const ownNextBufferedTrackPath = Object.getOwnPropertyDescriptor(audioEngine, 'nextBufferedTrackPath')
  const originalParallaxPauseHostPlayback = useParallaxStore.getState().pauseHostPlayback
  const originalParallaxStopHostPlayback = useParallaxStore.getState().stopHostPlayback
  const transitionGate = createDeferred<void>()
  const pauseGate = createDeferred<void>()
  const transitionTrack = makeTrack('/public-native-barrier/transition.flac', { sourceType: 'local' })
  const firstPublicTrack = makeTrack('/public-native-barrier/first.flac', { sourceType: 'local' })
  const secondPublicTrack = makeTrack('/public-native-barrier/second.flac', { sourceType: 'local' })
  const nativeLoadPaths: string[] = []
  let transitionStarted = false
  let pauseStarted = false
  let transition: Promise<boolean> | null = null
  let firstPublicLoad: Promise<boolean> | null = null
  let secondPublicLoad: Promise<boolean> | null = null

  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.supersedeCurrentLoadPreservingPrebuffer = () => undefined
  audioEngine.on = () => () => undefined
  audioEngine.loadTrackFromPath = async (track) => {
    nativeLoadPaths.push(track.path)
    return {
      playbackSequence: nativeLoadPaths.length,
      sampleRate: 96_000,
      channels: 2,
      sampleFormat: 's24',
      duration: track.duration
    }
  }
  audioEngine.pause = async () => {
    pauseStarted = true
    await pauseGate.promise
  }
  audioEngine.stop = async () => undefined
  Object.defineProperty(audioEngine, 'hasNextBuffered', { configurable: true, get: () => false })
  Object.defineProperty(audioEngine, 'nextBufferedTrackPath', { configurable: true, get: () => null })
  useParallaxStore.setState({
    pauseHostPlayback: async () => undefined,
    stopHostPlayback: async () => undefined
  })
  usePlayerStore.setState({
    _loadAndPlayTrack: async () => {
      transitionStarted = true
      await transitionGate.promise
      return 'superseded'
    }
  })

  try {
    transition = usePlayerStore.getState().loadTrackFromPath(transitionTrack)
    await flushAsyncWork()
    assert.equal(transitionStarted, true)

    firstPublicLoad = usePlayerStore.getState().loadTrack(firstPublicTrack, new ArrayBuffer(16))
    await flushAsyncWork()
    assert.deepEqual(nativeLoadPaths, [], 'public loadTrack must wait for the active native transition')

    transitionGate.resolve()
    assert.equal(await transition, false)
    assert.equal(await firstPublicLoad, true)
    assert.deepEqual(nativeLoadPaths, [firstPublicTrack.path])

    usePlayerStore.setState({
      currentTrack: firstPublicTrack,
      playbackState: 'playing'
    })
    usePlayerStore.getState().pause()
    await flushAsyncWork()
    assert.equal(pauseStarted, true)

    secondPublicLoad = usePlayerStore.getState().loadTrack(secondPublicTrack, new ArrayBuffer(16))
    await flushAsyncWork()
    assert.deepEqual(
      nativeLoadPaths,
      [firstPublicTrack.path],
      'public loadTrack must wait for the active native control Promise'
    )

    pauseGate.resolve()
    assert.equal(await secondPublicLoad, true)
    assert.deepEqual(nativeLoadPaths, [firstPublicTrack.path, secondPublicTrack.path])

    usePlayerStore.getState().stop()
    await flushAsyncWork()
  } finally {
    transitionGate.resolve()
    pauseGate.resolve()
    await Promise.allSettled([transition, firstPublicLoad, secondPublicLoad].filter(
      (pending): pending is Promise<boolean> => pending !== null
    ))
    usePlayerStore.getState()._cleanupListeners()
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'stopped',
      _loadAndPlayTrack: originalLoad
    })
    usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
    audioEngine.loadTrackFromPath = originalLoadTrackFromPath
    audioEngine.pause = originalPause
    audioEngine.stop = originalStop
    audioEngine.on = originalOn
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.supersedeCurrentLoadPreservingPrebuffer = originalSupersedeCurrentLoadPreservingPrebuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    if (ownHasNextBuffered) Object.defineProperty(audioEngine, 'hasNextBuffered', ownHasNextBuffered)
    else delete (audioEngine as unknown as Record<string, unknown>).hasNextBuffered
    if (ownNextBufferedTrackPath) Object.defineProperty(audioEngine, 'nextBufferedTrackPath', ownNextBufferedTrackPath)
    else delete (audioEngine as unknown as Record<string, unknown>).nextBufferedTrackPath
    useParallaxStore.setState({
      pauseHostPlayback: originalParallaxPauseHostPlayback,
      stopHostPlayback: originalParallaxStopHostPlayback
    })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a native resume handshake serializes a following context clear and load', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const currentTrack = makeTrack('/native-resume-barrier/a.flac', { sourceType: 'local' })
  const replacementTrack = makeTrack('/native-resume-barrier/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(
    createQueueEntryFromTrack(currentTrack),
    'native-resume-barrier-a',
    'context'
  )
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'paused',
    currentTime: 10,
    duration: currentTrack.duration,
    queueItems: [currentItem],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: currentItem.queueId,
    playbackHistory: [],
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalPlay = audioEngine.play
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalCancelPendingNativeDecode = audioEngine.cancelPendingNativeDecode
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalParallax = useParallaxStore.getState()
  const playHandshake = createDeferred<void>()
  const clearHandshake = createDeferred<void>()
  const operationOrder: string[] = []
  let activeNativeOperations = 0
  let maxNativeOperations = 0
  let contextStart: Promise<void> | null = null
  let resume: Promise<void> | null = null

  const enterOperation = (name: string): void => {
    activeNativeOperations += 1
    maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
    operationOrder.push(name)
  }
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => null
  })
  audioEngine.play = async () => {
    enterOperation('play-handshake')
    try {
      await playHandshake.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.clearNextBuffer = async () => {
    enterOperation('clear-next')
    try {
      await clearHandshake.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.cancelPendingNativeDecode = () => undefined
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      enterOperation(`load:${track.path}`)
      activeNativeOperations -= 1
      usePlayerStore.setState({ currentTrack: track, playbackState: 'playing' })
      return 'loaded'
    }
  })

  try {
    resume = usePlayerStore.getState().togglePlay()
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play-handshake'])
    assert.equal(activeNativeOperations, 1)

    contextStart = usePlayerStore.getState().startPlaybackContext([replacementTrack], 0)
    await flushAsyncWork()
    assert.equal(usePlayerStore.getState().currentTrack?.path, currentTrack.path)
    assert.equal(usePlayerStore.getState().currentQueueItemId, usePlayerStore.getState().queueItems[0]?.queueId)
    assert.deepEqual(operationOrder, ['play-handshake'], 'clear/load must wait for device start')

    playHandshake.resolve()
    await resume
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play-handshake', 'clear-next'])
    assert.equal(activeNativeOperations, 1)

    clearHandshake.resolve()
    await contextStart
    assert.deepEqual(operationOrder, [
      'play-handshake',
      'clear-next',
      `load:${replacementTrack.path}`
    ])
    assert.equal(maxNativeOperations, 1)
    assert.equal(activeNativeOperations, 0)
    assert.equal(usePlayerStore.getState().currentTrack?.path, replacementTrack.path)
  } finally {
    playHandshake.resolve()
    clearHandshake.resolve()
    await Promise.allSettled([resume, contextStart].filter(
      (pending): pending is Promise<void> => pending !== null
    ))
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.play = originalPlay
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.cancelPendingNativeDecode = originalCancelPendingNativeDecode
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback
    })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a native stable-resume handshake serializes a concurrent seek', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { search: '?window=test' }, electronAPI: {} }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const track = makeTrack('/native-resume-seek/a.flac', { sourceType: 'local' })
  usePlayerStore.setState({
    currentTrack: track,
    playbackState: 'paused',
    currentTime: 5,
    duration: track.duration,
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null
  })

  const originalPlay = audioEngine.play
  const originalSeek = audioEngine.seek
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalParallax = useParallaxStore.getState()
  const playGate = createDeferred<void>()
  const seekGate = createDeferred<void>()
  const operationOrder: string[] = []
  let activeNativeOperations = 0
  let maxNativeOperations = 0
  let seekStarted = false
  let resume: Promise<void> | null = null
  let seek: Promise<void> | null = null

  const enterOperation = (name: string): void => {
    activeNativeOperations += 1
    maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
    operationOrder.push(name)
  }
  audioEngine.play = async () => {
    enterOperation('play')
    try {
      await playGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.seek = async () => {
    enterOperation('seek')
    seekStarted = true
    try {
      await seekGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => null,
    prepareHostSeek: async () => null,
    cancelHostNextStream: async () => undefined
  })

  try {
    resume = usePlayerStore.getState().togglePlay()
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play'])

    seek = usePlayerStore.getState().seek(42)
    await flushAsyncWork()
    assert.equal(seekStarted, false, 'native seek must wait behind the active device-start handshake')

    playGate.resolve()
    await resume
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play', 'seek'])

    seekGate.resolve()
    await seek
    assert.equal(maxNativeOperations, 1)
    assert.equal(activeNativeOperations, 0)
  } finally {
    playGate.resolve()
    seekGate.resolve()
    await Promise.allSettled([resume, seek].filter(
      (pending): pending is Promise<void> => pending !== null
    ))
    audioEngine.play = originalPlay
    audioEngine.seek = originalSeek
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback,
      prepareHostSeek: originalParallax.prepareHostSeek,
      cancelHostNextStream: originalParallax.cancelHostNextStream
    })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('a generic native clear-next waits behind a stable-resume handshake', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { search: '?window=test' }, electronAPI: {} }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })
  const currentTrack = makeTrack('/native-resume-clear/a.flac', { sourceType: 'local' })
  const nextTrack = makeTrack('/native-resume-clear/b.flac', { sourceType: 'local' })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'native-resume-clear-a', 'context')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'native-resume-clear-b', 'context')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'paused',
    currentTime: 5,
    duration: currentTrack.duration,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId,
    restoredTrackNeedsLoad: false,
    restoredPlaybackTime: null
  })

  const originalPlay = audioEngine.play
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const originalParallax = useParallaxStore.getState()
  const playGate = createDeferred<void>()
  const clearGate = createDeferred<void>()
  const operationOrder: string[] = []
  let activeNativeOperations = 0
  let maxNativeOperations = 0
  let clearStarted = false
  let resume: Promise<void> | null = null

  const enterOperation = (name: string): void => {
    activeNativeOperations += 1
    maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
    operationOrder.push(name)
  }
  audioEngine.play = async () => {
    enterOperation('play')
    try {
      await playGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.clearNextBuffer = async () => {
    enterOperation('clear-next')
    clearStarted = true
    try {
      await clearGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  useParallaxStore.setState({
    status: null,
    resumeHostPlayback: async () => null,
    prepareHostPlayback: async () => null,
    cancelHostNextStream: async () => undefined
  })

  try {
    resume = usePlayerStore.getState().togglePlay()
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play'])

    usePlayerStore.getState().toggleShuffle()
    await flushAsyncWork()
    assert.equal(clearStarted, false, 'generic clear-next must wait behind native device start')

    playGate.resolve()
    await resume
    await flushAsyncWork()
    assert.deepEqual(operationOrder, ['play', 'clear-next'])

    clearGate.resolve()
    await flushAsyncWork()
    assert.equal(maxNativeOperations, 1)
    assert.equal(activeNativeOperations, 0)
  } finally {
    playGate.resolve()
    clearGate.resolve()
    if (resume) await Promise.allSettled([resume])
    audioEngine.play = originalPlay
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useParallaxStore.setState({
      status: originalParallax.status,
      resumeHostPlayback: originalParallax.resumeHostPlayback,
      prepareHostPlayback: originalParallax.prepareHostPlayback,
      cancelHostNextStream: originalParallax.cancelHostNextStream
    })
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
  }
})

test('deferred native clearNextBuffer blocks a new context load', async () => {
  resetStores()
  usePlayerStore.getState()._schedulePreBufferNextTrack({ invalidatePending: true })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search: '?window=test' },
      electronAPI: {}
    }
  })
  const originalSettings = useAudioSettingsStore.getState()
  useAudioSettingsStore.setState({ playbackOutputMode: 'bitperfect' })

  const oldTrack = makeTrack('/native-context-clear/old.flac', { sourceType: 'local' })
  const selectedTrack = makeTrack('/native-context-clear/selected.flac', { sourceType: 'local' })
  usePlayerStore.setState({
    currentTrack: oldTrack,
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    queueItems: [],
    baseUpcomingQueueIds: [],
    upcomingQueueIds: [],
    currentQueueItemId: null
  })

  const originalLoad = usePlayerStore.getState()._loadAndPlayTrack
  const originalClearNextBuffer = audioEngine.clearNextBuffer
  const originalGetPlaybackOutputMode = audioEngine.getPlaybackOutputMode
  const clearNextBufferGate = createDeferred<void>()
  const operationOrder: string[] = []
  let activeNativeOperations = 0
  let maxNativeOperations = 0
  let clearCalls = 0
  const loadedPaths: string[] = []

  audioEngine.clearNextBuffer = async () => {
    clearCalls += 1
    activeNativeOperations += 1
    maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
    operationOrder.push('clear')
    try {
      await clearNextBufferGate.promise
    } finally {
      activeNativeOperations -= 1
    }
  }
  audioEngine.getPlaybackOutputMode = () => 'bitperfect'
  usePlayerStore.setState({
    _loadAndPlayTrack: async (track) => {
      activeNativeOperations += 1
      maxNativeOperations = Math.max(maxNativeOperations, activeNativeOperations)
      loadedPaths.push(track.path)
      operationOrder.push(`load:${track.path}`)
      activeNativeOperations -= 1
      return 'loaded'
    }
  })

  try {
    const contextStart = usePlayerStore.getState().startPlaybackContext([selectedTrack], 0)
    await flushAsyncWork()
    assert.equal(clearCalls, 1)
    assert.deepEqual(loadedPaths, [])
    assert.equal(usePlayerStore.getState().currentQueueItemId !== null, true)

    clearNextBufferGate.resolve()
    await contextStart
    assert.deepEqual(loadedPaths, [selectedTrack.path])
    assert.deepEqual(operationOrder, ['clear', `load:${selectedTrack.path}`])
    assert.equal(maxNativeOperations, 1)
  } finally {
    clearNextBufferGate.resolve()
    await flushAsyncWork()
    usePlayerStore.setState({ _loadAndPlayTrack: originalLoad })
    audioEngine.clearNextBuffer = originalClearNextBuffer
    audioEngine.getPlaybackOutputMode = originalGetPlaybackOutputMode
    useAudioSettingsStore.setState({ playbackOutputMode: originalSettings.playbackOutputMode })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as Record<string, unknown>).window
    resetStores()
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

test('gapless prebuffer scheduling is event-driven instead of running on time updates', async () => {
  resetStores()
  const currentTrack = makeTrack('/music/current.flac', { duration: 180 })
  const nextTrack = makeTrack('/music/next.flac', { duration: 180 })
  const currentItem = makeQueueItem(createQueueEntryFromTrack(currentTrack), 'current')
  const nextItem = makeQueueItem(createQueueEntryFromTrack(nextTrack), 'next')
  usePlayerStore.setState({
    currentTrack,
    playbackState: 'playing',
    duration: 180,
    queueItems: [currentItem, nextItem],
    baseUpcomingQueueIds: [nextItem.queueId],
    upcomingQueueIds: [nextItem.queueId],
    currentQueueItemId: currentItem.queueId
  })

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: {
        onProgressiveLoadProgress: () => () => undefined
      }
    }
  })

  const originalSetTimeout = globalThis.setTimeout
  const originalSeek = audioEngine.seek
  const ownCurrentTime = Object.getOwnPropertyDescriptor(audioEngine, 'currentTime')
  const ownDuration = Object.getOwnPropertyDescriptor(audioEngine, 'duration')
  let scheduledTimers = 0
  let engineCurrentTime = 20

  Object.defineProperty(audioEngine, 'currentTime', { configurable: true, get: () => engineCurrentTime })
  Object.defineProperty(audioEngine, 'duration', { configurable: true, get: () => 180 })
  audioEngine.seek = async (time) => {
    engineCurrentTime = time
  }
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    void callback
    void delay
    scheduledTimers += 1
    return scheduledTimers as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const emitAudioEvent = (event: string, ...args: unknown[]) => {
    ;(audioEngine as unknown as { emit: (name: string, ...values: unknown[]) => void }).emit(event, ...args)
  }

  try {
    usePlayerStore.getState()._initListeners()
    emitAudioEvent('timeUpdate', 20)
    assert.equal(scheduledTimers, 0, 'regular clock updates must not rebuild the prebuffer deadline')

    await usePlayerStore.getState().seek(20)
    assert.equal(scheduledTimers, 1, 'a seek must recalculate the prebuffer deadline')

    await usePlayerStore.getState().playPrevious()
    assert.equal(engineCurrentTime, 0, 'Previous restarts the current track after three seconds')
    assert.equal(scheduledTimers, 1, 'an equivalent adaptive prebuffer deadline should be reused')
  } finally {
    usePlayerStore.getState()._cleanupListeners()
    globalThis.setTimeout = originalSetTimeout
    audioEngine.seek = originalSeek
    if (ownCurrentTime) Object.defineProperty(audioEngine, 'currentTime', ownCurrentTime)
    else delete (audioEngine as unknown as Record<string, unknown>).currentTime
    if (ownDuration) Object.defineProperty(audioEngine, 'duration', ownDuration)
    else delete (audioEngine as unknown as Record<string, unknown>).duration
  }
})
