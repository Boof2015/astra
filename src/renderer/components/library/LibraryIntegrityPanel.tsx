import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  IntegrityDuplicateGroup,
  IntegrityDuplicateTrashAction,
  IntegrityDuplicateTrashOutcome,
  IntegrityFinding,
  IntegrityFindingSeverity,
  IntegrityScanScope
} from '../../../types/libraryIntegrity'
import { useLibraryStore, type DbTrack, type LibraryFolder } from '../../stores/libraryStore'
import { useLibraryIntegrityStore, type IntegrityReportFilter } from '../../stores/libraryIntegrityStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import { usePresence } from '../../hooks/usePresence'
import { buildDuplicateTrashActions } from './duplicateCleanup'

interface IntegrityFolderNode {
  name: string
  fullPath: string
  children: Map<string, IntegrityFolderNode>
  trackCount: number
}

interface IntegrityFolderRow {
  node: IntegrityFolderNode
  depth: number
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function getFolderName(fullPath: string): string {
  const normalized = normalizePath(fullPath)
  const parts = normalized.split('/')
  return parts[parts.length - 1] || fullPath
}

function isTrackUnderFolder(trackPath: string, folderPath: string): boolean {
  const track = normalizePath(trackPath)
  const folder = normalizePath(folderPath)
  return track === folder || track.startsWith(`${folder}/`)
}

function buildFolderTree(folders: LibraryFolder[], tracks: DbTrack[]): IntegrityFolderNode[] {
  const localTracks = tracks.filter((track) => track.source_type === 'local')
  const roots = folders.map((folder) => ({
    name: getFolderName(folder.path),
    fullPath: folder.path,
    children: new Map<string, IntegrityFolderNode>(),
    trackCount: 0
  }))
  const rootsByLength = [...roots].sort((a, b) => b.fullPath.length - a.fullPath.length)

  for (const track of localTracks) {
    const root = rootsByLength.find((candidate) => isTrackUnderFolder(track.path, candidate.fullPath))
    if (!root) continue

    root.trackCount += 1
    const relative = normalizePath(track.path).slice(normalizePath(root.fullPath).length + 1)
    const segments = relative.split('/')
    segments.pop()
    let current = root
    let pathSoFar = normalizePath(root.fullPath)

    for (const segment of segments) {
      if (!segment) continue
      pathSoFar = `${pathSoFar}/${segment}`
      let child = current.children.get(segment)
      if (!child) {
        child = {
          name: segment,
          fullPath: pathSoFar,
          children: new Map(),
          trackCount: 0
        }
        current.children.set(segment, child)
      }
      child.trackCount += 1
      current = child
    }
  }

  const pruneEmpty = (node: IntegrityFolderNode): boolean => {
    for (const [key, child] of node.children.entries()) {
      if (!pruneEmpty(child)) {
        node.children.delete(key)
      }
    }
    return node.trackCount > 0
  }

  return roots.filter(pruneEmpty).sort((a, b) => a.name.localeCompare(b.name))
}

function flattenFolderTree(nodes: IntegrityFolderNode[], expanded: Set<string>): IntegrityFolderRow[] {
  const rows: IntegrityFolderRow[] = []
  const visit = (node: IntegrityFolderNode, depth: number) => {
    rows.push({ node, depth })
    if (!expanded.has(node.fullPath)) return
    const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      visit(child, depth + 1)
    }
  }

  for (const node of nodes) {
    visit(node, 0)
  }
  return rows
}

function scopeMatchesFolder(scope: IntegrityScanScope, folderPath: string): boolean {
  return scope.type === 'folder' && normalizePath(scope.folderPath) === normalizePath(folderPath)
}

function formatScopeLabel(scope: IntegrityScanScope): string {
  if (scope.type === 'all') return 'All Library'
  if (scope.type === 'track') return getFolderName(scope.trackPath)
  if (scope.type === 'tracks') return `${scope.trackPaths.length} Selected Tracks`
  return getFolderName(scope.folderPath) || scope.folderPath
}

function formatPathTail(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized.split('/')
  return parts.slice(Math.max(0, parts.length - 3)).join('/')
}

function summarizeFindings(findings: readonly IntegrityFinding[]): Record<IntegrityFindingSeverity, number> {
  return findings.reduce((acc, finding) => {
    acc[finding.severity] += 1
    return acc
  }, { error: 0, warning: 0, info: 0 })
}

