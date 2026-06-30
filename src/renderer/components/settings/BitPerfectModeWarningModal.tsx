import { usePresence } from '../../hooks/usePresence'

interface BitPerfectModeWarningModalProps {
  isOpen: boolean
  dontShowAgain: boolean
  onDontShowAgainChange: (checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export default function BitPerfectModeWarningModal({
  isOpen,
  dontShowAgain,
  onDontShowAgainChange,
  onCancel,
  onConfirm,
}: BitPerfectModeWarningModalProps) {
  const presence = usePresence(isOpen)
  if (!presence.shouldRender) return null

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={onCancel}>
      <div
        className="modal-content confirm-action-modal confirm-action-modal-danger exclusive-mode-warning-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Enable Bit-Perfect Exclusive Mode?</h2>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">
            Bit-perfect mode is experimental and takes exclusive/direct control of the selected output device.
          </p>
          <ul className="exclusive-mode-warning-list">
            <li>System and app volume controls may stop working on that device.</li>
            <li>Other apps may lose audio while Astra owns the device.</li>
            <li>Sample-rate switching can interrupt playback when tracks change formats.</li>
            <li>EQ, normalization, routing, and delay compensation are disabled in this mode.</li>
            <li>Use Standard mode if you want normal shared-device playback.</li>
          </ul>
          <label className="exclusive-mode-warning-checkbox">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => onDontShowAgainChange(event.target.checked)}
            />
            <span>Don&apos;t show this again</span>
          </label>
        </div>

        <div className="modal-footer confirm-action-footer">
          <button className="settings-btn" onClick={onCancel}>
            Stay in Standard
          </button>
          <button className="settings-btn settings-btn-danger" onClick={onConfirm}>
            Enable Exclusive Mode
          </button>
        </div>
      </div>
    </div>
  )
}
