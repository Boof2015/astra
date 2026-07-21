import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import QueuePanelBoundary from './components/queue/QueuePanelBoundary'
import CollectionQueueContextMenu from './components/queue/CollectionQueueContextMenu'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import ZoneDisplay from './components/layout/ZoneDisplay'
import QuickLaunchPalette from './components/layout/QuickLaunchPalette'
import DecodeFallbackCue from './components/layout/DecodeFallbackCue'
import OutputDelayCue from './components/layout/OutputDelayCue'
import UpdateAvailableCue from './components/layout/UpdateAvailableCue'
import AssociatedOpenCue from './components/layout/AssociatedOpenCue'
import ParallaxSinkMode from './components/layout/ParallaxSinkMode'
import ParallaxIncomingPairCard from './components/layout/ParallaxIncomingPairCard'
import PhoneRemoteIncomingPairCard from './components/layout/PhoneRemoteIncomingPairCard'
import PhoneSyncConflictResolverModal from './components/sync/PhoneSyncConflictResolverModal'
import { runHostOutputCalibration } from './audio/parallaxCalibration'
import ControllerHints from './components/layout/ControllerHints'
import ControllerFocusRing from './components/layout/ControllerFocusRing'
import ControllerRadialMenu from './components/layout/ControllerRadialMenu'
import LibraryIntegrityPanel from './components/library/LibraryIntegrityPanel'
import TrackIntegrityResultModal from './components/library/TrackIntegrityResultModal'
import MetadataEditorPanel from './components/metadata/MetadataEditorPanel'
import LyricsEditorPanel from './components/lyrics/LyricsEditorPanel'
import SignalShareModal from './components/signal/SignalShareModal'
import { useUIStore } from './stores/uiStore'
import { useLibraryStore } from './stores/libraryStore'
import { useRatingsStore } from './stores/ratingsStore'
import { useAudioSettingsStore } from './stores/audioSettingsStore'
import { useDiscordSettingsStore } from './stores/discordSettingsStore'
import { useThemeStore } from './stores/themeStore'
import { useUpdateStore } from './stores/updateStore'
import { useLocalApiSettingsStore } from './stores/localApiSettingsStore'
import { usePhoneRemoteSettingsStore } from './stores/phoneRemoteSettingsStore'
import { useParallaxStore } from './stores/parallaxStore'
import { useLastFmSettingsStore } from './stores/lastFmSettingsStore'
import { useLyricsStore } from './stores/lyricsStore'
import { useSubsonicSettingsStore } from './stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from './stores/jellyfinSettingsStore'
import { useGraphStore } from './stores/graphStore'
import { useListeningStatsStore } from './stores/listeningStatsStore'
import { usePlayerStore } from './stores/playerStore'
import { usePlaylistStore } from './stores/playlistStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useMiniPlayerBridge } from './hooks/useMiniPlayerBridge'
import { useCompanionApiBridge } from './hooks/useCompanionApiBridge'
import { useLyricsPopoutBridge } from './hooks/useLyricsPopoutBridge'
import { useScopePopoutBridge } from './hooks/useScopePopoutBridge'
import { useMemoryDiagnosticsBridge } from './hooks/useMemoryDiagnosticsBridge'
import { useCoverArtAccent } from './hooks/useCoverArtAccent'
import { useRuntimeAppIconSync } from './hooks/useRuntimeAppIconSync'
import { usePointerFocusCleanup } from './hooks/usePointerFocusCleanup'
import { useControllerInput } from './hooks/useControllerInput'
import { usePresence } from './hooks/usePresence'
import type { Track } from './types/audio'
import { readSessionSnapshot } from './utils/sessionState'
import { installSessionPersistence } from './utils/sessionAutosave'

function toAssociatedExternalTrack(filePath: string): Track {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const fileName = normalizedPath.split('/').pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf('.')
  const title = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  const format = extensionIndex > 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : 'unknown'

  return {
    id: filePath,
    path: filePath,
    origin: 'associated-external',
    title,
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    duration: 0,
    format,
  }
}

function getAssociatedOpenSourceLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'File Explorer'
  return 'File Manager'
}

