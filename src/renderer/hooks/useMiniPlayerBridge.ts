import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore } from '../stores/audioSettingsStore'
import { useUIStore } from '../stores/uiStore'
import { useVisualizerSettingsStore } from '../stores/visualizerSettingsStore'
import { audioEngine } from '../audio/AudioEngine'
import { isNativeAvailable } from '../audio/native/index'
import type {
  MiniPlayerQueueSnapshot,
  MiniPlayerResolvedArtwork,
  MiniPlayerSnapshot,
  MiniPlayerWindowState
} from '../../types/miniPlayer'
import { selectMiniPlayerTrackArtworkData } from '../../types/miniPlayer'

const SNAPSHOT_THROTTLE_MS = 120
const QUEUE_SNAPSHOT_THROTTLE_MS = 250
const QUEUE_SNAPSHOT_MAX_ITEMS = 200
const MINI_OSCILLOSCOPE_STREAM_INTERVAL_MS = 8
const MINI_SPECTRUM_STREAM_INTERVAL_MS = 12
const MINI_MAX_CHUNKS_PER_TICK_OSCILLOSCOPE = 6
const MINI_MAX_CHUNKS_PER_TICK_SPECTRUM = 8
const MINI_MAX_FFT_SIZE = 2048
const DEFAULT_MINI_WINDOW_STATE: MiniPlayerWindowState = {
  isOpen: false,
  alwaysOnTop: true,
  visualizerMode: 'off',
}

function toSafeTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clampSeekTime(time: number, duration: number): number {
  const safeTime = toSafeTime(time)
  const safeDuration = toSafeTime(duration)
  if (safeDuration <= 0) return 0
  return Math.max(0, Math.min(safeDuration, safeTime))
}

