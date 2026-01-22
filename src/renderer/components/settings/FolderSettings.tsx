import { useEffect, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'

interface FolderSettingsProps {
  isOpen: boolean
  onClose: () => void
}

export default function FolderSettings({ isOpen, onClose }: FolderSettingsProps) {
  const { folders, loadFolders, addFolder, removeFolder, isScanning } = useLibraryStore()
  const [removingPath, setRemovingPath] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      loadFolders()
    }
  }, [isOpen, loadFolders])

  const handleRemoveFolder = async (path: string) => {
    setRemovingPath(path)
    await removeFolder(path)
    setRemovingPath(null)
  }

  const handleAddFolder = async () => {
    await addFolder()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content folder-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Library Folders</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {folders.length === 0 ? (
            <div className="folder-empty">
              <p>No folders added to library</p>
              <p className="folder-empty-hint">Add a folder to start scanning your music collection</p>
            </div>
          ) : (
            <div className="folder-list">
              {folders.map((folder) => (
                <div key={folder.path} className="folder-item">
                  <div className="folder-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                    </svg>
                  </div>
                  <div className="folder-info">
                    <div className="folder-path">{folder.path}</div>
                    <div className="folder-meta">
                      Added {new Date(folder.added_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    className="folder-remove"
                    onClick={() => handleRemoveFolder(folder.path)}
                    disabled={removingPath === folder.path || isScanning}
                    title="Remove folder"
                  >
                    {removingPath === folder.path ? (
                      <div className="loading-spinner-small" />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                      </svg>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="add-folder-btn"
            onClick={handleAddFolder}
            disabled={isScanning}
          >
            <span>+</span> Add Folder
          </button>
        </div>
      </div>
    </div>
  )
}
