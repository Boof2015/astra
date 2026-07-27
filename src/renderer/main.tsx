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
import { I18nextProvider } from 'react-i18next'
import { initializeRendererI18n, rendererI18n } from './i18n'
import LocaleRerenderBoundary from './components/i18n/LocaleRerenderBoundary'
import TranslationInspector from './components/i18n/TranslationInspector'
import { isInspecting } from './components/i18n/inspectMode'
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

async function bootstrap(): Promise<void> {
  await initializeRendererI18n()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nextProvider i18n={rendererI18n}>
        <LocaleRerenderBoundary>
          <>
            <RootComponent />
            {isInspecting ? <TranslationInspector /> : null}
          </>
        </LocaleRerenderBoundary>
      </I18nextProvider>
    </React.StrictMode>
  )
}

void bootstrap()
