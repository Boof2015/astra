import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLyricsEditorStore } from '../../stores/lyricsEditorStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { LyricsFormat, LyricsTrackOverride } from '../../../types/lyrics'
import { usePresence } from '../../hooks/usePresence'

interface TrackRecord {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  source_type?: 'local' | 'subsonic' | 'jellyfin'
}

const EMPTY_TRACK_PATHS: string[] = []
const LYRICS_FILE_EXTENSIONS = new Set(['lrc', 'xlrc'])

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return fallback
}

function getFileExtension(fileName: string): string {
  const normalized = fileName.trim().toLocaleLowerCase()
  const dotIndex = normalized.lastIndexOf('.')
  return dotIndex >= 0 ? normalized.slice(dotIndex + 1) : ''
}

function inferLyricsFormat(fileName: string): LyricsFormat {
  return getFileExtension(fileName) === 'xlrc' ? 'xlrc' : 'lrc'
}

function getManualLyricsText(override: LyricsTrackOverride): string {
  if (!override.hasManualLyrics) return ''
  return override.syncedLyrics ?? override.plainLyrics ?? ''
}

function formatLyricsFormat(format: LyricsFormat): string {
  if (format === 'xlrc') return 'XLRC'
  if (format === 'lrc') return 'LRC'
  return 'Plain'
}

