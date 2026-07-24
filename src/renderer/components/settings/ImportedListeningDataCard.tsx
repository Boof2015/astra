import { useCallback, useEffect, useState } from 'react'
import type { ImportedListeningSource, ListeningImportPreview } from '../../../types/listeningStats'

// Play counts and listening sessions brought in from outside Astra, and the means to take
// them back out again. Every import is tagged with its source, so removal never touches
// ratings, favorites, or listening Astra recorded itself.

function formatCount(value: number): string {
  return value.toLocaleString()
}

function formatImportedAt(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

function describeSource(entry: ImportedListeningSource): string {
  const parts: string[] = []
  if (entry.playCount > 0) parts.push(`${formatCount(entry.playCount)} plays`)
  if (entry.sessionCount > 0) parts.push(`${formatCount(entry.sessionCount)} listens`)
  if (entry.trackCount > 0) parts.push(`${formatCount(entry.trackCount)} tracks`)
  const imported = formatImportedAt(entry.importedAt)
  if (imported) parts.push(`imported ${imported}`)
  return parts.join(' · ')
}

export default function ImportedListeningDataCard() {
  const [sources, setSources] = useState<ImportedListeningSource[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSources(await window.electronAPI.library.getImportedListeningSources())
    } catch {
      setSources([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reset = () => {
    setStatus('')
    setError('')
    setWarnings([])
  }

  const importFile = async () => {
    reset()
    setPendingRemoval(null)
    setBusy(true)
    try {
      const filePath = await window.electronAPI.openFileDialog({
        title: 'Import Listening Data',
        filters: [{ name: 'Astra Listening Import', extensions: ['json'] }],
      })
      if (!filePath) return

      // Read first so the file can be rejected, and its warnings shown, before anything is
      // written to the library.
      const preview: ListeningImportPreview = await window.electronAPI.library.readListeningImportFile(filePath)
      if (!preview.ok) {
        setError(preview.error)
        return
      }
      setWarnings(preview.warnings)

      const result = await window.electronAPI.library.applyListeningImportFile(filePath)
      const summary = [
        `${formatCount(result.identitiesMatched)} of ${formatCount(result.identitiesInPayload)} tracks matched`,
        `${formatCount(result.sessionsInserted)} listens added`,
      ]
      if (result.playCountsUpdated > 0) {
        summary.push(`${formatCount(result.playCountsUpdated)} play counts updated`)
      }
      setStatus(`Imported from ${preview.source}. ${summary.join(', ')}.`)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to import listening data.')
    } finally {
      setBusy(false)
    }
  }

  const removeSource = async (source: string) => {
    reset()
    setBusy(true)
    try {
      const removal = await window.electronAPI.library.removeImportedListeningSource(source)
      setStatus(`Removed ${source}. ${formatCount(removal.sessionsRemoved)} listens deleted.`)
      setPendingRemoval(null)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to remove imported data.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-label">Imported Listening Data</div>
      <div className="settings-grid">
        <div className="settings-field settings-field-inline">
          <span className="settings-field-label">External History</span>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={importFile}
            disabled={busy}
          >
            {busy ? 'Working...' : 'Import Listening Data'}
          </button>
        </div>
      </div>

      {status && <p className="settings-note settings-note-success">{status}</p>}
      {error && <p className="settings-note settings-note-error">{error}</p>}
      {warnings.length > 0 && (
        <div className="settings-import-warnings">
          {warnings.map((warning) => (
            <p key={warning} className="settings-note settings-note-warning">{warning}</p>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <div className="settings-import-sources">
          {sources.map((entry) => (
            <div key={entry.source} className="settings-import-source">
              <div className="settings-import-source-text">
                <span className="settings-import-source-name">{entry.source}</span>
                <span className="settings-import-source-meta">{describeSource(entry)}</span>
                {entry.generator && (
                  <span className="settings-import-source-generator">via {entry.generator}</span>
                )}
              </div>
              {pendingRemoval === entry.source ? (
                <div className="settings-import-source-confirm">
                  <button
                    type="button"
                    className="settings-btn settings-btn-danger"
                    onClick={() => removeSource(entry.source)}
                    disabled={busy}
                  >
                    Remove Everything
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => setPendingRemoval(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => { reset(); setPendingRemoval(entry.source) }}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="settings-note">
        Astra reads the open <code>astra-listening-import</code> format, so third-party tools can bring in
        play counts and listening history from other services. Each source can be removed again here without
        touching ratings, favorites, or anything Astra recorded itself.
      </p>
    </div>
  )
}
