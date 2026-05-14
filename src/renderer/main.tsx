import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import App from './App'
import MiniPlayerApp from './components/mini/MiniPlayerApp'
import LyricsPopoutApp from './components/popout/LyricsPopoutApp'
import ScopePopoutApp from './components/popout/ScopePopoutApp'
import './styles/globals.css'

const windowMode = new URLSearchParams(window.location.search).get('window')
document.documentElement.dataset.windowMode = windowMode ?? 'main'
document.body.dataset.windowMode = windowMode ?? 'main'

const RootComponent = windowMode === 'mini'
  ? MiniPlayerApp
  : windowMode === 'lyrics-popout'
    ? LyricsPopoutApp
  : windowMode === 'scope-popout'
    ? ScopePopoutApp
    : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>
)
