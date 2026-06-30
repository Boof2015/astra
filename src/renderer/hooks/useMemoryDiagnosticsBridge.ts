import { useEffect, useRef } from 'react'
import type { ScopeKind } from '../../types/scopePopout'
import type {
  MemoryDiagnosticsBlinkResourceUsageSnapshot,
  MemoryDiagnosticsRendererSnapshot,
  MemoryDiagnosticsTitleBarPeakSnapshot,
  MemoryDiagnosticsTitleBarSampleSnapshot,
  MemoryDiagnosticsUserAgentSpecificMemorySnapshot
} from '../../types/diagnostics'
import { audioEngine } from '../audio/AudioEngine'
import { useDiscordSettingsStore } from '../stores/discordSettingsStore'
import { getDiscordPresenceDiagnosticsSnapshot } from './useDiscordPresence'
import { getCoverArtAccentDiagnosticsSnapshot } from './useCoverArtAccent'
import { getLibraryDiagnosticsSnapshot } from '../stores/libraryStore'
import { usePlayerStore, getPlayerDiagnosticsSnapshot } from '../stores/playerStore'
import { useAudioSettingsStore } from '../stores/audioSettingsStore'
import { useScopePopoutStore } from '../stores/scopePopoutStore'
import { useVisualizerSettingsStore } from '../stores/visualizerSettingsStore'
import { logMemoryDiagnosticsEvent } from '../utils/memoryDiagnostics'
import {
  captureTitleBarSample,
  createEmptyTitleBarPeaks,
  createEmptyTitleBarSample,
  createTitleBarPeaksFromSample,
  TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS,
  updateTitleBarPeaks
} from '../utils/titleBarMemoryStats'

const TITLE_BAR_STALE_SAMPLE_MS = TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS * 2

