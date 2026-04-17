import { useEffect, useMemo, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLyricsStore } from '../stores/lyricsStore'
import { useLyricsPopoutStore } from '../stores/lyricsPopoutStore'
import { useUIStore } from '../stores/uiStore'
import { usePlaybackClock } from './usePlaybackClock'
import type { LyricsPopoutSnapshot } from '../../types/lyricsPopout'
import {
  buildLyricsQuery,
  getActiveLyricsResult
} from '../utils/lyricsPresentation'

const SNAPSHOT_THROTTLE_MS = 120

function toSafeTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function useLyricsPopoutBridge(): void {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const currentTime = usePlaybackClock()
  const duration = usePlayerStore((s) => s.duration)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const setWindowState = useLyricsPopoutStore((s) => s.setWindowState)
  const lyricsShelfExpanded = useUIStore((s) => s.lyricsShelfExpanded)

  const publishTimerRef = useRef<number | null>(null)
  const lastPublishRef = useRef(0)
  const latestPendingRef = useRef<LyricsPopoutSnapshot | null>(null)
  const previousTrackPathRef = useRef<string | null>(null)
  const previousPlaybackStateRef = useRef(playbackState)
  const previousLoadingRef = useRef(false)
  const previousErrorRef = useRef('')
  const previousLyricsResultRef = useRef<typeof lyricsResult>(null)
  const previousPreferredExpandedRef = useRef(lyricsShelfExpanded)

  const lyricsQuery = useMemo(() => buildLyricsQuery(currentTrack), [
    currentTrack?.path,
    currentTrack?.title,
    currentTrack?.artist,
    currentTrack?.album,
    currentTrack?.duration
  ])

  const activeLyricsResult = useMemo(() => (
    getActiveLyricsResult(currentTrack?.path ?? null, lyricsTrackPath, lyricsResult)
  ), [currentTrack?.path, lyricsResult, lyricsTrackPath])

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.lyricsPopout.getWindowState().then((state) => {
      if (!isMounted) return
      setWindowState(state)
    })

    const unsubscribe = window.electronAPI.lyricsPopout.onWindowState((state) => {
      setWindowState(state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [setWindowState])

  useEffect(() => {
    return () => {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current)
        publishTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.lyricsPopout.onCommand((command) => {
      if (command.type !== 'refresh') return
      const currentQuery = buildLyricsQuery(usePlayerStore.getState().currentTrack)
      if (!currentQuery) return
      void refreshLyricsForTrack(currentQuery)
    })

    return () => unsubscribe()
  }, [refreshLyricsForTrack])

  useEffect(() => {
    const snapshot: LyricsPopoutSnapshot = {
      capturedAt: Date.now(),
      preferredExpanded: lyricsShelfExpanded,
      playbackState,
      currentTime: toSafeTime(currentTime),
      duration: toSafeTime(duration),
      currentTrack: currentTrack
        ? {
            path: currentTrack.path,
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.album
          }
        : null,
      lyricsQuery,
      lyricsResult: activeLyricsResult,
      isLoading: lyricsIsLoading,
      errorMessage: lyricsStoreError
    }

    const trackPath = currentTrack?.path ?? null
    const shouldForce = previousTrackPathRef.current !== trackPath ||
      previousPlaybackStateRef.current !== playbackState ||
      previousLoadingRef.current !== lyricsIsLoading ||
      previousErrorRef.current !== lyricsStoreError ||
      previousLyricsResultRef.current !== activeLyricsResult ||
      previousPreferredExpandedRef.current !== lyricsShelfExpanded

    previousTrackPathRef.current = trackPath
    previousPlaybackStateRef.current = playbackState
    previousLoadingRef.current = lyricsIsLoading
    previousErrorRef.current = lyricsStoreError
    previousLyricsResultRef.current = activeLyricsResult
    previousPreferredExpandedRef.current = lyricsShelfExpanded

    latestPendingRef.current = snapshot

    const publishLatest = () => {
      if (!latestPendingRef.current) return
      window.electronAPI.lyricsPopout.publishSnapshot(latestPendingRef.current)
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
    activeLyricsResult,
    currentTime,
    currentTrack,
    duration,
    lyricsIsLoading,
    lyricsQuery,
    lyricsShelfExpanded,
    lyricsStoreError,
    playbackState
  ])
}
