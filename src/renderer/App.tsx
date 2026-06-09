import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import QueuePanelBoundary from './components/queue/QueuePanelBoundary'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import ZoneDisplay from './components/layout/ZoneDisplay'
import QuickLaunchPalette from './components/layout/QuickLaunchPalette'
import KeyboardShortcutsModal from './components/layout/KeyboardShortcutsModal'
import DecodeFallbackCue from './components/layout/DecodeFallbackCue'
import OutputDelayCue from './components/layout/OutputDelayCue'
import UpdateAvailableCue from './components/layout/UpdateAvailableCue'
import AssociatedOpenCue from './components/layout/AssociatedOpenCue'
import ParallaxSinkMode from './components/layout/ParallaxSinkMode'
import ParallaxIncomingPairCard from './components/layout/ParallaxIncomingPairCard'
import { runHostOutputCalibration } from './audio/parallaxCalibration'
import LibraryIntegrityPanel from './components/library/LibraryIntegrityPanel'
import TrackIntegrityResultModal from './components/library/TrackIntegrityResultModal'
import MetadataEditorPanel from './components/metadata/MetadataEditorPanel'
import LyricsEditorPanel from './components/lyrics/LyricsEditorPanel'
import { useUIStore } from './stores/uiStore'
import { useLibraryStore } from './stores/libraryStore'
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
import { usePlayerStore } from './stores/playerStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useMiniPlayerBridge } from './hooks/useMiniPlayerBridge'
import { useLyricsPopoutBridge } from './hooks/useLyricsPopoutBridge'
import { useScopePopoutBridge } from './hooks/useScopePopoutBridge'
import { useMemoryDiagnosticsBridge } from './hooks/useMemoryDiagnosticsBridge'
import { useCoverArtAccent } from './hooks/useCoverArtAccent'
import { useRuntimeAppIconSync } from './hooks/useRuntimeAppIconSync'
import { usePointerFocusCleanup } from './hooks/usePointerFocusCleanup'
import type { Track } from './types/audio'

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
  useMediaSession()
  useDiscordPresence()
  useMiniPlayerBridge()
  useLyricsPopoutBridge()
  useScopePopoutBridge()
  useMemoryDiagnosticsBridge()
  useCoverArtAccent()
  useRuntimeAppIconSync()

  const showQueue = useUIStore((s) => s.showQueue)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
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
      setActiveView('home')
    }
  }, [activeView, graphEnabled, setActiveView])

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
    useThemeStore.getState().initFromSaved()
    useLibraryStore.getState().loadLibrary()
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
    window.electronAPI.associatedOpenFiles.markReady()

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
    return () => {
      unsubscribeFileCreatedAtBackfill()
      unsubscribeBackfill()
      unsubscribeAssociatedOpenFiles()
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
            {showQueue && (
              <div className="queue-sidebar">
                <QueuePanelBoundary>
                  <QueuePanel />
                </QueuePanelBoundary>
              </div>
            )}
            {showInfoSidebar && <InfoSidebar />}
          </div>
        </div>
        <TransportBar />
        <ParallaxSinkMode />
        <ParallaxIncomingPairCard />
        <DecodeFallbackCue />
        <OutputDelayCue />
        <AssociatedOpenCue />
        <UpdateAvailableCue />
        <QuickLaunchPalette />
        <KeyboardShortcutsModal />
        <LibraryIntegrityPanel />
        <TrackIntegrityResultModal />
        <MetadataEditorPanel />
        <LyricsEditorPanel />
        {isFullscreen && <FullscreenMode />}
      </div>
    </div>
  )
}

export default App