function App() {
  const rackShellRef = useRef<HTMLDivElement | null>(null)
  const collapseToggleRef = useRef<HTMLButtonElement | null>(null)

  usePointerFocusCleanup()
  useKeyboardShortcuts()
  const controllerInput = useControllerInput()
  useMediaSession()
  useDiscordPresence()
  useMiniPlayerBridge()
  useCompanionApiBridge()
  useLyricsPopoutBridge()
  useScopePopoutBridge()
  useMemoryDiagnosticsBridge()
  useCoverArtAccent()
  useRuntimeAppIconSync()

  const showQueue = useUIStore((s) => s.showQueue)
  const activeView = useUIStore((s) => s.activeView)
  const replaceActiveView = useUIStore((s) => s.replaceActiveView)
  const showInfoSidebar = useUIStore((s) => s.showInfoSidebar)
  const isAnalyzerEditMode = useUIStore((s) => s.isAnalyzerEditMode)
  const isAnalyzerRackVisible = useUIStore((s) => s.isAnalyzerRackVisible)
  const showAnalyzerRack = useUIStore((s) => s.showAnalyzerRack)
  const hideAnalyzerRack = useUIStore((s) => s.hideAnalyzerRack)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const isZoneDisplayActive = useUIStore((s) => s.isZoneDisplayActive)
  const analyzerHeightPx = useUIStore((s) => s.analyzerHeightPx)
  const uiScalePercent = useUIStore((s) => s.uiScalePercent)
  const [analyzerHeightPreviewPx, setAnalyzerHeightPreviewPx] = useState<number | null>(null)
  const [isCollapseToggleNearby, setIsCollapseToggleNearby] = useState(false)
  const graphEnabled = useGraphStore((s) => s.enabled)
  const listeningStatsEnabled = useListeningStatsStore((s) => s.enabled)
  const queuePresence = usePresence(showQueue)
  const infoSidebarPresence = usePresence(showInfoSidebar)

  const appStyle = useMemo(() => {
    const uiScale = uiScalePercent / 100
    return {
      '--analyzer-height': `${isAnalyzerRackVisible ? (analyzerHeightPreviewPx ?? analyzerHeightPx) : 0}px`,
      '--ui-scale': String(uiScale),
      '--ui-scale-size': `${100 / uiScale}%`,
    } as CSSProperties
  }, [analyzerHeightPreviewPx, analyzerHeightPx, isAnalyzerRackVisible, uiScalePercent])

  useEffect(() => {
    if (!isAnalyzerRackVisible) {
      setAnalyzerHeightPreviewPx(null)
    }
  }, [isAnalyzerRackVisible])

  useEffect(() => {
    if (activeView === 'graph' && !graphEnabled) {
      replaceActiveView('home')
    }
    if (activeView === 'stats' && !listeningStatsEnabled) {
      replaceActiveView('home')
    }
  }, [activeView, graphEnabled, listeningStatsEnabled, replaceActiveView])

  useEffect(() => {
    if (!isAnalyzerRackVisible || isAnalyzerEditMode) {
      setIsCollapseToggleNearby(false)
      return
    }

    const horizontalRevealMarginPx = 24
    const topRevealMarginPx = 12
    const bottomRevealMarginPx = 24

    const updateNearbyState = (nextValue: boolean) => {
      setIsCollapseToggleNearby((currentValue) => currentValue === nextValue ? currentValue : nextValue)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') {
        updateNearbyState(false)
        return
      }

      const rackShell = rackShellRef.current
      const collapseToggle = collapseToggleRef.current
      if (!rackShell || !collapseToggle) {
        updateNearbyState(false)
        return
      }

      const rackRect = rackShell.getBoundingClientRect()
      const toggleRect = collapseToggle.getBoundingClientRect()
      const isInsideRack =
        event.clientX >= rackRect.left &&
        event.clientX <= rackRect.right &&
        event.clientY >= rackRect.top &&
        event.clientY <= rackRect.bottom

      if (isInsideRack) {
        updateNearbyState(false)
        return
      }

      // Reveal the hidden collapse control as the cursor approaches its resting position.
      const isNearToggle =
        event.clientX >= toggleRect.left - horizontalRevealMarginPx &&
        event.clientX <= toggleRect.right + horizontalRevealMarginPx &&
        event.clientY >= toggleRect.top - topRevealMarginPx &&
        event.clientY <= toggleRect.bottom + bottomRevealMarginPx

      updateNearbyState(isNearToggle)
    }

    const handleWindowBlur = () => {
      updateNearbyState(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [isAnalyzerEditMode, isAnalyzerRackVisible])

  // §22 Commit 2 — expose the calibration runner on `window.parallaxCalibration` so the
  // Windows-side validation pass can invoke it from devtools without needing UI. Commit 3 will
  // add the Settings dev-mode button. Dedicated AudioContext keeps calibration isolated from
  // the main playback engine — the measurement still captures the same OS render-endpoint
  // bias because every WebAudio context on a device shares the same downstream mixer path.
  useEffect(() => {
    const w = window as unknown as {
      parallaxCalibration?: {
        run: () => Promise<unknown>
        loopbackDiag: (durationMs?: number) => Promise<unknown>
        help: () => void
      }
    }
    w.parallaxCalibration = {
      run: async () => {
        const ctx = new AudioContext()
        try {
          if (ctx.state === 'suspended') await ctx.resume()
          const result = await runHostOutputCalibration(ctx)
          // Compact one-line summary for restart-to-restart comparison without expanding.
          const chirpsCast = result.chirps as Array<{ observedLatencyMs: number | null; confidence: number }>
          const lats = chirpsCast.map((c) => c.observedLatencyMs).filter((v): v is number => v !== null).map((v) => v.toFixed(2))
          const confs = chirpsCast.map((c) => c.confidence.toFixed(2))
          console.log(
            `[parallaxCalibration] measured=${result.measuredLatencyMs?.toFixed(2) ?? 'null'}ms` +
            ` estimated=${result.estimatedLatencyMs.toFixed(2)}ms` +
            ` range=${result.rangeMs?.toFixed(2) ?? 'null'}ms` +
            ` chirps=[${lats.join(', ')}]` +
            ` conf=[${confs.join(', ')}]` +
            ` ok=${result.ok}` +
            (result.rejectReason ? ` reject=${result.rejectReason}` : '')
          )
          console.log('[parallaxCalibration] result:', result)
          return result
        } finally {
          void ctx.close().catch(() => undefined)
        }
      },
      // Diagnostic: opens loopback, waits, scans captured PCM for real audio vs NaN vs silence.
      // Caller plays music in Astra manually between start() and the resolution of this Promise.
      loopbackDiag: async (durationMs = 3000) => {
        const api = window.parallaxLoopbackAPI
        if (!api) {
          console.log('[loopbackDiag] no parallaxLoopbackAPI')
          return null
        }
        const startResult = api.start()
        console.log('[loopbackDiag] start:', startResult)
        console.log(`[loopbackDiag] capturing for ${durationMs} ms — PLAY MUSIC IN ASTRA NOW`)
        await new Promise((r) => setTimeout(r, durationMs))
        const segs = api.drain()
        let nonZero = 0
        let nan = 0
        let zero = 0
        let firstNonZero: number | null = null
        for (const seg of segs) {
          for (let i = 0; i < seg.pcm.length; i += 1) {
            const v = seg.pcm[i]
            if (Number.isNaN(v)) {
              nan += 1
            } else if (v === 0) {
              zero += 1
            } else {
              nonZero += 1
              if (firstNonZero === null) firstNonZero = v
            }
          }
        }
        const result = {
          segments: segs.length,
          totalSamples: nonZero + nan + zero,
          nonZero,
          nan,
          zero,
          firstNonZero,
          first10Samples: Array.from(segs[0]?.pcm.slice(0, 10) ?? [])
        }
        console.log('[loopbackDiag] result:', result)
        api.stop()
        return result
      },
      help: () => {
        console.log(
          '[parallaxCalibration]\n' +
          '  Call window.parallaxCalibration.run() to run a host-output calibration cycle.\n' +
          '  Plays 3 short log chirps (50ms, ≈-20dBFS, with edge fades) ~150ms apart, captures via\n' +
          '  WASAPI loopback, cross-correlates, returns:\n' +
          '    measuredLatencyMs:    median Web Audio scheduling → loopback observation, ms\n' +
          '    estimatedLatencyMs:   AudioContext.outputLatency + baseLatency (for comparison)\n' +
          '    rangeMs:              max - min across chirps (gates ≤ 3 ms in v1)\n' +
          '    meanConfidence:       mean normalized correlation peak (gates ≥ 0.7 in v1)\n' +
          '    chirps[]:             per-chirp diagnostics\n' +
          '  Validation goal: measuredLatencyMs stable across restarts where estimatedLatencyMs drifts.'
        )
      }
    }
    return () => { delete w.parallaxCalibration }
  }, [])

  useEffect(() => {
    let sessionPersistenceCleanup: (() => void) | null = null
    let associatedOpenReady = false
    let didUnmount = false
    const sessionSnapshot = readSessionSnapshot()

    useThemeStore.getState().initFromSaved()
    useAudioSettingsStore.getState().initFromSaved()
    useDiscordSettingsStore.getState().initFromSaved()
    void useLocalApiSettingsStore.getState().init()
    void usePhoneRemoteSettingsStore.getState().init()
    void useParallaxStore.getState().init()
    void useLastFmSettingsStore.getState().init()
    void useLyricsStore.getState().init()
    void useSubsonicSettingsStore.getState().init()
    void useJellyfinSettingsStore.getState().init()

    const handleAssociatedOpenFiles = async (rawPaths: string[]) => {
      const queuePaths = [...new Set(
        rawPaths
          .filter((path): path is string => typeof path === 'string')
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )]
      if (queuePaths.length === 0) {
        return
      }

      const queueTracks = queuePaths.map(toAssociatedExternalTrack)
      const player = usePlayerStore.getState()
      await player.startPlaybackContext(queueTracks, 0, {
        contextLabel: getAssociatedOpenSourceLabel(window.electronAPI.platform)
      })
      if (usePlayerStore.getState().currentTrack?.path === queueTracks[0]?.path) {
        const firstTrack = queueTracks[0]
        player.showAssociatedOpenNotice({
          trackPath: firstTrack.path,
          title: firstTrack.title,
          fileCount: queueTracks.length,
          sourceLabel: getAssociatedOpenSourceLabel(window.electronAPI.platform)
        })
      }
    }

    const unsubscribeAssociatedOpenFiles = window.electronAPI.associatedOpenFiles.onOpenFiles((paths) => {
      void handleAssociatedOpenFiles(paths).catch((error) => {
        console.error('Failed to handle associated open files:', error)
      })
    })

    void (async () => {
      try {
        if (sessionSnapshot?.ui) {
          useUIStore.getState().restoreSession(sessionSnapshot.ui)
        }

        const libraryStore = useLibraryStore.getState()
        void useRatingsStore.getState().loadRatings()
        await libraryStore.loadLibrary()
        if (sessionSnapshot?.library) {
          await libraryStore.restoreSession(sessionSnapshot.library)
        }

        const playlistStore = usePlaylistStore.getState()
        await playlistStore.loadPlaylists()
        if (sessionSnapshot?.playlist) {
          await playlistStore.restoreSession(sessionSnapshot.playlist)
        }

        if (sessionSnapshot?.player) {
          await usePlayerStore.getState().restoreSession(sessionSnapshot.player)
        }
      } catch (error) {
        console.error('Failed to restore Astra session:', error)
      } finally {
        if (!didUnmount) {
          sessionPersistenceCleanup = installSessionPersistence()
          window.electronAPI.associatedOpenFiles.markReady()
          associatedOpenReady = true
        }
      }
    })()

    const updatesStore = useUpdateStore.getState()
    if (updatesStore.autoCheckEnabled) {
      void updatesStore.checkForUpdates()
    }
    const unsubscribeFileCreatedAtBackfill = window.electronAPI.library.onFileCreatedAtBackfillComplete(() => {
      void useLibraryStore.getState().loadLibrary()
    })
    const unsubscribeBackfill = window.electronAPI.library.onAudioMetadataBackfillComplete(() => {
      void useLibraryStore.getState().loadLibrary()
    })
    // A mobile LAN sync mutates favorites/playlists in the main process.
    const unsubscribeExternalLibraryMutation = window.electronAPI.library.onExternalLibraryMutation(() => {
      void useLibraryStore.getState().loadFavorites()
      void usePlaylistStore.getState().loadPlaylists()
    })
    return () => {
      didUnmount = true
      unsubscribeFileCreatedAtBackfill()
      unsubscribeBackfill()
      unsubscribeExternalLibraryMutation()
      unsubscribeAssociatedOpenFiles()
      sessionPersistenceCleanup?.()
      if (!associatedOpenReady) {
        window.electronAPI.associatedOpenFiles.markReady()
      }
    }
  }, [])

  // §14.1.4 — Zone Display takes over the entire window when active. Normal shell suppressed.
  // Init effects above still run (theme, library, parallax, etc) so the store/IPC plumbing is
  // identical between the two modes. UI-scale wrapper kept so zone display obeys --ui-scale.
  if (isZoneDisplayActive) {
    return (
      <div className="app-scale-host" style={appStyle}>
        <ZoneDisplay />
      </div>
    )
  }

  return (
    <div className="app-scale-host" style={appStyle}>
      <div
        className={`app ${isAnalyzerEditMode ? 'is-analyzer-editing' : ''}`.trim()}
      >
        <TitleBar />
        {isAnalyzerRackVisible && (
          <div
            ref={rackShellRef}
            className={`analyzer-rack-shell ${isCollapseToggleNearby ? 'is-collapse-toggle-nearby' : ''}`.trim()}
          >
            <AnalyzerDeck onAnalyzerHeightPreviewChange={setAnalyzerHeightPreviewPx} />
            {!isAnalyzerEditMode && (
              <button
                ref={collapseToggleRef}
                type="button"
                className="analyzer-rack-toggle analyzer-rack-collapse-toggle"
                onClick={hideAnalyzerRack}
                title="Hide analyzer rack"
                aria-label="Hide analyzer rack"
              >
                <svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden="true">
                  <path
                    d="M1 7l6-5 6 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        {!isAnalyzerRackVisible && (
          <button
            type="button"
            className="analyzer-rack-toggle analyzer-rack-restore-toggle"
            onClick={showAnalyzerRack}
            title="Show analyzer rack"
            aria-label="Show analyzer rack"
          >
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden="true">
              <path
                d="M1 7l6-5 6 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <div className="app-body">
          <Sidebar />
          <div className="app-content">
            <ViewRouter />
            {queuePresence.shouldRender && (
              <div
                className="queue-sidebar"
                data-presence={queuePresence.phase}
                aria-hidden={queuePresence.phase === 'exiting'}
              >
                <QueuePanelBoundary>
                  <QueuePanel />
                </QueuePanelBoundary>
              </div>
            )}
            {infoSidebarPresence.shouldRender && (
              <div
                className="info-sidebar-presence"
                data-presence={infoSidebarPresence.phase}
                aria-hidden={infoSidebarPresence.phase === 'exiting'}
              >
                <InfoSidebar />
              </div>
            )}
          </div>
        </div>
        <TransportBar />
        <ParallaxSinkMode />
        <ParallaxIncomingPairCard />
        <PhoneRemoteIncomingPairCard />
        <PhoneSyncConflictResolverModal />
        <DecodeFallbackCue />
        <OutputDelayCue />
        <AssociatedOpenCue />
        <UpdateAvailableCue />
        <QuickLaunchPalette />
        <LibraryIntegrityPanel />
        <TrackIntegrityResultModal />
        <MetadataEditorPanel />
        <LyricsEditorPanel />
        <SignalShareModal />
        <CollectionQueueContextMenu />
        {isFullscreen && <FullscreenMode />}
        <ControllerFocusRing active={controllerInput.active} />
        <ControllerRadialMenu
          active={controllerInput.active}
          family={controllerInput.family}
          canOpenContext={controllerInput.canOpenContext}
          radialMenu={controllerInput.radialMenu}
        />
        <ControllerHints active={controllerInput.active} family={controllerInput.family} />
      </div>
    </div>
  )
}

export default App
