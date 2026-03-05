import { useEffect } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import QuickLaunchPalette from './components/layout/QuickLaunchPalette'
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
import { usePlayerStore } from './stores/playerStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useMiniPlayerBridge } from './hooks/useMiniPlayerBridge'
import { useScopePopoutBridge } from './hooks/useScopePopoutBridge'
import { useCoverArtAccent } from './hooks/useCoverArtAccent'
import { useRuntimeAppIconSync } from './hooks/useRuntimeAppIconSync'
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
  useKeyboardShortcuts()
  useMediaSession()
  useDiscordPresence()
  useMiniPlayerBridge()
  useScopePopoutBridge()
  useCoverArtAccent()
  useRuntimeAppIconSync()

  const showQueue = useUIStore((s) => s.showQueue)
  const showInfoSidebar = useUIStore((s) => s.showInfoSidebar)
  const isFullscreen = useUIStore((s) => s.isFullscreen)

  useEffect(() => {
    useThemeStore.getState().initFromSaved()
    useLibraryStore.getState().loadLibrary()
    useAudioSettingsStore.getState().initFromSaved()
    useDiscordSettingsStore.getState().initFromSaved()
    void useLocalApiSettingsStore.getState().init()
    void useLastFmSettingsStore.getState().init()
    void useLyricsStore.getState().init()
    void useSubsonicSettingsStore.getState().init()

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
      player.setQueue(queueTracks, 0)

      const firstTrack = queueTracks[0]
      const loaded = await window.electronAPI.loadAudioFile(firstTrack.path, { metadataMode: 'none' })
      if (!loaded) {
        return
      }

      const didLoad = await player.loadTrack(firstTrack, loaded.data)
      if (didLoad) {
        await player.play()
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
    const unsubscribeBackfill = window.electronAPI.library.onAudioMetadataBackfillComplete(() => {
      void useLibraryStore.getState().loadLibrary()
    })
    return () => {
      unsubscribeBackfill()
      unsubscribeAssociatedOpenFiles()
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      <AnalyzerDeck />
      <div className="app-body">
        <Sidebar />
        <div className="app-content">
          <ViewRouter />
          {showQueue && (
            <div className="queue-sidebar">
              <QueuePanel />
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
      {isFullscreen && <FullscreenMode />}
    </div>
  )
}

export default App
