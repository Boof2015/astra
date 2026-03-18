import { useState, useEffect } from 'react'
import { useUpdateStore } from '../../stores/updateStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import AstraLogo from '../icons/AstraLogo'

interface AppPerformanceStats {
  cpuPercent: number
  memoryMb: number
}

const ASTRA_SUPPORT_URL = 'https://ko-fi.com/boof2015'

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [appStats, setAppStats] = useState<AppPerformanceStats | null>(null)
  const [fps, setFps] = useState(0)
  const updateAvailable = useUpdateStore((s) => s.updateAvailable)
  const openReleasesPage = useUpdateStore((s) => s.openReleasesPage)
  const localApiStatus = useLocalApiSettingsStore((s) => s.status)
  const initLocalApi = useLocalApiSettingsStore((s) => s.init)
  const platform = window.electronAPI?.platform ?? 'linux'
  const isMac = platform === 'darwin'

  useEffect(() => {
    void initLocalApi()
  }, [initLocalApi])

  useEffect(() => {
    let isMounted = true

    const checkMaximized = async () => {
      if (window.electronAPI) {
        try {
          const maximized = await window.electronAPI.isMaximized()
          if (isMounted) {
            setIsMaximized(maximized)
          }
        } catch {
          // Ignore maximize state errors; controls still function.
        }
      }
    }

    const loadAppVersion = async () => {
      if (window.electronAPI?.getAppVersion) {
        try {
          const version = await window.electronAPI.getAppVersion()
          if (isMounted) {
            setAppVersion(version)
          }
        } catch {
          // Ignore version load errors; title remains functional.
        }
      }
    }

    checkMaximized()
    void loadAppVersion()

    // Check on window resize
    const handleResize = () => {
      void checkMaximized()
    }
    window.addEventListener('resize', handleResize)
    return () => {
      isMounted = false
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const loadAppStats = async () => {
      if (!window.electronAPI?.getAppPerformanceStats) return
      try {
        const stats = await window.electronAPI.getAppPerformanceStats()
        if (isMounted) {
          setAppStats(stats)
        }
      } catch {
        // Ignore stats load errors; title remains functional.
      }
    }

    void loadAppStats()
    const intervalId = window.setInterval(() => {
      void loadAppStats()
    }, 1000)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    let rafId = 0
    let frameCount = 0
    let lastSample = performance.now()

    const tick = (timestamp: number) => {
      frameCount += 1
      const elapsed = timestamp - lastSample
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed))
        frameCount = 0
        lastSample = timestamp
      }
      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [])

  const handleMinimize = () => window.electronAPI?.minimize()
  const handleOpenUpdate = () => {
    void openReleasesPage()
  }
  const handleMaximize = async () => {
    window.electronAPI?.maximize()
    const maximized = await window.electronAPI?.isMaximized()
    setIsMaximized(maximized ?? false)
  }
  const handleClose = () => window.electronAPI?.close()
  const handleOpenSupport = () => {
    window.open(ASTRA_SUPPORT_URL, '_blank', 'noopener,noreferrer')
  }

  const formattedCpu = appStats ? `${Math.max(0, Math.round(appStats.cpuPercent))}%` : '\u2014'
  const formattedMemory = appStats
    ? appStats.memoryMb >= 1024
      ? `${(appStats.memoryMb / 1024).toFixed(2)}GB`
      : `${appStats.memoryMb.toFixed(appStats.memoryMb >= 100 ? 0 : 1)}MB`
    : '\u2014'
  const formattedFps = fps > 0 ? `${fps}` : '\u2014'
  const apiIndicatorLabel = localApiStatus?.active
    ? localApiStatus.controlsEnabled ? 'API+CTL' : 'API'
    : null
  const apiIndicatorTitle = localApiStatus
    ? localApiStatus.controlsEnabled
      ? `Local API active with controls on ${localApiStatus.baseUrl}`
      : `Local API active on ${localApiStatus.baseUrl}`
    : 'Local API status unavailable'

  return (
    <header className="titlebar">
      {/* Drag region - the entire titlebar is draggable except buttons */}
      <div className="titlebar-drag-region" />

      {/* macOS: traffic lights are native, just need padding */}
      {isMac && <div className="titlebar-macos-spacer" />}

      {/* App title/logo */}
      <div className="titlebar-title">
        <button
          type="button"
          className="titlebar-logo-link"
          onClick={handleOpenSupport}
          aria-label="Support Astra on Ko-fi"
          title="Support Astra on Ko-fi"
        >
          <span className="titlebar-logo">
            <AstraLogo includeBackground={false} />
          </span>
          <span className="titlebar-logo-heart" aria-hidden="true" />
        </button>
        <span>Astra</span>
        {appVersion && <span className="titlebar-version">v{appVersion}</span>}
      </div>

      {/* Spacer */}
      <div className="titlebar-spacer" />

      <div className="titlebar-right">
        {apiIndicatorLabel && (
          <span className="titlebar-api-pill" title={apiIndicatorTitle}>
            <span className="titlebar-api-pill-dot" aria-hidden="true" />
            <span>{apiIndicatorLabel}</span>
          </span>
        )}

        <div className="titlebar-stats" aria-label="Astra performance stats">
          <span className="titlebar-stat">
            <span className="titlebar-stat-label">CPU</span>
            <span>{formattedCpu}</span>
          </span>
          <span className="titlebar-stat">
            <span className="titlebar-stat-label">MEM</span>
            <span>{formattedMemory}</span>
          </span>
          <span className="titlebar-stat">
            <span className="titlebar-stat-label">FPS</span>
            <span>{formattedFps}</span>
          </span>
        </div>

        {updateAvailable && (
          <button
            className="titlebar-button titlebar-button-update"
            onClick={handleOpenUpdate}
            aria-label="Download update"
            title="Update available - open downloads"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v11" />
              <polyline points="7 11 12 16 17 11" />
              <path d="M5 21h14v-5" />
            </svg>
          </button>
        )}

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
      </div>
    </header>
  )
}
