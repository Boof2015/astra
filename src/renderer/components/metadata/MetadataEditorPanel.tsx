import { useCallback, useEffect, useMemo, useState } from 'react'
import AlbumArtwork from '../library/AlbumArtwork'
import DiffConfirmModal, { type DiffEntry } from './DiffConfirmModal'
import { useLibraryStore } from '../../stores/libraryStore'
import { useMetadataEditorStore, type MetadataEditChanges } from '../../stores/metadataEditorStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePresence } from '../../hooks/usePresence'

interface DraftField {
  value: string
  dirty: boolean
}

interface DraftState {
  title: DraftField
  artist: DraftField
  album: DraftField
  albumArtist: DraftField
  genre: DraftField
  year: DraftField
  trackNumber: DraftField
  discNumber: DraftField
}

interface CommonFieldState {
  mixed: boolean
  value: string
}

interface SelectionCommonState {
  title: CommonFieldState
  artist: CommonFieldState
  album: CommonFieldState
  albumArtist: CommonFieldState
  genre: CommonFieldState
  year: CommonFieldState
  trackNumber: CommonFieldState
  discNumber: CommonFieldState
}

type ArtworkDraft =
  | { mode: 'unchanged' }
  | { mode: 'remove' }
  | { mode: 'replace'; imagePath: string }

interface TrackRecord {
  path: string
  title: string
  artist: string
  artist_names?: string[]
  album: string
  album_artist: string | null
  album_artist_names?: string[]
  genre: string | null
  year: number | null
  track_number: number | null
  disc_number: number | null
  artwork_hash: string | null
  source_type?: 'local' | 'subsonic' | 'jellyfin'
}

const EMPTY_TRACK_PATHS: string[] = []

const DIFF_FIELD_MAP: Array<{ key: keyof DraftState; label: string; commonKey: keyof SelectionCommonState }> = [
  { key: 'title', label: 'Title', commonKey: 'title' },
  { key: 'artist', label: 'Artist', commonKey: 'artist' },
  { key: 'album', label: 'Album', commonKey: 'album' },
  { key: 'albumArtist', label: 'Album Artist', commonKey: 'albumArtist' },
  { key: 'genre', label: 'Genre', commonKey: 'genre' },
  { key: 'year', label: 'Year', commonKey: 'year' },
  { key: 'trackNumber', label: 'Track #', commonKey: 'trackNumber' },
  { key: 'discNumber', label: 'Disc #', commonKey: 'discNumber' }
]

function createDraftFromCommon(common: SelectionCommonState): DraftState {
  return {
    title: { value: common.title.value, dirty: false },
    artist: { value: common.artist.value, dirty: false },
    album: { value: common.album.value, dirty: false },
    albumArtist: { value: common.albumArtist.value, dirty: false },
    genre: { value: common.genre.value, dirty: false },
    year: { value: common.year.value, dirty: false },
    trackNumber: { value: common.trackNumber.value, dirty: false },
    discNumber: { value: common.discNumber.value, dirty: false }
  }
}

function getCommonString(values: Array<string | null | undefined>): CommonFieldState {
  if (values.length === 0) return { mixed: false, value: '' }
  const first = values[0] ?? ''
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? '') !== first) {
      return { mixed: true, value: '' }
    }
  }
  return { mixed: false, value: first }
}

function getCommonNumber(values: Array<number | null | undefined>): CommonFieldState {
  if (values.length === 0) return { mixed: false, value: '' }
  const first = values[0] ?? null
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? null) !== first) {
      return { mixed: true, value: '' }
    }
  }
  return { mixed: false, value: first === null ? '' : String(first) }
}

function getSelectionCommonState(tracks: TrackRecord[]): SelectionCommonState {
  return {
    title: getCommonString(tracks.map((track) => track.title)),
    artist: getCommonString(tracks.map((track) => track.artist)),
    album: getCommonString(tracks.map((track) => track.album)),
    albumArtist: getCommonString(tracks.map((track) => track.album_artist)),
    genre: getCommonString(tracks.map((track) => track.genre)),
    year: getCommonNumber(tracks.map((track) => track.year)),
    trackNumber: getCommonNumber(tracks.map((track) => track.track_number)),
    discNumber: getCommonNumber(tracks.map((track) => track.disc_number))
  }
}

