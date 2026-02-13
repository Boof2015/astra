import { useEffect, useState } from 'react'

interface ConfirmActionModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  typedPhrase?: string | null
  isDestructive?: boolean
  isBusy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  typedPhrase = null,
  isDestructive = false,
  isBusy = false,
  onConfirm,
  onCancel,
}: ConfirmActionModalProps) {
  const [typedValue, setTypedValue] = useState('')

  useEffect(() => {
    if (isOpen) {
      setTypedValue('')
    }
  }, [isOpen])

  if (!isOpen) return null

  const requiresTypedPhrase = typeof typedPhrase === 'string' && typedPhrase.length > 0
  const typedPhraseMatches = !requiresTypedPhrase || typedValue.trim() === typedPhrase
  const confirmDisabled = isBusy || !typedPhraseMatches

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className={`modal-content confirm-action-modal ${isDestructive ? 'confirm-action-modal-danger' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">{message}</p>
          {requiresTypedPhrase && (
            <label className="confirm-action-typed-wrap">
              <span className="confirm-action-typed-label">
                Type <code>{typedPhrase}</code> to confirm
              </span>
              <input
                type="text"
                className="settings-select confirm-action-typed-input"
                value={typedValue}
                onChange={(event) => setTypedValue(event.target.value)}
                autoFocus
              />
            </label>
          )}
        </div>

        <div className="modal-footer confirm-action-footer">
          <button className="settings-btn" onClick={onCancel} disabled={isBusy}>
            {cancelLabel}
          </button>
          <button
            className={`settings-btn ${isDestructive ? 'settings-btn-danger' : 'settings-btn-primary'}`}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {isBusy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

