import { useEffect, useMemo, useState } from 'react'
import PlaylistCover from './PlaylistCover'
import { usePresence } from '../../hooks/usePresence'
import DynamicPlaylistRuleEditor, { type DynamicPlaylistPreview } from './DynamicPlaylistRuleEditor'
import {
  createDefaultDynamicPlaylistRules,
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistRulesV1,
  type PlaylistKind
} from '../../../shared/playlists/dynamicPlaylist'

interface CreatePlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, coverImagePath: string | null) => Promise<unknown>
  onCreateDynamic?: (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV1) => Promise<unknown>
  onPreviewDynamic?: (rules: DynamicPlaylistRulesV1) => Promise<DynamicPlaylistPreview>
  allowDynamic?: boolean
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
  onCreateDynamic,
  onPreviewDynamic,
  allowDynamic = false,
  onImport,
  importLabel = 'Import',
  isImporting = false,
  title = 'Create Playlist',
  initialName = '',
  pendingTrackCount
}: CreatePlaylistModalProps) {
  const presence = usePresence(isOpen)
  const [name, setName] = useState('')
  const [coverImagePath, setCoverImagePath] = useState<string | null>(null)
  const [playlistKind, setPlaylistKind] = useState<PlaylistKind | null>(null)
  const [dynamicRules, setDynamicRules] = useState<DynamicPlaylistRulesV1>(() => createDefaultDynamicPlaylistRules())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const canCreateDynamic = allowDynamic && Boolean(onCreateDynamic && onPreviewDynamic)

  useEffect(() => {
    if (!isOpen) {
      if (presence.shouldRender) return
      setName('')
      setCoverImagePath(null)
      setPlaylistKind(null)
      setDynamicRules(createDefaultDynamicPlaylistRules())
      setIsSubmitting(false)
      setSubmitError(null)
      return
    }

    setName(initialName)
    setCoverImagePath(null)
    setPlaylistKind(canCreateDynamic ? null : 'normal')
    setDynamicRules(createDefaultDynamicPlaylistRules())
    setIsSubmitting(false)
    setSubmitError(null)
  }, [canCreateDynamic, initialName, isOpen, presence.shouldRender])

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

  const dynamicRulesError = useMemo(() => {
    if (playlistKind !== 'dynamic') return null
    try {
      normalizeDynamicPlaylistRules(dynamicRules)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Dynamic playlist rules are incomplete.'
    }
  }, [dynamicRules, playlistKind])

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
    if (canCreateDynamic && playlistKind === null) return
    const trimmedName = name.trim()
    if (!trimmedName) return

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      if (playlistKind === 'dynamic') {
        if (!onCreateDynamic || !onPreviewDynamic) {
          throw new Error('Dynamic playlist creation is not available here.')
        }
        await onCreateDynamic(trimmedName, coverImagePath, normalizeDynamicPlaylistRules(dynamicRules))
      } else {
        await onCreate(trimmedName, coverImagePath)
      }
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

  if (!presence.shouldRender) return null

  const isDynamicMode = playlistKind === 'dynamic'
  const isChoosingKind = canCreateDynamic && playlistKind === null
  const isCreateDisabled = isChoosingKind || isSubmitting || name.trim().length === 0 || (isDynamicMode && dynamicRulesError !== null)
  const effectiveTitle = isDynamicMode ? 'Create Dynamic Playlist' : title

  return (
    <div
      className="modal-overlay playlist-create-modal-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={onClose}
    >
      <div
        className={`modal-content playlist-create-modal ${isDynamicMode ? 'playlist-create-modal-dynamic' : ''} ${isChoosingKind ? 'playlist-create-modal-choice' : ''}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header playlist-create-modal-header">
          <div className="playlist-create-title-row">
            {canCreateDynamic && playlistKind !== null && (
              <button
                type="button"
                className="playlist-create-back-btn"
                onClick={() => setPlaylistKind(null)}
                disabled={isSubmitting}
              >
                Back
              </button>
            )}
            <h2>{effectiveTitle}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body playlist-create-modal-body">
          {isChoosingKind ? (
            <div className="playlist-create-choice-grid" role="radiogroup" aria-label="Playlist type">
              <button
                type="button"
                className="playlist-create-kind-option"
                onClick={() => setPlaylistKind('normal')}
                disabled={isSubmitting}
              >
                <span className="playlist-create-kind-title">Normal Playlist</span>
                <span className="playlist-create-kind-subtitle">Fixed track list</span>
              </button>
              <button
                type="button"
                className="playlist-create-kind-option"
                onClick={() => setPlaylistKind('dynamic')}
                disabled={isSubmitting}
              >
                <span className="playlist-create-kind-title">Dynamic Playlist</span>
                <span className="playlist-create-kind-subtitle">Rule-based track list</span>
              </button>
            </div>
          ) : (
            <>
              <div className={isDynamicMode ? 'playlist-dynamic-builder-top' : 'playlist-create-normal-fields'}>
                <label className="playlist-create-field">
                  <span className="playlist-create-label">Name</span>
                  <input
                    type="text"
                    className="playlist-create-input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !isDynamicMode) {
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

                {isDynamicMode ? (
                  <div className="playlist-create-cover-compact">
                    <span className="playlist-create-label">Cover</span>
                    <button
                      type="button"
                      className="playlist-create-cover-btn subtle"
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
                        Remove
                      </button>
                    )}
                  </div>
                ) : (
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
                )}
              </div>

              {isDynamicMode && onPreviewDynamic && (
                <DynamicPlaylistRuleEditor
                  rules={dynamicRules}
                  onRulesChange={setDynamicRules}
                  onPreview={onPreviewDynamic}
                  disabled={isSubmitting}
                />
              )}
            </>
          )}

          {submitError && (
            <div className="playlist-create-error" role="alert">
              {submitError}
            </div>
          )}
        </div>

        <div className="modal-footer playlist-create-modal-footer">
          {onImport && !isDynamicMode && (
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
            {!isChoosingKind && (
              <button
                className="settings-btn settings-btn-primary"
                onClick={() => void handleCreate()}
                disabled={isCreateDisabled}
              >
                {isSubmitting ? 'Creating...' : isDynamicMode ? 'Create Dynamic' : 'Create'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
