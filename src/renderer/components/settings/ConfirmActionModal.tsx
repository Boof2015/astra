import { useEffect, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'

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
  const presence = usePresence(isOpen ? {
    title,
    message,
    confirmLabel,
    cancelLabel,
    typedPhrase,
    isDestructive
  } : null)

  useEffect(() => {
    if (isOpen) {
      setTypedValue('')
    }
  }, [isOpen])

  if (!presence.shouldRender || !presence.presentValue) return null

  const displayed = presence.presentValue

  const requiresTypedPhrase = typeof displayed.typedPhrase === 'string' && displayed.typedPhrase.length > 0
  const typedPhraseMatches = !requiresTypedPhrase || typedValue.trim() === displayed.typedPhrase
  const confirmDisabled = isBusy || !typedPhraseMatches

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={onCancel}>
      <div
        className={`modal-content confirm-action-modal ${displayed.isDestructive ? 'confirm-action-modal-danger' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{displayed.title}</h2>
          <button className="modal-close" onClick={onCancel} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">{displayed.message}</p>
          {requiresTypedPhrase && (
            <label className="confirm-action-typed-wrap">
              <span className="confirm-action-typed-label">
                Type <code>{displayed.typedPhrase}</code> to confirm
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
            {displayed.cancelLabel}
          </button>
          <button
            className={`settings-btn ${displayed.isDestructive ? 'settings-btn-danger' : 'settings-btn-primary'}`}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {isBusy ? 'Working...' : displayed.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
