import LocalizedText from '../i18n/LocalizedText'
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
            <h3><LocalizedText ns="playback" i18nKey="auto.queuepanelboundary.queue" /></h3>
          </div>
          <div className="queue-empty">
            <p><LocalizedText ns="playback" i18nKey="auto.queuepanelboundary.queue_failed_to_render" /></p>
            <p className="queue-empty-hint"><LocalizedText ns="playback" i18nKey="auto.queuepanelboundary.close_and_reopen_the_queue_details_were_logged_to_the_co" /></p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
