import { useEffect } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import DecodeFallbackCue from './components/layout/DecodeFallbackCue'
import OutputDelayCue from './components/layout/OutputDelayCue'
import UpdateAvailableCue from './components/layout/UpdateAvailableCue'
import { useUIStore } from './stores/uiStore'
import { useLibraryStore } from './stores/libraryStore'
import { useAudioSettingsStore } from './stores/audioSettingsStore'
import { useDiscordSettingsStore } from './stores/discordSettingsStore'
import { useThemeStore } from './stores/themeStore'
import { useUpdateStore } from './stores/updateStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useMiniPlayerBridge } from './hooks/useMiniPlayerBridge'
import { useScopePopoutBridge } from './hooks/useScopePopoutBridge'
import { useCoverArtAccent } from './hooks/useCoverArtAccent'
import { useRuntimeAppIconSync } from './hooks/useRuntimeAppIconSync'

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
    const updatesStore = useUpdateStore.getState()
    if (updatesStore.autoCheckEnabled) {
      void updatesStore.checkForUpdates()
    }
    const unsubscribe = window.electronAPI.library.onAudioMetadataBackfillComplete(() => {
      void useLibraryStore.getState().loadLibrary()
    })
    return () => unsubscribe()
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
      <UpdateAvailableCue />
      {isFullscreen && <FullscreenMode />}
    </div>
  )
}

export default App
