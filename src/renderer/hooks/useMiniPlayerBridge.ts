import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'
import { useAudioSettingsStore } from '../stores/audioSettingsStore'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'

const SNAPSHOT_THROTTLE_MS = 120

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

  const [resolvedArtwork, setResolvedArtwork] = useState<string | null>(null)

  const publishTimerRef = useRef<number | null>(null)
  const lastPublishRef = useRef(0)
  const latestPendingRef = useRef<MiniPlayerSnapshot | null>(null)
  const previousTrackIdRef = useRef<string | null>(null)
  const previousPlaybackStateRef = useRef(playbackState)

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
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.miniPlayer.onCommand((command) => {
      const player = usePlayerStore.getState()
      const library = useLibraryStore.getState()

      switch (command.type) {
        case 'togglePlay':
          void player.togglePlay()
          break
        case 'playNext':
          void player.playNext()
          break
        case 'playPrevious':
          void player.playPrevious()
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
    const outputDeviceLabel = selectedDeviceId
      ? availableDevices.find((device) => device.deviceId === selectedDeviceId)?.label ?? null
      : null

    const isFavorite = currentTrack ? favorites.has(currentTrack.path) : false
    const snapshot: MiniPlayerSnapshot = {
      playbackState,
      currentTime: toSafeTime(currentTime),
      duration: toSafeTime(duration),
      queueLength,
      outputDeviceLabel,
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
    resolvedArtwork
  ])
}
