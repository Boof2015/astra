import type { MetadataSaveMode } from '../../stores/metadataEditorStore'
import { usePresence } from '../../hooks/usePresence'

export interface DiffEntry {
  field: string
  oldValue: string
  newValue: string
}

interface DiffConfirmModalProps {
  isOpen: boolean
  mode: MetadataSaveMode
  trackCount: number
  diffs: DiffEntry[]
  onConfirm: () => void
  onCancel: () => void
}

export default function DiffConfirmModal({
  isOpen,
  mode,
  trackCount,
  diffs,
  onConfirm,
  onCancel
}: DiffConfirmModalProps) {
  const presence = usePresence(isOpen ? { mode, trackCount, diffs } : null)
  if (!presence.shouldRender || !presence.presentValue) return null
  const displayed = presence.presentValue

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={onCancel}>
      <div
        className="modal-content metadata-diff-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Confirm Metadata Changes</h2>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <p className="metadata-diff-summary">
            {displayed.trackCount} track{displayed.trackCount !== 1 ? 's' : ''} will be updated via{' '}
            <strong>{displayed.mode === 'file' ? 'file tag write' : 'virtual override'}</strong>.
          </p>

          <table className="metadata-diff-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Current</th>
                <th />
                <th>New</th>
              </tr>
            </thead>
            <tbody>
              {displayed.diffs.map((diff) => (
                <tr key={diff.field}>
                  <td>{diff.field}</td>
                  <td className="metadata-diff-old">{diff.oldValue}</td>
                  <td className="metadata-diff-arrow">&rarr;</td>
                  <td className="metadata-diff-new">{diff.newValue}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {displayed.mode === 'file' && (
            <div className="metadata-diff-file-warning">
              File tag writes are irreversible. The original file metadata will be overwritten.
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="settings-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`settings-btn ${mode === 'file' ? 'settings-btn-danger' : 'settings-btn-primary'}`}
            onClick={onConfirm}
          >
            {mode === 'file' ? 'Write to Files' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