function severityLabel(severity: IntegrityFindingSeverity): string {
  if (severity === 'error') return 'Errors'
  if (severity === 'warning') return 'Warnings'
  return 'Info'
}

function findingToneClass(severity: IntegrityFindingSeverity): string {
  if (severity === 'error') return 'is-error'
  if (severity === 'warning') return 'is-warning'
  return 'is-info'
}

function confidenceRank(confidence: IntegrityFinding['confidence']): number {
  if (confidence === 'high') return 0
  if (confidence === 'medium') return 1
  if (confidence === 'low') return 2
  return 3
}

function severityRank(severity: IntegrityFindingSeverity): number {
  if (severity === 'error') return 0
  if (severity === 'warning') return 1
  return 2
}

function getFindingExplanation(finding: IntegrityFinding): string | null {
  switch (finding.code) {
    case 'quality_possible_lossy_source':
      return 'This can hint at MP3/AAC sourcing, but mastering or noise reduction can also cause it.'
    case 'quality_possible_upsample':
      return 'This can hint that a high-rate file was converted from a lower-rate source.'
    case 'quality_padded_bit_depth':
      return 'This usually means 16-bit audio was stored in a 24-bit container.'
    case 'flac_zero_md5':
      return 'STREAMINFO cannot verify the decoded audio checksum for this file.'
    case 'flac_zero_total_samples':
      return 'The FLAC header does not state the sample count; valid, but unusual.'
    case 'flac_sample_count_mismatch':
      return 'The decoded length disagrees with the FLAC header, which suggests a bad file.'
    case 'flac_decode_failed':
      return 'FFmpeg could not fully decode the audio stream.'
    case 'flac_streaminfo_unreadable':
      return 'The required FLAC STREAMINFO block could not be read.'
    case 'implausibly_small_file':
      return 'The file is much smaller than expected for its duration.'
    case 'metadata_unreadable':
      return 'Astra could not read enough metadata to inspect this file.'
    case 'file_unreadable':
      return 'The file could not be opened from disk.'
    case 'empty_file':
      return 'The indexed file exists, but it has no bytes.'
    case 'not_a_file':
      return 'The indexed path exists, but it is not a normal file.'
    case 'ffmpeg_unavailable':
      return 'Deep checks need FFmpeg, but Astra could not find it.'
    case 'track_not_found':
      return 'This track is not a local indexed library file.'
    case 'deep_scan_flac_only':
      return 'Deep traversal is FLAC-only; this file got quick checks instead.'
    default:
      return finding.severity === 'info' && finding.confidence
        ? 'This is a quality hint, not proof.'
        : null
  }
}

async function copyFindingToClipboard(finding: IntegrityFinding): Promise<void> {
  const explanation = getFindingExplanation(finding)
  const lines = [
    finding.message,
    explanation ? `Meaning: ${explanation}` : '',
    finding.detail,
    finding.confidence ? `Confidence: ${finding.confidence}` : '',
    finding.path
  ].filter(Boolean)
  await navigator.clipboard.writeText(lines.join('\n'))
}

interface IntegrityFindingListProps {
  findings: IntegrityFinding[]
  emptyLabel: string
}

