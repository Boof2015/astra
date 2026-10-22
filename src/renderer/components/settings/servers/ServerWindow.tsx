import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PresencePhase } from '../../../hooks/usePresence'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
)

/**
 * A focused window over the Servers page, for the rare tasks: adding a server,
 * changing its connection, signing in again, removing it. Uses Astra's modal
 * overlay and presence motion. Focus moves in on open (to `[data-autofocus]`, or
 * the first control) and back to whatever opened it on close; Tab stays inside.
 * While `busy`, the window can't be closed, so a half-finished change isn't left behind.
 */
export function ServerWindow({ phase, title, subtitle, busy = false, wide = false, onClose, children, footer }: {
  phase: PresencePhase
  title: string
  subtitle?: string
  busy?: boolean
  wide?: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const pressedOverlay = useRef(false)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const first = dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (!focusable.length) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return createPortal(
    <div className="modal-overlay servers-window-overlay" data-presence={phase} aria-hidden={phase === 'exiting'}
      onMouseDown={event => { pressedOverlay.current = event.target === event.currentTarget }}
      onClick={event => { if (pressedOverlay.current && event.target === event.currentTarget && !busy) onClose() }}>
      <div ref={dialogRef} className={`modal-content servers-window${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true"
        aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="servers-window-head">
          <div className="servers-window-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="servers-window-close" aria-label="Close" disabled={busy} onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="servers-window-body">{children}</div>
        <div className="servers-window-foot">{footer}</div>
      </div>
    </div>,
    document.body
  )
}

/** A small spinner for busy buttons and the Plex browser wait. */
export const Spinner = () => <span className="servers-spinner" aria-hidden="true" />
