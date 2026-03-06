import { CSSProperties, memo, ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps } from 'react-window'
import AlbumArtwork from '../library/AlbumArtwork'
import DiffConfirmModal, { type DiffEntry } from '../metadata/DiffConfirmModal'
import { useLibraryStore } from '../../stores/libraryStore'
import { useMetadataEditorStore, type MetadataEditChanges } from '../../stores/metadataEditorStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import type { LyricsTrackOverride } from '../../../types/lyrics'

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
  artwork_hash: string | null
  source_type?: 'local' | 'subsonic' | 'jellyfin'
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

interface ReorderRowProps {
  track: TrackRecord
  index: number
  newTrackNumber: number
  isDragging: boolean
  isDropTarget: boolean
  onDragStart: (index: number) => void
  onDragOver: (index: number) => void
  onDragEnd: () => void
}

function ReorderRow({ track, index, newTrackNumber, isDragging, isDropTarget, onDragStart, onDragOver, onDragEnd }: ReorderRowProps) {
  return (
    <div
      className={`metadata-reorder-row ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(index)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOver(index)
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDragEnd()
      }}
      onDragEnd={onDragEnd}
    >
      <div className="metadata-drag-handle" aria-label="Drag to reorder">
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="3" cy="2" r="1.2" />
          <circle cx="7" cy="2" r="1.2" />
          <circle cx="3" cy="6" r="1.2" />
          <circle cx="7" cy="6" r="1.2" />
          <circle cx="3" cy="10" r="1.2" />
          <circle cx="7" cy="10" r="1.2" />
          <circle cx="3" cy="14" r="1.2" />
          <circle cx="7" cy="14" r="1.2" />
        </svg>
      </div>
      <div className="metadata-reorder-number">{newTrackNumber}</div>
      <div className="metadata-reorder-title">{track.title}</div>
      <div className="metadata-reorder-artist">{track.artist}</div>
    </div>
  )
}

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

function getCommonArtworkHash(tracks: TrackRecord[]): { hash: string | null; mixed: boolean } {
  if (tracks.length === 0) return { hash: null, mixed: false }
  const first = tracks[0].artwork_hash
  for (let i = 1; i < tracks.length; i += 1) {
    if (tracks[i].artwork_hash !== first) return { hash: null, mixed: true }
  }
  return { hash: first, mixed: false }
}

function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || filePath
}

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

function buildLyricsQueryForCurrentTrack() {
  const currentTrack = usePlayerStore.getState().currentTrack
  if (!currentTrack) return null
  return {
    path: currentTrack.path,
    title: currentTrack.title,
    artist: currentTrack.artist,
    album: currentTrack.album || undefined,
    durationSeconds: Number.isFinite(currentTrack.duration) ? currentTrack.duration : undefined
  }
}

export default function MetadataView() {
  const loadLibrary = useLibraryStore((state) => state.loadLibrary)
  const [tracks, setTracks] = useState<TrackRecord[]>([])
  const [isTracksLoading, setIsTracksLoading] = useState(false)
  const [excludedRemoteTrackCount, setExcludedRemoteTrackCount] = useState(0)

  const playlistsSelectedId = usePlaylistStore((state) => state.selectedPlaylistId)
  const selectPlaylist = usePlaylistStore((state) => state.selectPlaylist)
  const refreshLyricsForTrack = useLyricsStore((state) => state.refreshForTrack)

  const {
    saveMode,
    defaultSaveMode,
    overridePaths,
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
    redo
  } = useMetadataEditorStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastSelectionIndex, setLastSelectionIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftState>(() => createDraftFromCommon(getSelectionCommonState([])))
  const [artworkDraft, setArtworkDraft] = useState<ArtworkDraft>({ mode: 'unchanged' })
  const [artworkDraftPreview, setArtworkDraftPreview] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [showFailureDetails, setShowFailureDetails] = useState(false)
  const [listViewportHeight, setListViewportHeight] = useState(0)
  const [metadataRowHeight, setMetadataRowHeight] = useState(METADATA_ROW_HEIGHT_FALLBACK_PX)
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number } | null>(null)
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string[]>>({})
  const [showDiffModal, setShowDiffModal] = useState(false)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [reorderedTracks, setReorderedTracks] = useState<TrackRecord[] | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [lyricsOverrides, setLyricsOverrides] = useState<Record<string, LyricsTrackOverride>>({})
  const [isLyricsStateLoading, setIsLyricsStateLoading] = useState(false)
  const [isLyricsActionRunning, setIsLyricsActionRunning] = useState(false)
  const [lyricsOffsetDraft, setLyricsOffsetDraft] = useState('0')
  const [lyricsOffsetMixed, setLyricsOffsetMixed] = useState(false)
  const [lyricsStatusMessage, setLyricsStatusMessage] = useState<string | null>(null)
  const [lyricsValidationError, setLyricsValidationError] = useState<string | null>(null)

  const metadataListBodyRef = useRef<HTMLDivElement | null>(null)

  const reloadEditorTracks = useCallback(async (): Promise<TrackRecord[]> => {
    setIsTracksLoading(true)
    try {
      const allTracks = await window.electronAPI.library.getTracks()
      const nextTracks = (allTracks as TrackRecord[]).filter((track) => (track.source_type ?? 'local') === 'local')
      setExcludedRemoteTrackCount(Math.max(0, (allTracks as TrackRecord[]).length - nextTracks.length))
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
  const artworkState = useMemo(() => getCommonArtworkHash(selectedTracks), [selectedTracks])
  const selectionKey = useMemo(() => {
    return Array.from(selectedPaths).sort((a, b) => a.localeCompare(b)).join('\\u0000')
  }, [selectedPaths])
  const selectedTrackPaths = useMemo(() => Array.from(selectedPaths), [selectedPaths])

  const refreshLyricsForActiveTrack = useCallback(async (affectedTrackPaths: string[]) => {
    if (affectedTrackPaths.length === 0) return
    const lyricsQuery = buildLyricsQueryForCurrentTrack()
    if (!lyricsQuery || !affectedTrackPaths.includes(lyricsQuery.path)) return
    await refreshLyricsForTrack(lyricsQuery)
  }, [refreshLyricsForTrack])

  const loadLyricsOverrideState = useCallback(async (trackPaths: string[]) => {
    if (trackPaths.length === 0) {
      setLyricsOverrides({})
      setLyricsOffsetMixed(false)
      setLyricsOffsetDraft('0')
      return
    }

    const overrides = await Promise.all(
      trackPaths.map((trackPath) => window.electronAPI.lyrics.getTrackOverride(trackPath))
    )

    const nextOverrides: Record<string, LyricsTrackOverride> = {}
    for (const override of overrides) {
      nextOverrides[override.trackPath] = override
    }
    setLyricsOverrides(nextOverrides)

    if (overrides.length === 0) {
      setLyricsOffsetMixed(false)
      setLyricsOffsetDraft('0')
      return
    }

    const firstOffset = overrides[0].syncOffsetMs
    const mixed = overrides.some((override) => override.syncOffsetMs !== firstOffset)
    setLyricsOffsetMixed(mixed)
    setLyricsOffsetDraft(mixed ? '' : String(firstOffset))
  }, [])

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
    setLyricsValidationError(null)
    setLyricsStatusMessage(null)
  }, [selectionKey])

  useEffect(() => {
    const paths = Array.from(selectedPaths)
    if (paths.length === 0) {
      setFieldOverrides({})
      return
    }
    void window.electronAPI.library.getTrackOverrideFields(paths).then(setFieldOverrides)
  }, [selectionKey])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setIsLyricsStateLoading(true)
      try {
        await loadLyricsOverrideState(selectedTrackPaths)
      } catch (error) {
        if (cancelled) return
        setLyricsValidationError(toErrorMessage(error, 'Failed to load lyrics override state.'))
      } finally {
        if (cancelled) return
        setIsLyricsStateLoading(false)
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [loadLyricsOverrideState, selectedTrackPaths])

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

  const handleImportLyricsFile = useCallback(async () => {
    if (selectedTrackPaths.length === 0) {
      setLyricsValidationError('Select at least one track to import lyrics.')
      return
    }

    setLyricsValidationError(null)
    setLyricsStatusMessage(null)

    const filePath = await window.electronAPI.openFileDialog({
      title: 'Import lyrics file',
      filters: [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }]
    })
    if (!filePath) return

    setIsLyricsActionRunning(true)
    try {
      const lyricsText = await window.electronAPI.readTextFile(filePath)
      const result = await window.electronAPI.lyrics.importManualLyrics(selectedTrackPaths, lyricsText)
      await loadLyricsOverrideState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)

      const importedMode = result.hasSyncedLyrics ? 'synced' : 'plain'
      setLyricsStatusMessage(`Imported ${importedMode} manual lyrics for ${result.updated} track${result.updated === 1 ? '' : 's'}.`)
    } catch (error) {
      setLyricsValidationError(toErrorMessage(error, 'Failed to import manual lyrics.'))
    } finally {
      setIsLyricsActionRunning(false)
    }
  }, [loadLyricsOverrideState, refreshLyricsForActiveTrack, selectedTrackPaths])

  const handleClearManualLyrics = useCallback(async () => {
    if (selectedTrackPaths.length === 0) {
      setLyricsValidationError('Select at least one track to clear manual lyrics.')
      return
    }

    setLyricsValidationError(null)
    setLyricsStatusMessage(null)
    setIsLyricsActionRunning(true)

    try {
      const result = await window.electronAPI.lyrics.clearManualLyrics(selectedTrackPaths)
      await loadLyricsOverrideState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)

      if (result.cleared === 0) {
        setLyricsStatusMessage('No manual lyrics were set on the selected tracks.')
      } else {
        setLyricsStatusMessage(`Cleared manual lyrics for ${result.cleared} track${result.cleared === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setLyricsValidationError(toErrorMessage(error, 'Failed to clear manual lyrics.'))
    } finally {
      setIsLyricsActionRunning(false)
    }
  }, [loadLyricsOverrideState, refreshLyricsForActiveTrack, selectedTrackPaths])

  const handleApplyLyricsOffset = useCallback(async () => {
    if (selectedTrackPaths.length === 0) {
      setLyricsValidationError('Select at least one track before applying sync offset.')
      return
    }

    const normalizedOffsetText = lyricsOffsetDraft.trim()
    if (!/^-?\d+$/.test(normalizedOffsetText)) {
      setLyricsValidationError('Sync offset must be an integer in milliseconds.')
      return
    }

    const offsetMs = Number.parseInt(normalizedOffsetText, 10)
    if (!Number.isFinite(offsetMs)) {
      setLyricsValidationError('Sync offset must be an integer in milliseconds.')
      return
    }

    setLyricsValidationError(null)
    setLyricsStatusMessage(null)
    setIsLyricsActionRunning(true)
    try {
      const result = await window.electronAPI.lyrics.setTrackOffset(selectedTrackPaths, offsetMs)
      await loadLyricsOverrideState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)
      const signedOffset = result.offsetMs > 0 ? `+${result.offsetMs}` : String(result.offsetMs)
      if (result.updated === 0) {
        setLyricsStatusMessage('Selected tracks already use this sync offset.')
      } else {
        setLyricsStatusMessage(`Applied ${signedOffset} ms sync offset to ${result.updated} track${result.updated === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setLyricsValidationError(toErrorMessage(error, 'Failed to apply sync offset.'))
    } finally {
      setIsLyricsActionRunning(false)
    }
  }, [loadLyricsOverrideState, lyricsOffsetDraft, refreshLyricsForActiveTrack, selectedTrackPaths])

  const handleResetLyricsOffset = useCallback(async () => {
    if (selectedTrackPaths.length === 0) {
      setLyricsValidationError('Select at least one track before resetting sync offset.')
      return
    }

    setLyricsValidationError(null)
    setLyricsStatusMessage(null)
    setIsLyricsActionRunning(true)
    try {
      const result = await window.electronAPI.lyrics.setTrackOffset(selectedTrackPaths, 0)
      await loadLyricsOverrideState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)
      if (result.updated === 0) {
        setLyricsStatusMessage('Sync offset was already reset for the selected tracks.')
      } else {
        setLyricsStatusMessage(`Reset sync offset for ${result.updated} track${result.updated === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setLyricsValidationError(toErrorMessage(error, 'Failed to reset sync offset.'))
    } finally {
      setIsLyricsActionRunning(false)
    }
  }, [loadLyricsOverrideState, refreshLyricsForActiveTrack, selectedTrackPaths])

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
          discNumber: refreshed.disc_number ?? undefined,
          artworkHash: refreshed.artwork_hash ?? undefined,
          artworkData: undefined
        }
      }
    })
  }, [loadLibrary, playlistsSelectedId, reloadEditorTracks, selectPlaylist])

  const handleSave = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)
    setSaveProgress(null)

    const unsubscribe = window.electronAPI.library.onMetadataEditProgress((progress) => {
      setSaveProgress({ current: progress.current, total: progress.total })
    })

    try {
      const changes = handleBuildChanges()
      const result = await saveEdits({
        mode: saveMode,
        trackPaths: Array.from(selectedPaths),
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
      const message = error instanceof Error ? error.message : 'Failed to save metadata edits.'
      setValidationError(message)
    } finally {
      unsubscribe()
      setSaveProgress(null)
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

  const handleReorderDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleReorderDragOver = useCallback((index: number) => {
    setDropIndex(index)
  }, [])

  const handleReorderDragEnd = useCallback(() => {
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex || !reorderedTracks) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }

    const updated = [...reorderedTracks]
    const [moved] = updated.splice(dragIndex, 1)
    updated.splice(dropIndex, 0, moved)
    setReorderedTracks(updated)
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex, dropIndex, reorderedTracks])

  const handleReorderSave = useCallback(async () => {
    if (!reorderedTracks || reorderedTracks.length === 0) return

    setValidationError(null)
    setStatusMessage(null)
    setSaveProgress(null)

    const unsubscribe = window.electronAPI.library.onMetadataEditProgress((progress) => {
      setSaveProgress({ current: progress.current, total: progress.total })
    })

    try {
      const allPaths: string[] = []
      for (let i = 0; i < reorderedTracks.length; i += 1) {
        const track = reorderedTracks[i]
        const result = await saveEdits({
          mode: saveMode,
          trackPaths: [track.path],
          changes: { trackNumber: i + 1 }
        })
        allPaths.push(...result.updatedTrackPaths)
      }

      await refreshAfterMutation(allPaths)
      setStatusMessage(`Reordered ${allPaths.length} tracks in album.`)
      setIsReorderMode(false)
      setReorderedTracks(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save track order.'
      setValidationError(message)
    } finally {
      unsubscribe()
      setSaveProgress(null)
    }
  }, [reorderedTracks, saveEdits, saveMode, refreshAfterMutation])

  const handleUndo = useCallback(async () => {
    const affectedPaths = await undo()
    if (affectedPaths.length > 0) {
      await refreshAfterMutation(affectedPaths)
      setStatusMessage(`Undid changes for ${affectedPaths.length} track(s).`)
    }
  }, [undo, refreshAfterMutation])

  const handleRedo = useCallback(async () => {
    const affectedPaths = await redo()
    if (affectedPaths.length > 0) {
      await refreshAfterMutation(affectedPaths)
      setStatusMessage(`Redid changes for ${affectedPaths.length} track(s).`)
    }
  }, [redo, refreshAfterMutation])

  const hasDirtyFields = useMemo(() => {
    return Object.values(draft).some((field) => field.dirty) || artworkDraft.mode !== 'unchanged'
  }, [artworkDraft.mode, draft])

  const reorderAlbum = useMemo(() => {
    if (selectedTracks.length === 0) return null
    const album = selectedTracks[0].album
    if (!selectedTracks.every((t) => t.album === album)) return null
    return album
  }, [selectedTracks])

  const canReorder = reorderAlbum !== null

  const albumTracksForReorder = useMemo(() => {
    if (!reorderAlbum) return []
    return tracks
      .filter((t) => t.album === reorderAlbum)
      .sort((a, b) => (a.disc_number ?? 0) - (b.disc_number ?? 0) || (a.track_number ?? 0) - (b.track_number ?? 0))
  }, [reorderAlbum, tracks])

  useEffect(() => {
    if (!canReorder && isReorderMode) {
      setIsReorderMode(false)
      setReorderedTracks(null)
    }
  }, [canReorder, isReorderMode])

  useEffect(() => {
    if (isReorderMode) {
      setReorderedTracks([...albumTracksForReorder])
    } else {
      setReorderedTracks(null)
    }
  }, [isReorderMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const overriddenFieldSet = useMemo(() => {
    const set = new Set<string>()
    for (const fields of Object.values(fieldOverrides)) {
      for (const f of fields) set.add(f)
    }
    return set
  }, [fieldOverrides])

  const selectedCount = selectedPaths.size
  const manualLyricsCount = useMemo(() => {
    if (selectedTrackPaths.length === 0) return 0
    let count = 0
    for (const trackPath of selectedTrackPaths) {
      if (lyricsOverrides[trackPath]?.hasManualLyrics) {
        count += 1
      }
    }
    return count
  }, [lyricsOverrides, selectedTrackPaths])
  const lyricsControlsDisabled = selectedCount === 0 || isSaving || isLyricsActionRunning || isLyricsStateLoading
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
            onClick={() => {
              try {
                handleBuildChanges()
                setValidationError(null)
                setShowDiffModal(true)
              } catch (error) {
                setValidationError(error instanceof Error ? error.message : 'Validation failed.')
              }
            }}
            disabled={isSaving || selectedCount === 0 || !hasDirtyFields}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
          {isSaving && saveProgress && (
            <div className="metadata-save-progress">
              <div
                className="metadata-save-progress-bar"
                style={{ width: `${(saveProgress.current / saveProgress.total) * 100}%` }}
              />
              <span>{saveProgress.current}/{saveProgress.total}</span>
            </div>
          )}
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
            data-shortcut-search="true"
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

        <div className="metadata-subheader-actions">
          <button
            className="settings-btn"
            onClick={() => void handleUndo()}
            disabled={undoStack.length === 0 || isSaving}
            title="Undo last virtual save"
          >
            Undo
          </button>
          <button
            className="settings-btn"
            onClick={() => void handleRedo()}
            disabled={redoStack.length === 0 || isSaving}
            title="Redo"
          >
            Redo
          </button>
          {canReorder && (
            <button
              className={`settings-btn ${isReorderMode ? 'settings-btn-primary' : ''}`}
              onClick={() => setIsReorderMode(!isReorderMode)}
              disabled={isSaving}
            >
              {isReorderMode ? 'Exit Reorder' : 'Reorder Tracks'}
            </button>
          )}
          <button
            className="settings-btn"
            onClick={() => void handleClearOverrides()}
            disabled={selectedCount === 0 || isSaving}
          >
            Clear Overrides
          </button>
        </div>
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
            {isReorderMode && reorderedTracks ? (
              <div className="metadata-reorder-list">
                {reorderedTracks.map((track, index) => (
                  <ReorderRow
                    key={track.path}
                    track={track}
                    index={index}
                    newTrackNumber={index + 1}
                    isDragging={dragIndex === index}
                    isDropTarget={dropIndex === index && dragIndex !== index}
                    onDragStart={handleReorderDragStart}
                    onDragOver={handleReorderDragOver}
                    onDragEnd={handleReorderDragEnd}
                  />
                ))}
                <div className="metadata-reorder-actions">
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={() => void handleReorderSave()}
                    disabled={isSaving}
                  >
                    {isSaving ? 'Saving...' : 'Apply Order'}
                  </button>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      setIsReorderMode(false)
                      setReorderedTracks(null)
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : filteredTracks.length === 0 ? (
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
          {selectedCount > 0 && (
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
          )}
          <div className="metadata-form-grid">
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

          <section className="metadata-lyrics-tools">
            <div className="metadata-lyrics-tools-header">
              <span>Lyrics Tools</span>
              <span className="metadata-lyrics-tools-summary">
                Manual lyrics: {manualLyricsCount}/{selectedCount || 0}
              </span>
            </div>

            <p className="metadata-lyrics-tools-note">
              Imported manual lyrics override embedded and LRCLIB results. Sync offset retimes synced lyrics from any source.
            </p>

            <div className="metadata-lyrics-tools-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={() => void handleImportLyricsFile()}
                disabled={lyricsControlsDisabled}
              >
                Import Lyrics File
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void handleClearManualLyrics()}
                disabled={lyricsControlsDisabled}
              >
                Clear Manual Lyrics
              </button>
            </div>

            <label className="metadata-field">
              <span>Sync Offset (ms)</span>
              <div className="metadata-field-inline">
                <input
                  className="settings-select"
                  type="text"
                  inputMode="numeric"
                  value={lyricsOffsetDraft}
                  onChange={(event) => setLyricsOffsetDraft(event.target.value)}
                  placeholder={lyricsOffsetMixed ? 'Mixed offsets' : '0'}
                  disabled={lyricsControlsDisabled}
                />
                <button
                  type="button"
                  className="settings-btn metadata-clear-btn"
                  onClick={() => void handleApplyLyricsOffset()}
                  disabled={lyricsControlsDisabled}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="settings-btn metadata-clear-btn"
                  onClick={() => void handleResetLyricsOffset()}
                  disabled={lyricsControlsDisabled}
                >
                  Reset
                </button>
              </div>
            </label>

            {isLyricsStateLoading && (
              <div className="metadata-footnote">Loading lyrics override state...</div>
            )}
            {lyricsValidationError && (
              <div className="metadata-status metadata-status-error">{lyricsValidationError}</div>
            )}
            {lyricsStatusMessage && (
              <div className="metadata-status metadata-status-success">{lyricsStatusMessage}</div>
            )}
          </section>

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
          {excludedRemoteTrackCount > 0 && (
            <div className="metadata-footnote">
              {excludedRemoteTrackCount} remote track{excludedRemoteTrackCount === 1 ? '' : 's'} hidden. Remote metadata editing is not supported.
            </div>
          )}
          <div className="metadata-footnote">Default mode: {defaultSaveMode === 'file' ? 'Write file tags' : 'Virtual (DB override)'}</div>
        </div>
      </div>

      <DiffConfirmModal
        isOpen={showDiffModal}
        mode={saveMode}
        trackCount={selectedCount}
        diffs={buildDiffEntries(draft, selectionCommon, artworkState, artworkDraft)}
        onConfirm={() => {
          setShowDiffModal(false)
          void handleSave()
        }}
        onCancel={() => setShowDiffModal(false)}
      />
    </div>
  )
}
