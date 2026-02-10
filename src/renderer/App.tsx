import { useEffect } from 'react'
import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import AnalyzerDeck from './components/layout/AnalyzerDeck'
import ViewRouter from './components/layout/ViewRouter'
import TransportBar from './components/layout/TransportBar'
import QueuePanel from './components/queue/QueuePanel'
import InfoSidebar from './components/layout/InfoSidebar'
import FullscreenMode from './components/layout/FullscreenMode'
import { useUIStore } from './stores/uiStore'
import { useLibraryStore } from './stores/libraryStore'
import { useAudioSettingsStore } from './stores/audioSettingsStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'

function App() {
  useKeyboardShortcuts()
  useMediaSession()

  const showQueue = useUIStore((s) => s.showQueue)
  const showInfoSidebar = useUIStore((s) => s.showInfoSidebar)
  const isFullscreen = useUIStore((s) => s.isFullscreen)

  useEffect(() => {
    useLibraryStore.getState().loadLibrary()
    useAudioSettingsStore.getState().initFromSaved()
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
      {isFullscreen && <FullscreenMode />}
    </div>
  )
}

export default App