export function useMiniPlayerBridge(): void {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const volume = usePlayerStore((s) => s.volume)
  const isMuted = usePlayerStore((s) => s.isMuted)
  const queueLength = usePlayerStore((s) => s.getResolvedQueueLength())
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const queueItems = usePlayerStore((s) => s.queueItems)
  const upcomingQueueIds = usePlayerStore((s) => s.upcomingQueueIds)
  const currentQueueItemId = usePlayerStore((s) => s.currentQueueItemId)
  const timeDisplayMode = useUIStore((s) => s.waveformTimeDisplayMode)

  const favorites = useLibraryStore((s) => s.favorites)
  const getArtwork = useLibraryStore((s) => s.getArtwork)
  const selectedDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const availableDevices = useAudioSettingsStore((s) => s.availableDevices)
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const isVisualizerRunning = useVisualizerSettingsStore((s) => s.isRunning)

  const [resolvedArtwork, setResolvedArtwork] = useState<MiniPlayerResolvedArtwork | null>(null)
  const [miniWindowState, setMiniWindowState] = useState<MiniPlayerWindowState>(DEFAULT_MINI_WINDOW_STATE)
  const nativeVisualizersAvailable = isNativeAvailable()

  const publishTimerRef = useRef<number | null>(null)
  const lastPublishRef = useRef(0)
  const latestPendingRef = useRef<MiniPlayerSnapshot | null>(null)
  const previousTrackIdRef = useRef<string | null>(null)
  const previousPlaybackStateRef = useRef(playbackState)
  const previousTimeDisplayModeRef = useRef(timeDisplayMode)
  const previousArtworkRef = useRef<string | null>(null)
  const previousShuffleRef = useRef(shuffle)
  const previousRepeatRef = useRef(repeat)
  const queuePublishTimerRef = useRef<number | null>(null)
  const lastQueuePublishRef = useRef(0)
  const latestPendingQueueRef = useRef<MiniPlayerQueueSnapshot | null>(null)
  const visualizerStreamTimerRef = useRef<number | null>(null)
  const visualizerResetSentRef = useRef(false)

  useEffect(() => {
    let isActive = true
    const track = currentTrack

    if (!track) {
      setResolvedArtwork(null)
      return () => {
        isActive = false
      }
    }

    if (track.artworkData) {
      setResolvedArtwork({
        trackPath: track.path,
        dataUrl: track.artworkData
      })
      return () => {
        isActive = false
      }
    }

    if (!track.artworkHash) {
      setResolvedArtwork({
        trackPath: track.path,
        dataUrl: null
      })
      return () => {
        isActive = false
      }
    }

    setResolvedArtwork({
      trackPath: track.path,
      dataUrl: null
    })
    void getArtwork(track.artworkHash, { variant: 'card', format: 'data-url' }).then((url) => {
      if (!isActive) return
      setResolvedArtwork({
        trackPath: track.path,
        dataUrl: url
      })
    })

    return () => {
      isActive = false
    }
  }, [currentTrack, getArtwork])

  useEffect(() => {
    return () => {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current)
        publishTimerRef.current = null
      }
      if (visualizerStreamTimerRef.current !== null) {
        window.clearInterval(visualizerStreamTimerRef.current)
        visualizerStreamTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.miniPlayer.onCommand((command) => {
      const player = usePlayerStore.getState()
      const library = useLibraryStore.getState()

      switch (command.type) {
        case 'play':
          void player.play()
          break
        case 'pause':
          player.pause()
          break
        case 'togglePlay':
          void player.togglePlay()
          break
        case 'playNext':
          void player.playNext()
          break
        case 'playPrevious':
          void player.playPrevious()
          break
        case 'toggleTimeDisplayMode':
          useUIStore.getState().toggleWaveformTimeDisplayMode()
          break
        case 'toggleFavoriteCurrent': {
          const currentTrackPath = player.currentTrack?.path
          if (!currentTrackPath) break
          void library.toggleFavorite(currentTrackPath)
          break
        }
        case 'toggleShuffle':
          player.toggleShuffle()
          break
        case 'toggleRepeat':
          player.toggleRepeat()
          break
        case 'playQueueItem':
          void player.playQueuedItem(command.queueId, { manualStart: true })
          break
        case 'seek': {
          const seekTarget = clampSeekTime(command.time, player.duration)
          void player.seek(seekTarget)
          break
        }
        case 'toggleFavorite':
          void library.toggleFavorite(command.trackPath)
          break
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      setMiniWindowState(state)
    })

    const unsubscribe = window.electronAPI.miniPlayer.onWindowState((state) => {
      setMiniWindowState(state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    audioEngine.setVisualizerConsumerDemand('mini-player-bridge', {
      miniSpectrum: nativeVisualizersAvailable && isVisualizerRunning && miniWindowState.isOpen && miniWindowState.visualizerMode === 'spectrum',
      miniOscilloscope: nativeVisualizersAvailable && isVisualizerRunning && miniWindowState.isOpen && miniWindowState.visualizerMode === 'oscilloscope',
    })

    return () => {
      audioEngine.clearVisualizerConsumerDemand('mini-player-bridge')
    }
  }, [isVisualizerRunning, miniWindowState.isOpen, miniWindowState.visualizerMode, nativeVisualizersAvailable])

  useEffect(() => {
    if (visualizerStreamTimerRef.current !== null) {
      window.clearInterval(visualizerStreamTimerRef.current)
      visualizerStreamTimerRef.current = null
    }

    const isOscilloscopeMode = miniWindowState.visualizerMode === 'oscilloscope'
    const streamIntervalMs = isOscilloscopeMode
      ? MINI_OSCILLOSCOPE_STREAM_INTERVAL_MS
      : MINI_SPECTRUM_STREAM_INTERVAL_MS
    const maxChunksPerTick = isOscilloscopeMode
      ? MINI_MAX_CHUNKS_PER_TICK_OSCILLOSCOPE
      : MINI_MAX_CHUNKS_PER_TICK_SPECTRUM

    const emitReset = () => {
      window.electronAPI.miniPlayer.publishVisualizerChunk({
        capturedAt: Date.now(),
        sampleRate: audioEngine.getSampleRate(),
        leftChunks: [],
        monoChunks: [],
        fftSize: Math.min(fftSize, MINI_MAX_FFT_SIZE),
        pitchLock,
        oscilloscopeUnderfillEnabled,
        lineColor,
        reset: true
      })
      visualizerResetSentRef.current = true
    }

    const shouldBridgeToMini = nativeVisualizersAvailable && miniWindowState.isOpen && miniWindowState.visualizerMode !== 'off'
    if (!shouldBridgeToMini) {
      audioEngine.flushPendingMiniVisualizerChunks()
      emitReset()
      return
    }

    visualizerStreamTimerRef.current = window.setInterval(() => {
      const active = playbackState === 'playing' && isVisualizerRunning
      if (!active) {
        audioEngine.flushPendingMiniVisualizerChunks()
        if (!visualizerResetSentRef.current) {
          emitReset()
        }
        return
      }

      const chunks = audioEngine.flushPendingMiniVisualizerChunks()
      if (chunks.length === 0) return
      const chunksToPublish = chunks.length > maxChunksPerTick
        ? chunks.slice(-maxChunksPerTick)
        : chunks

      window.electronAPI.miniPlayer.publishVisualizerChunk({
        capturedAt: Date.now(),
        sampleRate: audioEngine.getSampleRate(),
        leftChunks: isOscilloscopeMode ? chunksToPublish.map((chunk) => chunk.left) : [],
        monoChunks: isOscilloscopeMode ? [] : chunksToPublish.map((chunk) => chunk.mono),
        fftSize: Math.min(fftSize, MINI_MAX_FFT_SIZE),
        pitchLock,
        oscilloscopeUnderfillEnabled,
        lineColor,
        reset: false
      })
      visualizerResetSentRef.current = false
    }, streamIntervalMs)

    return () => {
      if (visualizerStreamTimerRef.current !== null) {
        window.clearInterval(visualizerStreamTimerRef.current)
        visualizerStreamTimerRef.current = null
      }
    }
  }, [
    miniWindowState.isOpen,
    miniWindowState.visualizerMode,
    nativeVisualizersAvailable,
    playbackState,
    isVisualizerRunning,
    fftSize,
    pitchLock,
    oscilloscopeUnderfillEnabled,
    lineColor
  ])

  useEffect(() => {
    const outputDeviceLabel = resolveOutputDeviceLabel(selectedDeviceId, availableDevices, {
      defaultRouteFallbackLabel: 'System Default Output',
      selectedFallbackLabel: 'Selected Output'
    }).label

    const isFavorite = currentTrack ? favorites.has(currentTrack.path) : false
    const currentTrackId = currentTrack?.id ?? null
    const effectiveArtworkData = selectMiniPlayerTrackArtworkData(currentTrack, resolvedArtwork)
    const shouldIncludeArtwork = previousTrackIdRef.current !== currentTrackId ||
      previousArtworkRef.current !== effectiveArtworkData
    const shouldForce = shouldIncludeArtwork ||
      previousPlaybackStateRef.current !== playbackState ||
      previousTimeDisplayModeRef.current !== timeDisplayMode ||
      previousShuffleRef.current !== shuffle ||
      previousRepeatRef.current !== repeat

    const snapshot: MiniPlayerSnapshot = {
      playbackState,
      currentTime: toSafeTime(currentTime),
      duration: toSafeTime(duration),
      queueLength,
      shuffle,
      repeat,
      volume,
      isMuted,
      outputDeviceLabel,
      timeDisplayMode,
      visualizerLineColor: lineColor,
      currentTrack: currentTrack
        ? {
            id: currentTrack.id,
            path: currentTrack.path,
            title: currentTrack.title,
            artist: currentTrack.artist,
            artistNames: currentTrack.artistNames,
            album: currentTrack.album,
            albumArtist: currentTrack.albumArtist ?? null,
            albumArtistNames: currentTrack.albumArtistNames,
            artworkHash: currentTrack.artworkHash ?? null,
            artworkData: shouldIncludeArtwork ? effectiveArtworkData : undefined,
            isFavorite,
            duration: currentTrack.duration,
            year: currentTrack.year ?? null,
            genres: currentTrack.genres ?? (currentTrack.genre ? [currentTrack.genre] : []),
            format: currentTrack.format || null,
            sampleRate: currentTrack.sampleRate ?? null,
            bitDepth: currentTrack.bitDepth ?? null,
            channels: currentTrack.channels ?? null,
          }
        : null
    }

    previousTrackIdRef.current = currentTrackId
    previousPlaybackStateRef.current = playbackState
    previousTimeDisplayModeRef.current = timeDisplayMode
    previousArtworkRef.current = effectiveArtworkData
    previousShuffleRef.current = shuffle
    previousRepeatRef.current = repeat

    latestPendingRef.current = snapshot

    const publishLatest = () => {
      if (!latestPendingRef.current) return
      window.electronAPI.miniPlayer.publishSnapshot(latestPendingRef.current)
      lastPublishRef.current = Date.now()
      latestPendingRef.current = null
    }

    if (shouldForce) {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current)
        publishTimerRef.current = null
      }
      publishLatest()
      return
    }

    const elapsed = Date.now() - lastPublishRef.current
    if (elapsed >= SNAPSHOT_THROTTLE_MS) {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current)
        publishTimerRef.current = null
      }
      publishLatest()
      return
    }

    if (publishTimerRef.current !== null) return
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null
      publishLatest()
    }, SNAPSHOT_THROTTLE_MS - elapsed)
  }, [
    currentTrack,
    playbackState,
    currentTime,
    duration,
    queueLength,
    shuffle,
    repeat,
    volume,
    isMuted,
    timeDisplayMode,
    selectedDeviceId,
    availableDevices,
    favorites,
    resolvedArtwork,
    lineColor
  ])

  // Queue snapshot for the remote controllers (current track + upcoming).
  // Rebuilt whenever queue composition or the active item changes; throttled
  // because drag-reorders emit bursts of store updates.
  useEffect(() => {
    const player = usePlayerStore.getState()
    const items: MiniPlayerQueueSnapshot['items'] = []
    if (currentTrack) {
      items.push({
        queueId: currentQueueItemId ?? `current:${currentTrack.id}`,
        title: currentTrack.title,
        artist: currentTrack.artist,
        durationSeconds: Number.isFinite(currentTrack.duration) && currentTrack.duration > 0
          ? currentTrack.duration
          : null,
        isCurrent: true,
        trackPath: currentTrack.path
      })
    }
    for (const entry of player.getResolvedUpcomingEntries()) {
      if (items.length >= QUEUE_SNAPSHOT_MAX_ITEMS) break
      items.push({
        queueId: entry.queueId,
        title: entry.track.title,
        artist: entry.track.artist,
        durationSeconds: Number.isFinite(entry.track.duration) && entry.track.duration > 0
          ? entry.track.duration
          : null,
        isCurrent: false,
        trackPath: entry.track.path
      })
    }

    latestPendingQueueRef.current = { items, updatedAt: Date.now() }

    const publishLatestQueue = () => {
      if (!latestPendingQueueRef.current) return
      window.electronAPI.miniPlayer.publishQueueSnapshot(latestPendingQueueRef.current)
      lastQueuePublishRef.current = Date.now()
      latestPendingQueueRef.current = null
    }

    const elapsed = Date.now() - lastQueuePublishRef.current
    if (elapsed >= QUEUE_SNAPSHOT_THROTTLE_MS) {
      if (queuePublishTimerRef.current !== null) {
        window.clearTimeout(queuePublishTimerRef.current)
        queuePublishTimerRef.current = null
      }
      publishLatestQueue()
      return
    }
    if (queuePublishTimerRef.current !== null) return
    queuePublishTimerRef.current = window.setTimeout(() => {
      queuePublishTimerRef.current = null
      publishLatestQueue()
    }, QUEUE_SNAPSHOT_THROTTLE_MS - elapsed)
  }, [queueItems, upcomingQueueIds, currentQueueItemId, currentTrack])

  useEffect(() => {
    return () => {
      if (queuePublishTimerRef.current !== null) {
        window.clearTimeout(queuePublishTimerRef.current)
        queuePublishTimerRef.current = null
      }
    }
  }, [])
}
