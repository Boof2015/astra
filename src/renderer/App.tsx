import TitleBar from './components/layout/TitleBar'
import Sidebar from './components/layout/Sidebar'
import MainContent from './components/layout/MainContent'

function App() {
  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <MainContent />
      </div>
    </div>
  )
}

export default App
