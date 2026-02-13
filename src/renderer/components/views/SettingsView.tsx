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
import { THEME_PRESET_LIST, useThemeStore, type ThemePresetId } from '../../stores/themeStore'
import {
  factoryResetApplication,
  resetAllSettings,
  resetAudioSettings,
  resetEqSettings,
  resetIntegrationSettings,
  resetMappedFolders,
  resetThemeSettings,
} from '../settings/resetActions'

type ResetActionId =
  | 'reset-theme'
  | 'reset-audio'
  | 'reset-integrations'
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
  'reset-eq',
  'reset-all',
  'reset-folders',
  'factory-reset',
]

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
  const [resetStatuses, setResetStatuses] = useState<Record<ResetActionId, ResetActionStatus>>(
    () => buildInitialResetStatusMap()
  )
  const { addFolder, rescan, isScanning, scanProgress } = useLibraryStore()
  const {
    presetId,
    customAccent,
    resolvedTokens,
    setPreset,
    setCustomAccent,
    usePresetAccent,
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
    statusMessage: discordStatusMessage,
    setEnabled: setDiscordEnabled,
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

  const selectedPreset = useMemo(
    () => THEME_PRESET_LIST.find((preset) => preset.id === presetId) ?? THEME_PRESET_LIST[0],
    [presetId]
  )
  const effectiveAccent = customAccent ?? selectedPreset.accent

  useEffect(() => {
    setAccentInputValue(effectiveAccent)
  }, [effectiveAccent])

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

  return (
    <div className="settings-view">
      <div className="settings-shell">
        <div className="settings-header">
          <div>
            <p className="settings-kicker">System Controls</p>
            <h2>Settings</h2>
            <p className="settings-subtitle">Manage your library, analyzer behavior, and playback output.</p>
          </div>
          {isScanning && (
            <div className="settings-scan-badge">
              Scanning
              {scanProgress ? ` ${scanProgress.current}/${scanProgress.total}` : '...'}
            </div>
          )}
        </div>

        <div className="settings-content">
          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Appearance</h3>
              <p>Choose a theme preset and customize accent color.</p>
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
                <span className="settings-field-label">Accent Color</span>
                <div className="settings-accent-inputs">
                  <input
                    className="settings-color settings-color-wide"
                    type="color"
                    value={effectiveAccent}
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
                        setAccentInputValue(effectiveAccent)
                        return
                      }
                      setAccentInputValue(normalized)
                    }}
                    placeholder="#38bdf8"
                    spellCheck={false}
                  />
                </div>
              </label>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Accent Source</span>
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
                    setAccentInputValue('#38bdf8')
                  }}
                >
                  Reset Theme to Default
                </button>
              </div>
            </div>
            <p className="settings-note">The current Astra look is preserved as the default theme preset.</p>
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Library</h3>
              <p>Choose source folders and keep metadata in sync.</p>
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
            <p className="settings-note">Use Manage Folders to review indexed locations and permission warnings.</p>
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Analyzer</h3>
              <p>Configure FFT resolution and visualizer behavior.</p>
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
            <p className="settings-note">
              Analyzer controls are centralized here. Visualizer line color follows the active theme accent.
            </p>
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Audio Output</h3>
              <p>Select the playback device used by the player.</p>
            </div>
            <div className="settings-audio-control">
              <AudioOutputSelect />
            </div>
            <DelayCompensationPanel />
            <ChannelRoutingPanel />
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Integrations</h3>
              <p>Enable optional platform integrations. Discord Rich Presence uses the app default configuration.</p>
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
            </div>
            <p className="settings-note">{discordStatusMessage}</p>
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Updates</h3>
              <p>Check GitHub releases for new Astra builds.</p>
            </div>
            <div className="settings-grid">
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
                  disabled={!updateAvailable}
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
          </section>

          <section className="settings-section settings-section-panel settings-danger-zone">
            <div className="settings-section-head">
              <h3>Danger Zone</h3>
              <p>Use these only when troubleshooting or intentionally wiping settings/data.</p>
            </div>
            <div className="settings-danger-list">
              {resetActions.map((action) => {
                const status = resetStatuses[action.id]
                return (
                  <div key={action.id} className="settings-danger-item">
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
              })}
            </div>
            {isScanning && (
              <p className="settings-note settings-danger-note">
                Destructive resets are disabled while library scanning is in progress.
              </p>
            )}
          </section>
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
