import { useEffect, useMemo, useState } from 'react'
import FolderSettings from '../settings/FolderSettings'
import AudioOutputSelect from '../settings/AudioOutputSelect'
import ChannelRoutingPanel from '../settings/ChannelRoutingPanel'
import DelayCompensationPanel from '../settings/DelayCompensationPanel'
import ConfirmActionModal from '../settings/ConfirmActionModal'
import { useLibraryStore } from '../../stores/libraryStore'
import { useVisualizerSettingsStore, type FFTSize } from '../../stores/visualizerSettingsStore'
import { useDiscordSettingsStore } from '../../stores/discordSettingsStore'
import { useUpdateStore } from '../../stores/updateStore'
import {
  DEFAULT_THEME_ACCENT,
  THEME_PRESET_LIST,
  useThemeStore,
  type AccentSource,
  type CoverArtAccentMethod,
  type ThemePresetId
} from '../../stores/themeStore'
import {
  factoryResetApplication,
  resetAllSettings,
  resetAudioSettings,
  resetDiscordCoverArtCache,
  resetEqSettings,
  resetIntegrationSettings,
  resetMappedFolders,
  resetThemeSettings,
} from '../settings/resetActions'
import type { MiniPlayerVisualizerMode } from '../../../types/miniPlayer'

type ResetActionId =
  | 'reset-theme'
  | 'reset-audio'
  | 'reset-integrations'
  | 'reset-discord-cover-art-cache'
  | 'reset-eq'
  | 'reset-all'
  | 'reset-folders'
  | 'factory-reset'

type ResetActionState = 'idle' | 'running' | 'success' | 'error'

interface ResetActionStatus {
  state: ResetActionState
  message: string
}

interface ResetActionDefinition {
  id: ResetActionId
  title: string
  description: string
  buttonLabel: string
  confirmTitle: string
  confirmMessage: string
  confirmLabel: string
  destructive: boolean
  typedPhrase?: string
  disabled?: boolean
  run: () => Promise<string | void>
}

const RESET_ACTION_IDS: ResetActionId[] = [
  'reset-theme',
  'reset-audio',
  'reset-integrations',
  'reset-discord-cover-art-cache',
  'reset-eq',
  'reset-all',
  'reset-folders',
  'factory-reset',
]

const ASTRA_REPOSITORY_URL = 'https://github.com/Boof2015/astra'
const ASTRA_SUPPORT_URL = 'https://ko-fi.com/boof2015'
const ASTRA_LICENSE_URL = 'https://github.com/Boof2015/astra/blob/main/LICENSE'
const GPL_V3_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'

const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'library', label: 'Library' },
  { id: 'analyzer', label: 'Analyzer' },
  { id: 'audio', label: 'Audio Output' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'info', label: 'Info' },
  { id: 'danger', label: 'Danger Zone' },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

function buildInitialResetStatusMap(): Record<ResetActionId, ResetActionStatus> {
  return RESET_ACTION_IDS.reduce((acc, actionId) => {
    acc[actionId] = { state: 'idle', message: '' }
    return acc
  }, {} as Record<ResetActionId, ResetActionStatus>)
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim()
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }

  const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
  if (!fullMatch) return null
  return `#${fullMatch[1].toLowerCase()}`
}

