import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import { resolveOutputDeviceLabel, useAudioSettingsStore } from '../stores/audioSettingsStore'
import { useVisualizerSettingsStore } from '../stores/visualizerSettingsStore'
import { audioEngine } from '../audio/AudioEngine'
import type {
  MiniPlayerSnapshot,
  MiniPlayerWindowState
} from '../../types/miniPlayer'

const SNAPSHOT_THROTTLE_MS = 120
const MINI_OSCILLOSCOPE_STREAM_INTERVAL_MS = 8
const MINI_SPECTRUM_STREAM_INTERVAL_MS = 12
const MINI_MAX_CHUNKS_PER_TICK_OSCILLOSCOPE = 6
const MINI_MAX_CHUNKS_PER_TICK_SPECTRUM = 8
const MINI_MAX_FFT_SIZE = 2048
const DEFAULT_MINI_WINDOW_STATE: MiniPlayerWindowState = {
  isOpen: false,
  alwaysOnTop: true,
  visualizerMode: 'spectrum',
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
  const queueLength = usePlayerStore((s) => s.queue.length)

  const favorites = useLibraryStore((s) => s.favorites)
  const getArtwork = useLibraryStore((s) => s.getArtwork)
  const selectedDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const availableDevices = useAudioSettingsStore((s) => s.availableDevices)
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const isVisualizerRunning = useVisualizerSettingsStore((s) => s.isRunning)

  const [resolvedArtwork, setResolvedArtwork] = useState<string | null>(null)
  const [miniWindowState, setMiniWindowState] = useState<MiniPlayerWindowState>(DEFAULT_MINI_WINDOW_STATE)

  const publishTimerRef = useRef<number | null>(null)
  const lastPublishRef = useRef(0)
  const latestPendingRef = useRef<MiniPlayerSnapshot | null>(null)
  const previousTrackIdRef = useRef<string | null>(null)
  const previousPlaybackStateRef = useRef(playbackState)
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
      setResolvedArtwork(track.artworkData)
      return () => {
        isActive = false
      }
    }

    if (!track.artworkHash) {
      setResolvedArtwork(null)
      return () => {
        isActive = false
      }
    }

    setResolvedArtwork(null)
    void getArtwork(track.artworkHash).then((url) => {
      if (!isActive) return
      setResolvedArtwork(url)
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
        case 'toggleFavoriteCurrent': {
          const currentTrackPath = player.currentTrack?.path
          if (!currentTrackPath) break
          void library.toggleFavorite(currentTrackPath)
          break
        }
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

    const shouldBridgeToMini = miniWindowState.isOpen && miniWindowState.visualizerMode !== 'off'
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
    const snapshot: MiniPlayerSnapshot = {
      playbackState,
      currentTime: toSafeTime(currentTime),
      duration: toSafeTime(duration),
      queueLength,
      outputDeviceLabel,
      visualizerLineColor: lineColor,
      currentTrack: currentTrack
        ? {
            id: currentTrack.id,
            path: currentTrack.path,
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.album,
            artworkData: resolvedArtwork,
            isFavorite,
          }
        : null
    }

    const currentTrackId = currentTrack?.id ?? null
    const shouldForce = previousTrackIdRef.current !== currentTrackId ||
      previousPlaybackStateRef.current !== playbackState

    previousTrackIdRef.current = currentTrackId
    previousPlaybackStateRef.current = playbackState

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
    selectedDeviceId,
    availableDevices,
    favorites,
    resolvedArtwork,
    lineColor
  ])
}
