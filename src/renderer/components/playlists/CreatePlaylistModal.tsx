import { useEffect, useMemo, useState } from 'react'
import PlaylistCover from './PlaylistCover'

interface CreatePlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, coverImagePath: string | null) => Promise<unknown>
  onImport?: () => Promise<boolean>
  importLabel?: string
  isImporting?: boolean
  title?: string
  initialName?: string
  pendingTrackCount?: number
}

function toFilePreviewSource(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return `file://${encodeURI(normalized).replace(/#/g, '%23')}`
}

export default function CreatePlaylistModal({
  isOpen,
  onClose,
  onCreate,
  onImport,
  importLabel = 'Import',
  isImporting = false,
  title = 'Create Playlist',
  initialName = '',
  pendingTrackCount
}: CreatePlaylistModalProps) {
  const [name, setName] = useState('')
  const [coverImagePath, setCoverImagePath] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setCoverImagePath(null)
      setIsSubmitting(false)
      setSubmitError(null)
      return
    }

    setName(initialName)
    setCoverImagePath(null)
    setIsSubmitting(false)
    setSubmitError(null)
  }, [initialName, isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  const coverPreviewSource = useMemo(() => {
    if (!coverImagePath) return null
    return toFilePreviewSource(coverImagePath)
  }, [coverImagePath])

  const handleChooseCover = async () => {
    const filePath = await window.electronAPI.openFileDialog({
      title: 'Choose playlist cover',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
      ]
    })

    if (!filePath) return
    setCoverImagePath(filePath)
  }

  const handleCreate = async () => {
    if (isSubmitting) return
    const trimmedName = name.trim()
    if (!trimmedName) return

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      await onCreate(trimmedName, coverImagePath)
      onClose()
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to create playlist.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleImport = async () => {
    if (!onImport || isSubmitting || isImporting) return

    setSubmitError(null)
    try {
      const shouldClose = await onImport()
      if (shouldClose) {
        onClose()
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to import playlist.')
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay playlist-create-modal-overlay" onClick={onClose}>
      <div
        className="modal-content playlist-create-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header playlist-create-modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body playlist-create-modal-body">
          <label className="playlist-create-field">
            <span className="playlist-create-label">Name</span>
            <input
              type="text"
              className="playlist-create-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder="Night drive"
              maxLength={80}
              autoFocus
            />
          </label>

          {typeof pendingTrackCount === 'number' && pendingTrackCount > 0 && (
            <div className="playlist-create-track-count" role="status">
              {pendingTrackCount} {pendingTrackCount === 1 ? 'track' : 'tracks'} will be added after creation.
            </div>
          )}

          <div className="playlist-create-cover-row">
            <div className="playlist-create-cover-preview">
              {coverPreviewSource ? (
                <img
                  src={coverPreviewSource}
                  alt="Playlist cover preview"
                  className="playlist-create-cover-image"
                  onError={() => setCoverImagePath(null)}
                />
              ) : (
                <PlaylistCover
                  hash={null}
                  name="New playlist"
                  className="playlist-create-cover-placeholder"
                />
              )}
            </div>

            <div className="playlist-create-cover-actions">
              <span className="playlist-create-label">Cover (optional)</span>
              <button
                type="button"
                className="playlist-create-cover-btn"
                onClick={() => void handleChooseCover()}
              >
                {coverImagePath ? 'Change image' : 'Choose image'}
              </button>
              {coverImagePath && (
                <button
                  type="button"
                  className="playlist-create-cover-btn subtle"
                  onClick={() => setCoverImagePath(null)}
                >
                  Remove image
                </button>
              )}
            </div>
          </div>

          {submitError && (
            <div className="playlist-create-error" role="alert">
              {submitError}
            </div>
          )}
        </div>

        <div className="modal-footer playlist-create-modal-footer">
          {onImport && (
            <button
              type="button"
              className="settings-btn playlist-create-import-btn"
              onClick={() => void handleImport()}
              disabled={isSubmitting || isImporting}
            >
              {isImporting ? 'Importing...' : importLabel}
            </button>
          )}
          <div className="playlist-create-modal-actions">
            <button className="settings-btn" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              className="settings-btn settings-btn-primary"
              onClick={() => void handleCreate()}
              disabled={isSubmitting || name.trim().length === 0}
            >
              {isSubmitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
