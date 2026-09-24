import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import { useUIStore } from '../../stores/uiStore'

interface BoundaryProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
}

interface BoundaryState {
  hasError: boolean
  wasOpen: boolean
}

function QuickLaunchError({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])

  return (
    <div
      className="quick-launch-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="quick-launch-panel" role="dialog" aria-modal="true" aria-label="Quick Search" aria-describedby="quick-launch-failure">
        <div className="quick-launch-input-wrap">
          <p id="quick-launch-failure" role="alert">Quick Search couldn’t open. Close it and try again.</p>
          <button ref={closeRef} type="button" className="settings-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

class PaletteBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false, wasOpen: false }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.isOpen === state.wasOpen) return null
    return { wasOpen: props.isOpen, hasError: props.isOpen ? false : state.hasError }
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Quick Search failed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.isOpen ? <QuickLaunchError onClose={this.props.onClose} /> : null
    }
    return this.props.children
  }
}

export default function QuickLaunchBoundary({ children }: { children: ReactNode }) {
  const isOpen = useUIStore((state) => state.isQuickLaunchOpen)
  const onClose = useUIStore((state) => state.closeQuickLaunch)
  return <PaletteBoundary isOpen={isOpen} onClose={onClose}>{children}</PaletteBoundary>
}