export function IntegrityFindingList({ findings, emptyLabel }: IntegrityFindingListProps) {
  if (findings.length === 0) {
    return <div className="library-integrity-empty">{emptyLabel}</div>
  }

  return (
    <div className="library-integrity-report-list">
      {findings.map((finding) => {
        const explanation = getFindingExplanation(finding)
        return (
          <article key={finding.id} className={`library-integrity-finding ${findingToneClass(finding.severity)}`}>
            <div className="library-integrity-finding-main">
              <div className="library-integrity-finding-head">
                <span className="library-integrity-finding-severity">{finding.severity}</span>
                {finding.confidence && (
                  <span className="library-integrity-confidence">{finding.confidence} confidence</span>
                )}
                <span className="library-integrity-code">{finding.code}</span>
              </div>
              <div className="library-integrity-finding-message">{finding.message}</div>
              {explanation && (
                <div className="library-integrity-finding-meaning">
                  <strong>Meaning:</strong> {explanation}
                </div>
              )}
              {finding.detail && <div className="library-integrity-finding-detail">{finding.detail}</div>}
              <div className="library-integrity-finding-path" title={finding.path}>{formatPathTail(finding.path)}</div>
            </div>
            <div className="library-integrity-finding-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={() => void window.electronAPI.revealFileInFolder(finding.path)}
              >
                Reveal
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void copyFindingToClipboard(finding)}
              >
                Copy
              </button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function formatDuplicateDuration(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '--:--'
  const totalSeconds = Math.round(duration)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function formatDuplicateSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '--'
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MiB`
}

function formatDuplicateQuality(member: IntegrityDuplicateGroup['members'][number]): string {
  const parts: string[] = []
  if (member.sampleRate) parts.push(`${(member.sampleRate / 1000).toFixed(member.sampleRate % 1000 === 0 ? 0 : 1)} kHz`)
  if (member.bitDepth) parts.push(`${member.bitDepth}-bit`)
  if (member.bitrate) parts.push(`${Math.round(member.bitrate)} kbps`)
  if (member.channels) parts.push(`${member.channels}ch`)
  return parts.join(' / ') || 'Quality metadata unavailable'
}

function duplicateEvidenceLabel(evidence: IntegrityDuplicateGroup['evidence']): string {
  if (evidence === 'exact') return 'Exact file match'
  if (evidence === 'mixed') return 'Mixed evidence'
  return 'Possible duplicate'
}

interface IntegrityDuplicateGroupListProps {
  groups: IntegrityDuplicateGroup[]
  keepByGroup: Record<string, string>
  outcomeByPath: ReadonlyMap<string, IntegrityDuplicateTrashOutcome>
  onChooseKeep: (groupId: string, path: string) => void
}

function IntegrityDuplicateGroupList({
  groups,
  keepByGroup,
  outcomeByPath,
  onChooseKeep
}: IntegrityDuplicateGroupListProps) {
  if (groups.length === 0) {
    return <div className="library-integrity-empty">No duplicate groups found in this scope.</div>
  }

  return (
    <div className="library-integrity-duplicate-list">
      {groups.map((group) => {
        const keepPath = keepByGroup[group.id] ?? ''
        return (
          <section key={group.id} className={`library-integrity-duplicate-group is-${group.evidence}`}>
            <header className="library-integrity-duplicate-head">
              <div>
                <span className="library-integrity-duplicate-evidence">{duplicateEvidenceLabel(group.evidence)}</span>
                <strong>{group.members[0]?.title || 'Duplicate tracks'}</strong>
                <span>{group.members[0]?.artist || 'Unknown artist'} · {group.members.length} files</span>
              </div>
              <span className={`library-integrity-duplicate-decision ${keepPath ? 'is-decided' : ''}`}>
                {keepPath ? `${group.members.length - 1} will move to Trash` : 'Choose one copy to keep'}
              </span>
            </header>
            <div className="library-integrity-duplicate-members">
              {group.members.map((member) => {
                const isKeep = keepPath === member.path
                const isStagedForTrash = Boolean(keepPath) && !isKeep
                const outcome = outcomeByPath.get(member.path)
                return (
                  <div
                    key={member.path}
                    className={`library-integrity-duplicate-member ${isKeep ? 'is-keep' : ''} ${isStagedForTrash ? 'is-staged-trash' : ''}`}
                  >
                    <label className="library-integrity-duplicate-choice">
                      <input
                        type="radio"
                        name={`duplicate-keep-${group.id}`}
                        checked={isKeep}
                        onChange={() => onChooseKeep(group.id, member.path)}
                      />
                      <span>{isKeep ? 'Keep' : keepPath ? 'Keep instead' : 'Keep this copy'}</span>
                    </label>
                    <div className="library-integrity-duplicate-member-main">
                      <div className="library-integrity-duplicate-member-title">
                        <strong>{member.title}</strong>
                        <span>{member.artist}</span>
                        {isKeep && <em className="is-keep-status">Keeping this copy</em>}
                        {isStagedForTrash && <em className="is-trash-status">Will move to Trash</em>}
                        {member.withinScope && <em>In selected scope</em>}
                        {member.exactSetId && <em className="is-exact">Byte-identical</em>}
                      </div>
                      <div className="library-integrity-duplicate-member-meta">
                        <span>{member.format.toUpperCase() || 'UNKNOWN'}</span>
                        <span>{formatDuplicateDuration(member.duration)}</span>
                        <span>{formatDuplicateSize(member.sizeBytes)}</span>
                        <span>{formatDuplicateQuality(member)}</span>
                      </div>
                      <div className="library-integrity-duplicate-member-path" title={member.path}>{member.path}</div>
                      {outcome && outcome.status !== 'trashed' && (
                        <div className="library-integrity-duplicate-outcome is-error">
                          {outcome.status === 'failed' ? 'Could not move to Trash' : 'Moved to Trash, but library merge failed'}
                          {outcome.error ? `: ${outcome.error}` : ''}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => void window.electronAPI.revealFileInFolder(member.path)}
                    >
                      Reveal
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export default function LibraryIntegrityPanel() {
  const folders = useLibraryStore((state) => state.folders)
  const fullTrackPaths = useLibraryStore((state) => state.fullTrackPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const loadFolders = useLibraryStore((state) => state.loadFolders)
  const loadLibrary = useLibraryStore((state) => state.loadLibrary)
  const loadFullTracks = useLibraryStore((state) => state.loadFullTracks)
  const releaseFullTracks = useLibraryStore((state) => state.releaseFullTracks)
  const enabled = useLibraryIntegrityStore((state) => state.enabled)
  const isPanelOpen = useLibraryIntegrityStore((state) => state.isPanelOpen)
  const presence = usePresence(enabled && isPanelOpen)
  const closePanel = useLibraryIntegrityStore((state) => state.closePanel)
  const mode = useLibraryIntegrityStore((state) => state.mode)
  const setMode = useLibraryIntegrityStore((state) => state.setMode)
  const selectedScope = useLibraryIntegrityStore((state) => state.selectedScope)
  const setSelectedScope = useLibraryIntegrityStore((state) => state.setSelectedScope)
  const isScanning = useLibraryIntegrityStore((state) => state.isScanning)
  const isCanceling = useLibraryIntegrityStore((state) => state.isCanceling)
  const progress = useLibraryIntegrityStore((state) => state.progress)
  const findings = useLibraryIntegrityStore((state) => state.findings)
  const duplicateGroups = useLibraryIntegrityStore((state) => state.duplicateGroups)
  const result = useLibraryIntegrityStore((state) => state.result)
  const filter = useLibraryIntegrityStore((state) => state.filter)
  const setFilter = useLibraryIntegrityStore((state) => state.setFilter)
  const startScan = useLibraryIntegrityStore((state) => state.startScan)
  const cancelScan = useLibraryIntegrityStore((state) => state.cancelScan)
  const clearReport = useLibraryIntegrityStore((state) => state.clearReport)
  const errorMessage = useLibraryIntegrityStore((state) => state.errorMessage)
  const isTrashingDuplicates = useLibraryIntegrityStore((state) => state.isTrashingDuplicates)
  const duplicateTrashResult = useLibraryIntegrityStore((state) => state.duplicateTrashResult)
  const duplicateTrashError = useLibraryIntegrityStore((state) => state.duplicateTrashError)
  const trashDuplicates = useLibraryIntegrityStore((state) => state.trashDuplicates)
  const currentTrackPath = usePlayerStore((state) => state.currentTrack?.path ?? null)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const replaceLocalTrackPaths = usePlayerStore((state) => state.replaceLocalTrackPaths)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [keepByGroup, setKeepByGroup] = useState<Record<string, string>>({})
  const [isTrashConfirmationOpen, setTrashConfirmationOpen] = useState(false)

  useEffect(() => {
    if (!isPanelOpen) return
    void loadFolders()
    void loadFullTracks('integrity')
    return () => {
      releaseFullTracks('integrity')
    }
  }, [isPanelOpen, loadFolders, loadFullTracks, releaseFullTracks])

  const fullTracks = useMemo(
    () => resolveTrackPaths(fullTrackPaths),
    [fullTrackPaths, resolveTrackPaths, trackCacheVersion]
  )

  useEffect(() => {
    if (!isPanelOpen || fullTracks.length === 0) return
    setExpandedFolders((current) => {
      if (current.size > 0) return current
      return new Set(folders.map((folder) => folder.path))
    })
  }, [folders, fullTracks.length, isPanelOpen])

  useEffect(() => {
    setKeepByGroup({})
    setTrashConfirmationOpen(false)
  }, [result?.runId])

  const localTrackCount = useMemo(
    () => fullTracks.filter((track) => track.source_type === 'local').length,
    [fullTracks]
  )
  const folderTree = useMemo(() => buildFolderTree(folders, fullTracks), [folders, fullTracks])
  const folderRows = useMemo(() => flattenFolderTree(folderTree, expandedFolders), [expandedFolders, folderTree])
  const findingCounts = useMemo(() => summarizeFindings(findings), [findings])
  const filteredFindings = useMemo(() => {
    const visible = filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter)
    return visible
      .map((finding, index) => ({ finding, index }))
      .sort((left, right) => (
        severityRank(left.finding.severity) - severityRank(right.finding.severity)
        || confidenceRank(left.finding.confidence) - confidenceRank(right.finding.confidence)
        || left.index - right.index
      ))
      .map(({ finding }) => finding)
  }, [filter, findings])

  const progressPercent = progress && progress.total > 0
    ? Math.max(0, Math.min(100, (progress.current / progress.total) * 100))
    : 0
  const selectedScopeLabel = formatScopeLabel(selectedScope)
  const canClose = !isScanning && !isTrashingDuplicates
  const outcomeByPath = useMemo(
    () => new Map((duplicateTrashResult?.outcomes ?? []).map((outcome) => [outcome.path, outcome])),
    [duplicateTrashResult]
  )
  const duplicateTrashActions = useMemo<IntegrityDuplicateTrashAction[]>(() => {
    return buildDuplicateTrashActions(duplicateGroups, keepByGroup)
  }, [duplicateGroups, keepByGroup])
  const selectedTrashCount = duplicateTrashActions.reduce((count, action) => count + action.trashPaths.length, 0)
  const selectedTrashPaths = useMemo(
    () => new Set(duplicateTrashActions.flatMap((action) => action.trashPaths)),
    [duplicateTrashActions]
  )
  const selectedActiveTrack = Boolean(
    currentTrackPath
    && playbackState !== 'stopped'
    && selectedTrashPaths.has(currentTrackPath)
  )
  const showDuplicateResults = result?.summary.mode === 'duplicates' || (mode === 'duplicates' && isScanning)

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(folderPath)) {
        next.delete(folderPath)
      } else {
        next.add(folderPath)
      }
      return next
    })
  }

  const handleStartScan = useCallback(() => {
    if (isScanning) return
    if (mode === 'deep') {
      const confirmed = window.confirm('Deep scans decode every FLAC in the selected scope and can be disk/CPU heavy. Start deep scan?')
      if (!confirmed) return
    }
    void startScan()
  }, [isScanning, mode, startScan])

  const handleChooseKeep = useCallback((groupId: string, path: string) => {
    setKeepByGroup((current) => ({ ...current, [groupId]: path }))
  }, [])

  const handleConfirmTrash = useCallback(async () => {
    if (duplicateTrashActions.length === 0 || selectedActiveTrack || isTrashingDuplicates) return
    const trashResult = await trashDuplicates(duplicateTrashActions)
    setTrashConfirmationOpen(false)
    if (!trashResult) return

    const successfulReplacements = trashResult.replacements
    if (Object.keys(successfulReplacements).length > 0) {
      await loadLibrary()
      const playlistStore = usePlaylistStore.getState()
      const selectedPlaylistId = playlistStore.selectedPlaylistId
      await Promise.all([
        playlistStore.loadPlaylists(),
        useRatingsStore.getState().loadRatings()
      ])
      if (selectedPlaylistId !== null) await usePlaylistStore.getState().selectPlaylist(selectedPlaylistId)
      await replaceLocalTrackPaths(successfulReplacements)
    }

    if (!trashResult.stale) {
      const remainingGroupIds = new Set(trashResult.remainingGroups.map((group) => group.id))
      setKeepByGroup((current) => Object.fromEntries(
        Object.entries(current).filter(([groupId]) => remainingGroupIds.has(groupId))
      ))
    }
  }, [
    duplicateTrashActions,
    isTrashingDuplicates,
    loadLibrary,
    replaceLocalTrackPaths,
    selectedActiveTrack,
    trashDuplicates
  ])

  if (!presence.shouldRender) return null

  return (
    <div className="modal-overlay library-integrity-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={() => {
      if (canClose) closePanel()
    }}>
      <div className="modal-content library-integrity-panel" onClick={(event) => event.stopPropagation()}>
        <div className="library-integrity-layout">
          <aside className="library-integrity-sidebar">
            <div className="library-integrity-sidebar-head">
              <div className="library-integrity-kicker">Scope</div>
              <button
                type="button"
                className={`library-integrity-scope-row ${selectedScope.type === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedScope({ type: 'all' })}
                disabled={isScanning || isTrashingDuplicates}
              >
                <span>All Library</span>
                <strong>{localTrackCount}</strong>
              </button>
            </div>
            <div className="library-integrity-folder-list">
              {folderRows.map(({ node, depth }) => {
                const isExpanded = expandedFolders.has(node.fullPath)
                const hasChildren = node.children.size > 0
                return (
                  <Fragment key={node.fullPath}>
                    <button
                      type="button"
                      className={`library-integrity-folder-row ${scopeMatchesFolder(selectedScope, node.fullPath) ? 'active' : ''}`}
                      style={{ paddingLeft: 10 + depth * 16 }}
                      onClick={() => setSelectedScope({ type: 'folder', folderPath: node.fullPath })}
                      disabled={isScanning || isTrashingDuplicates}
                    >
                      <span
                        className={`library-integrity-folder-chevron ${isExpanded ? 'is-expanded' : ''} ${hasChildren ? '' : 'is-empty'}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (hasChildren) toggleFolder(node.fullPath)
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </span>
                      <span className="library-integrity-folder-name" title={node.fullPath}>{node.name}</span>
                      <strong>{node.trackCount}</strong>
                    </button>
                  </Fragment>
                )
              })}
            </div>
          </aside>

          <main className="library-integrity-main">
            <header className="library-integrity-header">
              <div>
                <div className="library-integrity-kicker">Library Integrity</div>
                <h2>{selectedScopeLabel}</h2>
              </div>
              <button className="modal-close" onClick={closePanel} disabled={!canClose} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </header>

            <section className="library-integrity-control-band">
              <div className="library-integrity-mode-toggle" role="group" aria-label="Integrity scan mode">
                <button type="button" className={mode === 'quick' ? 'active' : ''} onClick={() => setMode('quick')} disabled={isScanning || isTrashingDuplicates}>
                  Quick
                </button>
                <button type="button" className={mode === 'deep' ? 'active' : ''} onClick={() => setMode('deep')} disabled={isScanning || isTrashingDuplicates}>
                  Deep
                </button>
                <button type="button" className={mode === 'duplicates' ? 'active' : ''} onClick={() => setMode('duplicates')} disabled={isScanning || isTrashingDuplicates}>
                  Duplicates
                </button>
              </div>
              <button className="settings-btn settings-btn-primary" onClick={handleStartScan} disabled={isScanning || isTrashingDuplicates || localTrackCount === 0}>
                {isScanning ? 'Scanning...' : `Start ${mode === 'deep' ? 'Deep' : mode === 'duplicates' ? 'Duplicate' : 'Quick'} Scan`}
              </button>
              <button className="settings-btn" onClick={() => void cancelScan()} disabled={!isScanning || isCanceling}>
                {isCanceling ? 'Canceling...' : 'Cancel'}
              </button>
              <button className="settings-btn" onClick={clearReport} disabled={isScanning || isTrashingDuplicates || !result}>
                Clear
              </button>
            </section>

            <section className="library-integrity-progress">
              <div className="library-integrity-progress-top">
                <span>{progress?.message ?? 'Ready to scan selected scope.'}</span>
                <strong>{progress?.total ? `${progress.current}/${progress.total}` : result ? `${result.summary.scanned} scanned` : '--'}</strong>
              </div>
              <div className="library-integrity-progress-path" title={progress?.filePath ?? ''}>
                {progress?.filePath ? formatPathTail(progress.filePath) : 'No active file'}
              </div>
              <div className="library-integrity-progress-bar">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </section>

            <section className="library-integrity-summary">
              {showDuplicateResults ? (
                <>
                  <span className="library-integrity-result-state">Groups <strong>{result?.summary.duplicateGroups ?? duplicateGroups.length}</strong></span>
                  <span className="library-integrity-result-state">Files <strong>{result?.summary.duplicateFiles ?? 0}</strong></span>
                  <span className="library-integrity-result-state">Exact <strong>{result?.summary.exactDuplicateGroups ?? 0}</strong></span>
                  <span className="library-integrity-result-state">Mixed <strong>{result?.summary.mixedDuplicateGroups ?? 0}</strong></span>
                  <span className="library-integrity-result-state">Possible <strong>{result?.summary.possibleDuplicateGroups ?? 0}</strong></span>
                  {findings.length > 0 && <span className="library-integrity-result-state is-warning">Scan issues <strong>{findings.length}</strong></span>}
                </>
              ) : (
                <>
                  <button className={`library-integrity-filter ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                    All <strong>{findings.length}</strong>
                  </button>
                  {(['error', 'warning', 'info'] as const).map((severity) => (
                    <button
                      key={severity}
                      className={`library-integrity-filter ${filter === severity ? 'active' : ''} ${findingToneClass(severity)}`}
                      onClick={() => setFilter(severity as IntegrityReportFilter)}
                    >
                      {severityLabel(severity)} <strong>{findingCounts[severity]}</strong>
                    </button>
                  ))}
                </>
              )}
              {result && (
                <span
                  className={`library-integrity-result-state ${result.summary.canceled ? 'is-warning' : ''}`}
                  title={result.summary.mode === 'deep' && result.summary.skipped > 0 ? 'Deep scan is FLAC-only in this version, so non-FLAC local tracks are skipped.' : undefined}
                >
                  {result.summary.canceled ? 'Canceled' : 'Complete'} - {result.summary.mode === 'deep' && result.summary.skipped > 0 ? `${result.summary.skipped} non-FLAC skipped` : `${result.summary.skipped} skipped`}
                </span>
              )}
            </section>

            {errorMessage && <div className="library-integrity-error" role="alert">{errorMessage}</div>}
            {duplicateTrashError && <div className="library-integrity-error" role="alert">{duplicateTrashError}</div>}

            {showDuplicateResults ? (
              <div className="library-integrity-duplicate-results">
                <IntegrityDuplicateGroupList
                  groups={duplicateGroups}
                  keepByGroup={keepByGroup}
                  outcomeByPath={outcomeByPath}
                  onChooseKeep={handleChooseKeep}
                />
                {findings.length > 0 && (
                  <section className="library-integrity-duplicate-issues">
                    <h3>Scan issues</h3>
                    <IntegrityFindingList findings={findings} emptyLabel="No scan issues." />
                  </section>
                )}
              </div>
            ) : (
              <IntegrityFindingList
                findings={filteredFindings}
                emptyLabel={isScanning ? 'No findings yet.' : 'No findings for this filter.'}
              />
            )}

            {showDuplicateResults && duplicateGroups.length > 0 && (
              <section className="library-integrity-duplicate-action-bar">
                <div>
                  <strong>{selectedTrashCount > 0 ? `${selectedTrashCount} file${selectedTrashCount === 1 ? '' : 's'} ready for review` : 'Choose a copy to keep in any group'}</strong>
                  <span>{selectedActiveTrack ? 'Stop the affected playing track before continuing.' : 'Nothing moves until you review and confirm.'}</span>
                </div>
                <button
                  type="button"
                  className="settings-btn library-integrity-trash-button"
                  disabled={selectedTrashCount === 0 || selectedActiveTrack || isTrashingDuplicates}
                  onClick={() => setTrashConfirmationOpen(true)}
                >
                  {isTrashingDuplicates ? 'Moving to Trash...' : `Review cleanup${selectedTrashCount > 0 ? ` · ${selectedTrashCount}` : ''}`}
                </button>
              </section>
            )}
          </main>
        </div>
      </div>
      {isTrashConfirmationOpen && (
        <div className="modal-overlay library-integrity-trash-confirm-overlay" onClick={(event) => {
          event.stopPropagation()
          if (!isTrashingDuplicates) setTrashConfirmationOpen(false)
        }}>
          <div className="modal-content library-integrity-trash-confirm" onClick={(event) => event.stopPropagation()}>
            <div className="library-integrity-kicker">Duplicate cleanup</div>
            <h2>Move {selectedTrashCount} file{selectedTrashCount === 1 ? '' : 's'} to Trash?</h2>
            <p>Astra will ask the operating system to move these files to Trash or the Recycle Bin. It will never fall back to permanent deletion.</p>
            <div className="library-integrity-trash-confirm-list">
              {duplicateTrashActions.flatMap((action) => action.trashPaths.map((trashPath) => (
                <div key={trashPath}>
                  <strong>Trash</strong>
                  <span>{trashPath}</span>
                  <em>Keep → {action.keepPath}</em>
                </div>
              )))}
            </div>
            <div className="library-integrity-trash-confirm-actions">
              <button className="settings-btn" onClick={() => setTrashConfirmationOpen(false)} disabled={isTrashingDuplicates}>Cancel</button>
              <button className="settings-btn library-integrity-trash-button" onClick={() => void handleConfirmTrash()} disabled={isTrashingDuplicates}>
                {isTrashingDuplicates ? 'Moving...' : 'Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
