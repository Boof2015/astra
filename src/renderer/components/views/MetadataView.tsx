import { CSSProperties, memo, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps } from 'react-window'
import { useLibraryStore } from '../../stores/libraryStore'
import { useMetadataEditorStore, type MetadataEditChanges } from '../../stores/metadataEditorStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePlayerStore } from '../../stores/playerStore'

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

type TrackRecord = {
  path: string
  title: string
  artist: string
  album: string
  album_artist: string | null
  genre: string | null
  year: number | null
  track_number: number | null
  disc_number: number | null
  format: string
}

interface MetadataRowSelectionOptions {
  shift: boolean
  additive: boolean
  fromCheckbox: boolean
}

interface MetadataTrackRowSharedProps {
  filteredTracks: TrackRecord[]
  selectedPaths: Set<string>
  overridePaths: Set<string>
  onRowSelection: (trackPath: string, rowIndex: number, options: MetadataRowSelectionOptions) => void
}

const METADATA_ROW_HEIGHT_FALLBACK_PX = 38
const METADATA_LIST_OVERSCAN_COUNT = 8

function resolveMetadataRowHeightPx(element: HTMLElement | null): number {
  if (!element) return METADATA_ROW_HEIGHT_FALLBACK_PX

  const cssValue = getComputedStyle(element).getPropertyValue('--metadata-row-height').trim()
  const parsed = Number.parseFloat(cssValue)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return METADATA_ROW_HEIGHT_FALLBACK_PX
}

function MetadataTrackRowRenderer({
  ariaAttributes,
  index,
  style,
  filteredTracks,
  selectedPaths,
  overridePaths,
  onRowSelection
}: RowComponentProps<MetadataTrackRowSharedProps>): ReactElement | null {
  const track = filteredTracks[index]
  if (!track) return null

  const isSelected = selectedPaths.has(track.path)
  const hasOverride = overridePaths.has(track.path)

  return (
    <div className="metadata-track-list-item" style={style as CSSProperties} {...ariaAttributes}>
      <div
        className={`metadata-track-row ${isSelected ? 'selected' : ''}`}
        onClick={(event) => {
          onRowSelection(track.path, index, {
            shift: event.shiftKey,
            additive: event.metaKey || event.ctrlKey,
            fromCheckbox: false
          })
        }}
      >
        <div className="metadata-track-cell metadata-track-cell-select">
          <input
            type="checkbox"
            checked={isSelected}
            onClick={(event) => {
              event.stopPropagation()
              event.preventDefault()
              onRowSelection(track.path, index, {
                shift: event.shiftKey,
                additive: event.metaKey || event.ctrlKey,
                fromCheckbox: true
              })
            }}
            onChange={() => undefined}
            aria-label={`Select ${track.title}`}
          />
        </div>
        <div className="metadata-track-cell metadata-track-cell-title metadata-col-title">{track.title}</div>
        <div className="metadata-track-cell metadata-track-cell-artist">{track.artist}</div>
        <div className="metadata-track-cell metadata-track-cell-album">{track.album}</div>
        <div className="metadata-track-cell metadata-track-cell-format">{track.format.toUpperCase()}</div>
        <div className="metadata-track-cell metadata-track-cell-override">
          {hasOverride ? <span className="metadata-override-badge">virtual</span> : <span className="metadata-override-badge muted">base</span>}
        </div>
      </div>
    </div>
  )
}

const MetadataTrackRow = memo(MetadataTrackRowRenderer) as (
  props: RowComponentProps<MetadataTrackRowSharedProps>
) => ReactElement | null

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

function getCommonString(values: Array<string | null>): CommonFieldState {
  if (values.length === 0) return { mixed: false, value: '' }
  const first = values[0] ?? ''
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? '') !== first) {
      return { mixed: true, value: '' }
    }
  }
  return { mixed: false, value: first }
}

