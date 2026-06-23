import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  IntegrityFinding,
  IntegrityFindingSeverity,
  IntegrityScanScope
} from '../../../types/libraryIntegrity'
import { useLibraryStore, type DbTrack, type LibraryFolder } from '../../stores/libraryStore'
import { useLibraryIntegrityStore, type IntegrityReportFilter } from '../../stores/libraryIntegrityStore'
import { usePresence } from '../../hooks/usePresence'

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

export default function LibraryIntegrityPanel() {
  const folders = useLibraryStore((state) => state.folders)
  const fullTrackPaths = useLibraryStore((state) => state.fullTrackPaths)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const loadFolders = useLibraryStore((state) => state.loadFolders)
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
  const result = useLibraryIntegrityStore((state) => state.result)
  const filter = useLibraryIntegrityStore((state) => state.filter)
  const setFilter = useLibraryIntegrityStore((state) => state.setFilter)
  const startScan = useLibraryIntegrityStore((state) => state.startScan)
  const cancelScan = useLibraryIntegrityStore((state) => state.cancelScan)
  const clearReport = useLibraryIntegrityStore((state) => state.clearReport)
  const errorMessage = useLibraryIntegrityStore((state) => state.errorMessage)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

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
  const canClose = !isScanning

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
                disabled={isScanning}
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
                      disabled={isScanning}
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
                <button type="button" className={mode === 'quick' ? 'active' : ''} onClick={() => setMode('quick')} disabled={isScanning}>
                  Quick
                </button>
                <button type="button" className={mode === 'deep' ? 'active' : ''} onClick={() => setMode('deep')} disabled={isScanning}>
                  Deep
                </button>
              </div>
              <button className="settings-btn settings-btn-primary" onClick={handleStartScan} disabled={isScanning || localTrackCount === 0}>
                {isScanning ? 'Scanning...' : `Start ${mode === 'deep' ? 'Deep' : 'Quick'} Scan`}
              </button>
              <button className="settings-btn" onClick={() => void cancelScan()} disabled={!isScanning || isCanceling}>
                {isCanceling ? 'Canceling...' : 'Cancel'}
              </button>
              <button className="settings-btn" onClick={clearReport} disabled={isScanning || findings.length === 0}>
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

            <IntegrityFindingList
              findings={filteredFindings}
              emptyLabel={isScanning ? 'No findings yet.' : 'No findings for this filter.'}
            />
          </main>
        </div>
      </div>
    </div>
  )
}
