import { useEffect, useMemo, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import {
  SETTINGS_TRANSFER_CATEGORY_DEFINITIONS,
  applySettingsTransferFile,
  createSettingsTransferFile,
  getImportableSettingsTransferCategoryIds,
  parseSettingsTransferFile,
  serializeSettingsTransferFile,
  type AstraSettingsTransferFile,
  type SettingsTransferCategoryId,
} from '../../utils/settingsTransfer'

type SettingsTransferMode = 'import' | 'export'

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
const WIZARD_STEPS = ['Direction', 'Details', 'Finish'] as const

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
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
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<SettingsTransferCategoryId[]>(ALL_CATEGORY_IDS)
  const [importFile, setImportFile] = useState<ImportFileState | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  const presence = usePresence(isOpen)

  useEffect(() => {
    if (!isOpen) return
    setMode(null)
    setSelectedCategoryIds(ALL_CATEGORY_IDS)
    setImportFile(null)
    setStatusMessage('')
    setErrorMessage('')
    setIsBusy(false)
  }, [isOpen])

  const visibleCategoryIds = useMemo(() => {
    if (mode === 'import' && importFile) {
      return importFile.availableCategoryIds
    }
    return ALL_CATEGORY_IDS
  }, [importFile, mode])

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
  }

  const selectMode = (nextMode: SettingsTransferMode) => {
    resetMessages()
    setMode(nextMode)
    setImportFile(null)
    setSelectedCategoryIds(nextMode === 'export' ? ALL_CATEGORY_IDS : [])
  }

  const goBackToModeChoice = () => {
    resetMessages()
    setMode(null)
    setImportFile(null)
    setSelectedCategoryIds(ALL_CATEGORY_IDS)
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
      })
      const today = new Date().toISOString().slice(0, 10)
      const filePath = await window.electronAPI.showSaveDialog({
        title: 'Export Astra Settings',
        defaultPath: `astra-settings-${today}.json`,
        filters: [{ name: 'Astra Settings', extensions: ['json'] }],
      })
      if (!filePath) return

      await window.electronAPI.writeFile(filePath, serializeSettingsTransferFile(file))
      setStatusMessage('Settings exported.')
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
    })

    if (!result.ok) {
      setErrorMessage(result.error)
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
                {SETTINGS_TRANSFER_CATEGORY_DEFINITIONS.map((category) => (
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
                  </label>
                ))}
              </div>
              <p className="settings-note">
                Library data, servers, scrobble profiles, passwords, tokens, output devices, and machine-specific
                assignments are not included.
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
            {mode === 'import' && (
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
