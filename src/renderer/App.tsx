import TitleBar from './components/layout/TitleBar'
import MainContent from './components/layout/MainContent'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'

function App() {
  useKeyboardShortcuts()
  useMediaSession()

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <MainContent />
      </div>
    </div>
  )
}

export default App
