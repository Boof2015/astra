import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { type FolderSubdirectoryEntry, type ScanIssueEntry, useLibraryStore } from '../../stores/libraryStore'
import { usePresence } from '../../hooks/usePresence'

interface FolderSettingsProps {
  isOpen: boolean
  onClose: () => void
}

interface SaveStatus {
  tone: 'info' | 'success' | 'error'
  message: string
}

function formatSubfolderSummary(totalSubfolders: number, excludedSubfolders: number): string {
  if (totalSubfolders <= 0) {
    return excludedSubfolders > 0
      ? `${excludedSubfolders} excluded`
      : 'No subfolders found'
  }

  if (excludedSubfolders > 0) {
    return `${totalSubfolders} found \u2022 ${excludedSubfolders} excluded`
  }

  return `${totalSubfolders} found`
}

function formatScanIssuePhase(phase: ScanIssueEntry['phase']): string {
  switch (phase) {
    case 'discovery':
      return 'Discovery'
    case 'scan':
      return 'Scan'
    case 'backfill':
      return 'Backfill'
    case 'cleanup':
      return 'Cleanup'
    default:
      return phase
  }
}

function makeNodeKey(folderPath: string, relativePath: string): string {
  return `${folderPath}::${relativePath}`
}

function stopSyntheticEventPropagation(event: { preventDefault: () => void; stopPropagation: () => void }): void {
  event.preventDefault()
  event.stopPropagation()
}

