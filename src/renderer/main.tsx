import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/globals.css'

type RootComponentType = React.ComponentType<Record<string, never>>

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error, null, 2)
  } catch {
    return String(error)
  }
}

function showBootstrapError(title: string, error: unknown): void {
  const host = document.getElementById('root') ?? document.body
  if (!host) return

  const details = formatErrorDetails(error)
  host.innerHTML = ''

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.inset = '0'
  container.style.padding = '24px'
  container.style.overflow = 'auto'
  container.style.background = '#0a0a0f'
  container.style.color = '#f5f7fb'
  container.style.fontFamily = '"JetBrains Mono", monospace'
  container.style.fontSize = '13px'
  container.style.lineHeight = '1.5'
  container.style.whiteSpace = 'pre-wrap'
  container.style.zIndex = '2147483647'

  const heading = document.createElement('div')
  heading.textContent = title
  heading.style.fontSize = '15px'
  heading.style.fontWeight = '700'
  heading.style.marginBottom = '12px'
  heading.style.color = '#fca5a5'

  const body = document.createElement('pre')
  body.textContent = details
  body.style.margin = '0'
  body.style.whiteSpace = 'pre-wrap'
  body.style.wordBreak = 'break-word'

  container.append(heading, body)
  host.appendChild(container)
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown | null }
> {
  state = { error: null as unknown | null }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }

  componentDidCatch(error: unknown): void {
    console.error('Root render failed:', error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            padding: 24,
            overflow: 'auto',
            background: '#0a0a0f',
            color: '#f5f7fb',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              fontSize: 15,
              fontWeight: 700,
              marginBottom: 12,
              color: '#fca5a5',
            },
          },
          'Renderer Error'
        ),
        React.createElement(
          'pre',
          {
            style: {
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          formatErrorDetails(this.state.error)
        )
      )
    }

    return this.props.children
  }
}

window.addEventListener('error', (event) => {
  console.error('Unhandled renderer error:', event.error ?? event.message)
  showBootstrapError('Unhandled Renderer Error', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled renderer rejection:', event.reason)
  showBootstrapError('Unhandled Renderer Rejection', event.reason)
})

async function resolveRootComponent(): Promise<RootComponentType> {
  const windowMode = new URLSearchParams(window.location.search).get('window')

  if (windowMode === 'mini') {
    const module = await import('./components/mini/MiniPlayerApp')
    return module.default as RootComponentType
  }

  if (windowMode === 'scope-popout') {
    const module = await import('./components/popout/ScopePopoutApp')
    return module.default as RootComponentType
  }

  const module = await import('./App')
  return module.default as RootComponentType
}

async function bootstrap(): Promise<void> {
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Renderer root element "#root" was not found.')
  }

  const RootComponent = await resolveRootComponent()

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <RootComponent />
      </RootErrorBoundary>
    </React.StrictMode>
  )
}

void bootstrap().catch((error) => {
  console.error('Renderer bootstrap failed:', error)
  showBootstrapError('Renderer Bootstrap Failed', error)
})