function formatSourceLabel(track: TrackRecord | null): string {
  if (!track) return ''
  if ((track.source_type ?? 'local') === 'jellyfin') return 'Jellyfin'
  if ((track.source_type ?? 'local') === 'subsonic') return 'Subsonic'
  return 'Local'
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

export default function LyricsEditorPanel() {
  const panelRequest = useLyricsEditorStore((state) => state.panelRequest)
  const closePanel = useLyricsEditorStore((state) => state.closePanel)
  const refreshLyricsForTrack = useLyricsStore((state) => state.refreshForTrack)
  const presence = usePresence(panelRequest)
  const displayedPanelRequest = presence.presentValue

  const requestTrackPaths = displayedPanelRequest?.trackPaths ?? EMPTY_TRACK_PATHS
  const requestTrackPathKey = requestTrackPaths.join('\u0000')

  const [tracks, setTracks] = useState<TrackRecord[]>([])
  const [overrides, setOverrides] = useState<Record<string, LyricsTrackOverride>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [isActionRunning, setIsActionRunning] = useState(false)
  const [isDropActive, setIsDropActive] = useState(false)
  const [lyricsTextDraft, setLyricsTextDraft] = useState('')
  const [lyricsTextDirty, setLyricsTextDirty] = useState(false)
  const [lyricsTextMixed, setLyricsTextMixed] = useState(false)
  const [formatDraft, setFormatDraft] = useState<LyricsFormat>('lrc')
  const [offsetDraft, setOffsetDraft] = useState('0')
  const [offsetDirty, setOffsetDirty] = useState(false)
  const [offsetMixed, setOffsetMixed] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  const selectedTrackPaths = requestTrackPaths
  const selectedCount = selectedTrackPaths.length
  const isSingleTrack = selectedCount === 1
  const primaryTrack = tracks[0] ?? null

  const manualLyricsCount = useMemo(() => {
    let count = 0
    for (const trackPath of selectedTrackPaths) {
      if (overrides[trackPath]?.hasManualLyrics) count += 1
    }
    return count
  }, [overrides, selectedTrackPaths])

  const syncedLyricsCount = useMemo(() => {
    let count = 0
    for (const trackPath of selectedTrackPaths) {
      const override = overrides[trackPath]
      if (override && override.hasManualLyrics && override.syncedLines.length > 0) count += 1
    }
    return count
  }, [overrides, selectedTrackPaths])

  const controlsDisabled = selectedCount === 0 || isLoading || isActionRunning

  const refreshLyricsForActiveTrack = useCallback(async (affectedTrackPaths: string[]) => {
    if (affectedTrackPaths.length === 0) return
    const lyricsQuery = buildLyricsQueryForCurrentTrack()
    if (!lyricsQuery || !affectedTrackPaths.includes(lyricsQuery.path)) return
    await refreshLyricsForTrack(lyricsQuery)
  }, [refreshLyricsForTrack])

  const loadPanelState = useCallback(async (trackPaths: string[]) => {
    if (trackPaths.length === 0) {
      setTracks([])
      setOverrides({})
      setLyricsTextDraft('')
      setLyricsTextDirty(false)
      setLyricsTextMixed(false)
      setFormatDraft('lrc')
      setOffsetDraft('0')
      setOffsetDirty(false)
      setOffsetMixed(false)
      return
    }

    const [nextTracks, nextOverrides] = await Promise.all([
      window.electronAPI.library.getTracksByPaths(trackPaths) as Promise<TrackRecord[]>,
      Promise.all(trackPaths.map((trackPath) => window.electronAPI.lyrics.getTrackOverride(trackPath)))
    ])

    const overridesByPath: Record<string, LyricsTrackOverride> = {}
    for (const override of nextOverrides) {
      overridesByPath[override.trackPath] = override
    }

    const firstOverride = nextOverrides[0]
    const firstText = firstOverride ? getManualLyricsText(firstOverride) : ''
    const textMixed = nextOverrides.some((override) => getManualLyricsText(override) !== firstText)
    const firstFormat = firstOverride?.format ?? 'lrc'
    const formatMixed = nextOverrides.some((override) => override.format !== firstFormat)
    const firstOffset = firstOverride?.syncOffsetMs ?? 0
    const nextOffsetMixed = nextOverrides.some((override) => override.syncOffsetMs !== firstOffset)

    setTracks(nextTracks)
    setOverrides(overridesByPath)
    setLyricsTextDraft(textMixed ? '' : firstText)
    setLyricsTextDirty(false)
    setLyricsTextMixed(textMixed)
    setFormatDraft(formatMixed ? 'lrc' : firstFormat)
    setOffsetMixed(nextOffsetMixed)
    setOffsetDraft(nextOffsetMixed ? '' : String(firstOffset))
    setOffsetDirty(false)
  }, [])

  useEffect(() => {
    if (!displayedPanelRequest) {
      setTracks([])
      setOverrides({})
      setValidationError(null)
      setStatusMessage(null)
      setIsDropActive(false)
      return
    }

    let cancelled = false
    const run = async () => {
      setIsLoading(true)
      setValidationError(null)
      setStatusMessage(null)
      try {
        await loadPanelState(requestTrackPaths)
      } catch (error) {
        if (cancelled) return
        setValidationError(toErrorMessage(error, 'Failed to load lyrics state.'))
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [displayedPanelRequest, loadPanelState, requestTrackPathKey, requestTrackPaths])

  const importLyricsText = useCallback(async (lyricsText: string, format: LyricsFormat, sourceLabel: string) => {
    if (selectedTrackPaths.length !== 1) {
      setValidationError('Manual lyrics can only be imported for one track at a time.')
      return
    }

    const normalizedText = lyricsText.trim()
    if (!normalizedText) {
      setValidationError('Lyrics text is empty.')
      return
    }

    setValidationError(null)
    setStatusMessage(null)
    setIsActionRunning(true)
    try {
      const targetTrackPaths = [selectedTrackPaths[0]]
      const result = await window.electronAPI.lyrics.importManualLyrics(targetTrackPaths, normalizedText, format)
      await loadPanelState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(targetTrackPaths)

      const resolvedFormat: LyricsFormat = format === 'xlrc'
        ? 'xlrc'
        : result.hasSyncedLyrics ? 'lrc' : 'plain'
      const importedMode = resolvedFormat === 'xlrc'
        ? 'XLRC'
        : resolvedFormat === 'lrc' ? 'synced LRC' : 'plain'
      setLyricsTextDraft(normalizedText)
      setLyricsTextDirty(false)
      setLyricsTextMixed(false)
      setFormatDraft(resolvedFormat)
      setStatusMessage(`Imported ${importedMode} lyrics from ${sourceLabel} for ${result.updated} track${result.updated === 1 ? '' : 's'}.`)
    } catch (error) {
      setValidationError(toErrorMessage(error, 'Failed to import manual lyrics.'))
    } finally {
      setIsActionRunning(false)
    }
  }, [loadPanelState, refreshLyricsForActiveTrack, selectedTrackPaths])

  const handleChooseLyricsFile = useCallback(async () => {
    setValidationError(null)
    setStatusMessage(null)

    if (!isSingleTrack) {
      setValidationError('Choose one track before importing a lyrics file.')
      return
    }

    const filePath = await window.electronAPI.openFileDialog({
      title: 'Import lyrics file',
      filters: [{ name: 'Lyrics', extensions: ['xlrc', 'lrc'] }]
    })
    if (!filePath) return

    const extension = getFileExtension(filePath)
    if (!LYRICS_FILE_EXTENSIONS.has(extension)) {
      setValidationError('Choose an LRC or XLRC file.')
      return
    }

    try {
      const lyricsText = await window.electronAPI.readTextFile(filePath)
      await importLyricsText(lyricsText, inferLyricsFormat(filePath), filePath.replace(/\\/g, '/').split('/').pop() ?? 'file')
    } catch (error) {
      setValidationError(toErrorMessage(error, 'Failed to read lyrics file.'))
    }
  }, [importLyricsText, isSingleTrack])

  const handleSaveTextDraft = useCallback(async () => {
    await importLyricsText(lyricsTextDraft, formatDraft, 'editor')
  }, [formatDraft, importLyricsText, lyricsTextDraft])

  const handleClearManualLyrics = useCallback(async () => {
    if (selectedTrackPaths.length === 0) {
      setValidationError('Select at least one track to clear manual lyrics.')
      return
    }

    setValidationError(null)
    setStatusMessage(null)
    setIsActionRunning(true)

    try {
      const result = await window.electronAPI.lyrics.clearManualLyrics(selectedTrackPaths)
      await loadPanelState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)

      if (result.cleared === 0) {
        setStatusMessage('No manual lyrics were set on the selected tracks.')
      } else {
        setStatusMessage(`Cleared manual lyrics for ${result.cleared} track${result.cleared === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setValidationError(toErrorMessage(error, 'Failed to clear manual lyrics.'))
    } finally {
      setIsActionRunning(false)
    }
  }, [loadPanelState, refreshLyricsForActiveTrack, selectedTrackPaths])

  const applyOffset = useCallback(async (offsetMs: number) => {
    if (selectedTrackPaths.length === 0) {
      setValidationError('Select at least one track before applying sync offset.')
      return
    }

    setValidationError(null)
    setStatusMessage(null)
    setIsActionRunning(true)
    try {
      const result = await window.electronAPI.lyrics.setTrackOffset(selectedTrackPaths, offsetMs)
      await loadPanelState(selectedTrackPaths)
      await refreshLyricsForActiveTrack(selectedTrackPaths)
      const signedOffset = result.offsetMs > 0 ? `+${result.offsetMs}` : String(result.offsetMs)
      if (result.updated === 0) {
        setStatusMessage('Selected tracks already use this sync offset.')
      } else {
        setStatusMessage(`Applied ${signedOffset} ms sync offset to ${result.updated} track${result.updated === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setValidationError(toErrorMessage(error, 'Failed to apply sync offset.'))
    } finally {
      setIsActionRunning(false)
    }
  }, [loadPanelState, refreshLyricsForActiveTrack, selectedTrackPaths])

  const handleApplyOffset = useCallback(async () => {
    const normalizedOffsetText = offsetDraft.trim()
    if (!/^-?\d+$/.test(normalizedOffsetText)) {
      setValidationError('Sync offset must be an integer in milliseconds.')
      return
    }

    const offsetMs = Number.parseInt(normalizedOffsetText, 10)
    if (!Number.isFinite(offsetMs)) {
      setValidationError('Sync offset must be an integer in milliseconds.')
      return
    }

    await applyOffset(offsetMs)
  }, [applyOffset, offsetDraft])

  const handleNudgeOffset = useCallback((deltaMs: number) => {
    const current = /^-?\d+$/.test(offsetDraft.trim())
      ? Number.parseInt(offsetDraft.trim(), 10)
      : 0
    const next = Number.isFinite(current) ? current + deltaMs : deltaMs
    setOffsetDraft(String(next))
    setOffsetMixed(false)
    setOffsetDirty(true)
  }, [offsetDraft])

  const handleDropFile = useCallback(async (file: File) => {
    if (!isSingleTrack) {
      setValidationError('Drop lyrics onto a single selected track.')
      return
    }

    const extension = getFileExtension(file.name)
    if (!LYRICS_FILE_EXTENSIONS.has(extension)) {
      setValidationError('Drop an LRC or XLRC file.')
      return
    }

    try {
      const lyricsText = await file.text()
      await importLyricsText(lyricsText, inferLyricsFormat(file.name), file.name)
    } catch (error) {
      setValidationError(toErrorMessage(error, 'Failed to read dropped lyrics file.'))
    }
  }, [importLyricsText, isSingleTrack])

  const handleClose = useCallback(() => {
    if (isActionRunning) return
    if ((lyricsTextDirty || offsetDirty) && !window.confirm('Discard unsaved lyrics changes?')) {
      return
    }
    closePanel()
  }, [closePanel, isActionRunning, lyricsTextDirty, offsetDirty])

  if (!presence.shouldRender || !displayedPanelRequest) return null

  return (
    <aside
      className="metadata-editor-panel lyrics-editor-panel"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      role="dialog"
      aria-modal="false"
      aria-labelledby="lyrics-editor-panel-title"
    >
      <div className="metadata-panel-header">
        <div className="metadata-panel-heading">
          <h2 id="lyrics-editor-panel-title">Edit Lyrics</h2>
          <span className="metadata-panel-subtitle">
            {selectedCount} track{selectedCount === 1 ? '' : 's'} · manual {manualLyricsCount}/{selectedCount}
          </span>
        </div>
        <button className="metadata-panel-close" onClick={handleClose} aria-label="Close lyrics editor" disabled={isActionRunning}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>

      <div className="lyrics-panel-body">
        {isLoading ? (
          <div className="metadata-panel-empty">Loading lyrics state...</div>
        ) : (
          <>
            <section className="lyrics-panel-track-summary">
              <div className="lyrics-panel-track-title">
                {selectedCount === 1 ? primaryTrack?.title ?? 'Selected track' : `${selectedCount} selected tracks`}
              </div>
              <div className="lyrics-panel-track-meta">
                {selectedCount === 1
                  ? `${primaryTrack?.artist ?? 'Unknown Artist'} · ${formatSourceLabel(primaryTrack)}`
                  : `${syncedLyricsCount} with synced manual lyrics · bulk offset and clear only`}
              </div>
            </section>

            {isSingleTrack && (
              <>
                <section
                  className={`lyrics-drop-zone ${isDropActive ? 'is-active' : ''}`}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setIsDropActive(true)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'copy'
                    setIsDropActive(true)
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                    setIsDropActive(false)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setIsDropActive(false)
                    const file = Array.from(event.dataTransfer.files).find((candidate) => (
                      LYRICS_FILE_EXTENSIONS.has(getFileExtension(candidate.name))
                    ))
                    if (!file) {
                      setValidationError('Drop an LRC or XLRC file.')
                      return
                    }
                    void handleDropFile(file)
                  }}
                >
                  <div className="lyrics-drop-zone-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                  </div>
                  <div className="lyrics-drop-zone-copy">
                    <span>Drop LRC or XLRC here</span>
                    <small>Manual lyrics override sidecar files, embedded tags, and online results.</small>
                  </div>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void handleChooseLyricsFile()}
                    disabled={controlsDisabled}
                  >
                    Choose File
                  </button>
                </section>

                <section className="lyrics-text-editor">
                  <div className="lyrics-section-header">
                    <div>
                      <span>Manual Lyrics</span>
                      <small>{lyricsTextMixed ? 'Mixed selected lyrics' : `${formatLyricsFormat(formatDraft)} editor`}</small>
                    </div>
                    <select
                      className="settings-select lyrics-format-select"
                      value={formatDraft}
                      onChange={(event) => {
                        setFormatDraft(event.target.value as LyricsFormat)
                        if (lyricsTextDraft.trim().length > 0) {
                          setLyricsTextDirty(true)
                        }
                      }}
                      disabled={controlsDisabled}
                      aria-label="Lyrics format"
                    >
                      <option value="lrc">LRC</option>
                      <option value="xlrc">XLRC</option>
                      <option value="plain">Plain</option>
                    </select>
                  </div>
                  <textarea
                    className="lyrics-textarea"
                    value={lyricsTextDraft}
                    onChange={(event) => {
                      setLyricsTextDraft(event.target.value)
                      setLyricsTextDirty(true)
                      setLyricsTextMixed(false)
                    }}
                    placeholder={lyricsTextMixed ? 'Selected tracks have different manual lyrics.' : '[00:12.34]Paste synced lyrics or plain lyrics here...'}
                    disabled={controlsDisabled}
                    spellCheck={false}
                  />
                  <div className="lyrics-text-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn-primary"
                      onClick={() => void handleSaveTextDraft()}
                      disabled={controlsDisabled || lyricsTextDraft.trim().length === 0}
                    >
                      Save Manual Lyrics
                    </button>
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => void handleClearManualLyrics()}
                      disabled={controlsDisabled || manualLyricsCount === 0}
                    >
                      Clear Manual Lyrics
                    </button>
                  </div>
                </section>
              </>
            )}

            {!isSingleTrack && manualLyricsCount > 0 && (
              <section className="lyrics-bulk-actions">
                <div className="lyrics-section-header">
                  <div>
                    <span>Manual Lyrics</span>
                    <small>{manualLyricsCount} selected track{manualLyricsCount === 1 ? '' : 's'} have manual lyrics</small>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void handleClearManualLyrics()}
                  disabled={controlsDisabled}
                >
                  Clear Manual Lyrics
                </button>
              </section>
            )}

            <section className="lyrics-offset-card">
              <div className="lyrics-section-header">
                <div>
                  <span>Sync Offset</span>
                  <small>{offsetMixed ? 'Mixed offsets' : 'Milliseconds applied at playback'}</small>
                </div>
              </div>
              <div className="lyrics-offset-controls">
                <button
                  type="button"
                  className="settings-btn lyrics-offset-nudge"
                  onClick={() => handleNudgeOffset(-50)}
                  disabled={controlsDisabled}
                >
                  -50
                </button>
                <input
                  className="settings-select lyrics-offset-input"
                  type="text"
                  inputMode="numeric"
                  value={offsetDraft}
                  onChange={(event) => {
                    setOffsetDraft(event.target.value)
                    setOffsetDirty(true)
                    setOffsetMixed(false)
                  }}
                  placeholder={offsetMixed ? 'Mixed' : '0'}
                  disabled={controlsDisabled}
                />
                <button
                  type="button"
                  className="settings-btn lyrics-offset-nudge"
                  onClick={() => handleNudgeOffset(50)}
                  disabled={controlsDisabled}
                >
                  +50
                </button>
                <button
                  type="button"
                  className="settings-btn settings-btn-primary lyrics-offset-apply"
                  onClick={() => void handleApplyOffset()}
                  disabled={controlsDisabled}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="settings-btn lyrics-offset-reset"
                  onClick={() => void applyOffset(0)}
                  disabled={controlsDisabled}
                >
                  Reset
                </button>
              </div>
            </section>

            {validationError && (
              <div className="metadata-status metadata-status-error">{validationError}</div>
            )}
            {statusMessage && (
              <div className="metadata-status metadata-status-success">{statusMessage}</div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
