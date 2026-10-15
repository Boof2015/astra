import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderSyncRef } from '../../../types/providerSync'
import type { RemotePlaylistDestination } from '../../../types/remotePlaylists'
import { RemotePlaylistCreationUncertainError } from '../../stores/playlistStore'
import PlaylistCover from './PlaylistCover'
import ServerDestinationPicker, { destinationKey } from './ServerDestinationPicker'
import { useServers } from '../settings/servers/useServers'
import { usePresence } from '../../hooks/usePresence'
import DynamicPlaylistRuleEditor, { type DynamicPlaylistPreview } from './DynamicPlaylistRuleEditor'
import {
  createDefaultDynamicPlaylistRules,
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistRulesV2,
  type PlaylistKind
} from '../../../shared/playlists/dynamicPlaylist'

interface CreatePlaylistModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string, coverImagePath: string | null, destination?: ProviderSyncRef) => Promise<unknown>
  onCreateDynamic?: (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV2) => Promise<unknown>
  onPreviewDynamic?: (rules: DynamicPlaylistRulesV2) => Promise<DynamicPlaylistPreview>
  allowDynamic?: boolean
  onImport?: () => Promise<boolean>
  importLabel?: string
  isImporting?: boolean
  title?: string
  initialName?: string
  pendingTrackCount?: number
  trackPaths?: string[]
}
const NO_TRACKS: string[] = []

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
  pendingTrackCount,
  trackPaths = NO_TRACKS
}: CreatePlaylistModalProps) {
  const presence = usePresence(isOpen)
  const [name, setName] = useState('')
  const [coverImagePath, setCoverImagePath] = useState<string | null>(null)
  const [playlistKind, setPlaylistKind] = useState<PlaylistKind | 'server' | null>(null)
  const servers = useServers()
  const [destinations, setDestinations] = useState<RemotePlaylistDestination[]>([])
  const [destination, setDestination] = useState('')
  const [destinationsError, setDestinationsError] = useState<string | null>(null)
  const [loadingDestinations, setLoadingDestinations] = useState(false)
  const [creationUncertain, setCreationUncertain] = useState(false)
  const submitting = useRef(false)
  const [dynamicRules, setDynamicRules] = useState<DynamicPlaylistRulesV2>(() => createDefaultDynamicPlaylistRules())
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
    setPlaylistKind(null)
    setDestination('')
    setCreationUncertain(false)
    setDynamicRules(createDefaultDynamicPlaylistRules())
    setIsSubmitting(false)
    setSubmitError(null)
  }, [canCreateDynamic, initialName, isOpen, presence.shouldRender])

  useEffect(() => {
    if (!isOpen) return
    let active = true, generation = 0
    const refresh = async () => {
      const request = ++generation
      setLoadingDestinations(true)
      try {
        const choices = await window.electronAPI.remotePlaylists.destinations(trackPaths)
        if (!active || request !== generation) return
        setDestinations(choices); setDestinationsError(null)
        // Once chosen, never silently switch to another server during refresh.
        setDestination(current => current || (choices[0] ? destinationKey(choices.find(choice => !choice.reason) ?? choices[0]) : ''))
        if (!canCreateDynamic && !choices.length) setPlaylistKind(current => current === null ? 'normal' : current)
      } catch {
        if (active && request === generation) { setDestinations([]); setDestinationsError('Could not load server destinations. Close and reopen this dialog to try again.') }
      } finally { if (active && request === generation) setLoadingDestinations(false) }
    }
    void refresh()
    const unsubscribe = window.electronAPI.remotePlaylists.onChanged(() => { void refresh() })
    return () => { active = false; unsubscribe() }
  }, [isOpen, trackPaths, canCreateDynamic])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!submitting.current) onClose()
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
    if (submitting.current || playlistKind === null) return
    const server = playlistKind === 'server' ? destinations.find(choice => destinationKey(choice) === destination) : undefined
    if (playlistKind === 'server' && (!server || server.reason || creationUncertain || loadingDestinations)) return
    const trimmedName = name.trim()
    if (!trimmedName) return

    submitting.current = true
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      if (playlistKind === 'dynamic') {
        if (!onCreateDynamic || !onPreviewDynamic) {
          throw new Error('Dynamic playlist creation is not available here.')
        }
        await onCreateDynamic(trimmedName, coverImagePath, normalizeDynamicPlaylistRules(dynamicRules))
      } else {
        await onCreate(trimmedName, server ? null : coverImagePath, server ? { provider: server.provider, sourceId: server.sourceId } : undefined)
      }
      onClose()
    } catch (error) {
      if (error instanceof RemotePlaylistCreationUncertainError) setCreationUncertain(true)
      setSubmitError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Failed to create playlist.')
    } finally {
      submitting.current = false
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
  const isServerMode = playlistKind === 'server'
  const selectedServer = destinations.find(choice => destinationKey(choice) === destination)
  const selectedServerName = servers.find(server => server.key === destination)?.name ?? selectedServer?.name
  const isChoosingKind = playlistKind === null
  const isCreateDisabled = isChoosingKind || isSubmitting || name.trim().length === 0 || (isDynamicMode && dynamicRulesError !== null)
    || (isServerMode && (!selectedServer || !!selectedServer.reason || loadingDestinations || creationUncertain))
  const effectiveTitle = isDynamicMode ? 'Create Dynamic Playlist' : isServerMode ? 'Create Server Playlist' : title
  const close = () => { if (!submitting.current) onClose() }

  return (
    <div
      className="modal-overlay playlist-create-modal-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={close}
    >
      <div
        className={`modal-content playlist-create-modal ${isDynamicMode ? 'playlist-create-modal-dynamic' : ''} ${isChoosingKind ? 'playlist-create-modal-choice' : ''}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header playlist-create-modal-header">
          <div className="playlist-create-title-row">
            {(canCreateDynamic || destinations.length > 0) && playlistKind !== null && (
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
          <button className="modal-close" onClick={close} aria-label="Close" disabled={isSubmitting}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body playlist-create-modal-body">
          {isChoosingKind ? (
            <div className="playlist-create-choice-grid" role="group" aria-label="Playlist type">
              <button
                type="button"
                className="playlist-create-kind-option"
                onClick={() => setPlaylistKind('normal')}
                disabled={isSubmitting}
              >
                <span className="playlist-create-kind-title">Local Playlist</span>
                <span className="playlist-create-kind-subtitle">Saved in Astra</span>
              </button>
              {canCreateDynamic && <button
                type="button"
                className="playlist-create-kind-option"
                onClick={() => setPlaylistKind('dynamic')}
                disabled={isSubmitting}
              >
                <span className="playlist-create-kind-title">Dynamic Playlist</span>
                <span className="playlist-create-kind-subtitle">Rule-based track list</span>
              </button>}
              {(loadingDestinations || destinations.length > 0 || destinationsError) && <button type="button"
                className="playlist-create-kind-option" disabled={isSubmitting || loadingDestinations || !destinations.length}
                onClick={() => setPlaylistKind('server')}>
                <span className="playlist-create-kind-title">Server Playlist</span>
                <span className="playlist-create-kind-subtitle">Saved on a music server</span>
              </button>}
            </div>
          ) : (
            <>
              <div className={isDynamicMode ? 'playlist-dynamic-builder-top' : 'playlist-create-normal-fields'}>
                {isServerMode && (
                  <div className="playlist-create-field">
                    <span className="playlist-create-label">Server</span>
                    <ServerDestinationPicker destinations={destinations} value={destination}
                      disabled={isSubmitting || loadingDestinations} onChange={setDestination} />
                    <p className="settings-note">
                      {selectedServer && !selectedServer.reason
                        ? 'The playlist and your edits are saved directly to this server.'
                        : 'Choose a server that can take this playlist.'}
                    </p>
                  </div>
                )}
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
                    disabled={isSubmitting}
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
                ) : !isServerMode ? (
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
                ) : null}
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
          {destinationsError && (isChoosingKind || isServerMode) && <p className="playlist-create-error" role="alert">{destinationsError}</p>}
        </div>

        <div className="modal-footer playlist-create-modal-footer">
          {onImport && !isDynamicMode && !isServerMode && (
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
            <button className="settings-btn" onClick={close} disabled={isSubmitting}>
              {creationUncertain ? 'Close' : 'Cancel'}
            </button>
            {!isChoosingKind && (
              <button
                className="settings-btn settings-btn-primary"
                onClick={() => void handleCreate()}
                disabled={isCreateDisabled}
              >
                {isSubmitting ? 'Creating...' : isDynamicMode ? 'Create Dynamic'
                  : isServerMode && selectedServer && !selectedServer.reason ? `Create on ${selectedServerName}` : 'Create'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
