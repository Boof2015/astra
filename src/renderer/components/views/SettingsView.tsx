import { useState } from 'react'
import FolderSettings from '../settings/FolderSettings'
import AudioOutputSelect from '../settings/AudioOutputSelect'
import ChannelRoutingPanel from '../settings/ChannelRoutingPanel'
import { useLibraryStore } from '../../stores/libraryStore'
import { useVisualizerSettingsStore, type FFTSize } from '../../stores/visualizerSettingsStore'
import { useDiscordSettingsStore } from '../../stores/discordSettingsStore'

export default function SettingsView() {
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const { addFolder, rescan, isScanning, scanProgress } = useLibraryStore()
  const {
    lineColor,
    fftSize,
    pitchLock,
    isRunning,
    setLineColor,
    setFftSize,
    setPitchLock,
    setIsRunning,
  } = useVisualizerSettingsStore()
  const {
    enabled: discordEnabled,
    statusMessage: discordStatusMessage,
    setEnabled: setDiscordEnabled,
  } = useDiscordSettingsStore()

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

              <label className="settings-field settings-field-inline">
                <span className="settings-field-label">Line Color</span>
                <input
                  className="settings-color"
                  type="color"
                  value={lineColor}
                  onChange={(e) => setLineColor(e.target.value)}
                />
              </label>
            </div>
            <p className="settings-note">Analyzer controls are centralized here instead of in hover-only controls.</p>
          </section>

          <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Audio Output</h3>
              <p>Select the playback device used by the player.</p>
            </div>
            <div className="settings-audio-control">
              <AudioOutputSelect />
            </div>
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
        </div>
      </div>
      <FolderSettings
        isOpen={showFolderSettings}
        onClose={() => setShowFolderSettings(false)}
      />
    </div>
  )
}