function getCommonArtworkHash(tracks: TrackRecord[]): { hash: string | null; mixed: boolean } {
  if (tracks.length === 0) return { hash: null, mixed: false }
  const first = tracks[0].artwork_hash
  for (let index = 1; index < tracks.length; index += 1) {
    if (tracks[index].artwork_hash !== first) return { hash: null, mixed: true }
  }
  return { hash: first, mixed: false }
}

function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || filePath
}

function buildDiffEntries(
  draft: DraftState,
  common: SelectionCommonState,
  artworkState: { hash: string | null; mixed: boolean },
  artworkDraft: ArtworkDraft
): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const { key, label, commonKey } of DIFF_FIELD_MAP) {
    if (draft[key].dirty) {
      entries.push({
        field: label,
        oldValue: common[commonKey].mixed ? '(mixed)' : common[commonKey].value || '(empty)',
        newValue: draft[key].value || '(empty)'
      })
    }
  }

  if (artworkDraft.mode !== 'unchanged') {
    const previous = artworkState.mixed
      ? '(mixed)'
      : (artworkState.hash ? 'Present' : '(none)')
    const next = artworkDraft.mode === 'remove'
      ? '(none)'
      : `Replace (${getFileNameFromPath(artworkDraft.imagePath)})`

    entries.push({
      field: 'Cover Art',
      oldValue: previous,
      newValue: next
    })
  }

  return entries
}

function parseOptionalInteger(value: string, fieldLabel: string): number | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${fieldLabel} must be a non-negative integer.`)
  }

  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldLabel} must be a non-negative integer.`)
  }

  return parsed
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return fallback
}

function isLocalTrack(track: TrackRecord): boolean {
  return (track.source_type ?? 'local') === 'local'
}

