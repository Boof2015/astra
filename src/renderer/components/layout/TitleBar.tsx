import { useState, useEffect } from 'react'

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const platform = window.electronAPI?.platform ?? 'linux'
  const isMac = platform === 'darwin'

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electronAPI) {
        const maximized = await window.electronAPI.isMaximized()
        setIsMaximized(maximized)
      }
    }
    checkMaximized()

    // Check on window resize
    const handleResize = () => checkMaximized()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleMinimize = () => window.electronAPI?.minimize()
  const handleMaximize = async () => {
    window.electronAPI?.maximize()
    const maximized = await window.electronAPI?.isMaximized()
    setIsMaximized(maximized ?? false)
  }
  const handleClose = () => window.electronAPI?.close()

  return (
    <header className="titlebar">
      {/* Drag region - the entire titlebar is draggable except buttons */}
      <div className="titlebar-drag-region" />

      {/* macOS: traffic lights are native, just need padding */}
      {isMac && <div className="titlebar-macos-spacer" />}

      {/* App title/logo */}
      <div className="titlebar-title">
        <span className="titlebar-logo">✦</span>
        <span>Astra</span>
      </div>

      {/* Spacer */}
      <div className="titlebar-spacer" />

      {/* Windows/Linux: custom window controls */}
      {!isMac && (
        <div className="titlebar-controls">
          <button
            className="titlebar-button"
            onClick={handleMinimize}
            aria-label="Minimize"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect fill="currentColor" width="10" height="1" x="1" y="6" />
            </svg>
          </button>
          <button
            className="titlebar-button"
            onClick={handleMaximize}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect fill="none" stroke="currentColor" width="7" height="7" x="1.5" y="3.5" />
                <polyline fill="none" stroke="currentColor" points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect fill="none" stroke="currentColor" width="9" height="9" x="1.5" y="1.5" />
              </svg>
            )}
          </button>
          <button
            className="titlebar-button titlebar-button-close"
            onClick={handleClose}
            aria-label="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <polygon fill="currentColor" points="11,1.5 10.5,1 6,5.5 1.5,1 1,1.5 5.5,6 1,10.5 1.5,11 6,6.5 10.5,11 11,10.5 6.5,6" />
            </svg>
          </button>
        </div>
      )}
    </header>
  )
}
