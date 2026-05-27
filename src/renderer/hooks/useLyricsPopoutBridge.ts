import { useEffect, useMemo, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLyricsStore } from '../stores/lyricsStore'
import { useLyricsPopoutStore } from '../stores/lyricsPopoutStore'
import { useUIStore } from '../stores/uiStore'
import { useAudioSettingsStore } from '../stores/audioSettingsStore'
import type { LyricsPopoutSnapshot } from '../../types/lyricsPopout'
import {
  buildLyricsQuery,
  getActiveLyricsResult
} from '../utils/lyricsPresentation'
import {
  LYRICS_POPOUT_RESYNC_INTERVAL_MS,
  getLyricsPopoutPublishReason
} from '../utils/lyricsPopoutBridge'

function toSafeTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clampSeekTime(timeSeconds: number, durationSeconds: number): number | null {
  if (!Number.isFinite(timeSeconds)) return null
  const safeTime = Math.max(0, timeSeconds)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return safeTime
  return Math.min(durationSeconds, safeTime)
}

interface LyricsPopoutBridgeState {
  preferredExpanded: boolean
  playbackState: LyricsPopoutSnapshot['playbackState']
  currentTime: number
  duration: number
  effectiveDelayMs: number
  currentTrack: LyricsPopoutSnapshot['currentTrack']
  lyricsQuery: LyricsPopoutSnapshot['lyricsQuery']
  lyricsResult: LyricsPopoutSnapshot['lyricsResult']
  isLoading: boolean
  errorMessage: string
}

function buildLyricsPopoutSnapshot(
  state: LyricsPopoutBridgeState,
  capturedAt = Date.now()
): LyricsPopoutSnapshot {
  return {
    capturedAt,
    preferredExpanded: state.preferredExpanded,
    playbackState: state.playbackState,
    currentTime: state.currentTime,
    duration: state.duration,
    effectiveDelayMs: state.effectiveDelayMs,
    currentTrack: state.currentTrack,
    lyricsQuery: state.lyricsQuery,
    lyricsResult: state.lyricsResult,
    isLoading: state.isLoading,
    errorMessage: state.errorMessage
  }
}

export function useLyricsPopoutBridge(): void {
  const lyricsPopoutIsOpen = useLyricsPopoutStore((s) => s.windowState.isOpen)
  const setWindowState = useLyricsPopoutStore((s) => s.setWindowState)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const currentTime = usePlayerStore((s) => lyricsPopoutIsOpen ? s.currentTime : 0)
  const duration = usePlayerStore((s) => s.duration)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const lyricsShelfExpanded = useUIStore((s) => s.lyricsShelfExpanded)

  const latestStateRef = useRef<LyricsPopoutBridgeState | null>(null)
  const lastPublishedSnapshotRef = useRef<LyricsPopoutSnapshot | null>(null)
  const previousWindowOpenRef = useRef(false)
  const resyncTimerRef = useRef<number | null>(null)

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

  const bridgeState = useMemo(() => ({
    preferredExpanded: lyricsShelfExpanded,
    playbackState,
    currentTime: toSafeTime(currentTime),
    duration: toSafeTime(duration),
    effectiveDelayMs: toSafeTime(effectiveDelayMs),
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
  } satisfies LyricsPopoutBridgeState), [
    activeLyricsResult,
    currentTime,
    currentTrack,
    duration,
    effectiveDelayMs,
    lyricsIsLoading,
    lyricsQuery,
    lyricsShelfExpanded,
    lyricsStoreError,
    playbackState
  ])

  latestStateRef.current = bridgeState

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
    const unsubscribe = window.electronAPI.lyricsPopout.onCommand((command) => {
      const player = usePlayerStore.getState()
      switch (command.type) {
        case 'refresh': {
          const currentQuery = buildLyricsQuery(player.currentTrack)
          if (!currentQuery) return
          void refreshLyricsForTrack(currentQuery)
          break
        }
        case 'seek': {
          const seekTimeSeconds = clampSeekTime(command.time, player.duration)
          if (seekTimeSeconds === null) return
          void player.seek(seekTimeSeconds)
          break
        }
      }
    })

    return () => unsubscribe()
  }, [refreshLyricsForTrack])

  useEffect(() => {
    const nextSnapshot = buildLyricsPopoutSnapshot(bridgeState)
    const reason = getLyricsPopoutPublishReason({
      trigger: 'state-change',
      isWindowOpen: lyricsPopoutIsOpen,
      wasWindowOpen: previousWindowOpenRef.current,
      nextSnapshot,
      lastPublishedSnapshot: lastPublishedSnapshotRef.current,
      now: nextSnapshot.capturedAt
    })

    previousWindowOpenRef.current = lyricsPopoutIsOpen

    if (reason === 'closed' || reason === 'not-needed') {
      return
    }

    window.electronAPI.lyricsPopout.publishSnapshot(nextSnapshot)
    lastPublishedSnapshotRef.current = nextSnapshot
  }, [bridgeState, lyricsPopoutIsOpen])

  useEffect(() => {
    if (resyncTimerRef.current !== null) {
      window.clearInterval(resyncTimerRef.current)
      resyncTimerRef.current = null
    }

    if (!lyricsPopoutIsOpen || playbackState !== 'playing') {
      return
    }

    resyncTimerRef.current = window.setInterval(() => {
      const latestState = latestStateRef.current
      if (!latestState) return

      const nextSnapshot = buildLyricsPopoutSnapshot(latestState)
      const reason = getLyricsPopoutPublishReason({
        trigger: 'resync-tick',
        isWindowOpen: true,
        wasWindowOpen: true,
        nextSnapshot,
        lastPublishedSnapshot: lastPublishedSnapshotRef.current,
        now: nextSnapshot.capturedAt,
        resyncIntervalMs: LYRICS_POPOUT_RESYNC_INTERVAL_MS
      })

      if (reason !== 'resync' && reason !== 'no-snapshot') {
        return
      }

      window.electronAPI.lyricsPopout.publishSnapshot(nextSnapshot)
      lastPublishedSnapshotRef.current = nextSnapshot
    }, LYRICS_POPOUT_RESYNC_INTERVAL_MS)

    return () => {
      if (resyncTimerRef.current !== null) {
        window.clearInterval(resyncTimerRef.current)
        resyncTimerRef.current = null
      }
    }
  }, [lyricsPopoutIsOpen, playbackState])
}