function getCommonNumber(values: Array<number | null>): CommonFieldState {
  if (values.length === 0) return { mixed: false, value: '' }
  const first = values[0]
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== first) {
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

export default function MetadataView() {
  const loadLibrary = useLibraryStore((state) => state.loadLibrary)
  const [tracks, setTracks] = useState<TrackRecord[]>([])
  const [isTracksLoading, setIsTracksLoading] = useState(false)

  const playlistsSelectedId = usePlaylistStore((state) => state.selectedPlaylistId)
  const selectPlaylist = usePlaylistStore((state) => state.selectPlaylist)

  const {
    saveMode,
    defaultSaveMode,
    overridePaths,
    isSaving,
    lastResult,
    setSaveMode,
    setDefaultSaveMode,
    loadOverridePaths,
    clearOverrides,
    saveEdits,
    clearLastResult
  } = useMetadataEditorStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastSelectionIndex, setLastSelectionIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftState>(() => createDraftFromCommon(getSelectionCommonState([])))
  const [validationError, setValidationError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [showFailureDetails, setShowFailureDetails] = useState(false)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [metadataRowHeight, setMetadataRowHeight] = useState(METADATA_ROW_HEIGHT_FALLBACK_PX)

  const metadataListBodyRef = useRef<HTMLDivElement | null>(null)

  const reloadEditorTracks = useCallback(async (): Promise<TrackRecord[]> => {
    setIsTracksLoading(true)
    try {
      const allTracks = await window.electronAPI.library.getTracks()
      const nextTracks = allTracks as TrackRecord[]
      setTracks(nextTracks)
      return nextTracks
    } finally {
      setIsTracksLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.all([
      loadOverridePaths(),
      reloadEditorTracks()
    ])
  }, [loadOverridePaths, reloadEditorTracks])

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredTracks = useMemo(() => {
    const rows = tracks as TrackRecord[]
    if (!normalizedQuery) {
      return rows
    }

    return rows.filter((track) => {
      return (
        track.title.toLowerCase().includes(normalizedQuery)
        || track.artist.toLowerCase().includes(normalizedQuery)
        || track.album.toLowerCase().includes(normalizedQuery)
        || track.path.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [normalizedQuery, tracks])

  useLayoutEffect(() => {
    const element = metadataListBodyRef.current
    if (!element) return

    const updateMeasurements = () => {
      const nextHeight = Math.max(0, Math.round(element.clientHeight))
      const nextRowHeight = resolveMetadataRowHeightPx(element)

      setListViewportHeight((previous) => (previous === nextHeight ? previous : nextHeight))
      setMetadataRowHeight((previous) => (previous === nextRowHeight ? previous : nextRowHeight))
    }

    updateMeasurements()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateMeasurements)
      return () => {
        window.removeEventListener('resize', updateMeasurements)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      updateMeasurements()
    })
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    setLastSelectionIndex(null)
  }, [normalizedQuery])

  useEffect(() => {
    setSelectedPaths((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      for (const path of current) {
        if (tracks.some((track) => track.path === path)) {
          next.add(path)
        }
      }
      return next.size === current.size ? current : next
    })
  }, [tracks])

  const selectedTracks = useMemo(() => {
    const selected = new Set(selectedPaths)
    return tracks.filter((track) => selected.has(track.path))
  }, [selectedPaths, tracks])

  const selectionCommon = useMemo(() => getSelectionCommonState(selectedTracks), [selectedTracks])
  const selectionKey = useMemo(() => {
    return Array.from(selectedPaths).sort((a, b) => a.localeCompare(b)).join('\\u0000')
  }, [selectedPaths])

  useEffect(() => {
    setDraft(createDraftFromCommon(selectionCommon))
  }, [selectionCommon])

  useEffect(() => {
    setValidationError(null)
    setStatusMessage(null)
    clearLastResult()
    setShowFailureDetails(false)
  }, [clearLastResult, selectionKey])

  const allVisibleSelected = useMemo(() => {
    if (filteredTracks.length === 0) return false
    return filteredTracks.every((track) => selectedPaths.has(track.path))
  }, [filteredTracks, selectedPaths])

  const anyVisibleSelected = useMemo(() => {
    return filteredTracks.some((track) => selectedPaths.has(track.path))
  }, [filteredTracks, selectedPaths])

  const updateDraftField = useCallback((field: keyof DraftState, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: {
        value,
        dirty: true
      }
    }))
  }, [])

  const handleRowSelection = useCallback((trackPath: string, rowIndex: number, options: MetadataRowSelectionOptions) => {
    setSelectedPaths((current) => {
      const next = new Set(current)

      if (options.shift && lastSelectionIndex !== null) {
        const rangeStart = Math.min(lastSelectionIndex, rowIndex)
        const rangeEnd = Math.max(lastSelectionIndex, rowIndex)
        const rangePaths = filteredTracks.slice(rangeStart, rangeEnd + 1).map((track) => track.path)
        const shouldSelect = !current.has(trackPath)

        for (const path of rangePaths) {
          if (shouldSelect) {
            next.add(path)
          } else {
            next.delete(path)
          }
        }
        return next
      }

      if (options.additive || options.fromCheckbox) {
        if (next.has(trackPath)) {
          next.delete(trackPath)
        } else {
          next.add(trackPath)
        }
        return next
      }

      return new Set([trackPath])
    })

    setLastSelectionIndex(rowIndex)
  }, [filteredTracks, lastSelectionIndex])

  const handleToggleAllVisible = useCallback(() => {
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        for (const track of filteredTracks) {
          next.delete(track.path)
        }
      } else {
        for (const track of filteredTracks) {
          next.add(track.path)
        }
      }
      return next
    })
  }, [allVisibleSelected, filteredTracks])

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

    if (Object.keys(changes).length === 0) {
      throw new Error('No changes to save.')
    }

    return changes
  }, [draft])

  const refreshAfterMutation = useCallback(async (updatedTrackPaths: string[]) => {
    await loadLibrary()
    const refreshedTracks = await reloadEditorTracks()

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
          album: refreshed.album,
          albumArtist: refreshed.album_artist ?? undefined,
          genre: refreshed.genre ?? undefined,
          year: refreshed.year ?? undefined,
          trackNumber: refreshed.track_number ?? undefined,
          discNumber: refreshed.disc_number ?? undefined
        }
      }
    })
  }, [loadLibrary, playlistsSelectedId, reloadEditorTracks, selectPlaylist])

  const handleSave = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)

    try {
      const changes = handleBuildChanges()
      const result = await saveEdits({
        mode: saveMode,
        trackPaths: Array.from(selectedPaths),
        changes
      })

      await refreshAfterMutation(result.updatedTrackPaths)
      if (result.failed === 0) {
        setStatusMessage(`Saved metadata for ${result.succeeded}/${result.requested} tracks.`)
      } else {
        setStatusMessage(`Saved ${result.succeeded}/${result.requested}. ${result.failed} failed.`)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save metadata edits.'
      setValidationError(message)
    }
  }, [handleBuildChanges, refreshAfterMutation, saveEdits, saveMode, selectedPaths])

  const handleClearOverrides = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)

    try {
      const trackPaths = Array.from(selectedPaths)
      if (trackPaths.length === 0) {
        throw new Error('Select at least one track to clear overrides.')
      }
      const result = await clearOverrides(trackPaths)
      await refreshAfterMutation(trackPaths)
      setStatusMessage(`Cleared overrides for ${result.cleared} tracks.`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to clear metadata overrides.'
      setValidationError(message)
    }
  }, [clearOverrides, refreshAfterMutation, selectedPaths])

  const hasDirtyFields = useMemo(() => {
    return Object.values(draft).some((field) => field.dirty)
  }, [draft])

  const selectedCount = selectedPaths.size
  const metadataRowProps = useMemo<MetadataTrackRowSharedProps>(() => ({
    filteredTracks,
    selectedPaths,
    overridePaths,
    onRowSelection: handleRowSelection
  }), [filteredTracks, selectedPaths, overridePaths, handleRowSelection])
  const metadataListHeight = listViewportHeight > 0 ? listViewportHeight : metadataRowHeight

  return (
    <div className="metadata-view">
      <div className="metadata-header">
        <div className="metadata-header-left">
          <h2>Metadata Editor</h2>
          <span className="track-count">
            {selectedCount} selected · {tracks.length} tracks
          </span>
        </div>

        <div className="metadata-save-controls">
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

          <button
            className="settings-btn settings-btn-primary"
            onClick={() => void handleSave()}
            disabled={isSaving || selectedCount === 0 || !hasDirtyFields}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="metadata-subheader">
        <div className="search-container metadata-search">
          <span className="search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            type="text"
            className="search-input"
            placeholder="Search tracks..."
            aria-label="Search tracks"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              className="search-clear-btn"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setSearchQuery('')}
            >
              ×
            </button>
          )}
        </div>

        <button
          className="settings-btn"
          onClick={() => void handleClearOverrides()}
          disabled={selectedCount === 0 || isSaving}
        >
          Clear Overrides
        </button>
      </div>

      <div className="metadata-body">
        <div className="metadata-track-list">
          <div className="metadata-track-list-header">
            <div className="metadata-track-cell metadata-track-cell-select">
              <input
                type="checkbox"
                checked={allVisibleSelected && filteredTracks.length > 0}
                ref={(element) => {
                  if (element) {
                    element.indeterminate = anyVisibleSelected && !allVisibleSelected
                  }
                }}
                onChange={handleToggleAllVisible}
                aria-label="Toggle all visible tracks"
              />
            </div>
            <div className="metadata-track-cell metadata-track-cell-title">Title</div>
            <div className="metadata-track-cell metadata-track-cell-artist">Artist</div>
            <div className="metadata-track-cell metadata-track-cell-album">Album</div>
            <div className="metadata-track-cell metadata-track-cell-format">Fmt</div>
            <div className="metadata-track-cell metadata-track-cell-override">Override</div>
          </div>
          <div className="metadata-track-list-body" ref={metadataListBodyRef}>
            {filteredTracks.length === 0 ? (
              <div className="metadata-track-list-empty">
                <div className="metadata-empty-cell">No tracks match your search.</div>
              </div>
            ) : (
              <List
                className="metadata-track-list-virtualized"
                defaultHeight={METADATA_ROW_HEIGHT_FALLBACK_PX * 8}
                overscanCount={METADATA_LIST_OVERSCAN_COUNT}
                rowComponent={MetadataTrackRow}
                rowCount={filteredTracks.length}
                rowHeight={metadataRowHeight}
                rowProps={metadataRowProps}
                style={{ height: metadataListHeight, width: '100%' }}
              />
            )}
          </div>
        </div>

        <div className="metadata-form-panel">
          <div className="metadata-form-grid">
            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

            <label className="metadata-field">
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

          {isTracksLoading && <div className="metadata-footnote">Refreshing library…</div>}
          <div className="metadata-footnote">Default mode: {defaultSaveMode === 'file' ? 'Write file tags' : 'Virtual (DB override)'}</div>
        </div>
      </div>
    </div>
  )
}
