import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import QueuePanelBoundary from './components/queue/QueuePanelBoundary'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import QuickLaunchPalette from './components/layout/QuickLaunchPalette'
import KeyboardShortcutsModal from './components/layout/KeyboardShortcutsModal'
import DecodeFallbackCue from './components/layout/DecodeFallbackCue'
import OutputDelayCue from './components/layout/OutputDelayCue'
import UpdateAvailableCue from './components/layout/UpdateAvailableCue'
import AssociatedOpenCue from './components/layout/AssociatedOpenCue'
import { useUIStore } from './stores/uiStore'
import { useLibraryStore } from './stores/libraryStore'
import { useAudioSettingsStore } from './stores/audioSettingsStore'
import { useDiscordSettingsStore } from './stores/discordSettingsStore'
import { useThemeStore } from './stores/themeStore'
import { useUpdateStore } from './stores/updateStore'
import { useLocalApiSettingsStore } from './stores/localApiSettingsStore'
import { useLastFmSettingsStore } from './stores/lastFmSettingsStore'
import { useLyricsStore } from './stores/lyricsStore'
import { useSubsonicSettingsStore } from './stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from './stores/jellyfinSettingsStore'
import { usePlayerStore } from './stores/playerStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useMiniPlayerBridge } from './hooks/useMiniPlayerBridge'
import { useScopePopoutBridge } from './hooks/useScopePopoutBridge'
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
  usePointerFocusCleanup()
  useKeyboardShortcuts()
  useMediaSession()
  useDiscordPresence()
  useMiniPlayerBridge()
  useScopePopoutBridge()
  useCoverArtAccent()
  useRuntimeAppIconSync()

  const showQueue = useUIStore((s) => s.showQueue)
  const showInfoSidebar = useUIStore((s) => s.showInfoSidebar)
  const isAnalyzerEditMode = useUIStore((s) => s.isAnalyzerEditMode)
  const isAnalyzerRackVisible = useUIStore((s) => s.isAnalyzerRackVisible)
  const showAnalyzerRack = useUIStore((s) => s.showAnalyzerRack)
  const hideAnalyzerRack = useUIStore((s) => s.hideAnalyzerRack)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const analyzerHeightPx = useUIStore((s) => s.analyzerHeightPx)
  const [analyzerHeightPreviewPx, setAnalyzerHeightPreviewPx] = useState<number | null>(null)

  const appStyle = useMemo(() => ({
    '--analyzer-height': `${isAnalyzerRackVisible ? (analyzerHeightPreviewPx ?? analyzerHeightPx) : 0}px`,
  }) as CSSProperties, [analyzerHeightPreviewPx, analyzerHeightPx, isAnalyzerRackVisible])

  useEffect(() => {
    if (!isAnalyzerRackVisible) {
      setAnalyzerHeightPreviewPx(null)
    }
  }, [isAnalyzerRackVisible])

  useEffect(() => {
    useThemeStore.getState().initFromSaved()
    useLibraryStore.getState().loadLibrary()
    useAudioSettingsStore.getState().initFromSaved()
    useDiscordSettingsStore.getState().initFromSaved()
    void useLocalApiSettingsStore.getState().init()
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

  return (
    <div
      className={`app ${isAnalyzerEditMode ? 'is-analyzer-editing' : ''}`.trim()}
      style={appStyle}
    >
      <TitleBar />
      {isAnalyzerRackVisible && (
        <div className="analyzer-rack-shell">
          <AnalyzerDeck onAnalyzerHeightPreviewChange={setAnalyzerHeightPreviewPx} />
          {!isAnalyzerEditMode && (
            <button
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
      <DecodeFallbackCue />
      <OutputDelayCue />
      <AssociatedOpenCue />
      <UpdateAvailableCue />
      <QuickLaunchPalette />
      <KeyboardShortcutsModal />
      {isFullscreen && <FullscreenMode />}
    </div>
  )
}

export default App
