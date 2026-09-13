import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/globals.css'

const windowMode = new URLSearchParams(window.location.search).get('window')
document.documentElement.dataset.windowMode = windowMode ?? 'main'
document.body.dataset.windowMode = windowMode ?? 'main'

const RootComponent = windowMode === 'mini'
  ? React.lazy(() => import('./components/mini/MiniPlayerApp'))
  : windowMode === 'notch'
    ? React.lazy(() => import('./components/notch/NotchApp'))
  : windowMode === 'lyrics-popout'
    ? React.lazy(() => import('./components/popout/LyricsPopoutApp'))
  : windowMode === 'scope-popout'
    ? React.lazy(() => import('./components/popout/ScopePopoutApp'))
    : React.lazy(() => import('./App'))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}><RootComponent /></React.Suspense>
  </React.StrictMode>
)
