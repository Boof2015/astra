import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import { Track, PlaybackState } from '../types/audio'
import { extractWaveformPeaks } from '../audio/waveformExtractor'
import { useLibraryStore } from './libraryStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore, type ReplayGainMode } from './audioSettingsStore'

interface RemoteLoadProgress {
  path: string
  sourceType: 'subsonic' | 'jellyfin'
  stage: 'downloading'
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  percent: number | null
  done: boolean
  failed: boolean
}

interface PlayerStore {
  // State
  currentTrack: Track | null
  playbackState: PlaybackState
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  waveformData: Float32Array | null
  remoteLoadProgress: RemoteLoadProgress | null
  ffmpegFallbackNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
  } | null
  outputDelayNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
    delayMs: number
    outputLabel: string
  } | null
  associatedOpenNotice: {
    id: number
    trackPath: string
    title: string
    fileCount: number
    sourceLabel: string
  } | null

  // Queue state
  queue: Track[]
  queueIndex: number
  queueSourcePlaylistId: number | null
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'
  shuffledIndices: number[]
  shufflePosition: number

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<boolean>
  play: () => Promise<void>
  pause: () => void
  togglePlay: () => Promise<void>
  stop: () => void
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  toggleMute: () => void
  resetAudioPreferences: () => void

  // Queue actions
  setQueue: (tracks: Track[], startIndex?: number, options?: { sourcePlaylistId?: number | null }) => void
  addToQueue: (track: Track) => void
  addToQueueNext: (track: Track) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  playNext: () => Promise<void>
  playPrevious: () => Promise<void>
  playTrackAt: (index: number) => Promise<void>
  toggleShuffle: () => void
  toggleRepeat: () => void
  getUpcomingTracks: () => Track[]
  getPreviousTracks: () => Track[]
  clearFfmpegFallbackNotice: () => void
  clearOutputDelayNotice: () => void
  showAssociatedOpenNotice: (notice: {
    trackPath: string
    title: string
    fileCount: number
    sourceLabel: string
  }) => void
  clearAssociatedOpenNotice: () => void

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
  _loadAndPlayTrack: (track: Track, options?: { manualStart?: boolean }) => Promise<boolean>
  _preBufferNextTrack: () => Promise<void>
  _getNextIndex: () => number
  _generateShuffleOrder: (currentQueueIndex: number) => void
}

// Waveform cache stored outside zustand to avoid re-renders on cache updates
const waveformCache = new Map<string, Float32Array>()
const SLOW_PATH_THRESHOLD_MS = 1500
const OUTPUT_DELAY_NOTICE_THRESHOLD_MS = 120
const RECENT_PLAY_MIN_SECONDS = 10
const DEFAULT_PLAYER_VOLUME = 0.7
export const PLAYER_VOLUME_STORAGE_KEY = 'astra-player-volume-v1'
const BIT_PERFECT_REMOTE_FALLBACK_MESSAGE = 'Bit-perfect mode is only available for local files. Playback fell back to Standard.'

function isUnavailableRemoteTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  return track.sourceType !== undefined
    && track.sourceType !== 'local'
    && track.isAvailable === false
}

interface RecentPlaySession {
  trackPath: string
  thresholdSeconds: number
  counted: boolean
  allowDbWrite: boolean
  sourcePlaylistId: number | null
}

interface AssociatedAudioMetadata {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  duration?: number
  format?: string
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  artwork?: string
}

function mergeAssociatedTrackMetadata(track: Track, metadata: AssociatedAudioMetadata): Track {
  return {
    ...track,
    title: metadata.title?.trim() || track.title,
    artist: metadata.artist?.trim() || track.artist,
    album: metadata.album?.trim() || track.album,
    albumArtist: metadata.albumArtist ?? track.albumArtist,
    duration: typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration > 0
      ? metadata.duration
      : track.duration,
    format: metadata.format?.trim() || track.format,
    artworkData: metadata.artwork ?? track.artworkData,
    channels: metadata.channels ?? track.channels,
    codec: metadata.codec ?? track.codec,
    codecProfile: metadata.codecProfile ?? track.codecProfile,
    isAtmosJoc: metadata.isAtmosJoc ?? track.isAtmosJoc,
    replayGainTrackDb: metadata.replayGainTrackDb ?? track.replayGainTrackDb,
    replayGainAlbumDb: metadata.replayGainAlbumDb ?? track.replayGainAlbumDb
  }
}

function clampPlayerVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_VOLUME
  return Math.max(0, Math.min(1, value))
}

function readSavedPlayerVolume(): number {
  try {
    const raw = localStorage.getItem(PLAYER_VOLUME_STORAGE_KEY)
    if (raw == null) return DEFAULT_PLAYER_VOLUME
    return clampPlayerVolume(Number(raw))
  } catch {
    return DEFAULT_PLAYER_VOLUME
  }
}

