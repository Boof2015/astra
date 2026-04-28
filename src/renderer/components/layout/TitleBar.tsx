import { useState, useEffect } from 'react'
import type { AudioBufferMemoryStats } from '../../../types/nativeAudio'
import type { AppBuildInfo } from '../../../types/appBuildInfo'
import { audioEngine } from '../../audio/AudioEngine'
import { useUpdateStore } from '../../stores/updateStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useAstraActivity } from '../../hooks/useAstraActivity'
import AstraActivityIndicator from '../activity/AstraActivityIndicator'
import AstraLogo from '../icons/AstraLogo'

interface AppPerformanceStats {
  cpuPercent: number
  workingSetMb: number
}

interface RendererMemoryStats {
  privateMb: number
}

const ASTRA_SUPPORT_URL = 'https://ko-fi.com/boof2015'
const BYTES_PER_MB = 1024 * 1024
const FPS_SAMPLE_INTERVAL_MS = 1000
const FPS_SAMPLE_WINDOW_MS = 200

function formatMemoryMb(memoryMb: number | null, options: { zeroAsZeroMb?: boolean } = {}): string {
  if (memoryMb === null || !Number.isFinite(memoryMb)) return '\u2014'

  const normalized = Math.max(0, memoryMb)
  if (options.zeroAsZeroMb && normalized < 0.05) {
    return '0 MB'
  }

  return normalized >= 1024
    ? `${(normalized / 1024).toFixed(2)} GB`
    : `${normalized.toFixed(normalized >= 100 ? 0 : 1)} MB`
}

