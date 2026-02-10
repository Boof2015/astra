import { useState } from 'react'
import FolderSettings from '../settings/FolderSettings'
import AudioOutputSelect from '../settings/AudioOutputSelect'

export default function SettingsView() {
  const [showFolderSettings, setShowFolderSettings] = useState(false)

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h2>Settings</h2>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          <h3>Library</h3>
          <button className="settings-btn" onClick={() => setShowFolderSettings(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
            Manage Folders
          </button>
        </div>
        <div className="settings-section">
          <h3>Audio Output</h3>
          <AudioOutputSelect />
        </div>
      </div>
      <FolderSettings
        isOpen={showFolderSettings}
        onClose={() => setShowFolderSettings(false)}
      />
    </div>
  )
}
