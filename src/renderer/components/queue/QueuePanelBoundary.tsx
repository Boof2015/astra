import { Component, type ErrorInfo, type ReactNode } from 'react'

interface QueuePanelBoundaryProps {
  children: ReactNode
}

interface QueuePanelBoundaryState {
  hasError: boolean
}

export default class QueuePanelBoundary extends Component<QueuePanelBoundaryProps, QueuePanelBoundaryState> {
  state: QueuePanelBoundaryState = {
    hasError: false
  }

  static getDerivedStateFromError(): QueuePanelBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Queue panel render failed:', error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="queue-panel">
          <div className="queue-header">
            <h3>Queue</h3>
          </div>
          <div className="queue-empty">
            <p>Queue failed to render</p>
            <p className="queue-empty-hint">Close and reopen the queue. Details were logged to the console.</p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
