import { useEffect, useMemo, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import {
  DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS,
  SETTINGS_TRANSFER_CATEGORY_DEFINITIONS,
  applySettingsTransferFile,
  createSettingsTransferFile,
  getImportableSettingsTransferCategoryIds,
  parseSettingsTransferFile,
  serializeSettingsTransferFile,
  type AstraSettingsTransferFile,
  type SettingsTransferCategoryId,
} from '../../utils/settingsTransfer'
import type { ListeningStatsImportResult } from '../../../shared/stats/statsTransfer'

type SettingsTransferMode = 'import' | 'export'

// Settings exports go through their own write channel, which allows far more than the 10 MB
// bound on the general-purpose one. Stop short of that ceiling so the wizard can name the
// category responsible instead of surfacing the raw main-process error.
const SETTINGS_TRANSFER_MAX_BYTES = 250 * 1024 * 1024

interface ListeningStatsExportState {
  countsEncoded: string
  historyEncoded: string
  countsBytes: number
  historyBytes: number
  playCount: number
  ratingCount: number
  favoriteCount: number
  sessionCount: number
  sessionsTotal: number
  truncated: boolean
}

interface WizardStage {
  index: number
  eyebrow: string
  title: string
  description: string
}

interface SettingsTransferWizardProps {
  isOpen: boolean
  onClose: () => void
}

interface ImportFileState {
  path: string
  name: string
  file: AstraSettingsTransferFile
  availableCategoryIds: SettingsTransferCategoryId[]
}

const ALL_CATEGORY_IDS = SETTINGS_TRANSFER_CATEGORY_DEFINITIONS.map((definition) => definition.id)
const DEFAULT_EXPORT_CATEGORY_IDS = [...DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS]
const WIZARD_STEPS = ['Direction', 'Details', 'Finish'] as const

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function measureBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

function getExportCategoryMeta(
  categoryId: SettingsTransferCategoryId,
  statsExport: ListeningStatsExportState | null
): string | null {
  if (!statsExport) return null

  if (categoryId === 'listening_stats') {
    const parts = [`${formatCount(statsExport.playCount)} tracks`]
    if (statsExport.ratingCount > 0) parts.push(`${formatCount(statsExport.ratingCount)} rated`)
    if (statsExport.favoriteCount > 0) parts.push(`${formatCount(statsExport.favoriteCount)} favorites`)
    return `${parts.join(' · ')} · ~${formatBytes(statsExport.countsBytes)}`
  }

  if (categoryId === 'listening_history' && statsExport.sessionCount > 0) {
    return `${formatCount(statsExport.sessionCount)} sessions · ~${formatBytes(statsExport.historyBytes)}`
  }

  return null
}

function buildOversizeMessage(
  bytes: number,
  selectedCategoryIds: readonly SettingsTransferCategoryId[],
  statsExport: ListeningStatsExportState | null
): string {
  const base = `This export is ${formatBytes(bytes)}, over the ${formatBytes(SETTINGS_TRANSFER_MAX_BYTES)} file limit.`
  if (!statsExport) return `${base} Deselect a category and try again.`

  const historySelected = selectedCategoryIds.includes('listening_history')
  const countsSelected = selectedCategoryIds.includes('listening_stats')

  if (historySelected && statsExport.historyBytes >= statsExport.countsBytes) {
    return `${base} Detailed Listening History accounts for ${formatBytes(statsExport.historyBytes)} — deselect it, or export it on its own.`
  }
  if (countsSelected && statsExport.countsBytes > 0) {
    return `${base} Listening Counts & Ratings accounts for ${formatBytes(statsExport.countsBytes)} — deselect it, or export it on its own.`
  }
  return `${base} Deselect a category and try again.`
}

function buildImportSummaryLines(result: ListeningStatsImportResult): string[] {
  const lines: string[] = []

  if (result.identitiesInPayload > 0) {
    const unmatched = result.identitiesUnmatched > 0
      ? ` (${formatCount(result.identitiesUnmatched)} not in this library)`
      : ''
    lines.push(
      `${formatCount(result.identitiesMatched)} of ${formatCount(result.identitiesInPayload)} tracks matched${unmatched}.`
    )
  }

  if (result.countsApplied) {
    const parts = [
      `Play counts updated on ${formatCount(result.playCountsUpdated)} tracks`,
      `${formatCount(result.ratingsApplied)} ratings`,
      `${formatCount(result.favoritesAdded)} favorites`,
    ]
    lines.push(`${parts.join(' · ')}.`)
    if (result.ratingsKeptLocal > 0) {
      lines.push(`${formatCount(result.ratingsKeptLocal)} ratings kept because this install had newer ones.`)
    }
  }

  if (result.historyApplied) {
    lines.push(
      `${formatCount(result.sessionsInserted)} listening sessions added, ${formatCount(result.sessionsMerged)} merged.`
    )
    if (result.sessionsTruncatedAtExport) {
      lines.push('The source file was truncated at export, so older sessions were not included.')
    }
  }

  return lines
}

function getCategorySummary(categoryIds: readonly SettingsTransferCategoryId[]): string {
  if (categoryIds.length === 1) return '1 category selected'
  return `${categoryIds.length} categories selected`
}

function getStage(
  mode: SettingsTransferMode | null,
  importFile: ImportFileState | null,
  statusMessage: string
): WizardStage {
  if (statusMessage) {
    return {
      index: 2,
      eyebrow: 'Step 3 of 3',
      title: 'Finish transfer',
      description: statusMessage,
    }
  }

  if (!mode) {
    return {
      index: 0,
      eyebrow: 'Step 1 of 3',
      title: 'Choose a transfer direction',
      description: 'Move portable settings into this Astra or create a settings file for another install.',
    }
  }

  if (mode === 'import' && !importFile) {
    return {
      index: 1,
      eyebrow: 'Step 2 of 3',
      title: 'Choose a settings file',
      description: 'Pick an Astra settings export, then choose which portable categories to import.',
    }
  }

  return {
    index: 1,
    eyebrow: 'Step 2 of 3',
    title: mode === 'export' ? 'Choose what to export' : 'Review what to import',
    description: mode === 'export'
      ? 'Select the portable categories to write into the settings file.'
      : 'Select the portable categories to replace on this Astra install.',
  }
}

export default function SettingsTransferWizard({ isOpen, onClose }: SettingsTransferWizardProps) {
  const [mode, setMode] = useState<SettingsTransferMode | null>(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<SettingsTransferCategoryId[]>(DEFAULT_EXPORT_CATEGORY_IDS)
  const [importFile, setImportFile] = useState<ImportFileState | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [statsExport, setStatsExport] = useState<ListeningStatsExportState | null>(null)
  const [importSummaryLines, setImportSummaryLines] = useState<string[]>([])
  const [awaitingReload, setAwaitingReload] = useState(false)

  const presence = usePresence(isOpen)

  useEffect(() => {
    if (!isOpen) return
    setMode(null)
    setSelectedCategoryIds(DEFAULT_EXPORT_CATEGORY_IDS)
    setImportFile(null)
    setStatusMessage('')
    setErrorMessage('')
    setIsBusy(false)
    setStatsExport(null)
    setImportSummaryLines([])
    setAwaitingReload(false)
  }, [isOpen])

  // Loading the payloads up front lets each category show its real row count and size
  // before the user commits to a save location.
  useEffect(() => {
    if (mode !== 'export') return
    let cancelled = false

    void (async () => {
      try {
        // Deliberately not gated on the Listening Stats experiment: sessions are recorded
        // regardless of whether that page is switched on, so gating here would hide the
        // user's own data from them. Only whether any sessions exist matters.
        const availability = await window.electronAPI.library.getListeningStatsTransferAvailability()
        const bundle = await window.electronAPI.library.exportListeningStatsTransfer({
          includeHistory: availability.hasHistory,
        })
        if (cancelled) return
        setStatsExport({
          countsEncoded: bundle.counts.encoded,
          historyEncoded: bundle.history?.encoded ?? '',
          countsBytes: measureBytes(bundle.counts.encoded),
          historyBytes: bundle.history ? measureBytes(bundle.history.encoded) : 0,
          playCount: bundle.counts.playCount,
          ratingCount: bundle.counts.ratingCount,
          favoriteCount: bundle.counts.favoriteCount,
          sessionCount: bundle.history?.sessionCount ?? 0,
          sessionsTotal: bundle.history?.sessionsTotal ?? 0,
          truncated: bundle.history?.truncated ?? false,
        })
      } catch {
        if (!cancelled) setStatsExport(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [mode])

  const visibleCategoryIds = useMemo(() => {
    if (mode === 'import' && importFile) {
      return importFile.availableCategoryIds
    }
    // History has nothing to offer when this install has no sessions, or when the stats
    // experiment that produces them is off. Import is never gated this way — the same file
    // may be switching the experiment on in the very same pass.
    if (mode === 'export' && statsExport && statsExport.sessionCount === 0) {
      return ALL_CATEGORY_IDS.filter((categoryId) => categoryId !== 'listening_history')
    }
    return ALL_CATEGORY_IDS
  }, [importFile, mode, statsExport])

  const selectedVisibleCategoryIds = useMemo(
    () => selectedCategoryIds.filter((categoryId) => visibleCategoryIds.includes(categoryId)),
    [selectedCategoryIds, visibleCategoryIds]
  )
  const stage = useMemo(
    () => getStage(mode, importFile, statusMessage),
    [importFile, mode, statusMessage]
  )

  if (!presence.shouldRender) return null

  const resetMessages = () => {
    setStatusMessage('')
    setErrorMessage('')
    setImportSummaryLines([])
  }

  const selectMode = (nextMode: SettingsTransferMode) => {
    resetMessages()
    setMode(nextMode)
    setImportFile(null)
    setSelectedCategoryIds(nextMode === 'export' ? DEFAULT_EXPORT_CATEGORY_IDS : [])
  }

  const goBackToModeChoice = () => {
    resetMessages()
    setMode(null)
    setImportFile(null)
    setSelectedCategoryIds(DEFAULT_EXPORT_CATEGORY_IDS)
  }

  const toggleCategory = (categoryId: SettingsTransferCategoryId) => {
    resetMessages()
    setSelectedCategoryIds((current) => (
      current.includes(categoryId)
        ? current.filter((id) => id !== categoryId)
        : [...current, categoryId]
    ))
  }

  const selectAllVisible = () => {
    resetMessages()
    setSelectedCategoryIds(visibleCategoryIds)
  }

  const selectNone = () => {
    resetMessages()
    setSelectedCategoryIds([])
  }

  const chooseImportFile = async () => {
    resetMessages()
    setIsBusy(true)
    try {
      const filePath = await window.electronAPI.openFileDialog({
        title: 'Import Astra Settings',
        filters: [{ name: 'Astra Settings', extensions: ['json'] }],
      })
      if (!filePath) return

      const content = await window.electronAPI.readTextFile(filePath)
      const parsed = parseSettingsTransferFile(content)
      if (!parsed.ok) {
        setImportFile(null)
        setSelectedCategoryIds([])
        setErrorMessage(parsed.error)
        return
      }

      const availableCategoryIds = getImportableSettingsTransferCategoryIds(parsed.file)
      setImportFile({
        path: filePath,
        name: getFileName(filePath),
        file: parsed.file,
        availableCategoryIds,
      })
      setSelectedCategoryIds(availableCategoryIds)
      if (availableCategoryIds.length === 0) {
        setErrorMessage('This settings file does not contain any portable settings categories.')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to read settings file.')
    } finally {
      setIsBusy(false)
    }
  }

  const exportSettings = async () => {
    resetMessages()
    if (selectedVisibleCategoryIds.length === 0) {
      setErrorMessage('Select at least one category to export.')
      return
    }

    setIsBusy(true)
    try {
      const appVersion = await window.electronAPI.getAppVersion().catch(() => null)
      const lyricsStatus = await window.electronAPI.lyrics.getStatus().catch(() => null)
      const file = createSettingsTransferFile(selectedVisibleCategoryIds, {
        appVersion,
        lyricsOnlineEnabled: lyricsStatus?.enabled ?? false,
        lyricsLrclibBaseUrl: lyricsStatus?.lrclibBaseUrl,
        listeningCountsEncoded: selectedVisibleCategoryIds.includes('listening_stats')
          ? statsExport?.countsEncoded
          : undefined,
        listeningHistoryEncoded: selectedVisibleCategoryIds.includes('listening_history')
          ? statsExport?.historyEncoded
          : undefined,
      })

      const content = serializeSettingsTransferFile(file)
      const bytes = measureBytes(content)
      if (bytes > SETTINGS_TRANSFER_MAX_BYTES) {
        setErrorMessage(buildOversizeMessage(bytes, selectedVisibleCategoryIds, statsExport))
        return
      }

      const today = new Date().toISOString().slice(0, 10)
      const filePath = await window.electronAPI.showSaveDialog({
        title: 'Export Astra Settings',
        defaultPath: `astra-settings-${today}.json`,
        filters: [{ name: 'Astra Settings', extensions: ['json'] }],
      })
      if (!filePath) return

      await window.electronAPI.writeSettingsTransferFile(filePath, content)
      setStatusMessage(
        statsExport?.truncated && selectedVisibleCategoryIds.includes('listening_history')
          ? `Settings exported. Listening history included the ${formatCount(statsExport.sessionCount)} most recent of ${formatCount(statsExport.sessionsTotal)} sessions.`
          : 'Settings exported.'
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to export settings.')
    } finally {
      setIsBusy(false)
    }
  }

  const importSettings = async () => {
    resetMessages()
    if (!importFile) {
      setErrorMessage('Choose a settings file first.')
      return
    }
    if (selectedVisibleCategoryIds.length === 0) {
      setErrorMessage('Select at least one category to import.')
      return
    }

    setIsBusy(true)
    const result = await applySettingsTransferFile(importFile.file, selectedVisibleCategoryIds, {
      setLyricsOnlineEnabled: async (enabled) => {
        await window.electronAPI.lyrics.setEnabled(enabled)
      },
      setLyricsLrclibBaseUrl: async (baseUrl) => {
        await window.electronAPI.lyrics.setLrclibBaseUrl(baseUrl)
      },
      applyListeningStatsTransfer: async (request) => {
        return window.electronAPI.library.applyListeningStatsTransfer(request)
      },
    })

    if (!result.ok) {
      setErrorMessage(result.error)
      setIsBusy(false)
      return
    }

    // A listening import produces counts worth reading, and the auto-reload would wipe them
    // off screen. Hand the reload to the user instead.
    if (result.listeningStats) {
      setImportSummaryLines(buildImportSummaryLines(result.listeningStats))
      setStatusMessage('Listening data imported.')
      setAwaitingReload(true)
      setIsBusy(false)
      return
    }

    setStatusMessage('Settings imported. Reloading...')
    window.setTimeout(() => {
      window.location.reload()
    }, 250)
  }

  return (
    <div
      className="modal-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={isBusy ? undefined : onClose}
    >
      <div
        className="modal-content settings-transfer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-transfer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header settings-transfer-header">
          <div>
            <p className="settings-transfer-step-label">
              {mode ? (mode === 'export' ? 'Export settings' : 'Import settings') : 'Settings transfer'}
            </p>
            <h2 id="settings-transfer-title">Move Astra settings</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={isBusy}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="settings-transfer-stepper" aria-label="Settings transfer progress">
          {WIZARD_STEPS.map((stepLabel, index) => (
            <div
              key={stepLabel}
              className={`settings-transfer-step ${index === stage.index ? 'active' : ''} ${index < stage.index ? 'complete' : ''}`}
            >
              <span className="settings-transfer-step-dot">{index + 1}</span>
              <span className="settings-transfer-step-text">{stepLabel}</span>
            </div>
          ))}
        </div>

        <div className="modal-body settings-transfer-body">
          {statusMessage && <p className="settings-note settings-note-success">{statusMessage}</p>}
          {errorMessage && <p className="settings-note settings-note-error">{errorMessage}</p>}

          {importSummaryLines.length > 0 && (
            <div className="settings-transfer-summary">
              {importSummaryLines.map((line) => (
                <p key={line} className="settings-transfer-summary-row">{line}</p>
              ))}
            </div>
          )}

          <div className="settings-transfer-stage-card">
            <div>
              <p className="settings-transfer-stage-eyebrow">{stage.eyebrow}</p>
              <h3>{stage.title}</h3>
              <p>{stage.description}</p>
            </div>
            {mode && (
              <span className="settings-transfer-stage-badge">
                {mode === 'export' ? 'Export' : 'Import'}
              </span>
            )}
          </div>

          {!mode && (
            <div className="settings-transfer-mode-grid">
              <button type="button" className="settings-transfer-mode-card" onClick={() => selectMode('import')}>
                <span className="settings-transfer-mode-number">01</span>
                <span className="settings-transfer-mode-title">Import to this Astra</span>
                <span className="settings-transfer-mode-description">
                  Bring portable settings from another Astra export into this install.
                </span>
              </button>
              <button type="button" className="settings-transfer-mode-card" onClick={() => selectMode('export')}>
                <span className="settings-transfer-mode-number">02</span>
                <span className="settings-transfer-mode-title">Export from this Astra</span>
                <span className="settings-transfer-mode-description">
                  Save portable settings from this install to a JSON file.
                </span>
              </button>
            </div>
          )}

          {mode === 'import' && (
            <div className="settings-transfer-flow">
              <div className="settings-transfer-file-row">
                <div>
                  <span className="settings-transfer-file-kicker">Source file</span>
                  <p className="settings-transfer-file-title">
                    {importFile ? importFile.name : 'No settings file selected'}
                  </p>
                  <p className="settings-transfer-file-description">
                    {importFile
                      ? `Exported ${importFile.file.exportedAt || 'from another Astra install'}`
                      : 'Choose a JSON file exported from Astra settings transfer.'}
                  </p>
                </div>
                <button className="settings-btn" onClick={chooseImportFile} disabled={isBusy}>
                  {importFile ? 'Choose Different File' : 'Choose File'}
                </button>
              </div>

              {importFile && (
                <>
                  <div className="settings-transfer-list-head">
                    <span>{getCategorySummary(selectedVisibleCategoryIds)}</span>
                    <div className="settings-transfer-list-actions">
                      <button className="settings-link-btn" onClick={selectAllVisible} disabled={isBusy}>
                        Select All
                      </button>
                      <button className="settings-link-btn" onClick={selectNone} disabled={isBusy}>
                        None
                      </button>
                    </div>
                  </div>
                  <div className="settings-transfer-category-list">
                    {SETTINGS_TRANSFER_CATEGORY_DEFINITIONS.map((category) => {
                      const available = importFile.availableCategoryIds.includes(category.id)
                      return (
                        <label
                          key={category.id}
                          className={`settings-transfer-category ${available ? '' : 'disabled'}`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedCategoryIds.includes(category.id)}
                            onChange={() => toggleCategory(category.id)}
                            disabled={!available || isBusy}
                          />
                          <span>
                            <span className="settings-transfer-category-title">{category.label}</span>
                            <span className="settings-transfer-category-description">
                              {available ? category.description : 'Not included in this file.'}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {mode === 'export' && (
            <div className="settings-transfer-flow">
              <div className="settings-transfer-list-head">
                <span>{getCategorySummary(selectedVisibleCategoryIds)}</span>
                <div className="settings-transfer-list-actions">
                  <button className="settings-link-btn" onClick={selectAllVisible} disabled={isBusy}>
                    Select All
                  </button>
                  <button className="settings-link-btn" onClick={selectNone} disabled={isBusy}>
                    None
                  </button>
                </div>
              </div>
              <div className="settings-transfer-category-list">
                {SETTINGS_TRANSFER_CATEGORY_DEFINITIONS
                  .filter((category) => visibleCategoryIds.includes(category.id))
                  .map((category) => {
                    const meta = getExportCategoryMeta(category.id, statsExport)
                    return (
                      <label key={category.id} className="settings-transfer-category">
                        <input
                          type="checkbox"
                          checked={selectedCategoryIds.includes(category.id)}
                          onChange={() => toggleCategory(category.id)}
                          disabled={isBusy}
                        />
                        <span>
                          <span className="settings-transfer-category-title">{category.label}</span>
                          <span className="settings-transfer-category-description">{category.description}</span>
                        </span>
                        {meta && <span className="settings-transfer-category-meta">{meta}</span>}
                      </label>
                    )
                  })}
              </div>
              <p className="settings-note">
                Servers, scrobble profiles, passwords, tokens, output devices, and machine-specific assignments are
                not included. Library files themselves are not included — listening data travels as track names and
                is matched against whatever this install already has.
              </p>
            </div>
          )}
        </div>

        <div className="modal-footer settings-transfer-footer">
          <button className="settings-btn" onClick={mode ? goBackToModeChoice : onClose} disabled={isBusy}>
            {mode ? 'Back' : 'Cancel'}
          </button>
          <div className="settings-transfer-footer-actions">
            {mode === 'export' && (
              <button
                className="settings-btn settings-btn-primary"
                onClick={exportSettings}
                disabled={isBusy || selectedVisibleCategoryIds.length === 0}
              >
                {isBusy ? 'Exporting...' : 'Export'}
              </button>
            )}
            {mode === 'import' && awaitingReload && (
              <button
                className="settings-btn settings-btn-primary"
                onClick={() => window.location.reload()}
              >
                Reload Astra
              </button>
            )}
            {mode === 'import' && !awaitingReload && (
              <button
                className="settings-btn settings-btn-primary"
                onClick={importSettings}
                disabled={isBusy || !importFile || selectedVisibleCategoryIds.length === 0}
              >
                {isBusy ? 'Importing...' : 'Import and Reload'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