function TitleBarActivityFallback({ rackVisible }: { rackVisible: boolean }) {
  const activity = useAstraActivity()

  return (
    <span
      className={`titlebar-activity-fallback ${rackVisible ? 'is-rack-visible' : 'is-rack-hidden'}`.trim()}
      title={activity.note}
      aria-label={`Astra activity: ${activity.note}`}
    >
      <AstraActivityIndicator
        className="titlebar-activity-indicator"
        state={activity.state}
        event={activity.event}
        size={16}
      />
    </span>
  )
}

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [appBuildInfo, setAppBuildInfo] = useState<AppBuildInfo | null>(null)
  const [appStats, setAppStats] = useState<AppPerformanceStats | null>(null)
  const [rendererMemoryStats, setRendererMemoryStats] = useState<RendererMemoryStats | null>(null)
  const [bufferStats, setBufferStats] = useState<AudioBufferMemoryStats | null>(null)
  const [fps, setFps] = useState(0)
  const updateAvailable = useUpdateStore((s) => s.updateAvailable)
  const openReleasesPage = useUpdateStore((s) => s.openReleasesPage)
  const localApiStatus = useLocalApiSettingsStore((s) => s.status)
  const phoneRemoteStatus = usePhoneRemoteSettingsStore((s) => s.status)
  const initLocalApi = useLocalApiSettingsStore((s) => s.init)
  const initPhoneRemote = usePhoneRemoteSettingsStore((s) => s.init)
  const activityIndicatorExperimentEnabled = useUIStore((s) => s.activityIndicatorExperimentEnabled)
  const isAnalyzerRackVisible = useUIStore((s) => s.isAnalyzerRackVisible)
  const platform = window.electronAPI?.platform ?? 'linux'
  const isMac = platform === 'darwin'

  useEffect(() => {
    void initLocalApi()
    void initPhoneRemote()
  }, [initLocalApi, initPhoneRemote])

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

    const loadAppBuildInfo = async () => {
      if (window.electronAPI?.getAppBuildInfo) {
        try {
          const buildInfo = await window.electronAPI.getAppBuildInfo()
          if (isMounted) {
            setAppBuildInfo(buildInfo)
          }
        } catch {
          // Ignore build info load errors; title remains functional.
        }
        return
      }

      if (window.electronAPI?.getAppVersion) {
        try {
          const version = await window.electronAPI.getAppVersion()
          if (isMounted) {
            setAppBuildInfo({
              version,
              commitHash: null,
              shortCommitHash: null,
              isDirty: false
            })
          }
        } catch {
          // Ignore version load errors; title remains functional.
        }
      }
    }

    checkMaximized()
    void loadAppBuildInfo()

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
      const [appStatsResult, rendererMemoryResult, bufferStatsResult] = await Promise.allSettled([
        window.electronAPI?.getAppPerformanceStats
          ? window.electronAPI.getAppPerformanceStats()
          : Promise.reject(new Error('App performance stats unavailable.')),
        window.electronAPI?.getRendererMemoryStats
          ? window.electronAPI.getRendererMemoryStats()
          : Promise.reject(new Error('Renderer memory stats unavailable.')),
        audioEngine.getBufferMemoryStats()
      ])

      if (!isMounted) return

      if (appStatsResult.status === 'fulfilled') {
        setAppStats(appStatsResult.value)
      }
      if (rendererMemoryResult.status === 'fulfilled') {
        setRendererMemoryStats(rendererMemoryResult.value)
      }
      if (bufferStatsResult.status === 'fulfilled') {
        setBufferStats(bufferStatsResult.value)
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
    let disposed = false
    let sampleAnimationFrame = 0
    let sampleStartTime: number | null = null
    let frameCount = 0

    const clearActiveSample = () => {
      if (sampleAnimationFrame !== 0) {
        window.cancelAnimationFrame(sampleAnimationFrame)
        sampleAnimationFrame = 0
      }
      sampleStartTime = null
      frameCount = 0
    }

    const tick = (timestamp: number) => {
      if (disposed) return
      if (sampleStartTime === null) {
        sampleStartTime = timestamp
        sampleAnimationFrame = window.requestAnimationFrame(tick)
        return
      }
      frameCount += 1

      const elapsed = timestamp - sampleStartTime
      if (elapsed >= FPS_SAMPLE_WINDOW_MS) {
        setFps(Math.round((frameCount * 1000) / Math.max(elapsed, 1)))
        clearActiveSample()
        return
      }

      sampleAnimationFrame = window.requestAnimationFrame(tick)
    }

    const runSample = () => {
      clearActiveSample()
      sampleAnimationFrame = window.requestAnimationFrame(tick)
    }

    runSample()
    const intervalId = window.setInterval(runSample, FPS_SAMPLE_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(intervalId)
      clearActiveSample()
    }
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
  const bufferMemoryMb = bufferStats ? bufferStats.totalBytes / BYTES_PER_MB : null
  const currentBufferMemoryMb = bufferStats ? bufferStats.currentBytes / BYTES_PER_MB : null
  const nextBufferMemoryMb = bufferStats ? bufferStats.nextBytes / BYTES_PER_MB : null
  const otherProcessMemoryMb = appStats && rendererMemoryStats
    ? Math.max(appStats.workingSetMb - rendererMemoryStats.privateMb, 0)
    : null
  const appMemoryMb = rendererMemoryStats && bufferMemoryMb !== null
    ? Math.max(rendererMemoryStats.privateMb - bufferMemoryMb, 0)
    : appStats && bufferMemoryMb !== null
      ? Math.max(appStats.workingSetMb - bufferMemoryMb, 0)
    : null
  const formattedRendererMemory = formatMemoryMb(rendererMemoryStats?.privateMb ?? null)
  const formattedAppMemory = formatMemoryMb(appMemoryMb)
  const formattedBufferMemory = formatMemoryMb(bufferMemoryMb, { zeroAsZeroMb: true })
  const formattedCurrentBufferMemory = formatMemoryMb(currentBufferMemoryMb, { zeroAsZeroMb: true })
  const formattedNextBufferMemory = formatMemoryMb(nextBufferMemoryMb, { zeroAsZeroMb: true })
  const formattedOtherProcessMemory = formatMemoryMb(otherProcessMemoryMb)
  const formattedTotalMemory = formatMemoryMb(appStats?.workingSetMb ?? null)
  const formattedFps = fps > 0 ? `${fps}` : '\u2014'
  const appVersionLabel = appBuildInfo?.version ? `v${appBuildInfo.version}` : ''
  const appCommitLabel = appBuildInfo?.shortCommitHash
    ? `${appBuildInfo.shortCommitHash}${appBuildInfo.isDirty ? '*' : ''}`
    : ''
  const appBuildTooltip = appBuildInfo?.commitHash
    ? `Astra ${appVersionLabel}\nCommit: ${appBuildInfo.commitHash}${appBuildInfo.isDirty ? '\nWorking tree was dirty when this build started.' : ''}`
    : undefined
  const apiIndicatorLabel = localApiStatus?.active
    ? localApiStatus.controlsEnabled ? 'API+CTL' : 'API'
    : null
  const apiIndicatorTitle = localApiStatus
    ? localApiStatus.controlsEnabled
      ? `Local API active with controls on ${localApiStatus.baseUrl}`
      : `Local API active on ${localApiStatus.baseUrl}`
    : 'Local API status unavailable'
  const pwaIndicatorLabel = phoneRemoteStatus?.active ? 'PWA' : null
  const pwaIndicatorTitle = phoneRemoteStatus
    ? phoneRemoteStatus.controllerUrl
      ? phoneRemoteStatus.controlsEnabled
        ? `Phone remote active with controls on ${phoneRemoteStatus.controllerUrl}`
        : `Phone remote active in read-only mode on ${phoneRemoteStatus.controllerUrl}`
      : `Phone remote active on port ${phoneRemoteStatus.port}`
    : 'Phone remote status unavailable'
  const appMemoryTitle = rendererMemoryStats && bufferStats
    ? `Renderer-private memory excluding decoded audio buffers. Renderer private: ${formatMemoryMb(rendererMemoryStats.privateMb)}.${appStats ? ` Total app working set: ${formatMemoryMb(appStats.workingSetMb)}.` : ''}`
    : appStats && bufferStats
      ? `Fallback app working set excluding decoded audio buffers. Total working set: ${formatMemoryMb(appStats.workingSetMb)}.`
      : 'App memory excluding decoded audio buffers.'
  const bufferMemoryTitle = bufferStats
    ? `Decoded audio buffers held by Astra. Current: ${formatMemoryMb(bufferStats.currentBytes / BYTES_PER_MB, { zeroAsZeroMb: true })}. Next: ${formatMemoryMb(bufferStats.nextBytes / BYTES_PER_MB, { zeroAsZeroMb: true })}.`
    : 'Decoded audio buffer memory for the current and next track.'
  const totalMemoryTitle = appStats
    ? `Total app working set across renderer, main, GPU, and utility processes: ${formatMemoryMb(appStats.workingSetMb)}.`
    : 'Total app working set.'

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
        {activityIndicatorExperimentEnabled && (
          <TitleBarActivityFallback rackVisible={isAnalyzerRackVisible} />
        )}
        {appVersionLabel && (
          <span className="titlebar-version" title={appBuildTooltip}>
            <span>{appVersionLabel}</span>
            {appCommitLabel && (
              <>
                <span className="titlebar-version-separator" aria-hidden="true">&middot;</span>
                <span className="titlebar-build-hash">{appCommitLabel}</span>
              </>
            )}
          </span>
        )}
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
        {pwaIndicatorLabel && (
          <span className="titlebar-api-pill" title={pwaIndicatorTitle}>
            <span className="titlebar-api-pill-dot" aria-hidden="true" />
            <span>{pwaIndicatorLabel}</span>
          </span>
        )}

        <div
          className="titlebar-stats-shell"
          tabIndex={0}
          aria-label="Astra performance stats with memory breakdown"
        >
          <div className="titlebar-stats" aria-label="Astra performance stats">
            <span className="titlebar-stat">
              <span className="titlebar-stat-label">CPU</span>
              <span>{formattedCpu}</span>
            </span>
            <span className="titlebar-stat" title={appMemoryTitle}>
              <span className="titlebar-stat-label">APP</span>
              <span>{formattedAppMemory}</span>
            </span>
            <span className="titlebar-stat" title={bufferMemoryTitle}>
              <span className="titlebar-stat-label">BUF</span>
              <span>{formattedBufferMemory}</span>
            </span>
            <span className="titlebar-stat" title={totalMemoryTitle}>
              <span className="titlebar-stat-label">TOT</span>
              <span>{formattedTotalMemory}</span>
            </span>
            <span className="titlebar-stat">
              <span className="titlebar-stat-label">FPS</span>
              <span>{formattedFps}</span>
            </span>
          </div>
          <div className="titlebar-stats-breakdown" role="tooltip" aria-label="Memory breakdown">
            <div className="titlebar-stats-breakdown-title">Memory</div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">Renderer</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">APP</span>
              <span className="titlebar-stats-breakdown-value">{formattedAppMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">Buffers</span>
              <span className="titlebar-stats-breakdown-value">{formattedBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">Current buf</span>
              <span className="titlebar-stats-breakdown-value">{formattedCurrentBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">Next buf</span>
              <span className="titlebar-stats-breakdown-value">{formattedNextBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row">
              <span className="titlebar-stats-breakdown-label">Other procs</span>
              <span className="titlebar-stats-breakdown-value">{formattedOtherProcessMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row titlebar-stats-breakdown-row-total">
              <span className="titlebar-stats-breakdown-label">Total</span>
              <span className="titlebar-stats-breakdown-value">{formattedTotalMemory}</span>
            </div>
          </div>
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