export default function MetadataEditorPanel() {
  const loadLibrary = useLibraryStore((state) => state.loadLibrary)
  const playlistsSelectedId = usePlaylistStore((state) => state.selectedPlaylistId)
  const selectPlaylist = usePlaylistStore((state) => state.selectPlaylist)

  const {
    panelRequest,
    saveMode,
    defaultSaveMode,
    isSaving,
    lastResult,
    undoStack,
    redoStack,
    setSaveMode,
    setDefaultSaveMode,
    loadOverridePaths,
    clearOverrides,
    saveEdits,
    clearLastResult,
    undo,
    redo,
    closePanel
  } = useMetadataEditorStore()
  const presence = usePresence(panelRequest)
  const displayedPanelRequest = presence.presentValue

  const requestTrackPaths = displayedPanelRequest?.trackPaths ?? EMPTY_TRACK_PATHS
  const requestTrackPathKey = requestTrackPaths.join('\u0000')
  const skippedRemoteCount = displayedPanelRequest?.skippedRemoteCount ?? 0

  const [tracks, setTracks] = useState<TrackRecord[]>([])
  const [isTracksLoading, setIsTracksLoading] = useState(false)
  const [draft, setDraft] = useState<DraftState>(() => createDraftFromCommon(getSelectionCommonState([])))
  const [artworkDraft, setArtworkDraft] = useState<ArtworkDraft>({ mode: 'unchanged' })
  const [artworkDraftPreview, setArtworkDraftPreview] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [showFailureDetails, setShowFailureDetails] = useState(false)
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number } | null>(null)
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string[]>>({})
  const [showDiffModal, setShowDiffModal] = useState(false)

  const selectedTrackPaths = useMemo(() => tracks.map((track) => track.path), [tracks])
  const selectedCount = selectedTrackPaths.length
  const selectionCommon = useMemo(() => getSelectionCommonState(tracks), [tracks])
  const artworkState = useMemo(() => getCommonArtworkHash(tracks), [tracks])
  const selectionKey = useMemo(() => selectedTrackPaths.join('\u0000'), [selectedTrackPaths])

  const reloadPanelTracks = useCallback(async (): Promise<TrackRecord[]> => {
    if (requestTrackPaths.length === 0) {
      setTracks([])
      return []
    }

    const fetchedTracks = await window.electronAPI.library.getTracksByPaths(requestTrackPaths) as TrackRecord[]
    const localTracks = fetchedTracks.filter(isLocalTrack)
    setTracks(localTracks)
    return localTracks
  }, [requestTrackPathKey, requestTrackPaths])

  useEffect(() => {
    if (!displayedPanelRequest) {
      setTracks([])
      setValidationError(null)
      setStatusMessage(null)
      setShowFailureDetails(false)
      setSaveProgress(null)
      setFieldOverrides({})
      setShowDiffModal(false)
      return
    }

    let cancelled = false
    const run = async () => {
      setIsTracksLoading(true)
      setValidationError(null)
      setStatusMessage(null)
      try {
        await loadOverridePaths()
        const nextTracks = await reloadPanelTracks()
        if (cancelled) return
        if (nextTracks.length === 0) {
          setValidationError('No editable local tracks were found for this selection.')
        }
      } catch (error) {
        if (cancelled) return
        setValidationError(toErrorMessage(error, 'Failed to load selected tracks.'))
      } finally {
        if (!cancelled) {
          setIsTracksLoading(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [displayedPanelRequest, loadOverridePaths, reloadPanelTracks])

  useEffect(() => {
    setDraft(createDraftFromCommon(selectionCommon))
  }, [selectionCommon])

  useEffect(() => {
    setArtworkDraft({ mode: 'unchanged' })
  }, [selectionKey])

  useEffect(() => {
    let isCancelled = false
    if (artworkDraft.mode !== 'replace') {
      setArtworkDraftPreview(null)
      return () => {
        isCancelled = true
      }
    }

    setArtworkDraftPreview(null)
    void window.electronAPI.readFileAsDataUrl(artworkDraft.imagePath)
      .then((dataUrl) => {
        if (isCancelled) return
        setArtworkDraftPreview(dataUrl)
      })
      .catch(() => {
        if (isCancelled) return
        setArtworkDraftPreview(null)
      })

    return () => {
      isCancelled = true
    }
  }, [artworkDraft])

  useEffect(() => {
    setValidationError(null)
    setStatusMessage(null)
    clearLastResult()
    setShowFailureDetails(false)
  }, [clearLastResult, selectionKey])

  useEffect(() => {
    if (selectedTrackPaths.length === 0) {
      setFieldOverrides({})
      return
    }
    void window.electronAPI.library.getTrackOverrideFields(selectedTrackPaths).then(setFieldOverrides)
  }, [selectedTrackPaths])

  const hasDirtyFields = useMemo(() => {
    return Object.values(draft).some((field) => field.dirty) || artworkDraft.mode !== 'unchanged'
  }, [artworkDraft.mode, draft])

  const overriddenFieldSet = useMemo(() => {
    const set = new Set<string>()
    for (const fields of Object.values(fieldOverrides)) {
      for (const field of fields) set.add(field)
    }
    return set
  }, [fieldOverrides])

  const diffEntries = useMemo(() => (
    buildDiffEntries(draft, selectionCommon, artworkState, artworkDraft)
  ), [artworkDraft, artworkState, draft, selectionCommon])

  const updateDraftField = useCallback((field: keyof DraftState, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: {
        value,
        dirty: true
      }
    }))
  }, [])

  const handleClose = useCallback(() => {
    if (isSaving) return
    if (hasDirtyFields && !window.confirm('Discard unsaved metadata edits?')) {
      return
    }
    closePanel()
  }, [closePanel, hasDirtyFields, isSaving])

  const handleChooseArtwork = useCallback(async () => {
    const imagePath = await window.electronAPI.openFileDialog({
      title: 'Choose track cover art',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (!imagePath) return
    setArtworkDraft({ mode: 'replace', imagePath })
  }, [])

  const handleRemoveArtwork = useCallback(() => {
    setArtworkDraft((current) => (current.mode === 'remove' ? { mode: 'unchanged' } : { mode: 'remove' }))
  }, [])

  const handleBuildChanges = useCallback((): MetadataEditChanges => {
    const changes: MetadataEditChanges = {}

    if (draft.title.dirty) {
      const value = draft.title.value.trim()
      if (!value) throw new Error('Title cannot be empty.')
      changes.title = value
    }

    if (draft.artist.dirty) {
      const value = draft.artist.value.trim()
      if (!value) throw new Error('Artist cannot be empty.')
      changes.artist = value
    }

    if (draft.album.dirty) {
      const value = draft.album.value.trim()
      if (!value) throw new Error('Album cannot be empty.')
      changes.album = value
    }

    if (draft.albumArtist.dirty) {
      const value = draft.albumArtist.value.trim()
      changes.albumArtist = value.length > 0 ? value : null
    }

    if (draft.genre.dirty) {
      const value = draft.genre.value.trim()
      changes.genre = value.length > 0 ? value : null
    }

    if (draft.year.dirty) {
      changes.year = parseOptionalInteger(draft.year.value, 'Year')
    }

    if (draft.trackNumber.dirty) {
      changes.trackNumber = parseOptionalInteger(draft.trackNumber.value, 'Track number')
    }

    if (draft.discNumber.dirty) {
      changes.discNumber = parseOptionalInteger(draft.discNumber.value, 'Disc number')
    }

    if (artworkDraft.mode === 'replace') {
      changes.artworkPath = artworkDraft.imagePath
    } else if (artworkDraft.mode === 'remove') {
      changes.artworkPath = null
    }

    if (Object.keys(changes).length === 0) {
      throw new Error('No changes to save.')
    }

    return changes
  }, [artworkDraft, draft])

  const refreshAfterMutation = useCallback(async (updatedTrackPaths: string[]) => {
    await loadLibrary()
    const refreshedTracks = await reloadPanelTracks()

    if (playlistsSelectedId !== null) {
      await selectPlaylist(playlistsSelectedId)
    }

    const currentTrack = usePlayerStore.getState().currentTrack
    if (!currentTrack || !updatedTrackPaths.includes(currentTrack.path)) {
      return
    }

    const refreshed = refreshedTracks.find((track) => track.path === currentTrack.path)
    if (!refreshed) return

    usePlayerStore.setState((state) => {
      if (!state.currentTrack || state.currentTrack.path !== refreshed.path) {
        return state
      }

      return {
        ...state,
        currentTrack: {
          ...state.currentTrack,
          title: refreshed.title,
          artist: refreshed.artist,
          artistNames: refreshed.artist_names,
          album: refreshed.album,
          albumArtist: refreshed.album_artist ?? undefined,
          albumArtistNames: refreshed.album_artist_names,
          genre: refreshed.genre ?? undefined,
          year: refreshed.year ?? undefined,
          trackNumber: refreshed.track_number ?? undefined,
          discNumber: refreshed.disc_number ?? undefined,
          artworkHash: refreshed.artwork_hash ?? undefined,
          artworkData: undefined
        }
      }
    })
  }, [loadLibrary, playlistsSelectedId, reloadPanelTracks, selectPlaylist])

  const handleSave = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)
    setSaveProgress(null)

    const unsubscribe = window.electronAPI.library.onMetadataEditProgress((progress) => {
      setSaveProgress({ current: progress.current, total: progress.total })
    })

    try {
      if (selectedTrackPaths.length === 0) {
        throw new Error('No editable local tracks are selected.')
      }
      const changes = handleBuildChanges()
      const result = await saveEdits({
        mode: saveMode,
        trackPaths: selectedTrackPaths,
        changes
      })

      await refreshAfterMutation(result.updatedTrackPaths)
      setArtworkDraft({ mode: 'unchanged' })
      if (result.failed === 0) {
        setStatusMessage(`Saved metadata for ${result.succeeded}/${result.requested} tracks.`)
      } else {
        setStatusMessage(`Saved ${result.succeeded}/${result.requested}. ${result.failed} failed.`)
      }
    } catch (error: unknown) {
      setValidationError(toErrorMessage(error, 'Failed to save metadata edits.'))
    } finally {
      unsubscribe()
      setSaveProgress(null)
    }
  }, [handleBuildChanges, refreshAfterMutation, saveEdits, saveMode, selectedTrackPaths])

  const handleClearOverrides = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)

    try {
      if (selectedTrackPaths.length === 0) {
        throw new Error('Select at least one track to clear overrides.')
      }
      const result = await clearOverrides(selectedTrackPaths)
      await refreshAfterMutation(selectedTrackPaths)
      setStatusMessage(`Cleared overrides for ${result.cleared} tracks.`)
    } catch (error: unknown) {
      setValidationError(toErrorMessage(error, 'Failed to clear metadata overrides.'))
    }
  }, [clearOverrides, refreshAfterMutation, selectedTrackPaths])

  const handleUndo = useCallback(async () => {
    const affectedPaths = await undo()
    if (affectedPaths.length > 0) {
      await refreshAfterMutation(affectedPaths)
      setStatusMessage(`Undid changes for ${affectedPaths.length} track(s).`)
    }
  }, [refreshAfterMutation, undo])

  const handleRedo = useCallback(async () => {
    const affectedPaths = await redo()
    if (affectedPaths.length > 0) {
      await refreshAfterMutation(affectedPaths)
      setStatusMessage(`Redid changes for ${affectedPaths.length} track(s).`)
    }
  }, [redo, refreshAfterMutation])

  if (!presence.shouldRender || !displayedPanelRequest) return null

  return (
    <aside
      className="metadata-editor-panel"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      role="dialog"
      aria-modal="false"
      aria-labelledby="metadata-editor-panel-title"
    >
      <div className="metadata-panel-header">
        <div className="metadata-panel-heading">
          <h2 id="metadata-editor-panel-title">Edit Metadata</h2>
          <span className="metadata-panel-subtitle">
            {selectedCount} editable track{selectedCount === 1 ? '' : 's'}
            {skippedRemoteCount > 0 && ` · ${skippedRemoteCount} remote skipped`}
          </span>
        </div>
        <button className="metadata-panel-close" onClick={handleClose} aria-label="Close metadata editor" disabled={isSaving}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>

      <div className="metadata-panel-toolbar">
        <label className="metadata-mode-field">
          <span>Save Mode</span>
          <select
            className="settings-select"
            value={saveMode}
            onChange={(event) => setSaveMode(event.target.value === 'file' ? 'file' : 'virtual')}
            disabled={isSaving}
          >
            <option value="virtual">Virtual (DB override)</option>
            <option value="file">Write file tags</option>
          </select>
        </label>

        <button
          className="settings-btn"
          onClick={() => setDefaultSaveMode(saveMode)}
          disabled={isSaving || defaultSaveMode === saveMode}
        >
          Make Default
        </button>
      </div>

      <div className="metadata-panel-actions">
        <div className="metadata-panel-secondary-actions">
          <button
            className="settings-btn metadata-panel-icon-btn"
            onClick={() => void handleUndo()}
            disabled={undoStack.length === 0 || isSaving}
            title="Undo last virtual save"
            aria-label="Undo last virtual save"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-2" />
            </svg>
          </button>
          <button
            className="settings-btn metadata-panel-icon-btn"
            onClick={() => void handleRedo()}
            disabled={redoStack.length === 0 || isSaving}
            title="Redo"
            aria-label="Redo"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H10a6 6 0 0 0 0 12h2" />
            </svg>
          </button>
          <button
            className="settings-btn metadata-panel-clear-btn"
            onClick={() => void handleClearOverrides()}
            disabled={selectedCount === 0 || isSaving}
          >
            Clear Overrides
          </button>
        </div>
        <button
          className="settings-btn settings-btn-primary metadata-panel-save-btn"
          onClick={() => {
            try {
              handleBuildChanges()
              setValidationError(null)
              setShowDiffModal(true)
            } catch (error) {
              setValidationError(toErrorMessage(error, 'Validation failed.'))
            }
          }}
          disabled={isSaving || selectedCount === 0 || !hasDirtyFields}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {isSaving && saveProgress && (
        <div className="metadata-save-progress metadata-panel-progress">
          <div
            className="metadata-save-progress-bar"
            style={{ width: `${(saveProgress.current / saveProgress.total) * 100}%` }}
          />
          <span>{saveProgress.current}/{saveProgress.total}</span>
        </div>
      )}

      <div className="metadata-panel-body">
        {isTracksLoading ? (
          <div className="metadata-panel-empty">Loading selected tracks...</div>
        ) : selectedCount === 0 ? (
          <div className="metadata-panel-empty">No editable local tracks selected.</div>
        ) : (
          <>
            <div className={`metadata-artwork-section ${overriddenFieldSet.has('artworkHash') ? 'metadata-artwork-section-overridden' : ''}`}>
              <div className="metadata-artwork-preview">
                {artworkDraft.mode === 'replace' && artworkDraftPreview ? (
                  <img
                    src={artworkDraftPreview}
                    alt="Selected artwork preview"
                    className="metadata-artwork-thumbnail"
                  />
                ) : artworkDraft.mode === 'replace' ? (
                  <div className="metadata-artwork-remove-preview">
                    <span className="metadata-artwork-mixed-label">Loading preview...</span>
                  </div>
                ) : artworkDraft.mode === 'remove' ? (
                  <div className="metadata-artwork-remove-preview">
                    <span className="metadata-artwork-mixed-label">Cover will be removed</span>
                  </div>
                ) : artworkState.mixed ? (
                  <div className="metadata-artwork-stacked">
                    <div className="metadata-artwork-stack-card" />
                    <div className="metadata-artwork-stack-card" />
                    <div className="metadata-artwork-stack-front">
                      <span className="metadata-artwork-mixed-label">Multiple covers</span>
                    </div>
                  </div>
                ) : (
                  <AlbumArtwork
                    hash={artworkState.hash}
                    alt="Selected track artwork"
                    className="metadata-artwork-thumbnail"
                  />
                )}

                <div className="metadata-artwork-overlay">
                  <button
                    type="button"
                    className={`metadata-artwork-icon-btn ${artworkDraft.mode === 'replace' ? 'active' : ''}`}
                    onClick={() => void handleChooseArtwork()}
                    disabled={selectedCount === 0 || isSaving}
                    aria-label="Choose cover image"
                    title={artworkDraft.mode === 'replace' ? 'Change cover image' : 'Choose cover image'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <path d="m18 2 4 4-10 10H8v-4L18 2z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={`metadata-artwork-icon-btn ${artworkDraft.mode === 'remove' ? 'active danger' : ''}`}
                    onClick={handleRemoveArtwork}
                    disabled={selectedCount === 0 || isSaving}
                    aria-label={artworkDraft.mode === 'remove' ? 'Keep current cover' : 'Remove cover'}
                    title={artworkDraft.mode === 'remove' ? 'Keep current cover' : 'Remove cover'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M5 19 19 5" />
                    </svg>
                  </button>
                </div>
              </div>
              {artworkDraft.mode === 'replace' && (
                <div className="metadata-artwork-selected-file" title={artworkDraft.imagePath}>
                  {getFileNameFromPath(artworkDraft.imagePath)}
                </div>
              )}
            </div>

            <div className="metadata-form-grid metadata-panel-form-grid">
              <label className={`metadata-field ${overriddenFieldSet.has('title') ? 'metadata-field-overridden' : ''}`}>
                <span>Title</span>
                <input
                  className="settings-select"
                  type="text"
                  value={draft.title.value}
                  onChange={(event) => updateDraftField('title', event.target.value)}
                  placeholder={selectionCommon.title.mixed ? 'Mixed values' : ''}
                  disabled={selectedCount === 0}
                />
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('artist') ? 'metadata-field-overridden' : ''}`}>
                <span>Artist</span>
                <input
                  className="settings-select"
                  type="text"
                  value={draft.artist.value}
                  onChange={(event) => updateDraftField('artist', event.target.value)}
                  placeholder={selectionCommon.artist.mixed ? 'Mixed values' : ''}
                  disabled={selectedCount === 0}
                />
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('album') ? 'metadata-field-overridden' : ''}`}>
                <span>Album</span>
                <input
                  className="settings-select"
                  type="text"
                  value={draft.album.value}
                  onChange={(event) => updateDraftField('album', event.target.value)}
                  placeholder={selectionCommon.album.mixed ? 'Mixed values' : ''}
                  disabled={selectedCount === 0}
                />
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('albumArtist') ? 'metadata-field-overridden' : ''}`}>
                <span>Album Artist</span>
                <div className="metadata-field-inline">
                  <input
                    className="settings-select"
                    type="text"
                    value={draft.albumArtist.value}
                    onChange={(event) => updateDraftField('albumArtist', event.target.value)}
                    placeholder={selectionCommon.albumArtist.mixed ? 'Mixed values' : ''}
                    disabled={selectedCount === 0}
                  />
                  <button
                    type="button"
                    className="settings-btn metadata-clear-btn"
                    onClick={() => updateDraftField('albumArtist', '')}
                    disabled={selectedCount === 0 || isSaving}
                  >
                    Clear
                  </button>
                </div>
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('genre') ? 'metadata-field-overridden' : ''}`}>
                <span>Genre</span>
                <div className="metadata-field-inline">
                  <input
                    className="settings-select"
                    type="text"
                    value={draft.genre.value}
                    onChange={(event) => updateDraftField('genre', event.target.value)}
                    placeholder={selectionCommon.genre.mixed ? 'Mixed values' : ''}
                    disabled={selectedCount === 0}
                  />
                  <button
                    type="button"
                    className="settings-btn metadata-clear-btn"
                    onClick={() => updateDraftField('genre', '')}
                    disabled={selectedCount === 0 || isSaving}
                  >
                    Clear
                  </button>
                </div>
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('year') ? 'metadata-field-overridden' : ''}`}>
                <span>Year</span>
                <div className="metadata-field-inline">
                  <input
                    className="settings-select"
                    type="text"
                    inputMode="numeric"
                    value={draft.year.value}
                    onChange={(event) => updateDraftField('year', event.target.value)}
                    placeholder={selectionCommon.year.mixed ? 'Mixed values' : ''}
                    disabled={selectedCount === 0}
                  />
                  <button
                    type="button"
                    className="settings-btn metadata-clear-btn"
                    onClick={() => updateDraftField('year', '')}
                    disabled={selectedCount === 0 || isSaving}
                  >
                    Clear
                  </button>
                </div>
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('trackNumber') ? 'metadata-field-overridden' : ''}`}>
                <span>Track #</span>
                <div className="metadata-field-inline">
                  <input
                    className="settings-select"
                    type="text"
                    inputMode="numeric"
                    value={draft.trackNumber.value}
                    onChange={(event) => updateDraftField('trackNumber', event.target.value)}
                    placeholder={selectionCommon.trackNumber.mixed ? 'Mixed values' : ''}
                    disabled={selectedCount === 0}
                  />
                  <button
                    type="button"
                    className="settings-btn metadata-clear-btn"
                    onClick={() => updateDraftField('trackNumber', '')}
                    disabled={selectedCount === 0 || isSaving}
                  >
                    Clear
                  </button>
                </div>
              </label>

              <label className={`metadata-field ${overriddenFieldSet.has('discNumber') ? 'metadata-field-overridden' : ''}`}>
                <span>Disc #</span>
                <div className="metadata-field-inline">
                  <input
                    className="settings-select"
                    type="text"
                    inputMode="numeric"
                    value={draft.discNumber.value}
                    onChange={(event) => updateDraftField('discNumber', event.target.value)}
                    placeholder={selectionCommon.discNumber.mixed ? 'Mixed values' : ''}
                    disabled={selectedCount === 0}
                  />
                  <button
                    type="button"
                    className="settings-btn metadata-clear-btn"
                    onClick={() => updateDraftField('discNumber', '')}
                    disabled={selectedCount === 0 || isSaving}
                  >
                    Clear
                  </button>
                </div>
              </label>
            </div>
          </>
        )}

        {skippedRemoteCount > 0 && (
          <div className="metadata-footnote">
            {skippedRemoteCount} remote track{skippedRemoteCount === 1 ? '' : 's'} skipped. Remote metadata editing is not supported.
          </div>
        )}
        {validationError && (
          <div className="metadata-status metadata-status-error">{validationError}</div>
        )}
        {statusMessage && (
          <div className="metadata-status metadata-status-success">{statusMessage}</div>
        )}

        {lastResult && (
          <div className="metadata-result">
            <div className="metadata-result-title">
              {lastResult.mode === 'file' ? 'File write result' : 'Virtual save result'}
            </div>
            <div className="metadata-result-summary">
              Requested: {lastResult.requested} · Succeeded: {lastResult.succeeded} · Failed: {lastResult.failed}
            </div>
            {lastResult.failed > 0 && (
              <>
                <button
                  className="settings-btn metadata-result-toggle"
                  onClick={() => setShowFailureDetails((value) => !value)}
                >
                  {showFailureDetails ? 'Hide failures' : 'Show failures'}
                </button>
                {showFailureDetails && (
                  <ul className="metadata-failure-list">
                    {lastResult.failures.map((failure) => (
                      <li key={`${failure.trackPath}-${failure.message}`}>
                        <code>{failure.trackPath}</code>
                        <span>{failure.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div className="metadata-footnote">Default mode: {defaultSaveMode === 'file' ? 'Write file tags' : 'Virtual (DB override)'}</div>
      </div>

      <DiffConfirmModal
        isOpen={showDiffModal}
        mode={saveMode}
        trackCount={selectedCount}
        diffs={diffEntries}
        onConfirm={() => {
          setShowDiffModal(false)
          void handleSave()
        }}
        onCancel={() => setShowDiffModal(false)}
      />
    </aside>
  )
}