function persistPlayerVolume(volume: number): void {
  try {
    localStorage.setItem(PLAYER_VOLUME_STORAGE_KEY, String(clampPlayerVolume(volume)))
  } catch {
    // Ignore storage failures and continue with in-memory volume.
  }
}

function clearSavedPlayerVolume(): void {
  try {
    localStorage.removeItem(PLAYER_VOLUME_STORAGE_KEY)
  } catch {
    // Ignore storage failures and continue with in-memory volume.
  }
}

const initialPlayerVolume = readSavedPlayerVolume()
audioEngine.setVolume(initialPlayerVolume)

function logSlowPath(label: string, startTime: number, details: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return
  const elapsed = performance.now() - startTime
  if (elapsed <= SLOW_PATH_THRESHOLD_MS) return
  console.warn(`[perf] ${label} slow path (${Math.round(elapsed)}ms)`, details)
}

function toReplayGainDb(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function getReplayGainCandidateDb(
  track: Track | null | undefined,
  replayGainMode: ReplayGainMode
): number | null {
  if (!track) return null

  const trackGainDb = toReplayGainDb(track.replayGainTrackDb)
  const albumGainDb = toReplayGainDb(track.replayGainAlbumDb)

  if (replayGainMode === 'track') {
    return trackGainDb
  }

  if (replayGainMode === 'album') {
    return albumGainDb
  }

  return trackGainDb ?? albumGainDb
}

function shouldUseBitPerfectPath(track: Track | null | undefined): boolean {
  if (!track) return false
  const sourceType = track.sourceType ?? 'local'
  if (sourceType !== 'local') return false
  return useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect'
}

async function ensureCompatiblePlaybackMode(track: Track): Promise<void> {
  const sourceType = track.sourceType ?? 'local'
  if (sourceType === 'local') {
    return
  }

  const audioSettings = useAudioSettingsStore.getState()
  if (audioSettings.playbackOutputMode !== 'bitperfect') {
    return
  }

  await audioSettings.setPlaybackOutputMode('standard')
  useAudioSettingsStore.setState({
    playbackModeStatusMessage: BIT_PERFECT_REMOTE_FALLBACK_MESSAGE
  })
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  // Track if listeners are initialized
  let listenersInitialized = false
  let remoteLoadProgressUnsubscribe: (() => void) | null = null
  let ffmpegFallbackNoticeId = 0
  let outputDelayNoticeId = 0
  let associatedOpenNoticeId = 0
  const associatedMetadataInflight = new Set<string>()
  let pendingManualLoadCueTrack: Track | null = null
  let recentPlaySession: RecentPlaySession | null = null

  const hydrateAssociatedCurrentTrackMetadata = (track: Track): void => {
    if (track.origin !== 'associated-external') {
      return
    }
    if (associatedMetadataInflight.has(track.path)) {
      return
    }

    associatedMetadataInflight.add(track.path)

    void window.electronAPI.getAudioMetadata(track.path)
      .then((metadata) => {
        if (!metadata) {
          return
        }

        const currentState = get()
        const activeTrack = currentState.currentTrack
        if (!activeTrack || activeTrack.path !== track.path || activeTrack.origin !== 'associated-external') {
          return
        }

        const nextTrack = mergeAssociatedTrackMetadata(activeTrack, metadata)
        set({
          currentTrack: nextTrack,
          duration: currentState.duration > 0 ? currentState.duration : nextTrack.duration
        })
      })
      .catch((error) => {
        console.warn(`Failed to hydrate metadata for associated track ${track.path}:`, error)
      })
      .finally(() => {
        associatedMetadataInflight.delete(track.path)
      })
  }

  const getRecentPlayThresholdSeconds = (track: Track | null): number => {
    if (!track || !Number.isFinite(track.duration) || track.duration <= 0) {
      return RECENT_PLAY_MIN_SECONDS
    }
    return Math.min(RECENT_PLAY_MIN_SECONDS, Math.max(0, track.duration))
  }

  const resolveSourcePlaylistIdForTrack = (trackPath: string): number | null => {
    const { queue, queueIndex, queueSourcePlaylistId } = get()
    if (queueSourcePlaylistId === null) return null
    const queuedTrackPath = queue[queueIndex]?.path
    if (queuedTrackPath === trackPath) {
      return queueSourcePlaylistId
    }
    return null
  }

  const clearQueueSourceIfMismatched = (trackPath: string): void => {
    const { queue, queueIndex, queueSourcePlaylistId } = get()
    if (queueSourcePlaylistId === null) return
    const queuedTrackPath = queue[queueIndex]?.path
    if (queuedTrackPath !== trackPath) {
      set({ queueSourcePlaylistId: null })
    }
  }

  const commitRecentPlay = (session: RecentPlaySession): void => {
    if (session.counted) return
    session.counted = true
    if (!session.allowDbWrite) return
    void useLibraryStore.getState().recordPlay(session.trackPath)
    if (session.sourcePlaylistId !== null) {
      void window.electronAPI.library.markPlaylistPlayed(session.sourcePlaylistId)
    }
  }

  const commitRecentPlayNow = (): void => {
    if (!recentPlaySession || recentPlaySession.counted) return
    commitRecentPlay(recentPlaySession)
  }

  const maybeCommitRecentPlay = (time: number): void => {
    if (!recentPlaySession || recentPlaySession.counted) return
    if (time >= recentPlaySession.thresholdSeconds) {
      commitRecentPlay(recentPlaySession)
    }
  }

  const startRecentPlaySession = (trackPath: string): void => {
    const track = get().currentTrack
    const thresholdSeconds = getRecentPlayThresholdSeconds(track)
    recentPlaySession = {
      trackPath,
      thresholdSeconds,
      counted: false,
      allowDbWrite: track?.origin !== 'associated-external',
      sourcePlaylistId: resolveSourcePlaylistIdForTrack(trackPath)
    }
    clearQueueSourceIfMismatched(trackPath)
  }

  const showFfmpegFallbackNotice = (track: Track) => {
    ffmpegFallbackNoticeId += 1
    set({
      ffmpegFallbackNotice: {
        id: ffmpegFallbackNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist
      }
    })
  }

  const showOutputDelayNotice = (track: Track) => {
    const audioSettingsState = useAudioSettingsStore.getState()
    const delayMs = Math.round(audioSettingsState.effectiveDelayMs)
    if (delayMs < OUTPUT_DELAY_NOTICE_THRESHOLD_MS) return

    const outputLabel = resolveOutputDeviceLabel(
      audioSettingsState.selectedDeviceId,
      audioSettingsState.availableDevices,
      {
        defaultRouteFallbackLabel: 'System Default Output',
        selectedFallbackLabel: 'Selected Output'
      }
    ).label

    outputDelayNoticeId += 1
    set({
      outputDelayNotice: {
        id: outputDelayNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist,
        delayMs,
        outputLabel
      }
    })
  }

  const markTrackUnavailableInState = (trackPath: string, reason: string = 'source_unavailable'): void => {
    set((state) => ({
      queue: state.queue.map((queuedTrack) => (
        queuedTrack.path === trackPath
          ? { ...queuedTrack, isAvailable: false, availabilityReason: reason }
          : queuedTrack
      )),
      currentTrack: state.currentTrack && state.currentTrack.path === trackPath
        ? { ...state.currentTrack, isAvailable: false, availabilityReason: reason }
        : state.currentTrack
    }))
  }

  const collectNextCandidateIndices = (): number[] => {
    const { queue, queueIndex, repeat, shuffle, shuffledIndices, shufflePosition } = get()
    if (queue.length === 0) return []

    if (repeat === 'one') {
      return queueIndex >= 0 && queueIndex < queue.length ? [queueIndex] : []
    }

    if (shuffle && shuffledIndices.length > 0) {
      const afterCurrent = shuffledIndices.slice(Math.max(0, shufflePosition + 1))
      if (repeat === 'all') {
        const wrap = shuffledIndices.slice(0, Math.max(0, shufflePosition + 1))
        return [...afterCurrent, ...wrap]
      }
      return afterCurrent
    }

    const linearIndices = queue.map((_, index) => index)
    const afterCurrent = linearIndices.slice(Math.max(0, queueIndex + 1))
    if (repeat === 'all') {
      const wrap = linearIndices.slice(0, Math.max(0, queueIndex + 1))
      return [...afterCurrent, ...wrap]
    }
    return afterCurrent
  }

  const getNextPlayableIndex = (): number => {
    const { queue } = get()
    const candidates = collectNextCandidateIndices()
    for (const candidateIndex of candidates) {
      const candidate = queue[candidateIndex]
      if (!candidate) continue
      if (isUnavailableRemoteTrack(candidate)) continue
      return candidateIndex
    }
    return -1
  }

  return {
    // Initial state
    currentTrack: null,
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    volume: initialPlayerVolume,
    isMuted: false,
    waveformData: null,
    remoteLoadProgress: null,
    ffmpegFallbackNotice: null,
    outputDelayNotice: null,
    associatedOpenNotice: null,

    // Queue state
    queue: [],
    queueIndex: -1,
    queueSourcePlaylistId: null,
    shuffle: false,
    repeat: 'none',
    shuffledIndices: [],
    shufflePosition: 0,

    // Load a track
    loadTrack: async (track: Track, audioData: ArrayBuffer) => {
      const loadStart = performance.now()
      pendingManualLoadCueTrack = null
      // Initialize listeners on first load
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        remoteLoadProgress: null,
        currentTime: 0,
        duration: track.duration
      })

      try {
        await ensureCompatiblePlaybackMode(track)
        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        if (shouldUseBitPerfectPath(track)) {
          const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const result = await audioEngine.loadTrackFromPath(track)
          const decodeMs = Math.round(performance.now() - decodeStart)
          const resolvedTrack: Track = {
            ...track,
            duration: result.duration > 0 ? result.duration : track.duration,
            channels: result.channels ?? track.channels
          }
          set({
            duration: result.duration > 0 ? result.duration : track.duration,
            currentTrack: resolvedTrack,
            remoteLoadProgress: null,
            currentTime: 0
          })
          hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
          pendingManualLoadCueTrack = resolvedTrack
          clearQueueSourceIfMismatched(track.path)
          get()._preBufferNextTrack()
          logSlowPath('loadTrack', loadStart, {
            trackPath: track.path,
            usedNativeBitPerfect: true,
            decodeMs
          })
          return true
        }

        const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
        try {
          await audioEngine.loadAudioData(audioData, { replayGainDb })
        } catch (primaryDecodeError) {
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb })
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const resolvedTrack: Track = {
          ...track,
          channels: detectedChannels ?? track.channels
        }
        set({
          duration: audioEngine.duration,
          currentTrack: resolvedTrack,
          remoteLoadProgress: null,
          currentTime: 0
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        pendingManualLoadCueTrack = resolvedTrack

        clearQueueSourceIfMismatched(track.path)

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          usedFfmpegFallback,
          decodeMs
        })
        return true
      } catch (error) {
        console.error('Failed to load track:', error)
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        set({ playbackState: 'stopped', remoteLoadProgress: null })
        pendingManualLoadCueTrack = null
        return false
      }
    },

    // Playback controls
    play: async () => {
      const previousPlaybackState = get().playbackState
      if (pendingManualLoadCueTrack) {
        showOutputDelayNotice(pendingManualLoadCueTrack)
        pendingManualLoadCueTrack = null
      }
      await audioEngine.play()
      const currentTrack = get().currentTrack
      if ((previousPlaybackState === 'loading' || previousPlaybackState === 'stopped') && currentTrack) {
        startRecentPlaySession(currentTrack.path)
      }
    },

    pause: () => {
      audioEngine.pause()
    },

    togglePlay: async () => {
      await audioEngine.togglePlay()
    },

    stop: () => {
      pendingManualLoadCueTrack = null
      recentPlaySession = null
      audioEngine.stop()
    },

    seek: async (time: number) => {
      await audioEngine.seek(time)
    },

    // Volume controls
    setVolume: (volume: number) => {
      const normalized = clampPlayerVolume(volume)
      audioEngine.setMuted(false)
      audioEngine.setVolume(normalized)
      set({ volume: normalized, isMuted: false })
      persistPlayerVolume(normalized)
    },

    toggleMute: () => {
      audioEngine.toggleMute()
      set({ isMuted: audioEngine.isMuted })
    },

    resetAudioPreferences: () => {
      clearSavedPlayerVolume()
      audioEngine.setVolume(DEFAULT_PLAYER_VOLUME)
      audioEngine.setMuted(false)
      set({ volume: DEFAULT_PLAYER_VOLUME, isMuted: false })
    },

    // Queue actions
    setQueue: (tracks: Track[], startIndex = 0, options?: { sourcePlaylistId?: number | null }) => {
      const { shuffle } = get()
      set({
        queue: tracks,
        queueIndex: startIndex,
        queueSourcePlaylistId: options?.sourcePlaylistId ?? null
      })

      if (shuffle) {
        get()._generateShuffleOrder(startIndex)
      } else {
        set({ shuffledIndices: [], shufflePosition: 0 })
      }
    },

    addToQueue: (track: Track) => {
      const state = get()
      const newQueue = [...state.queue, track]
      const newTrackIndex = newQueue.length - 1

      if (state.shuffle && state.shuffledIndices.length > 0) {
        const insertableStart = state.shufflePosition + 1
        const insertableRange = state.shuffledIndices.length + 1 - insertableStart
        const insertPos = insertableStart + Math.floor(Math.random() * insertableRange)
        const newShuffled = [...state.shuffledIndices]
        newShuffled.splice(insertPos, 0, newTrackIndex)
        set({ queue: newQueue, shuffledIndices: newShuffled })
      } else {
        set({ queue: newQueue })
      }
    },

    addToQueueNext: (track: Track) => {
      const state = get()
      const newQueue = [...state.queue]
      const insertionPoint = state.queueIndex + 1
      newQueue.splice(insertionPoint, 0, track)

      if (state.shuffle && state.shuffledIndices.length > 0) {
        // Increment indices >= insertion point (they shifted in the queue array)
        const newShuffled = state.shuffledIndices.map(idx =>
          idx >= insertionPoint ? idx + 1 : idx
        )
        // Insert the new track right after current in shuffle order
        newShuffled.splice(state.shufflePosition + 1, 0, insertionPoint)
        set({ queue: newQueue, shuffledIndices: newShuffled })
      } else {
        set({ queue: newQueue })
      }

      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    removeFromQueue: (index: number) => {
      const state = get()
      if (index < 0 || index >= state.queue.length) return

      const newQueue = state.queue.filter((_, i) => i !== index)
      let newQueueIndex = state.queueIndex

      if (index < state.queueIndex) {
        newQueueIndex = state.queueIndex - 1
      } else if (index === state.queueIndex) {
        if (newQueueIndex >= newQueue.length) {
          newQueueIndex = newQueue.length - 1
        }
      }

      if (state.shuffle && state.shuffledIndices.length > 0) {
        const removedShufflePos = state.shuffledIndices.indexOf(index)
        let newShuffled = state.shuffledIndices.filter(idx => idx !== index)
        newShuffled = newShuffled.map(idx => idx > index ? idx - 1 : idx)

        let newShufflePos = state.shufflePosition
        if (removedShufflePos !== -1 && removedShufflePos < state.shufflePosition) {
          newShufflePos = state.shufflePosition - 1
        }
        if (newShufflePos >= newShuffled.length) {
          newShufflePos = Math.max(0, newShuffled.length - 1)
        }

        set({
          queue: newQueue,
          queueIndex: newQueueIndex,
          shuffledIndices: newShuffled,
          shufflePosition: newShufflePos
        })
      } else {
        set({ queue: newQueue, queueIndex: newQueueIndex })
      }

      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    moveInQueue: (fromIndex: number, toIndex: number) => {
      const state = get()
      if (fromIndex === toIndex) return

      if (state.shuffle && state.shuffledIndices.length > 0) {
        // When shuffle is on, reorder within shuffledIndices
        if (fromIndex < 0 || fromIndex >= state.shuffledIndices.length) return
        if (toIndex < 0 || toIndex >= state.shuffledIndices.length) return

        const newShuffled = [...state.shuffledIndices]
        const [removed] = newShuffled.splice(fromIndex, 1)
        newShuffled.splice(toIndex, 0, removed)

        let newShufflePos = state.shufflePosition
        if (state.shufflePosition === fromIndex) {
          newShufflePos = toIndex
        } else if (fromIndex < state.shufflePosition && toIndex >= state.shufflePosition) {
          newShufflePos = state.shufflePosition - 1
        } else if (fromIndex > state.shufflePosition && toIndex <= state.shufflePosition) {
          newShufflePos = state.shufflePosition + 1
        }

        set({ shuffledIndices: newShuffled, shufflePosition: newShufflePos })

        audioEngine.clearNextBuffer()
        get()._preBufferNextTrack()
      } else {
        // Original sequential reorder
        if (fromIndex < 0 || fromIndex >= state.queue.length) return
        if (toIndex < 0 || toIndex >= state.queue.length) return

        const newQueue = [...state.queue]
        const [removed] = newQueue.splice(fromIndex, 1)
        newQueue.splice(toIndex, 0, removed)

        let newIndex = state.queueIndex
        if (state.queueIndex === fromIndex) {
          newIndex = toIndex
        } else if (fromIndex < state.queueIndex && toIndex >= state.queueIndex) {
          newIndex = state.queueIndex - 1
        } else if (fromIndex > state.queueIndex && toIndex <= state.queueIndex) {
          newIndex = state.queueIndex + 1
        }

        set({ queue: newQueue, queueIndex: newIndex })

        const oldNextIndex = state.queueIndex + 1
        const newNextIndex = newIndex + 1
        if (fromIndex === oldNextIndex || toIndex === oldNextIndex ||
            fromIndex === newNextIndex || toIndex === newNextIndex) {
          audioEngine.clearNextBuffer()
          get()._preBufferNextTrack()
        }
      }
    },

    clearQueue: () => {
      audioEngine.clearNextBuffer()
      recentPlaySession = null
      set({ queue: [], queueIndex: -1, queueSourcePlaylistId: null, shuffledIndices: [], shufflePosition: 0 })
    },

    // Generate a shuffled playback order with the current track at position 0
    _generateShuffleOrder: (currentQueueIndex: number) => {
      const { queue } = get()
      if (queue.length === 0) {
        set({ shuffledIndices: [], shufflePosition: 0 })
        return
      }

      const indices = queue.map((_, i) => i).filter(i => i !== currentQueueIndex)

      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]]
      }

      set({ shuffledIndices: [currentQueueIndex, ...indices], shufflePosition: 0 })
    },

    // Get upcoming tracks in the correct display order
    getUpcomingTracks: () => {
      const { queue, queueIndex, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return []

      if (shuffle && shuffledIndices.length > 0) {
        return shuffledIndices
          .slice(shufflePosition + 1)
          .map(idx => queue[idx])
          .filter(Boolean)
      }
      return queue.slice(queueIndex + 1)
    },

    // Get previously played tracks in the correct display order
    getPreviousTracks: () => {
      const { queue, queueIndex, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return []

      if (shuffle && shuffledIndices.length > 0) {
        return shuffledIndices
          .slice(0, shufflePosition)
          .map(idx => queue[idx])
          .filter(Boolean)
      }
      return queue.slice(0, queueIndex)
    },

    clearFfmpegFallbackNotice: () => {
      set({ ffmpegFallbackNotice: null })
    },

    clearOutputDelayNotice: () => {
      set({ outputDelayNotice: null })
    },

    showAssociatedOpenNotice: (notice) => {
      const fileCount = Number.isFinite(notice.fileCount)
        ? Math.max(1, Math.floor(notice.fileCount))
        : 1
      associatedOpenNoticeId += 1
      set({
        associatedOpenNotice: {
          id: associatedOpenNoticeId,
          trackPath: notice.trackPath,
          title: notice.title.trim() || 'Unknown Track',
          fileCount,
          sourceLabel: notice.sourceLabel.trim() || 'File Explorer'
        }
      })
    },

    clearAssociatedOpenNotice: () => {
      set({ associatedOpenNotice: null })
    },

    // Get the next index based on shuffle/repeat settings
    _getNextIndex: () => {
      return getNextPlayableIndex()
    },

    playNext: async () => {
      const { queue, shuffle, shuffledIndices } = get()
      const candidateIndices = collectNextCandidateIndices()
      if (candidateIndices.length === 0) return

      for (const nextIndex of candidateIndices) {
        const nextTrack = queue[nextIndex]
        if (!nextTrack) continue
        if (isUnavailableRemoteTrack(nextTrack)) continue

        const nextState: { queueIndex: number; shufflePosition?: number } = {
          queueIndex: nextIndex
        }
        if (shuffle && shuffledIndices.length > 0) {
          const nextShufflePosition = shuffledIndices.indexOf(nextIndex)
          if (nextShufflePosition >= 0) {
            nextState.shufflePosition = nextShufflePosition
          }
        }
        set(nextState)

        const loaded = await get()._loadAndPlayTrack(nextTrack)
        if (loaded) return
        if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
          markTrackUnavailableInState(nextTrack.path)
        }
      }
    },

    playPrevious: async () => {
      const { queue, queueIndex, currentTime, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return

      // If more than 3 seconds into track, restart it
      if (currentTime > 3) {
        await audioEngine.seek(0)
        return
      }

      if (shuffle && shuffledIndices.length > 0) {
        if (shufflePosition <= 0) {
          // At beginning of shuffle, wrap to end
          const prevPos = shuffledIndices.length - 1
          set({ shufflePosition: prevPos, queueIndex: shuffledIndices[prevPos] })
          await get()._loadAndPlayTrack(queue[shuffledIndices[prevPos]])
        } else {
          const prevPos = shufflePosition - 1
          set({ shufflePosition: prevPos, queueIndex: shuffledIndices[prevPos] })
          await get()._loadAndPlayTrack(queue[shuffledIndices[prevPos]])
        }
      } else {
        let prevIndex = queueIndex - 1
        if (prevIndex < 0) {
          prevIndex = queue.length - 1
        }
        set({ queueIndex: prevIndex })
        await get()._loadAndPlayTrack(queue[prevIndex])
      }
    },

    playTrackAt: async (index: number) => {
      const { queue, shuffle, shuffledIndices, _loadAndPlayTrack } = get()
      if (index < 0 || index >= queue.length) return
      if (isUnavailableRemoteTrack(queue[index])) return

      set({ queueIndex: index })

      if (shuffle && shuffledIndices.length > 0) {
        const posInShuffle = shuffledIndices.indexOf(index)
        if (posInShuffle !== -1) {
          set({ shufflePosition: posInShuffle })
        }
      }

      const loaded = await _loadAndPlayTrack(queue[index], { manualStart: true })
      if (!loaded) {
        const failedTrack = queue[index]
        if (failedTrack?.sourceType && failedTrack.sourceType !== 'local') {
          markTrackUnavailableInState(failedTrack.path)
        }
      }
    },

    toggleShuffle: () => {
      const { shuffle, queueIndex } = get()
      const newShuffle = !shuffle

      if (newShuffle) {
        set({ shuffle: true })
        get()._generateShuffleOrder(queueIndex)
      } else {
        set({ shuffle: false, shuffledIndices: [], shufflePosition: 0 })
      }

      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    toggleRepeat: () => {
      set((state) => {
        const modes: Array<'none' | 'one' | 'all'> = ['none', 'all', 'one']
        const currentIndex = modes.indexOf(state.repeat)
        return { repeat: modes[(currentIndex + 1) % modes.length] }
      })
      // Re-buffer with new repeat setting
      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    // Internal: Load and play a track from queue
    _loadAndPlayTrack: async (track: Track, options = {}) => {
      const loadStart = performance.now()
      const manualStart = Boolean(options.manualStart)
      pendingManualLoadCueTrack = null
      // Initialize listeners if needed
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        remoteLoadProgress: track.sourceType && track.sourceType !== 'local'
          ? {
              path: track.path,
              sourceType: track.sourceType,
              stage: 'downloading',
              loadedBytes: 0,
              totalBytes: null,
              chunkCount: 0,
              percent: null,
              done: false,
              failed: false
            }
          : null,
        currentTime: 0,
        duration: track.duration
      })

      try {
        await ensureCompatiblePlaybackMode(track)
        if (shouldUseBitPerfectPath(track)) {
          const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
          audioEngine.setCurrentReplayGainDb(replayGainDb)
          const loadResult = await audioEngine.loadTrackFromPath(track)
          const resolvedTrack: Track = {
            ...track,
            duration: loadResult.duration > 0 ? loadResult.duration : track.duration,
            channels: loadResult.channels ?? track.channels
          }
          set({
            duration: loadResult.duration > 0 ? loadResult.duration : track.duration,
            currentTrack: resolvedTrack,
            remoteLoadProgress: null,
            currentTime: 0
          })
          hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
          if (manualStart) {
            showOutputDelayNotice(resolvedTrack)
          }
          await audioEngine.play()
          startRecentPlaySession(resolvedTrack.path)
          get()._preBufferNextTrack()
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            usedNativeBitPerfect: true
          })
          return true
        }

        const fileLoadStart = performance.now()
        // Load audio file from path
        const result = await window.electronAPI.loadAudioFile(track.path, { metadataMode: 'none' })
        const fileLoadMs = Math.round(performance.now() - fileLoadStart)
        if (!result) {
          console.error('Failed to load audio file:', track.path)
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            failed: true,
            stage: 'fileLoad'
          })
          set({ playbackState: 'stopped', remoteLoadProgress: null })
          return false
        }

        let usedFfmpegFallback = false
        const replayGainDb = getReplayGainCandidateDb(track, useAudioSettingsStore.getState().replayGainMode)
        const decodeStart = performance.now()
        try {
          await audioEngine.loadAudioData(result.data, { replayGainDb })
        } catch (primaryDecodeError) {
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData, { replayGainDb })
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const resolvedTrack: Track = {
          ...track,
          title: result.metadata?.title ?? track.title,
          artist: result.metadata?.artist ?? track.artist,
          album: result.metadata?.album ?? track.album,
          albumArtist: result.metadata?.albumArtist ?? track.albumArtist,
          duration: result.metadata?.duration ?? track.duration,
          channels: detectedChannels ?? result.metadata?.channels ?? track.channels,
          codec: result.metadata?.codec ?? track.codec,
          codecProfile: result.metadata?.codecProfile ?? track.codecProfile,
          isAtmosJoc: result.metadata?.isAtmosJoc ?? track.isAtmosJoc,
          replayGainTrackDb: result.metadata?.replayGainTrackDb ?? track.replayGainTrackDb,
          replayGainAlbumDb: result.metadata?.replayGainAlbumDb ?? track.replayGainAlbumDb
        }
        set({
          duration: audioEngine.duration,
          currentTrack: resolvedTrack,
          remoteLoadProgress: null,
          currentTime: 0
        })
        hydrateAssociatedCurrentTrackMetadata(resolvedTrack)
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        if (manualStart) {
          showOutputDelayNotice(resolvedTrack)
        }
        await audioEngine.play()
        startRecentPlaySession(resolvedTrack.path)

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          fileLoadMs,
          decodeMs,
          usedFfmpegFallback
        })
        return true
      } catch (error) {
        console.error('Failed to load track:', error)
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        if (track.sourceType && track.sourceType !== 'local') {
          markTrackUnavailableInState(track.path)
        }
        set({ playbackState: 'stopped', remoteLoadProgress: null })
        return false
      }
    },

    // Pre-buffer the next track for gapless playback
    _preBufferNextTrack: async () => {
      const bufferStart = performance.now()
      const { queue, repeat } = get()

      if (repeat === 'one') {
        return
      }

      const candidates = collectNextCandidateIndices()
      if (candidates.length === 0) return

      for (const nextIndex of candidates) {
        const nextTrack = queue[nextIndex]
        if (!nextTrack) continue
        if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
          // Remote prebuffering downloads entire files and can stall click-to-play on constrained links.
          continue
        }
        if (isUnavailableRemoteTrack(nextTrack)) continue

        try {
          if (shouldUseBitPerfectPath(nextTrack)) {
            await audioEngine.preBufferNextTrackFromPath(nextTrack)
            logSlowPath('preBufferNextTrack', bufferStart, {
              trackPath: nextTrack.path,
              loaded: true,
              usedNativeBitPerfect: true
            })
            return
          }

          const result = await window.electronAPI.loadAudioFile(nextTrack.path, { metadataMode: 'none' })
          // Re-check repeat mode after async gap — may have changed to 'one'
          if (get().repeat === 'one') {
            return
          }
          if (result) {
            await audioEngine.preBufferNext(result.data, {
              replayGainDb: getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode)
            })
            logSlowPath('preBufferNextTrack', bufferStart, {
              trackPath: nextTrack.path,
              loaded: true
            })
            return
          }
          if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
            markTrackUnavailableInState(nextTrack.path)
          }
        } catch (error) {
          console.error('Failed to pre-buffer next track:', error)
          if (nextTrack.sourceType && nextTrack.sourceType !== 'local') {
            markTrackUnavailableInState(nextTrack.path)
          }
          logSlowPath('preBufferNextTrack', bufferStart, {
            trackPath: nextTrack.path,
            failed: true
          })
        }
      }
    },

    // Initialize audio engine event listeners
    _initListeners: () => {
      if (listenersInitialized) return
      listenersInitialized = true

      remoteLoadProgressUnsubscribe?.()
      remoteLoadProgressUnsubscribe = window.electronAPI.onRemoteLoadProgress((progress) => {
        set((state) => {
          const activeTrackPath = state.currentTrack?.path
          if (!activeTrackPath || activeTrackPath !== progress.path) {
            return state
          }
          return {
            remoteLoadProgress: progress
          }
        })
      })

      audioEngine.on('stateChange', (state) => {
        set({ playbackState: state as PlaybackState })
      })

      audioEngine.on('timeUpdate', (time) => {
        const normalizedTime = time as number
        set({ currentTime: normalizedTime })
        maybeCommitRecentPlay(normalizedTime)
      })

      audioEngine.on('durationChange', (duration) => {
        set({ duration: duration as number })
      })

      audioEngine.on('bufferReady', (buffer) => {
        const track = get().currentTrack
        if (!track || !buffer) return

        const cached = waveformCache.get(track.path)
        if (cached) {
          set({ waveformData: cached })
          return
        }

        const peaks = extractWaveformPeaks(buffer as AudioBuffer)
        waveformCache.set(track.path, peaks)
        set({ waveformData: peaks })
      })

      // Handle gapless transition - advance queue without reloading
      audioEngine.on('gaplessTransition', () => {
        commitRecentPlayNow()
        const { queue, queueIndex, repeat, shuffle, shuffledIndices } = get()

        if (repeat === 'one') {
          // Safety net: AudioEngine already swapped to the wrong buffer.
          // Reload the correct track to fix audio/UI desync.
          const correctTrack = queue[queueIndex]
          if (correctTrack) {
            void get()._loadAndPlayTrack(correctTrack)
          }
          return
        }

        const nextIndex = get()._getNextIndex()
        if (nextIndex < 0 || nextIndex >= queue.length) {
          return
        }

        const nextTrack = queue[nextIndex]
        if (!nextTrack) return
        if (isUnavailableRemoteTrack(nextTrack)) return

        const nextState: {
          queueIndex: number
          currentTrack: Track
          currentTime: number
          duration: number
          waveformData: Float32Array | null
          shufflePosition?: number
        } = {
          queueIndex: nextIndex,
          currentTrack: nextTrack,
          currentTime: 0,
          duration: nextTrack.duration,
          waveformData: waveformCache.get(nextTrack.path) ?? null
        }
        if (shuffle && shuffledIndices.length > 0) {
          const nextShufflePosition = shuffledIndices.indexOf(nextIndex)
          if (nextShufflePosition >= 0) {
            nextState.shufflePosition = nextShufflePosition
          }
        }
        set(nextState)
        audioEngine.setCurrentReplayGainDb(
          getReplayGainCandidateDb(nextTrack, useAudioSettingsStore.getState().replayGainMode)
        )
        startRecentPlaySession(nextTrack.path)

        // Pre-buffer the NEXT next track
        void get()._preBufferNextTrack()
      })

      // Handle non-gapless track end (when no next track buffered)
      audioEngine.on('ended', () => {
        commitRecentPlayNow()
        recentPlaySession = null
        set({ currentTime: 0 })
        // Auto-play next track (non-gapless fallback)
        get().playNext()
      })

      audioEngine.on('error', (error) => {
        console.error('Audio engine error:', error)
      })

      // Set initial volume
      audioEngine.setVolume(get().volume)
    },

    // Cleanup listeners
    _cleanupListeners: () => {
      // Audio engine handles its own cleanup
      if (remoteLoadProgressUnsubscribe) {
        remoteLoadProgressUnsubscribe()
        remoteLoadProgressUnsubscribe = null
      }
      listenersInitialized = false
    }
  }
})

useAudioSettingsStore.subscribe((nextState, prevState) => {
  if (nextState.replayGainMode === prevState.replayGainMode) return

  const playerState = usePlayerStore.getState()
  const replayGainDb = getReplayGainCandidateDb(playerState.currentTrack, nextState.replayGainMode)
  audioEngine.setCurrentReplayGainDb(replayGainDb)
  audioEngine.clearNextBuffer()
  void playerState._preBufferNextTrack()
})