type PerformanceWithMemoryDiagnostics = Performance & {
  memory?: {
    usedJSHeapSize?: number
    totalJSHeapSize?: number
    jsHeapSizeLimit?: number
  }
  measureUserAgentSpecificMemory?: () => Promise<{
    bytes?: number
    breakdown?: Array<{
      bytes?: number
      types?: unknown
      attribution?: unknown
    }>
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getJsHeapStats(): {
  usedBytes: number | null
  totalBytes: number | null
  limitBytes: number | null
} {
  const performanceWithMemory = performance as PerformanceWithMemoryDiagnostics
  const memory = performanceWithMemory.memory
  if (!memory) {
    return {
      usedBytes: null,
      totalBytes: null,
      limitBytes: null
    }
  }
  const normalize = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return {
    usedBytes: normalize(memory.usedJSHeapSize),
    totalBytes: normalize(memory.totalJSHeapSize),
    limitBytes: normalize(memory.jsHeapSizeLimit)
  }
}

async function getUserAgentSpecificMemoryStats(): Promise<MemoryDiagnosticsUserAgentSpecificMemorySnapshot | null> {
  const performanceWithDiagnostics = performance as PerformanceWithMemoryDiagnostics
  if (typeof performanceWithDiagnostics.measureUserAgentSpecificMemory !== 'function') {
    return null
  }

  try {
    const result = await performanceWithDiagnostics.measureUserAgentSpecificMemory()
    if (typeof result?.bytes !== 'number' || !Number.isFinite(result.bytes)) {
      return null
    }

    const breakdown = Array.isArray(result.breakdown)
      ? result.breakdown.flatMap((entry) => {
          if (!entry || typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes)) {
            return []
          }

          const types = Array.isArray(entry.types)
            ? entry.types.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : []
          const attribution = Array.isArray(entry.attribution)
            ? entry.attribution.flatMap((item) => {
                if (!isRecord(item)) return []
                const normalized = Object.entries(item).reduce<Record<string, string | null>>((acc, [key, value]) => {
                  if (typeof value === 'string') {
                    acc[key] = value
                  } else if (value === null) {
                    acc[key] = null
                  }
                  return acc
                }, {})
                return Object.keys(normalized).length > 0 ? [normalized] : []
              })
            : []

          return [{
            bytes: entry.bytes,
            types,
            attribution
          }]
        })
      : []

    return {
      bytes: result.bytes,
      breakdown
    }
  } catch {
    return null
  }
}

function getBlinkResourceUsage(): MemoryDiagnosticsBlinkResourceUsageSnapshot | null {
  try {
    return window.electronAPI.diagnostics.getBlinkResourceUsage()
  } catch {
    return null
  }
}

export function useMemoryDiagnosticsBridge(): void {
  const miniVisualizerModeRef = useRef<string>('unknown')
  const diagnosticsEnabledRef = useRef(false)
  const titleBarSampleRef = useRef<MemoryDiagnosticsTitleBarSampleSnapshot>(createEmptyTitleBarSample())
  const titleBarPeaksRef = useRef<MemoryDiagnosticsTitleBarPeakSnapshot>(createEmptyTitleBarPeaks())
  const titleBarSamplerTimerRef = useRef<number | null>(null)
  const titleBarSamplerInFlightRef = useRef<Promise<MemoryDiagnosticsTitleBarSampleSnapshot> | null>(null)

  const refreshTitleBarSample = async (force = false): Promise<MemoryDiagnosticsTitleBarSampleSnapshot> => {
    if (!force && !diagnosticsEnabledRef.current) {
      return titleBarSampleRef.current
    }
    if (titleBarSamplerInFlightRef.current) {
      return titleBarSamplerInFlightRef.current
    }

    const task = captureTitleBarSample()
      .then((sample) => {
        titleBarSampleRef.current = sample
        titleBarPeaksRef.current = updateTitleBarPeaks(titleBarPeaksRef.current, sample)
        return sample
      })
      .catch(() => titleBarSampleRef.current)
      .finally(() => {
        titleBarSamplerInFlightRef.current = null
      })

    titleBarSamplerInFlightRef.current = task
    return task
  }

  const ensureFreshTitleBarSample = async (): Promise<MemoryDiagnosticsTitleBarSampleSnapshot> => {
    const current = titleBarSampleRef.current
    if (current.sampledAt !== null && (Date.now() - current.sampledAt) <= TITLE_BAR_STALE_SAMPLE_MS) {
      return current
    }
    return refreshTitleBarSample(true)
  }

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      miniVisualizerModeRef.current = state.visualizerMode
    }).catch(() => {
      miniVisualizerModeRef.current = 'unknown'
    })

    const unsubscribe = window.electronAPI.miniPlayer.onWindowState((state) => {
      miniVisualizerModeRef.current = state.visualizerMode
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let disposed = false

    const stopSampler = () => {
      if (titleBarSamplerTimerRef.current !== null) {
        window.clearInterval(titleBarSamplerTimerRef.current)
        titleBarSamplerTimerRef.current = null
      }
    }

    const startSampler = () => {
      if (titleBarSamplerTimerRef.current !== null) return
      void refreshTitleBarSample(true)
      titleBarSamplerTimerRef.current = window.setInterval(() => {
        void refreshTitleBarSample()
      }, TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS)
    }

    const applyEnabledState = (enabled: boolean) => {
      diagnosticsEnabledRef.current = enabled
      if (!enabled) {
        stopSampler()
        titleBarSampleRef.current = createEmptyTitleBarSample()
        titleBarPeaksRef.current = createEmptyTitleBarPeaks()
        return
      }
      startSampler()
    }

    void window.electronAPI.diagnostics.getStatus()
      .then((status) => {
        if (disposed) return
        applyEnabledState(status.enabled)
      })
      .catch(() => {})

    const unsubscribeStatus = window.electronAPI.diagnostics.onStatus((status) => {
      if (disposed) return
      applyEnabledState(status.enabled)
    })

    return () => {
      disposed = true
      stopSampler()
      unsubscribeStatus()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.diagnostics.onSnapshotRequest((request) => {
      void (async () => {
        const [titleBarSample, userAgentSpecificMemory] = await Promise.all([
          ensureFreshTitleBarSample(),
          getUserAgentSpecificMemoryStats()
        ])
        const titleBarPeaks = titleBarSample.sampledAt === null
          ? titleBarPeaksRef.current
          : updateTitleBarPeaks(titleBarPeaksRef.current, titleBarSample)
        const blinkResourceUsage = getBlinkResourceUsage()

        titleBarPeaksRef.current = createTitleBarPeaksFromSample(titleBarSample)

        const audioSnapshot = audioEngine.getDiagnosticsSnapshot()
        const playerState = usePlayerStore.getState()
        const playerDiagnostics = getPlayerDiagnosticsSnapshot()
        const visualizerState = useVisualizerSettingsStore.getState()
        const librarySnapshot = getLibraryDiagnosticsSnapshot()
        const nextTrack = playerState.getResolvedNextTrack()
        const diagnosticsSnapshot: MemoryDiagnosticsRendererSnapshot = {
          capturedAt: Date.now(),
          rendererPrivateMb: null,
          rendererProcessRssBytes: null,
          rendererProcessHeapUsedBytes: null,
          rendererProcessHeapTotalBytes: null,
          rendererProcessExternalBytes: null,
          rendererProcessArrayBuffersBytes: null,
          jsHeapUsedBytes: null,
          jsHeapTotalBytes: null,
          jsHeapLimitBytes: null,
          userAgentSpecificMemory,
          blinkResourceUsage,
          heapSpaces: {
            oldSpaceUsedBytes: null,
            newSpaceUsedBytes: null,
            codeSpaceUsedBytes: null,
            mapSpaceUsedBytes: null,
            largeObjectSpaceUsedBytes: null
          },
          titleBar: titleBarSample,
          titleBarPeaks,
          gaplessPrebufferDisabledDev: useAudioSettingsStore.getState().disableGaplessPrebufferDev,
          standardAnalysisGraphDisabledDev: useAudioSettingsStore.getState().disableStandardAnalysisGraphDev,
          playbackState: playerState.playbackState,
          currentTimeSeconds: playerState.currentTime,
          currentTrackPath: playerState.currentTrack?.path ?? null,
          currentTrackSourceType: playerState.currentTrack
            ? (playerState.currentTrack.sourceType ?? 'local')
            : null,
          currentTrackDurationSeconds: playerState.currentTrack?.duration ?? null,
          currentTrackArtworkDataBytes: typeof playerState.currentTrack?.artworkData === 'string'
            ? playerState.currentTrack.artworkData.length * 2
            : 0,
          nextTrackPath: nextTrack?.path ?? null,
          nextTrackSourceType: nextTrack?.sourceType ?? null,
          remoteStreamSessionId: playerState.remoteStreamSessionId,
          remoteBufferedSeconds: playerState.remoteBufferedSeconds,
          remoteLoad: playerState.remoteLoadProgress
            ? {
                stage: playerState.remoteLoadProgress.stage,
                loadedBytes: playerState.remoteLoadProgress.loadedBytes,
                totalBytes: playerState.remoteLoadProgress.totalBytes,
                chunkCount: playerState.remoteLoadProgress.chunkCount,
                percent: playerState.remoteLoadProgress.percent,
                done: playerState.remoteLoadProgress.done,
                failed: playerState.remoteLoadProgress.failed,
                bufferedSeconds: playerState.remoteLoadProgress.bufferedSeconds,
                bufferedPercent: playerState.remoteLoadProgress.bufferedPercent,
                analyzedSeconds: playerState.remoteLoadProgress.analyzedSeconds,
                analyzedPercent: playerState.remoteLoadProgress.analyzedPercent,
                playable: playerState.remoteLoadProgress.playable
              }
            : null,
          discordEnabled: useDiscordSettingsStore.getState().enabled,
          discordCoverArtEnabled: useDiscordSettingsStore.getState().coverArtEnabled,
          queue: {
            userQueueCount: playerState.queueItems.filter((item) => item.origin === 'manual').length,
            autoQueueCount: playerState.queueItems.filter((item) => item.origin === 'context').length,
            playbackHistoryCount: playerState.playbackHistory.length,
            playbackFutureCount: 0,
            shuffle: playerState.shuffle,
            repeat: playerState.repeat,
            retainedTrackCount: playerDiagnostics.retention.retainedTrackCount,
            distinctRetainedTrackCount: playerDiagnostics.retention.distinctRetainedTrackCount,
            retainedArtworkTrackCount: playerDiagnostics.retention.retainedArtworkTrackCount,
            retainedArtworkDataBytes: playerDiagnostics.retention.retainedArtworkDataBytes
          },
          audio: {
            ...audioSnapshot
          },
          visualizer: {
            isRunning: visualizerState.isRunning,
            fftSize: visualizerState.fftSize,
            spectrogramFftSize: visualizerState.spectrogramFftSize,
            hiddenScopeCount: visualizerState.hiddenScopes.length,
            activeScopeCount: visualizerState.scopeOrder.length - visualizerState.hiddenScopes.length,
            openScopes: Object.entries(useScopePopoutStore.getState().state)
              .filter(([, isOpen]) => Boolean(isOpen))
              .map(([scope]) => scope as ScopeKind),
            activeScopes: visualizerState.scopeOrder.filter((scope) => !visualizerState.hiddenScopes.includes(scope)),
            miniVisualizerMode: miniVisualizerModeRef.current
          },
          scopePopouts: { ...useScopePopoutStore.getState().state },
          library: {
            totalTrackCount: librarySnapshot.totalTrackCount,
            visibleTrackCount: librarySnapshot.visibleTrackCount,
            fullTrackCount: librarySnapshot.fullTrackCount,
            albumCount: librarySnapshot.albumCount,
            artistCount: librarySnapshot.artistCount,
            genreCount: librarySnapshot.genreCount,
            folderCount: librarySnapshot.folderCount,
            favoriteCount: librarySnapshot.favoriteCount,
            favoriteTrackCount: librarySnapshot.favoriteTrackCount,
            recentlyPlayedCount: librarySnapshot.recentlyPlayedCount,
            searchResultCount: librarySnapshot.searchResultCount,
            selectionHistoryCount: librarySnapshot.selectionHistoryCount,
            selectionHistoryTrackCount: librarySnapshot.selectionHistoryTrackCount,
            selectedDetailTrackCount: librarySnapshot.selectedDetailTrackCount,
            scanInProgress: librarySnapshot.scanInProgress
          },
          caches: {
            ...playerDiagnostics.caches,
            ...librarySnapshot.caches,
            ...getCoverArtAccentDiagnosticsSnapshot(),
            ...getDiscordPresenceDiagnosticsSnapshot()
          }
        }

        const { usedBytes, totalBytes, limitBytes } = getJsHeapStats()
        diagnosticsSnapshot.jsHeapUsedBytes = usedBytes
        diagnosticsSnapshot.jsHeapTotalBytes = totalBytes
        diagnosticsSnapshot.jsHeapLimitBytes = limitBytes

        try {
          const memoryStats = await window.electronAPI.getRendererMemoryStats()
          diagnosticsSnapshot.rendererPrivateMb = memoryStats.privateMb
          diagnosticsSnapshot.rendererProcessRssBytes = memoryStats.rssBytes
          diagnosticsSnapshot.rendererProcessHeapUsedBytes = memoryStats.heapUsedBytes
          diagnosticsSnapshot.rendererProcessHeapTotalBytes = memoryStats.heapTotalBytes
          diagnosticsSnapshot.rendererProcessExternalBytes = memoryStats.externalBytes
          diagnosticsSnapshot.rendererProcessArrayBuffersBytes = memoryStats.arrayBuffersBytes
          diagnosticsSnapshot.heapSpaces = memoryStats.heapSpaces
        } catch {
          diagnosticsSnapshot.rendererPrivateMb = null
        }

        window.electronAPI.diagnostics.publishRendererSnapshot(request.requestId, diagnosticsSnapshot)
      })()
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    let previousRemoteStreamSessionId = usePlayerStore.getState().remoteStreamSessionId
    const unsubscribePlayer = usePlayerStore.subscribe((state) => {
      if (previousRemoteStreamSessionId !== null && state.remoteStreamSessionId === null) {
        logMemoryDiagnosticsEvent('remote_stream_ended', {
          previousSessionId: previousRemoteStreamSessionId,
          currentTrackPath: state.currentTrack?.path ?? null
        })
      }
      previousRemoteStreamSessionId = state.remoteStreamSessionId
    })

    return () => {
      unsubscribePlayer()
    }
  }, [])
}
