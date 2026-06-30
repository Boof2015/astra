import { useState, useEffect } from 'react'
import type { AppBuildInfo } from '../../../types/appBuildInfo'
import { useUpdateStore } from '../../stores/updateStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import ParallaxPresencePill from './ParallaxPresencePill'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useAstraActivity } from '../../hooks/useAstraActivity'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import {
  captureTitleBarPerformanceSample,
  createEmptyTitleBarPerformanceSample,
  TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS,
  type TitleBarPerformanceSample
} from '../../utils/titleBarMemoryStats'
import AstraActivityIndicator from '../activity/AstraActivityIndicator'
import AstraLogo from '../icons/AstraLogo'

const ASTRA_SUPPORT_URL = 'https://ko-fi.com/boof2015'
const FPS_SAMPLE_INTERVAL_MS = 1000
const FPS_SAMPLE_WINDOW_MS = 200
const ANALYZER_RAIL_COLLAPSE_QUERY = '(max-width: 1040px)'

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
  const [performanceSample, setPerformanceSample] = useState<TitleBarPerformanceSample>(
    createEmptyTitleBarPerformanceSample
  )
  const [fps, setFps] = useState(0)
  const updateAvailable = useUpdateStore((s) => s.updateAvailable)
  const openReleasesPage = useUpdateStore((s) => s.openReleasesPage)
  const localApiStatus = useLocalApiSettingsStore((s) => s.status)
  const phoneRemoteStatus = usePhoneRemoteSettingsStore((s) => s.status)
  const initLocalApi = useLocalApiSettingsStore((s) => s.init)
  const initPhoneRemote = usePhoneRemoteSettingsStore((s) => s.init)
  const activityIndicatorExperimentEnabled = useUIStore((s) => s.activityIndicatorExperimentEnabled)
  const isAnalyzerRackVisible = useUIStore((s) => s.isAnalyzerRackVisible)
  const analyzerRailCollapsed = useMediaQuery(ANALYZER_RAIL_COLLAPSE_QUERY)
  const platform = window.electronAPI?.platform ?? 'linux'
  const isMac = platform === 'darwin'
  const showTitlebarActivityIndicator = activityIndicatorExperimentEnabled
    && (!isAnalyzerRackVisible || analyzerRailCollapsed)

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

    const loadPerformanceSample = async () => {
      const nextSample = await captureTitleBarPerformanceSample()
      if (!isMounted) return
      setPerformanceSample(nextSample)
    }

    void loadPerformanceSample()
    const intervalId = window.setInterval(() => {
      void loadPerformanceSample()
    }, TITLE_BAR_MEMORY_SAMPLE_INTERVAL_MS)

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

  const memorySample = performanceSample.memory
  const formattedCpu = performanceSample.cpuPercent !== null && Number.isFinite(performanceSample.cpuPercent)
    ? `${Math.max(0, Math.round(performanceSample.cpuPercent))}%`
    : '\u2014'
  const formattedRendererJsMemory = formatMemoryMb(memorySample.rendererHeapUsedMb)
  const formattedRendererPrivateMemory = formatMemoryMb(memorySample.rendererPrivateMb)
  const formattedRendererExternalMemory = formatMemoryMb(memorySample.rendererExternalMb, { zeroAsZeroMb: true })
  const formattedRendererArrayBuffersMemory = formatMemoryMb(memorySample.rendererArrayBuffersMb, { zeroAsZeroMb: true })
  const formattedRendererOldSpaceMemory = formatMemoryMb(memorySample.rendererOldSpaceMb, { zeroAsZeroMb: true })
  const formattedRendererLargeObjectSpaceMemory = formatMemoryMb(memorySample.rendererLargeObjectSpaceMb, { zeroAsZeroMb: true })
  const formattedMainHeapMemory = formatMemoryMb(memorySample.mainHeapUsedMb)
  const formattedMainRssMemory = formatMemoryMb(memorySample.mainRssMb)
  const formattedMainExternalMemory = formatMemoryMb(memorySample.mainExternalMb, { zeroAsZeroMb: true })
  const formattedMainArrayBuffersMemory = formatMemoryMb(memorySample.mainArrayBuffersMb, { zeroAsZeroMb: true })
  const formattedBufferMemory = formatMemoryMb(memorySample.bufferMemoryMb, { zeroAsZeroMb: true })
  const formattedCurrentBufferMemory = formatMemoryMb(memorySample.currentBufferMemoryMb, { zeroAsZeroMb: true })
  const formattedNextBufferMemory = formatMemoryMb(memorySample.nextBufferMemoryMb, { zeroAsZeroMb: true })
  const formattedNonRendererWorkingSetMemory = formatMemoryMb(memorySample.otherProcessMemoryMb)
  const formattedTotalMemory = formatMemoryMb(memorySample.totalWorkingSetMb)
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
  const rendererJsTitle = `Renderer JS heap used from process.memoryUsage().heapUsed: ${formattedRendererJsMemory}.`
  const rendererPrivateTitle = `Renderer private memory from process.getProcessMemoryInfo().private: ${formattedRendererPrivateMemory}.`
  const rendererExternalTitle = `Renderer external memory from process.memoryUsage().external: ${formattedRendererExternalMemory}.`
  const rendererArrayBuffersTitle = `Renderer ArrayBuffer memory from process.memoryUsage().arrayBuffers: ${formattedRendererArrayBuffersMemory}.`
  const rendererOldSpaceTitle = `Renderer V8 old_space used: ${formattedRendererOldSpaceMemory}.`
  const rendererLargeObjectSpaceTitle = `Renderer V8 large_object_space used: ${formattedRendererLargeObjectSpaceMemory}.`
  const mainHeapTitle = `Main process heap used from process.memoryUsage().heapUsed: ${formattedMainHeapMemory}. Main RSS is shown in the breakdown.`
  const mainRssTitle = `Main process RSS from process.memoryUsage().rss: ${formattedMainRssMemory}.`
  const mainExternalTitle = `Main process external memory from process.memoryUsage().external: ${formattedMainExternalMemory}.`
  const mainArrayBuffersTitle = `Main process ArrayBuffer memory from process.memoryUsage().arrayBuffers: ${formattedMainArrayBuffersMemory}.`
  const bufferMemoryTitle = `Decoded audio buffers held by Astra. Current: ${formattedCurrentBufferMemory}. Next: ${formattedNextBufferMemory}.`
  const nonRendererWorkingSetTitle = `Total Electron working set minus renderer private memory; includes main, GPU, utility, and other app processes: ${formattedNonRendererWorkingSetMemory}.`
  const totalMemoryTitle = `Total Electron working set across renderer, main, GPU, and utility processes from app.getAppMetrics(): ${formattedTotalMemory}.`

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
        {showTitlebarActivityIndicator && (
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
        {/* §18 — Parallax presence pill. Mounted unconditionally; renders null when neither host
            nor sink mode is active. Sibling to the API/PWA pills per share §18.1. */}
        <ParallaxPresencePill />
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
            <div className="titlebar-stats-breakdown-title">Memory breakdown</div>
            <div className="titlebar-stats-breakdown-row" title={rendererJsTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer JS heap</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererJsMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={rendererPrivateTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer private</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererPrivateMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={rendererExternalTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer external</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererExternalMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={rendererArrayBuffersTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer ArrayBuffers</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererArrayBuffersMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={rendererOldSpaceTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer old_space</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererOldSpaceMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={rendererLargeObjectSpaceTitle}>
              <span className="titlebar-stats-breakdown-label">Renderer large_object</span>
              <span className="titlebar-stats-breakdown-value">{formattedRendererLargeObjectSpaceMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={mainHeapTitle}>
              <span className="titlebar-stats-breakdown-label">Main heap used</span>
              <span className="titlebar-stats-breakdown-value">{formattedMainHeapMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={mainRssTitle}>
              <span className="titlebar-stats-breakdown-label">Main RSS</span>
              <span className="titlebar-stats-breakdown-value">{formattedMainRssMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={mainExternalTitle}>
              <span className="titlebar-stats-breakdown-label">Main external</span>
              <span className="titlebar-stats-breakdown-value">{formattedMainExternalMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={mainArrayBuffersTitle}>
              <span className="titlebar-stats-breakdown-label">Main ArrayBuffers</span>
              <span className="titlebar-stats-breakdown-value">{formattedMainArrayBuffersMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={bufferMemoryTitle}>
              <span className="titlebar-stats-breakdown-label">Decoded buffers</span>
              <span className="titlebar-stats-breakdown-value">{formattedBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={bufferMemoryTitle}>
              <span className="titlebar-stats-breakdown-label">Current buf</span>
              <span className="titlebar-stats-breakdown-value">{formattedCurrentBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={bufferMemoryTitle}>
              <span className="titlebar-stats-breakdown-label">Next buf</span>
              <span className="titlebar-stats-breakdown-value">{formattedNextBufferMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row" title={nonRendererWorkingSetTitle}>
              <span className="titlebar-stats-breakdown-label">Non-renderer WS</span>
              <span className="titlebar-stats-breakdown-value">{formattedNonRendererWorkingSetMemory}</span>
            </div>
            <div className="titlebar-stats-breakdown-row titlebar-stats-breakdown-row-total" title={totalMemoryTitle}>
              <span className="titlebar-stats-breakdown-label">Total working set</span>
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