export default function SettingsView() {
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const [pendingResetId, setPendingResetId] = useState<ResetActionId | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  const [appVersionLabel, setAppVersionLabel] = useState('Loading...')
  const [resetStatuses, setResetStatuses] = useState<Record<ResetActionId, ResetActionStatus>>(
    () => buildInitialResetStatusMap()
  )
  const { addFolder, rescan, isScanning, scanProgress } = useLibraryStore()
  const {
    presetId,
    customAccent,
    accentSource,
    coverArtAccentMethod,
    resolvedTokens,
    setPreset,
    setCustomAccent,
    usePresetAccent,
    setAccentSource,
    setCoverArtAccentMethod,
    resetToDefault: resetThemeToDefault,
  } = useThemeStore()
  const {
    fftSize,
    pitchLock,
    isRunning,
    setFftSize,
    setPitchLock,
    setIsRunning,
  } = useVisualizerSettingsStore()
  const {
    enabled: discordEnabled,
    coverArtEnabled: discordCoverArtEnabled,
    statusMessage: discordStatusMessage,
    setEnabled: setDiscordEnabled,
    setCoverArtEnabled: setDiscordCoverArtEnabled,
  } = useDiscordSettingsStore()
  const {
    autoCheckEnabled,
    checkState: updateCheckState,
    statusMessage: updateStatusMessage,
    updateAvailable,
    latestTag,
    releaseName,
    lastCheckedAt,
    setAutoCheckEnabled,
    checkForUpdates,
    openReleasesPage,
  } = useUpdateStore()
  const [accentInputValue, setAccentInputValue] = useState(resolvedTokens.accent)
  const [miniPlayerVisualizerMode, setMiniPlayerVisualizerMode] = useState<MiniPlayerVisualizerMode>('spectrum')

  const selectedPreset = useMemo(
    () => THEME_PRESET_LIST.find((preset) => preset.id === presetId) ?? THEME_PRESET_LIST[0],
    [presetId]
  )
  const defaultPresetAccent = useMemo(
    () => THEME_PRESET_LIST.find((preset) => preset.id === 'default')?.accent ?? DEFAULT_THEME_ACCENT,
    []
  )
  const fallbackAccent = customAccent ?? selectedPreset.accent

  useEffect(() => {
    setAccentInputValue(fallbackAccent)
  }, [fallbackAccent])

  const resetActions = useMemo<ResetActionDefinition[]>(() => ([
    {
      id: 'reset-theme',
      title: 'Reset Theme',
      description: 'Restore the default Astra theme and accent.',
      buttonLabel: 'Reset Theme',
      confirmTitle: 'Reset Theme to Default',
      confirmMessage: 'This will restore the default preset and accent color.',
      confirmLabel: 'Reset Theme',
      destructive: false,
      run: resetThemeSettings,
    },
    {
      id: 'reset-audio',
      title: 'Reset Audio Settings',
      description: 'Clear output device, routing, delay, and calibration settings.',
      buttonLabel: 'Reset Audio',
      confirmTitle: 'Reset Audio Settings',
      confirmMessage: 'This will clear custom output routing and delay calibration profiles.',
      confirmLabel: 'Reset Audio',
      destructive: false,
      run: resetAudioSettings,
    },
    {
      id: 'reset-integrations',
      title: 'Reset Integrations',
      description: 'Disable integrations and clear integration preferences.',
      buttonLabel: 'Reset Integrations',
      confirmTitle: 'Reset Integration Settings',
      confirmMessage: 'This will disable Discord Rich Presence and clear related preferences.',
      confirmLabel: 'Reset Integrations',
      destructive: false,
      run: resetIntegrationSettings,
    },
    {
      id: 'reset-discord-cover-art-cache',
      title: 'Reset Discord Cover Art Cache',
      description: 'Clear saved cover art lookup hits and misses for Discord Rich Presence.',
      buttonLabel: 'Reset Cover Art Cache',
      confirmTitle: 'Reset Discord Cover Art Cache',
      confirmMessage: 'This clears cached Discord cover art lookup results and allows fresh lookups.',
      confirmLabel: 'Reset Cover Art Cache',
      destructive: false,
      run: resetDiscordCoverArtCache,
    },
    {
      id: 'reset-eq',
      title: 'Reset EQ Presets',
      description: 'Remove custom EQ presets and restore default EQ curve.',
      buttonLabel: 'Reset EQ',
      confirmTitle: 'Reset EQ Presets',
      confirmMessage: 'Custom EQ presets will be removed and EQ will return to defaults.',
      confirmLabel: 'Reset EQ',
      destructive: false,
      run: resetEqSettings,
    },
    {
      id: 'reset-all',
      title: 'Reset All Settings',
      description: 'Reset theme, audio, integrations, EQ, and visualizer settings.',
      buttonLabel: 'Reset All Settings',
      confirmTitle: 'Reset All Renderer Settings',
      confirmMessage: 'This clears all renderer settings but keeps your library data and folders.',
      confirmLabel: 'Reset All',
      destructive: false,
      run: resetAllSettings,
    },
    {
      id: 'reset-folders',
      title: 'Reset Mapped Folders',
      description: 'Remove mapped folders and indexed library data while preserving playlists.',
      buttonLabel: 'Reset Mapped Folders',
      confirmTitle: 'Reset Mapped Folders',
      confirmMessage: 'This deletes mapped folders, indexed tracks, favorites, and recently played history.',
      confirmLabel: 'Reset Folders',
      destructive: true,
      typedPhrase: 'RESET FOLDERS',
      disabled: isScanning,
      run: resetMappedFolders,
    },
    {
      id: 'factory-reset',
      title: 'Factory Reset',
      description: 'Wipe all settings and all library-side data including playlists and app metadata.',
      buttonLabel: 'Factory Reset',
      confirmTitle: 'Factory Reset Astra',
      confirmMessage: 'This removes all settings and all library data, then reloads the app.',
      confirmLabel: 'Factory Reset',
      destructive: true,
      typedPhrase: 'FACTORY RESET',
      disabled: isScanning,
      run: factoryResetApplication,
    },
  ]), [isScanning])

  const resetActionMap = useMemo(() => {
    return new Map<ResetActionId, ResetActionDefinition>(resetActions.map((action) => [action.id, action]))
  }, [resetActions])
  const safeResetActions = useMemo(
    () => resetActions.filter((action) => !action.destructive),
    [resetActions]
  )
  const destructiveResetActions = useMemo(
    () => resetActions.filter((action) => action.destructive),
    [resetActions]
  )

  const pendingReset = pendingResetId ? (resetActionMap.get(pendingResetId) ?? null) : null
  const isAnyResetRunning = Object.values(resetStatuses).some((status) => status.state === 'running')
  const updateStatusTone = updateCheckState === 'update-available'
    ? 'available'
    : updateCheckState === 'error'
      ? 'error'
      : updateCheckState === 'checking'
        ? 'checking'
        : 'default'
  const lastCheckedLabel = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleString()
    : 'No update checks have run yet.'

  useEffect(() => {
    let isMounted = true

    const loadAppVersion = async () => {
      if (!window.electronAPI?.getAppVersion) {
        if (isMounted) setAppVersionLabel('Unavailable')
        return
      }

      try {
        const version = await window.electronAPI.getAppVersion()
        if (!isMounted) return
        setAppVersionLabel(version ? `v${version}` : 'Unavailable')
      } catch {
        if (isMounted) setAppVersionLabel('Unavailable')
      }
    }

    void loadAppVersion()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })

    const unsubscribe = window.electronAPI.miniPlayer.onWindowState((state) => {
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const executeResetAction = async (actionId: ResetActionId): Promise<void> => {
    const action = resetActionMap.get(actionId)
    if (!action) return

    setResetStatuses((prev) => ({
      ...prev,
      [actionId]: { state: 'running', message: 'Running...' },
    }))

    try {
      const result = await action.run()
      setResetStatuses((prev) => ({
        ...prev,
        [actionId]: { state: 'success', message: result ?? 'Completed.' },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete action.'
      setResetStatuses((prev) => ({
        ...prev,
        [actionId]: { state: 'error', message },
      }))
    } finally {
      setPendingResetId(null)
    }
  }

  const handleAccentColorInput = (value: string) => {
    setAccentInputValue(value)
    const normalized = normalizeHexColor(value)
    if (!normalized) return
    setCustomAccent(normalized)
  }

  const openExternalLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleMiniPlayerVisualizerModeChange = (mode: MiniPlayerVisualizerMode) => {
    setMiniPlayerVisualizerMode(mode)
    void window.electronAPI.miniPlayer.setVisualizerMode(mode).then((state) => {
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })
  }

  const renderResetAction = (action: ResetActionDefinition) => {
    const status = resetStatuses[action.id]
    return (
      <div
        key={action.id}
        className={`settings-danger-item ${action.destructive ? 'settings-danger-item-destructive' : ''}`}
      >
        <div className="settings-danger-item-copy">
          <p className="settings-danger-item-title">{action.title}</p>
          <p className="settings-danger-item-description">{action.description}</p>
          {status.state !== 'idle' && (
            <p className={`settings-danger-status settings-danger-status-${status.state}`}>
              {status.message}
            </p>
          )}
        </div>
        <button
          className={`settings-btn ${action.destructive ? 'settings-btn-danger' : ''}`}
          onClick={() => setPendingResetId(action.id)}
          disabled={Boolean(action.disabled) || isAnyResetRunning}
        >
          {action.buttonLabel}
        </button>
      </div>
    )
  }

  return (
    <div className="settings-view">
      <div className="settings-shell">
        <div className="settings-header">
          <div>
            <p className="settings-kicker">System Controls</p>
            <h2>Settings</h2>
            <p className="settings-subtitle">Manage playback behavior, library scanning, and application preferences.</p>
          </div>
          {isScanning && (
            <div className="settings-scan-badge">
              Scanning
              {scanProgress ? ` ${scanProgress.current}/${scanProgress.total}` : '...'}
            </div>
          )}
        </div>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-sidebar-item ${activeSectionId === section.id ? 'active' : ''}`}
                aria-current={activeSectionId === section.id ? 'true' : undefined}
                onClick={() => setActiveSectionId(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {activeSectionId === 'appearance' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Appearance</h3>
              <p>Theme and accent preferences.</p>
            </div>
            <div className="settings-theme-grid">
              {THEME_PRESET_LIST.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`settings-theme-card ${presetId === preset.id ? 'active' : ''}`}
                  onClick={() => setPreset(preset.id as ThemePresetId)}
                >
                  <span className="settings-theme-card-title">{preset.label}</span>
                  <span className="settings-theme-card-description">{preset.description}</span>
                </button>
              ))}
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="settings-field-label">
                  {accentSource === 'cover-art' ? 'Fallback Accent Color' : 'Accent Color'}
                </span>
                <div className="settings-accent-inputs">
                  <input
                    className="settings-color settings-color-wide"
                    type="color"
                    value={fallbackAccent}
                    onChange={(event) => {
                      const next = event.target.value.toLowerCase()
                      setAccentInputValue(next)
                      setCustomAccent(next)
                    }}
                  />
                  <input
                    className="settings-select settings-accent-hex-input"
                    type="text"
                    value={accentInputValue}
                    onChange={(event) => handleAccentColorInput(event.target.value)}
                    onBlur={() => {
                      const normalized = normalizeHexColor(accentInputValue)
                      if (!normalized) {
                        setAccentInputValue(fallbackAccent)
                        return
                      }
                      setAccentInputValue(normalized)
                    }}
                    placeholder={defaultPresetAccent}
                    spellCheck={false}
                  />
                </div>
              </label>
              <label className="settings-field">
                <span className="settings-field-label">Accent Source</span>
                <select
                  className="settings-select"
                  value={accentSource}
                  onChange={(event) => {
                    const source: AccentSource = event.target.value === 'cover-art' ? 'cover-art' : 'theme'
                    setAccentSource(source)
                  }}
                >
                  <option value="theme">Theme Accent</option>
                  <option value="cover-art">Cover Art (Now Playing)</option>
                </select>
              </label>
              {accentSource === 'cover-art' && (
                <label className="settings-field">
                  <span className="settings-field-label">Cover Art Method</span>
                  <select
                    className="settings-select"
                    value={coverArtAccentMethod}
                    onChange={(event) => {
                      const method: CoverArtAccentMethod = event.target.value === 'average' ? 'average' : 'dominant'
                      setCoverArtAccentMethod(method)
                    }}
                  >
                    <option value="dominant">Dominant</option>
                    <option value="average">Average</option>
                  </select>
                </label>
              )}
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">
                  {accentSource === 'cover-art' ? 'Fallback Accent' : 'Preset Accent'}
                </span>
                {customAccent ? (
                  <button className="settings-btn" onClick={usePresetAccent}>
                    Use Preset Accent
                  </button>
                ) : (
                  <span className="settings-chip">Using Preset Accent</span>
                )}
              </div>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Theme</span>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => {
                    resetThemeToDefault()
                    setAccentInputValue(defaultPresetAccent)
                  }}
                >
                  Reset Theme to Default
                </button>
              </div>
            </div>
            <p className="settings-note">The current Astra look is preserved as the default preset.</p>
            {accentSource === 'cover-art' && (
              <p className="settings-note">
                Cover art accents use the selected method on the current track artwork. If artwork is missing, Astra uses the fallback accent color.
              </p>
            )}
          </section>
            )}

            {activeSectionId === 'library' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Library</h3>
              <p>Manage folders and refresh indexed metadata.</p>
            </div>
            <div className="settings-actions settings-actions-grid">
              <button className="settings-btn settings-btn-primary" onClick={() => setShowFolderSettings(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
                Manage Folders
              </button>
              <button className="settings-btn" onClick={addFolder} disabled={isScanning}>
                <span>+</span>
                Add Folder
              </button>
              <button className="settings-btn" onClick={rescan} disabled={isScanning}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Rescan Library
              </button>
            </div>
            <p className="settings-note">Manage Folders includes folder-level permission warnings.</p>
          </section>
            )}

            {activeSectionId === 'analyzer' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Analyzer</h3>
              <p>FFT and visualizer behavior.</p>
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="settings-field-label">FFT Size</span>
                <select
                  className="settings-select"
                  value={fftSize}
                  onChange={(e) => setFftSize(Number(e.target.value) as FFTSize)}
                >
                  <option value={1024}>1024</option>
                  <option value={2048}>2048</option>
                  <option value={4096}>4096</option>
                  <option value={8192}>8192</option>
                  <option value={16384}>16384</option>
                </select>
              </label>

              <label className="settings-field">
                <span className="settings-field-label">Mini Player Visualizer</span>
                <select
                  className="settings-select"
                  value={miniPlayerVisualizerMode}
                  onChange={(event) => handleMiniPlayerVisualizerModeChange(event.target.value as MiniPlayerVisualizerMode)}
                >
                  <option value="off">Off</option>
                  <option value="oscilloscope">Oscilloscope</option>
                  <option value="spectrum">Spectrum</option>
                </select>
              </label>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Pitch Lock</span>
                <button
                  className={`settings-toggle ${pitchLock ? 'active' : ''}`}
                  onClick={() => setPitchLock(!pitchLock)}
                >
                  {pitchLock ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Visualizer</span>
                <button
                  className={`settings-toggle ${isRunning ? 'active' : ''}`}
                  onClick={() => setIsRunning(!isRunning)}
                >
                  {isRunning ? 'Running' : 'Paused'}
                </button>
              </div>

            </div>
            <p className="settings-note">Visualizer line color follows the active theme accent.</p>
          </section>
            )}

            {activeSectionId === 'audio' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Audio Output</h3>
              <p>Output device, delay compensation, and channel routing.</p>
            </div>
            <div className="settings-audio-control">
              <AudioOutputSelect />
            </div>
            <DelayCompensationPanel />
            <ChannelRoutingPanel />
          </section>
            )}

            {activeSectionId === 'integrations' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Integrations</h3>
              <p>Optional platform integrations.</p>
            </div>
            <div className="settings-grid">
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Discord Rich Presence</span>
                <button
                  className={`settings-toggle ${discordEnabled ? 'active' : ''}`}
                  onClick={() => void setDiscordEnabled(!discordEnabled)}
                >
                  {discordEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Discord Cover Art (Internet Lookup)</span>
                <button
                  className={`settings-toggle ${discordCoverArtEnabled ? 'active' : ''}`}
                  onClick={() => void setDiscordCoverArtEnabled(!discordCoverArtEnabled)}
                  disabled={!discordEnabled}
                >
                  {discordCoverArtEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
            <p className="settings-note">{discordStatusMessage}</p>
            <p className="settings-note">
              Enabling Discord Cover Art performs internet lookups to MusicBrainz and Cover Art Archive.
            </p>
          </section>
            )}

            {activeSectionId === 'info' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Info</h3>
              <p>Version, updates, attribution, and license details.</p>
            </div>
            <div className="settings-grid settings-info-grid">
              <div className="settings-field">
                <span className="settings-field-label">App Version</span>
                <span className="settings-info-value">{appVersionLabel}</span>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Auto-check on Startup</span>
                <button
                  className={`settings-toggle ${autoCheckEnabled ? 'active' : ''}`}
                  onClick={() => setAutoCheckEnabled(!autoCheckEnabled)}
                >
                  {autoCheckEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Check for Updates</span>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => void checkForUpdates()}
                  disabled={updateCheckState === 'checking'}
                >
                  {updateCheckState === 'checking' ? 'Checking...' : 'Check Now'}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Download</span>
                <button
                  className="settings-btn"
                  onClick={() => void openReleasesPage()}
                >
                  Open Releases
                </button>
              </div>
            </div>
            <p className={`settings-note settings-update-status settings-update-status-${updateStatusTone}`}>
              {updateStatusMessage}
            </p>
            {updateAvailable && latestTag && (
              <p className="settings-note settings-update-meta">
                Latest release: {latestTag}{releaseName ? ` (${releaseName})` : ''}
              </p>
            )}
            <p className="settings-note settings-update-meta">
              {lastCheckedAt ? `Last checked: ${lastCheckedLabel}` : lastCheckedLabel}
            </p>
            <div className="settings-info-panels">
              <div className="settings-info-panel">
                <h4>Attribution</h4>
                <p>Astra is created and maintained by Boof2015.</p>
                <p className="settings-info-meta">Contact: contact@novaml.ai</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_REPOSITORY_URL)}
                  >
                    GitHub Repository
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_SUPPORT_URL)}
                  >
                    Support
                  </button>
                </div>
              </div>
              <div className="settings-info-panel">
                <h4>License</h4>
                <p>Astra is distributed under GPL-3.0-only.</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_LICENSE_URL)}
                  >
                    View LICENSE
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(GPL_V3_URL)}
                  >
                    GPL v3 Text
                  </button>
                </div>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'danger' && (
            <section className="settings-section settings-section-panel settings-danger-zone">
            <div className="settings-section-head">
              <h3>Danger Zone</h3>
              <p>Use these actions when troubleshooting or intentionally resetting data.</p>
            </div>
            <div className="settings-danger-groups">
              <div className="settings-danger-group">
                <p className="settings-danger-group-title">Safe Resets</p>
                <p className="settings-danger-group-description">
                  Reset app preferences while keeping primary library data.
                </p>
                <div className="settings-danger-list">
                  {safeResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
              <div className="settings-danger-group settings-danger-group-destructive">
                <p className="settings-danger-group-title">Destructive Resets</p>
                <p className="settings-danger-group-description">
                  Remove indexed media data or perform a full wipe.
                </p>
                <div className="settings-danger-list">
                  {destructiveResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
            </div>
            {isScanning && (
              <p className="settings-note settings-danger-note">
                Destructive resets are disabled while library scanning is in progress.
              </p>
            )}
          </section>
            )}
          </div>
        </div>
      </div>
      <FolderSettings
        isOpen={showFolderSettings}
        onClose={() => setShowFolderSettings(false)}
      />
      <ConfirmActionModal
        isOpen={pendingReset != null}
        title={pendingReset?.confirmTitle ?? ''}
        message={pendingReset?.confirmMessage ?? ''}
        confirmLabel={pendingReset?.confirmLabel ?? 'Confirm'}
        typedPhrase={pendingReset?.typedPhrase ?? null}
        isDestructive={pendingReset?.destructive ?? false}
        isBusy={pendingReset ? resetStatuses[pendingReset.id].state === 'running' : false}
        onCancel={() => {
          if (pendingReset && resetStatuses[pendingReset.id].state === 'running') return
          setPendingResetId(null)
        }}
        onConfirm={() => {
          if (!pendingReset) return
          void executeResetAction(pendingReset.id)
        }}
      />
    </div>
  )
}
