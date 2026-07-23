import LocalizedText from '../i18n/LocalizedText'
import { translate, translateSourceText } from '../../i18n'
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
          <h2><LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.confirm_metadata_changes" /></h2>
          <button className="modal-close" onClick={onCancel} aria-label={translate('common:auto.diffconfirmmodal.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <p className="metadata-diff-summary">
            {translate('common:metadata.updateSummary', {
              count: displayed.trackCount,
              mode: translate(displayed.mode === 'file'
                ? 'common:metadata.fileTagWrite'
                : 'common:metadata.virtualOverride')
            })}
          </p>

          <table className="metadata-diff-table">
            <thead>
              <tr>
                <th><LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.field" /></th>
                <th><LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.current" /></th>
                <th />
                <th><LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.new" /></th>
              </tr>
            </thead>
            <tbody>
              {displayed.diffs.map((diff) => (
                <tr key={diff.field}>
                  <td>{translateSourceText(diff.field)}</td>
                  <td className="metadata-diff-old">{translateSourceText(diff.oldValue)}</td>
                  <td className="metadata-diff-arrow"><LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.rarr" /></td>
                  <td className="metadata-diff-new">{translateSourceText(diff.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {displayed.mode === 'file' && (
            <div className="metadata-diff-file-warning">

              <LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.file_tag_writes_are_irreversible_the_original_file_metad" />
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="settings-btn" onClick={onCancel}>

            <LocalizedText ns="common" i18nKey="auto.diffconfirmmodal.cancel" />
          </button>
          <button
            className={`settings-btn ${mode === 'file' ? 'settings-btn-danger' : 'settings-btn-primary'}`}
            onClick={onConfirm}
          >
            {mode === 'file' ? translate('common:auto.diffconfirmmodal.write_to_files') : translate('common:auto.diffconfirmmodal.save_changes')}
          </button>
        </div>
      </div>
    </div>
  )
}