export default function FolderSettings({ isOpen, onClose }: FolderSettingsProps) {
  const presence = usePresence(isOpen)
  const folders = useLibraryStore((state) => state.folders)
  const loadFolders = useLibraryStore((state) => state.loadFolders)
  const addFolderWithoutScan = useLibraryStore((state) => state.addFolderWithoutScan)
  const removeFolder = useLibraryStore((state) => state.removeFolder)
  const setFolderHidden = useLibraryStore((state) => state.setFolderHidden)
  const isScanning = useLibraryStore((state) => state.isScanning)
  const isCancelingScan = useLibraryStore((state) => state.isCancelingScan)
  const scanProgress = useLibraryStore((state) => state.scanProgress)
  const scanStage = useLibraryStore((state) => state.scanStage)
  const folderWarnings = useLibraryStore((state) => state.folderWarnings)
  const lastScanIssueLog = useLibraryStore((state) => state.lastScanIssueLog)
  const folderSubfolderSummaries = useLibraryStore((state) => state.folderSubfolderSummaries)
  const loadFolderSubfolderSummary = useLibraryStore((state) => state.loadFolderSubfolderSummary)
  const listFolderSubdirectories = useLibraryStore((state) => state.listFolderSubdirectories)
  const setFolderSubfolderExcluded = useLibraryStore((state) => state.setFolderSubfolderExcluded)
  const scanFolders = useLibraryStore((state) => state.scanFolders)
  const cancelScan = useLibraryStore((state) => state.cancelScan)

  const [removingPath, setRemovingPath] = useState<string | null>(null)
  const [pendingExclusionChangesByFolder, setPendingExclusionChangesByFolder] = useState<Record<string, Record<string, boolean>>>({})
  const [pendingFolderScans, setPendingFolderScans] = useState<string[]>([])
  const [isSavingChanges, setIsSavingChanges] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null)

  // Tree state
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<Map<string, FolderSubdirectoryEntry[]>>(new Map())
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set())
  const [nodeErrors, setNodeErrors] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!isOpen) return
    void loadFolders()
  }, [isOpen, loadFolders])

  useEffect(() => {
    if (!isOpen || folders.length === 0) return
    void Promise.all(
      folders.map((folder) => loadFolderSubfolderSummary(folder.path).catch(() => ({ totalSubfolders: 0, excludedSubfolders: 0 })))
    )
  }, [folders, isOpen, loadFolderSubfolderSummary])

  useEffect(() => {
    if (folders.length === 0) {
      setPendingFolderScans([])
      setPendingExclusionChangesByFolder({})
      return
    }

    const folderPaths = new Set(folders.map((folder) => folder.path))
    setPendingFolderScans((current) => {
      const next = current.filter((folderPath) => folderPaths.has(folderPath))
      return next.length === current.length ? current : next
    })

    setPendingExclusionChangesByFolder((current) => {
      let changed = false
      const next: Record<string, Record<string, boolean>> = {}

      for (const [folderPath, changes] of Object.entries(current)) {
        if (!folderPaths.has(folderPath)) {
          changed = true
          continue
        }

        if (Object.keys(changes).length === 0) {
          changed = true
          continue
        }

        next[folderPath] = changes
      }

      return changed ? next : current
    })
  }, [folders])

  useEffect(() => {
    if (isOpen) return
    setExpandedNodes(new Set())
    setChildrenCache(new Map())
    setLoadingNodes(new Set())
    setNodeErrors(new Map())
    setRemovingPath(null)
  }, [presence.shouldRender])

  useEffect(() => {
    if (!isOpen || !isScanning) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void cancelScan()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelScan, isOpen, isScanning])

  useEffect(() => {
    if (!presence.shouldRender) return

    const body = document.body
    const appElement = document.querySelector('.app')
    const previousAriaHidden = appElement?.getAttribute('aria-hidden') ?? null
    const hadInert = appElement?.hasAttribute('inert') ?? false

    body.classList.add('folder-settings-open')
    appElement?.setAttribute('aria-hidden', 'true')
    appElement?.setAttribute('inert', '')

    return () => {
      body.classList.remove('folder-settings-open')

      if (!appElement) return
      if (previousAriaHidden === null) {
        appElement.removeAttribute('aria-hidden')
      } else {
        appElement.setAttribute('aria-hidden', previousAriaHidden)
      }

      if (!hadInert) {
        appElement.removeAttribute('inert')
      }
    }
  }, [presence.shouldRender])

  const pendingScanFolderPaths = useMemo(() => {
    const paths = new Set<string>(pendingFolderScans)
    for (const [folderPath, changes] of Object.entries(pendingExclusionChangesByFolder)) {
      if (Object.keys(changes).length > 0) {
        paths.add(folderPath)
      }
    }
    return Array.from(paths)
  }, [pendingExclusionChangesByFolder, pendingFolderScans])

  const pendingScanFolderSet = useMemo(
    () => new Set(pendingScanFolderPaths),
    [pendingScanFolderPaths]
  )

  const totalPendingChangeCount = useMemo(() => {
    let count = 0
    for (const changes of Object.values(pendingExclusionChangesByFolder)) {
      count += Object.keys(changes).length
    }
    return count
  }, [pendingExclusionChangesByFolder])

  // Compute per-root-folder error counts and per-subfolder error presence from scan issues
  const folderIssueCountMap = useMemo(() => {
    const map: Record<string, number> = {}
    if (!lastScanIssueLog) return map
    for (const entry of lastScanIssueLog.entries) {
      const fp = entry.folderPath ?? ''
      map[fp] = (map[fp] ?? 0) + 1
    }
    return map
  }, [lastScanIssueLog])

  // Map of "folderPath::relativePath" -> issue count for subfolders (scan errors + inaccessible warnings)
  const subfolderIssueMap = useMemo(() => {
    const map = new Map<string, number>()

    // Attribute scan issue entries to their containing subfolders
    if (lastScanIssueLog) {
      for (const entry of lastScanIssueLog.entries) {
        const rootFolder = entry.folderPath
        if (!rootFolder) continue
        if (!entry.path.startsWith(rootFolder)) continue
        const relative = entry.path.slice(rootFolder.length).replace(/^[/\\]/, '')
        const parts = relative.split('/')
        for (let i = 1; i <= parts.length - 1; i++) {
          const subPath = parts.slice(0, i).join('/')
          const key = makeNodeKey(rootFolder, subPath)
          map.set(key, (map.get(key) ?? 0) + 1)
        }
      }
    }

    // Attribute inaccessible folder warnings to the exact subfolder node
    for (const [rootFolder, warningPaths] of Object.entries(folderWarnings)) {
      for (const absPath of warningPaths) {
        if (!absPath.startsWith(rootFolder)) continue
        const relative = absPath.slice(rootFolder.length).replace(/^[/\\]/, '')
        if (!relative) continue
        const key = makeNodeKey(rootFolder, relative)
        // Mark with at least 1 so the indicator shows even if no scan issues exist
        if (!map.has(key)) map.set(key, 0)
        // Also bubble up to parent subfolders
        const parts = relative.split('/')
        for (let i = 1; i < parts.length; i++) {
          const parentPath = parts.slice(0, i).join('/')
          const parentKey = makeNodeKey(rootFolder, parentPath)
          if (!map.has(parentKey)) map.set(parentKey, 0)
        }
      }
    }

    return map
  }, [lastScanIssueLog, folderWarnings])

  // Set of node keys that are directly inaccessible (EACCES/EPERM)
  const inaccessibleNodeKeys = useMemo(() => {
    const set = new Set<string>()
    for (const [rootFolder, warningPaths] of Object.entries(folderWarnings)) {
      for (const absPath of warningPaths) {
        if (!absPath.startsWith(rootFolder)) continue
        const relative = absPath.slice(rootFolder.length).replace(/^[/\\]/, '')
        if (!relative) continue
        set.add(makeNodeKey(rootFolder, relative))
      }
    }
    return set
  }, [folderWarnings])

  const pendingScanCount = pendingScanFolderPaths.length
  const hasPendingChanges = pendingScanCount > 0
  const canClose = !isScanning && !isSavingChanges

  const stage = scanStage?.stage ?? 'scanning'
  const isCleanupStage = stage === 'cleanup'
  const scanPercent = scanProgress && scanProgress.total > 0
    ? (scanProgress.current / scanProgress.total) * 100
    : 0
  const displayScanPercent = isCleanupStage ? 100 : scanPercent

  const scanFileName = scanProgress?.file
    ? scanProgress.file.split('/').pop() || scanProgress.file.split('\\').pop() || scanProgress.file
    : ''
  const scanTitle = stage === 'backfill'
    ? 'Processing Metadata'
    : stage === 'cleanup'
      ? 'Finalizing Library'
      : 'Scanning Library'
  const countUnit = stage === 'backfill' ? 'tracks' : 'files'
  const scanMessage = scanStage?.message
    ?? (!isCleanupStage ? 'Processing...' : 'Finalizing library...')
  const scanDetail = isCleanupStage ? scanMessage : (scanFileName || scanMessage)
  const showCount = !isCleanupStage && (scanProgress?.total ?? 0) > 0
  const showScanIssuePopout = Boolean(lastScanIssueLog && lastScanIssueLog.total > 0)

  const queueFolderForScan = (folderPath: string) => {
    setPendingFolderScans((current) => {
      if (current.includes(folderPath)) return current
      return [...current, folderPath]
    })
  }

  const handleClose = () => {
    if (!canClose) return
    onClose()
  }

  const isolateModalShellEvent = (event: React.MouseEvent | React.PointerEvent) => {
    event.stopPropagation()
  }

  const handleActionButtonClick = (
    action: () => void | Promise<void>
  ) => (event: React.MouseEvent<HTMLButtonElement>) => {
    stopSyntheticEventPropagation(event)
    void action()
  }

  const handleActionButtonPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }

  const getEffectiveExcludedState = (folderPath: string, entry: FolderSubdirectoryEntry): boolean => {
    const changes = pendingExclusionChangesByFolder[folderPath] ?? {}
    if (Object.prototype.hasOwnProperty.call(changes, entry.relativePath)) {
      return Boolean(changes[entry.relativePath])
    }
    return entry.excluded
  }

  const handleToggleExpand = async (folderPath: string, relativePath: string) => {
    const key = makeNodeKey(folderPath, relativePath)

    if (expandedNodes.has(key)) {
      setExpandedNodes((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      return
    }

    if (childrenCache.has(key)) {
      setExpandedNodes((prev) => new Set(prev).add(key))
      return
    }

    setLoadingNodes((prev) => new Set(prev).add(key))
    setNodeErrors((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })

    try {
      const entries = await listFolderSubdirectories(folderPath, relativePath)
      setChildrenCache((prev) => new Map(prev).set(key, entries))
      setExpandedNodes((prev) => new Set(prev).add(key))
    } catch (error) {
      console.error('Failed to load tree node:', error)
      setNodeErrors((prev) => new Map(prev).set(key, 'Could not load subfolders.'))
    } finally {
      setLoadingNodes((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleRemoveFolder = async (path: string) => {
    setRemovingPath(path)
    try {
      await removeFolder(path)

      setPendingFolderScans((current) => current.filter((folderPath) => folderPath !== path))
      setPendingExclusionChangesByFolder((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, path)) return current
        const { [path]: _removed, ...remaining } = current
        return remaining
      })

      setExpandedNodes((prev) => {
        const next = new Set(prev)
        for (const key of next) {
          if (key.startsWith(`${path}::`)) next.delete(key)
        }
        return next
      })
      setChildrenCache((prev) => {
        const next = new Map(prev)
        for (const key of next.keys()) {
          if (key.startsWith(`${path}::`)) next.delete(key)
        }
        return next
      })

      setSaveStatus({ tone: 'info', message: 'Folder removed from library.' })
    } catch (error) {
      console.error('Failed to remove folder:', error)
      setSaveStatus({ tone: 'error', message: 'Could not remove folder.' })
    } finally {
      setRemovingPath(null)
    }
  }

  const handleAddFolder = async () => {
    const addedFolderPath = await addFolderWithoutScan()
    if (!addedFolderPath) return

    queueFolderForScan(addedFolderPath)
    setSaveStatus({ tone: 'info', message: 'Folder added. Review subfolders, then Save & Scan.' })
  }

  const handleToggleExcluded = (folderPath: string, entry: FolderSubdirectoryEntry) => {
    const currentExcluded = getEffectiveExcludedState(folderPath, entry)
    const nextExcluded = !currentExcluded
    const baselineExcluded = entry.excluded

    setPendingExclusionChangesByFolder((current) => {
      const currentFolderChanges = { ...(current[folderPath] ?? {}) }

      if (nextExcluded === baselineExcluded) {
        delete currentFolderChanges[entry.relativePath]
      } else {
        currentFolderChanges[entry.relativePath] = nextExcluded
      }

      const next = { ...current }
      if (Object.keys(currentFolderChanges).length === 0) {
        delete next[folderPath]
      } else {
        next[folderPath] = currentFolderChanges
      }

      return next
    })
  }

  const handleDiscardAllPendingChanges = () => {
    setPendingExclusionChangesByFolder({})
  }

  const handleSaveAndScan = async () => {
    if (isSavingChanges || isScanning || pendingScanCount === 0) return

    setIsSavingChanges(true)
    setSaveStatus({ tone: 'info', message: 'Saving library changes...' })

    try {
      const scanTargets = new Set(pendingScanFolderPaths)

      const exclusionPromises: Promise<void>[] = []
      for (const [folderPath, changes] of Object.entries(pendingExclusionChangesByFolder)) {
        const updates = Object.entries(changes)
        if (updates.length === 0) continue
        scanTargets.add(folderPath)

        for (const [relativePath, excluded] of updates) {
          exclusionPromises.push(
            setFolderSubfolderExcluded(folderPath, relativePath, excluded).then((result) => {
              if (!result) throw new Error(`Failed to update exclusion for ${folderPath}:${relativePath}`)
            })
          )
        }
      }
      if (exclusionPromises.length > 0) {
        await Promise.all(exclusionPromises)
      }

      const folderPathsToScan = Array.from(scanTargets)
      let scannedFolders = 0
      let canceled = false
      if (folderPathsToScan.length > 0) {
        const scanResult = await scanFolders(folderPathsToScan)
        scannedFolders = scanResult.scannedFolders
        canceled = scanResult.canceled
      }

      setPendingExclusionChangesByFolder({})
      setPendingFolderScans((current) => {
        const completedFolderSet = new Set(folderPathsToScan.slice(0, scannedFolders))
        const remainingFolderPaths = folderPathsToScan.slice(scannedFolders)
        const next = current.filter((folderPath) => !completedFolderSet.has(folderPath))
        for (const folderPath of remainingFolderPaths) {
          if (!next.includes(folderPath)) {
            next.push(folderPath)
          }
        }
        return next
      })

      // Invalidate tree cache for scanned folders so re-expand fetches fresh data
      setChildrenCache((prev) => {
        const next = new Map(prev)
        for (const fp of folderPathsToScan) {
          for (const key of next.keys()) {
            if (key.startsWith(`${fp}::`)) next.delete(key)
          }
        }
        return next
      })

      if (canceled) {
        const remainingFolders = Math.max(0, folderPathsToScan.length - scannedFolders)
        setSaveStatus({
          tone: 'info',
          message: `Scan canceled. ${scannedFolders} folder${scannedFolders === 1 ? '' : 's'} completed, ${remainingFolders} still queued.`
        })
      } else {
        setSaveStatus({
          tone: 'success',
          message: `Saved and scanned ${folderPathsToScan.length} folder${folderPathsToScan.length === 1 ? '' : 's'}.`
        })
      }
    } catch (error) {
      console.error('Failed to save and scan library changes:', error)
      setSaveStatus({ tone: 'error', message: 'Could not save changes. Please try again.' })
    } finally {
      setIsSavingChanges(false)
    }
  }

  const renderTreeNode = ({
    elementKey,
    folderPath,
    entry,
    guideMask,
    isLast,
  }: {
    elementKey: string
    folderPath: string
    entry: FolderSubdirectoryEntry
    guideMask: boolean[]
    isLast: boolean
  }) => {
    const key = makeNodeKey(folderPath, entry.relativePath)
    const isExpanded = expandedNodes.has(key)
    const isLoading = loadingNodes.has(key)
    const children = childrenCache.get(key)
    const effectiveExcluded = getEffectiveExcludedState(folderPath, entry)
    const hasPendingOverride = Object.prototype.hasOwnProperty.call(
      pendingExclusionChangesByFolder[folderPath] ?? {}, entry.relativePath
    )
    const error = nodeErrors.get(key)
    const childMask = [...guideMask, !isLast]

    const issueCount = subfolderIssueMap.get(key) ?? 0
    const isInaccessible = inaccessibleNodeKeys.has(key)
    const hasChildIssues = !isInaccessible && issueCount === 0 && subfolderIssueMap.has(key)

    return (
      <Fragment key={elementKey}>
        <div className={`folder-tree-node ${effectiveExcluded ? 'is-excluded' : ''} ${hasPendingOverride ? 'has-pending-change' : ''}`}>
          <span className="folder-tree-guide">
            {guideMask.map((hasLine, i) => (
              <span key={i} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
            ))}
            <span className={`folder-tree-guide-branch ${isLast ? 'is-last' : ''}`} />
          </span>
          {entry.hasChildren ? (
            <button
              className={`folder-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
              onClick={handleActionButtonClick(() => handleToggleExpand(folderPath, entry.relativePath))}
              onPointerDown={handleActionButtonPointerDown}
              disabled={isScanning || isSavingChanges}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          ) : (
            <div className="folder-tree-chevron is-leaf" />
          )}
          <span className="folder-tree-name">{entry.name}</span>
          {entry.audioFileCount > 0 && (
            <span className="folder-tree-file-count">
              {entry.audioFileCount}
            </span>
          )}
          {isInaccessible && (
            <span className="folder-tree-badge inaccessible" title="Permission denied — cannot read this folder">Inaccessible</span>
          )}
          {issueCount > 0 && (
            <span className="folder-tree-issue-count" title={`${issueCount} scan error${issueCount !== 1 ? 's' : ''} in this folder`}>
              {issueCount}
            </span>
          )}
          {hasChildIssues && (
            <span className="folder-tree-issue-hint" title="Contains subfolders with issues">&bull;</span>
          )}
          {entry.missing && <span className="folder-tree-badge missing">missing</span>}
          {effectiveExcluded && <span className="folder-tree-badge excluded">Excluded</span>}
          {hasPendingOverride && <span className="folder-tree-badge unsaved">Unsaved</span>}
          <button
            className="folder-tree-toggle-btn"
            onClick={handleActionButtonClick(() => handleToggleExcluded(folderPath, entry))}
            onPointerDown={handleActionButtonPointerDown}
            disabled={isScanning || isSavingChanges}
          >
            {effectiveExcluded ? 'Include' : 'Exclude'}
          </button>
        </div>

        {isLoading && (
          <div className="folder-tree-status">
            <span className="folder-tree-guide">
              {childMask.map((hasLine, i) => (
                <span key={i} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
              ))}
            </span>
            <div className="loading-spinner-small" />
            <span>Loading...</span>
          </div>
        )}

        {error && (
          <div className="folder-tree-status">
            <span className="folder-tree-guide">
              {childMask.map((hasLine, i) => (
                <span key={i} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
              ))}
            </span>
            {error}
          </div>
        )}

        {isExpanded && children && (
          <div className="folder-tree-children">
            {children.length === 0 ? (
              <div className="folder-tree-status">
                <span className="folder-tree-guide">
                  {childMask.map((hasLine, i) => (
                    <span key={i} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
                  ))}
                </span>
                <span style={{ opacity: 0.5 }}>(empty)</span>
              </div>
            ) : (
              children.map((child, index) => (
                renderTreeNode({
                  elementKey: child.relativePath,
                  folderPath,
                  entry: child,
                  guideMask: childMask,
                  isLast: index === children.length - 1,
                })
              ))
            )}
          </div>
        )}
      </Fragment>
    )
  }

  if (!presence.shouldRender) return null
  const modalContent = (
    <div
      className="modal-overlay folder-settings-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={handleClose}
    >
      <div
        className="folder-settings-shell"
        onClick={isolateModalShellEvent}
        onMouseDown={isolateModalShellEvent}
        onPointerDown={isolateModalShellEvent}
      >
        <div className={`modal-content folder-settings ${showScanIssuePopout ? 'has-detached-issues' : ''}`}>
          <div className="folder-settings-main">
            <div className="modal-header">
              <h2>Library Folders</h2>
              <button className="modal-close" onClick={handleClose} aria-label="Close" disabled={!canClose}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>

            <div className="modal-body folder-settings-body">
              {hasPendingChanges && (
                <div className="folder-settings-pending-overview">
                  {pendingScanCount} folder{pendingScanCount === 1 ? '' : 's'} queued for scan.
                </div>
              )}

              {folders.length === 0 ? (
                <div className="folder-empty">
                  <p>No folders added to library</p>
                  <p className="folder-empty-hint">Add a folder to start scanning your music collection</p>
                </div>
              ) : (
                <div className="folder-tree">
                  {folders.map((folder) => {
                    const rootKey = makeNodeKey(folder.path, '')
                    const isExpanded = expandedNodes.has(rootKey)
                    const isLoading = loadingNodes.has(rootKey)
                    const children = childrenCache.get(rootKey)
                    const summary = folderSubfolderSummaries[folder.path]
                    const needsScan = pendingScanFolderSet.has(folder.path)
                    const rootError = nodeErrors.get(rootKey)
                    const rootIssueCount = folderIssueCountMap[folder.path] ?? 0

                    return (
                      <div key={folder.path} className="folder-tree-root-group">
                        <div className={`folder-tree-node is-root ${folder.hidden ? 'is-hidden' : ''}`}>
                          <button
                            className={`folder-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
                            onClick={handleActionButtonClick(() => handleToggleExpand(folder.path, ''))}
                            onPointerDown={handleActionButtonPointerDown}
                            disabled={isScanning || isSavingChanges}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                          <svg className="folder-tree-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                          </svg>
                          <div className="folder-tree-label">
                            <span className="folder-tree-name" title={folder.path}>{folder.path}</span>
                            <span className="folder-tree-meta">
                              {summary
                                ? formatSubfolderSummary(summary.totalSubfolders, summary.excludedSubfolders)
                                : 'Loading...'}
                            </span>
                          </div>
                          {rootIssueCount > 0 && (
                            <span className="folder-tree-issue-count" title={`${rootIssueCount} scan error${rootIssueCount !== 1 ? 's' : ''}`}>
                              {rootIssueCount}
                            </span>
                          )}
                          {needsScan && <span className="folder-tree-badge needs-scan">Needs Scan</span>}
                          {folder.hidden ? <span className="folder-tree-badge hidden">Hidden</span> : null}
                          <button
                            className="folder-visibility-toggle"
                            role="checkbox"
                            aria-checked={!folder.hidden}
                            onClick={handleActionButtonClick(() => setFolderHidden(folder.path, !folder.hidden))}
                            onPointerDown={handleActionButtonPointerDown}
                            disabled={isScanning || isSavingChanges}
                            title={folder.hidden ? 'Hidden from library — click to show' : 'Visible in library — click to hide'}
                          >
                            {folder.hidden ? (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="4" y="4" width="16" height="16" rx="3" />
                              </svg>
                            ) : (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="4" y="4" width="16" height="16" rx="3" />
                                <path d="M8 12l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </button>
                          <button
                            className="folder-remove"
                            onClick={handleActionButtonClick(() => handleRemoveFolder(folder.path))}
                            onPointerDown={handleActionButtonPointerDown}
                            disabled={removingPath === folder.path || isScanning || isSavingChanges}
                            title="Remove folder"
                          >
                            {removingPath === folder.path ? (
                              <div className="loading-spinner-small" />
                            ) : (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                              </svg>
                            )}
                          </button>
                        </div>

                        {isLoading && (
                          <div className="folder-tree-status" style={{ paddingLeft: 20 }}>
                            <div className="loading-spinner-small" />
                            <span>Loading...</span>
                          </div>
                        )}

                        {rootError && (
                          <div className="folder-tree-status" style={{ paddingLeft: 20 }}>
                            {rootError}
                          </div>
                        )}

                        {isExpanded && children && (
                          <div className="folder-tree-children">
                            {children.length === 0 ? (
                              <div className="folder-tree-status" style={{ paddingLeft: 20 }}>
                                <span style={{ opacity: 0.5 }}>(empty)</span>
                              </div>
                            ) : (
                              children.map((entry, index) => (
                                renderTreeNode({
                                  elementKey: entry.relativePath,
                                  folderPath: folder.path,
                                  entry,
                                  guideMask: [],
                                  isLast: index === children.length - 1,
                                })
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="modal-footer folder-settings-footer">
              <div className={`folder-settings-feedback ${saveStatus ? `is-${saveStatus.tone}` : ''}`}>
                {saveStatus?.message ?? (hasPendingChanges ? 'Review changes, then save to start scanning.' : '')}
              </div>

              <div className="folder-settings-footer-actions">
                {totalPendingChangeCount > 0 && (
                  <button
                    className="settings-btn"
                    onClick={handleDiscardAllPendingChanges}
                    disabled={isSavingChanges || isScanning}
                  >
                    Discard
                  </button>
                )}

                <button
                  className="add-folder-btn"
                  onClick={() => void handleAddFolder()}
                  disabled={isScanning || isSavingChanges}
                >
                  <span>+</span> Add Folder
                </button>

                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => void handleSaveAndScan()}
                  disabled={isSavingChanges || isScanning || pendingScanCount === 0}
                >
                  {(isSavingChanges || isScanning)
                    ? 'Saving...'
                    : `Save & Scan${pendingScanCount > 0 ? ` (${pendingScanCount})` : ''}`}
                </button>
              </div>
            </div>

            {isScanning && scanProgress && (
              <div className="scan-overlay folder-settings-scan-overlay">
                <div className="scan-progress">
                  <button
                    className="scan-cancel-btn"
                    onClick={() => void cancelScan()}
                    disabled={isCancelingScan}
                    aria-label="Cancel scan"
                    title="Cancel scan (Esc)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                  <div className="loading-spinner" />
                  <div className="scan-title">{scanTitle}</div>
                  {showCount && <div className="scan-count">{scanProgress.current} / {scanProgress.total} {countUnit}</div>}
                  <div className="scan-bar">
                    <div className="scan-bar-fill" style={{ width: `${displayScanPercent}%` }} />
                  </div>
                  {scanDetail && <div className="scan-file">{scanDetail}</div>}
                  <div className="scan-cancel-hint">{isCancelingScan ? 'Canceling...' : 'Press Esc to cancel'}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {showScanIssuePopout && lastScanIssueLog && (
          <div className="modal-content folder-scan-issues-window" aria-live="polite">
            <div className="folder-scan-issues-header">
              <h3>Scan Errors</h3>
              <p>{lastScanIssueLog.total} file{lastScanIssueLog.total === 1 ? '' : 's'} skipped and not indexed.</p>
              {lastScanIssueLog.truncated && (
                <p className="folder-scan-issues-subtle">Showing {lastScanIssueLog.shown} of {lastScanIssueLog.total}.</p>
              )}
            </div>
            <div className="folder-scan-issues-list">
              {lastScanIssueLog.entries.map((issue, index) => (
                <div key={`${issue.phase}:${issue.path}:${index}`} className="folder-scan-issue-item">
                  <div className="folder-scan-issue-top">
                    <span className={`folder-scan-issue-phase phase-${issue.phase}`}>{formatScanIssuePhase(issue.phase)}</span>
                    {issue.code && <span className="folder-scan-issue-code">{issue.code}</span>}
                  </div>
                  <div className="folder-scan-issue-path" title={issue.path}>{issue.path}</div>
                  <div className="folder-scan-issue-message" title={issue.message}>{issue.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(modalContent, document.body)
}
