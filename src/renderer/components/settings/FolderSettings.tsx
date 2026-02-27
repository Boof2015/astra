import { useEffect, useMemo, useState } from 'react'
import { type FolderSubdirectoryEntry, useLibraryStore } from '../../stores/libraryStore'

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
    return `${totalSubfolders} found • ${excludedSubfolders} excluded`
  }

  return `${totalSubfolders} found`
}

function getParentPath(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf('/')
  if (separatorIndex === -1) return ''
  return relativePath.slice(0, separatorIndex)
}

export default function FolderSettings({ isOpen, onClose }: FolderSettingsProps) {
  const {
    folders,
    loadFolders,
    addFolderWithoutScan,
    removeFolder,
    isScanning,
    isCancelingScan,
    scanProgress,
    scanStage,
    folderWarnings,
    folderSubfolderSummaries,
    loadFolderSubfolderSummary,
    listFolderSubdirectories,
    setFolderSubfolderExcluded,
    scanFolders,
    cancelScan,
  } = useLibraryStore()

  const [removingPath, setRemovingPath] = useState<string | null>(null)
  const [expandedWarning, setExpandedWarning] = useState<string | null>(null)
  const [activeFolderPath, setActiveFolderPath] = useState<string | null>(null)
  const [currentRelativePath, setCurrentRelativePath] = useState('')
  const [subdirectories, setSubdirectories] = useState<FolderSubdirectoryEntry[]>([])
  const [isSubdirectoryLoading, setIsSubdirectoryLoading] = useState(false)
  const [subdirectoryError, setSubdirectoryError] = useState<string | null>(null)
  const [pendingExclusionChangesByFolder, setPendingExclusionChangesByFolder] = useState<Record<string, Record<string, boolean>>>({})
  const [pendingFolderScans, setPendingFolderScans] = useState<string[]>([])
  const [isSavingChanges, setIsSavingChanges] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null)

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
    if (!activeFolderPath) return
    if (folders.some((folder) => folder.path === activeFolderPath)) return
    setActiveFolderPath(null)
    setCurrentRelativePath('')
    setSubdirectories([])
    setSubdirectoryError(null)
  }, [activeFolderPath, folders])

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
    setActiveFolderPath(null)
    setCurrentRelativePath('')
    setSubdirectories([])
    setSubdirectoryError(null)
    setIsSubdirectoryLoading(false)
    setExpandedWarning(null)
    setRemovingPath(null)
  }, [isOpen])

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

  const breadcrumbSegments = useMemo(
    () => currentRelativePath.split('/').filter((segment) => segment.length > 0),
    [currentRelativePath]
  )

  const activeFolderPendingChanges = useMemo(
    () => activeFolderPath ? (pendingExclusionChangesByFolder[activeFolderPath] ?? {}) : {},
    [activeFolderPath, pendingExclusionChangesByFolder]
  )

  const pendingChangeCount = useMemo(
    () => Object.keys(activeFolderPendingChanges).length,
    [activeFolderPendingChanges]
  )

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

  const queueFolderForScan = (folderPath: string) => {
    setPendingFolderScans((current) => {
      if (current.includes(folderPath)) return current
      return [...current, folderPath]
    })
  }

  const loadSubdirectoryBranch = async (folderPath: string, relativePath: string = '') => {
    setIsSubdirectoryLoading(true)
    setSubdirectoryError(null)
    try {
      const entries = await listFolderSubdirectories(folderPath, relativePath)
      setSubdirectories(entries)
      setCurrentRelativePath(relativePath)
    } catch (error) {
      console.error('Failed to load subdirectories:', error)
      setSubdirectoryError('Could not load subfolders right now.')
      setSubdirectories([])
    } finally {
      setIsSubdirectoryLoading(false)
    }
  }

  const handleClose = () => {
    if (!canClose) return
    onClose()
  }

  const getEffectiveExcludedState = (entry: FolderSubdirectoryEntry): boolean => {
    if (Object.prototype.hasOwnProperty.call(activeFolderPendingChanges, entry.relativePath)) {
      return Boolean(activeFolderPendingChanges[entry.relativePath])
    }
    return entry.excluded
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

      if (activeFolderPath === path) {
        setActiveFolderPath(null)
        setCurrentRelativePath('')
        setSubdirectories([])
        setSubdirectoryError(null)
      }

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

  const handleOpenSubfolders = async (folderPath: string) => {
    setActiveFolderPath(folderPath)
    await loadSubdirectoryBranch(folderPath, '')
  }

  const handleBackToFolders = () => {
    setActiveFolderPath(null)
    setCurrentRelativePath('')
    setSubdirectories([])
    setSubdirectoryError(null)
  }

  const handleToggleSubfolderExcluded = (entry: FolderSubdirectoryEntry) => {
    if (!activeFolderPath) return

    const currentExcluded = getEffectiveExcludedState(entry)
    const nextExcluded = !currentExcluded
    const baselineExcluded = entry.excluded

    setPendingExclusionChangesByFolder((current) => {
      const currentFolderChanges = { ...(current[activeFolderPath] ?? {}) }

      if (nextExcluded === baselineExcluded) {
        delete currentFolderChanges[entry.relativePath]
      } else {
        currentFolderChanges[entry.relativePath] = nextExcluded
      }

      const next = { ...current }
      if (Object.keys(currentFolderChanges).length === 0) {
        delete next[activeFolderPath]
      } else {
        next[activeFolderPath] = currentFolderChanges
      }

      return next
    })
  }

  const handleDiscardPendingChanges = () => {
    if (!activeFolderPath) return

    setPendingExclusionChangesByFolder((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, activeFolderPath)) return current
      const { [activeFolderPath]: _discarded, ...remaining } = current
      return remaining
    })
  }

  const handleSaveAndScan = async () => {
    if (isSavingChanges || isScanning || pendingScanCount === 0) return

    setIsSavingChanges(true)
    setSaveStatus({ tone: 'info', message: 'Saving library changes...' })

    try {
      const scanTargets = new Set(pendingScanFolderPaths)

      for (const [folderPath, changes] of Object.entries(pendingExclusionChangesByFolder)) {
        const updates = Object.entries(changes)
        if (updates.length === 0) continue

        for (const [relativePath, excluded] of updates) {
          const result = await setFolderSubfolderExcluded(folderPath, relativePath, excluded)
          if (!result) {
            throw new Error(`Failed to update exclusion for ${folderPath}:${relativePath}`)
          }
        }

        scanTargets.add(folderPath)
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

      if (activeFolderPath) {
        await loadSubdirectoryBranch(activeFolderPath, currentRelativePath)
      }

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

  const handleOpenChildPath = async (entry: FolderSubdirectoryEntry) => {
    if (!activeFolderPath || !entry.hasChildren) return
    await loadSubdirectoryBranch(activeFolderPath, entry.relativePath)
  }

  const handleNavigateToBreadcrumb = async (segmentIndex: number) => {
    if (!activeFolderPath) return
    const nextRelativePath = segmentIndex < 0
      ? ''
      : breadcrumbSegments.slice(0, segmentIndex + 1).join('/')
    await loadSubdirectoryBranch(activeFolderPath, nextRelativePath)
  }

  const handleNavigateUp = async () => {
    if (!activeFolderPath) return
    const parentPath = getParentPath(currentRelativePath)
    await loadSubdirectoryBranch(activeFolderPath, parentPath)
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content folder-settings" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          {activeFolderPath ? (
            <button
              className="folder-subfolder-back-btn"
              onClick={handleBackToFolders}
              aria-label="Back to parent folders"
              disabled={isScanning || isSavingChanges}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
              </svg>
              <span>Folders</span>
            </button>
          ) : (
            <h2>Library Folders</h2>
          )}
          {activeFolderPath && (
            <div className="folder-subfolder-header-title">
              <h2>Subfolders</h2>
              <p>{activeFolderPath}</p>
            </div>
          )}
          <button className="modal-close" onClick={handleClose} aria-label="Close" disabled={!canClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {hasPendingChanges && (
            <div className="folder-settings-pending-overview">
              {pendingScanCount} folder{pendingScanCount === 1 ? '' : 's'} queued for scan.
            </div>
          )}

          {!activeFolderPath ? (
            folders.length === 0 ? (
              <div className="folder-empty">
                <p>No folders added to library</p>
                <p className="folder-empty-hint">Add a folder to start scanning your music collection</p>
              </div>
            ) : (
              <div className="folder-list">
                {folders.map((folder) => {
                  const summary = folderSubfolderSummaries[folder.path]
                  return (
                    <div key={folder.path} className="folder-item">
                      <div className="folder-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                        </svg>
                      </div>
                      <div className="folder-info">
                        <div className="folder-path">{folder.path}</div>
                        <div className="folder-meta">
                          Added {new Date(folder.added_at).toLocaleDateString()}
                        </div>
                        <div className="folder-subfolder-summary">
                          {summary
                            ? formatSubfolderSummary(summary.totalSubfolders, summary.excludedSubfolders)
                            : 'Loading subfolder counts...'}
                          {pendingScanFolderSet.has(folder.path) && (
                            <span className="folder-pending-scan-badge">Needs Scan</span>
                          )}
                        </div>
                        {folderWarnings[folder.path] && folderWarnings[folder.path].length > 0 && (
                          <div className="folder-warning">
                            <button
                              className="folder-warning-toggle"
                              onClick={() => setExpandedWarning(
                                expandedWarning === folder.path ? null : folder.path
                              )}
                            >
                              <svg className="folder-warning-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                              </svg>
                              {folderWarnings[folder.path].length} subfolder{folderWarnings[folder.path].length !== 1 ? 's' : ''} inaccessible
                            </button>
                            {expandedWarning === folder.path && (
                              <div className="folder-warning-details">
                                {folderWarnings[folder.path].map((dir) => (
                                  <div key={dir} className="folder-warning-path">{dir}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="folder-actions">
                        <button
                          className="folder-manage-subfolders"
                          onClick={() => void handleOpenSubfolders(folder.path)}
                          disabled={isScanning || isSavingChanges}
                        >
                          Subfolders
                        </button>
                        <button
                          className="folder-remove"
                          onClick={() => void handleRemoveFolder(folder.path)}
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
                    </div>
                  )
                })}
              </div>
            )
          ) : (
            <div className="folder-subfolder-view">
              <div className="folder-subfolder-toolbar">
                <div className="folder-subfolder-breadcrumb">
                  <button
                    className={`folder-subfolder-crumb ${currentRelativePath.length === 0 ? 'active' : ''}`}
                    onClick={() => void handleNavigateToBreadcrumb(-1)}
                    disabled={isSubdirectoryLoading || isScanning || isSavingChanges}
                  >
                    Root
                  </button>
                  {breadcrumbSegments.map((segment, index) => (
                    <button
                      key={`${segment}-${index}`}
                      className={`folder-subfolder-crumb ${index === breadcrumbSegments.length - 1 ? 'active' : ''}`}
                      onClick={() => void handleNavigateToBreadcrumb(index)}
                      disabled={isSubdirectoryLoading || isScanning || isSavingChanges}
                    >
                      {segment}
                    </button>
                  ))}
                </div>
                <button
                  className="folder-subfolder-up-btn"
                  onClick={() => void handleNavigateUp()}
                  disabled={currentRelativePath.length === 0 || isSubdirectoryLoading || isScanning || isSavingChanges}
                >
                  Up
                </button>
              </div>

              {pendingChangeCount > 0 && (
                <div className="folder-subfolder-pending-note">
                  {pendingChangeCount} unsaved change{pendingChangeCount === 1 ? '' : 's'}
                </div>
              )}

              {subdirectoryError ? (
                <div className="folder-subfolder-empty">
                  <p>{subdirectoryError}</p>
                </div>
              ) : isSubdirectoryLoading ? (
                <div className="folder-subfolder-empty">
                  <div className="loading-spinner" />
                  <p>Loading subfolders...</p>
                </div>
              ) : subdirectories.length === 0 ? (
                <div className="folder-subfolder-empty">
                  <p>No subfolders at this level.</p>
                </div>
              ) : (
                <div className="folder-subfolder-list">
                  {subdirectories.map((entry) => {
                    const effectiveExcluded = getEffectiveExcludedState(entry)
                    const hasPendingOverride = Object.prototype.hasOwnProperty.call(activeFolderPendingChanges, entry.relativePath)
                    return (
                      <div
                        key={entry.relativePath}
                        className={`folder-subfolder-item ${effectiveExcluded ? 'is-excluded' : ''} ${hasPendingOverride ? 'has-pending-change' : ''}`}
                      >
                        <button
                          className="folder-subfolder-entry"
                          onClick={() => void handleOpenChildPath(entry)}
                          disabled={!entry.hasChildren || isScanning || isSubdirectoryLoading || isSavingChanges}
                          title={entry.hasChildren ? 'Open subfolder' : 'No nested subfolders'}
                        >
                          <span className="folder-subfolder-name">{entry.name}</span>
                          {entry.missing && <span className="folder-subfolder-missing">missing</span>}
                          {effectiveExcluded && <span className="folder-subfolder-excluded-badge">Excluded</span>}
                          {hasPendingOverride && <span className="folder-subfolder-pending-badge">Unsaved</span>}
                        </button>
                        <button
                          className="folder-subfolder-toggle-btn"
                          onClick={() => handleToggleSubfolderExcluded(entry)}
                          disabled={isScanning || isSubdirectoryLoading || isSavingChanges}
                        >
                          {effectiveExcluded ? 'Include again' : 'Exclude'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer folder-settings-footer">
          <div className={`folder-settings-feedback ${saveStatus ? `is-${saveStatus.tone}` : ''}`}>
            {saveStatus?.message ?? (hasPendingChanges ? 'Review changes, then save to start scanning.' : '')}
          </div>

          <div className="folder-settings-footer-actions">
            {activeFolderPath && (
              <button
                className="settings-btn"
                onClick={handleDiscardPendingChanges}
                disabled={isSavingChanges || isScanning || pendingChangeCount === 0}
              >
                Discard
              </button>
            )}

            {!activeFolderPath && (
              <button
                className="add-folder-btn"
                onClick={() => void handleAddFolder()}
                disabled={isScanning || isSavingChanges}
              >
                <span>+</span> Add Folder
              </button>
            )}

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
  )
}
