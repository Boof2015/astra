import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ServerEntry } from './useServers'

export type ServerMenuAction = 'connection' | 'remove'

/**
 * Astra's playback shortcuts listen on the document (Space plays/pauses, ↑/↓ change the
 * volume) and cancel the key's default. Keys that operate this menu stop here so they
 * do one thing. Activation keys keep their default, so the focused button still clicks.
 */
const ACTIVATION_KEYS = new Set([' ', 'Enter'])

const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
  </svg>
)

/** Rare actions for a server: changing how Astra signs in to it, and removing it. */
export function ServerMenu({ server, onAction }: { server: ServerEntry; onAction: (action: ServerMenuAction) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const focus = (next: number) => items[(next + items.length) % items.length]?.focus()
    if (ACTIVATION_KEYS.has(event.key)) {
      event.stopPropagation()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      focus(event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : -1)
    } else if (event.key === 'Tab') {
      close(false)
    }
  }
  // Focus goes back to ··· first, so the window that opens returns it there when it closes.
  const choose = (action: ServerMenuAction) => {
    close(true)
    onAction(action)
  }

  return (
    <div className="servers-menu-wrap" ref={wrapRef}>
      <button ref={buttonRef} type="button" className="servers-icon-btn" aria-label={`More actions for ${server.name}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (ACTIVATION_KEYS.has(event.key)) event.stopPropagation() }}>
        <MoreIcon />
      </button>
      {open && (
        <div ref={menuRef} className="servers-menu" role="menu" aria-label={server.name} onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" onClick={() => choose('connection')}>
            {server.provider === 'plex' ? 'Sign in again…' : 'Change connection…'}
          </button>
          <hr />
          <button type="button" role="menuitem" className="is-danger" onClick={() => choose('remove')}>Remove server…</button>
        </div>
      )}
    </div>
  )
}
