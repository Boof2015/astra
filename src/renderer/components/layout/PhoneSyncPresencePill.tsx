// Library-sync presence pill — title-bar surface, same interaction language as
// ParallaxPresencePill (and reusing its CSS classes): appears on sync events,
// auto-opens its popover briefly, stays amber while conflicts need attention,
// click opens Settings. The phone runs the sync; this pill mirrors what it
// reports (conflicts, completions) so the user finds out immediately instead
// of by visiting Settings.

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import { useUIStore } from '../../stores/uiStore'

interface ToastEntry {
  message: string
  expiresAt: number
}

const TOAST_DURATION_MS = 4000
const AUTO_OPEN_DURATION_MS = 4000

export default function PhoneSyncPresencePill() {
  const status = usePhoneRemoteSettingsStore((s) => s.status)
  const openSyncConflictResolver = usePhoneRemoteSettingsStore((s) => s.openSyncConflictResolver)
  const setActiveView = useUIStore((s) => s.setActiveView)

  const [toast, setToast] = useState<ToastEntry | null>(null)
  const [autoOpenUntilMs, setAutoOpenUntilMs] = useState<number | null>(null)

  // Snapshot refs for delta detection; first push is the baseline (no events),
  // so pre-existing conflicts don't re-toast on every app launch — the amber
  // pill itself carries that state.
  const prevConflictUidsRef = useRef<Set<string> | null>(null)
  const prevLastSyncedAtRef = useRef<number | null>(null)
  const prevRequestedAtRef = useRef<number | null>(null)

  useEffect(() => {
    const sync = status?.sync
    if (!sync) return

    const nextUids = new Set(sync.conflicts.map((conflict) => conflict.syncUid))
    const prevUids = prevConflictUidsRef.current
    const prevLastSyncedAt = prevLastSyncedAtRef.current
    const prevRequestedAt = prevRequestedAtRef.current

    if (prevUids === null) {
      prevConflictUidsRef.current = nextUids
      prevLastSyncedAtRef.current = sync.lastSyncedAt
      prevRequestedAtRef.current = sync.requestedAt
      return
    }

    const now = Date.now()
    let newConflictCount = 0
    for (const uid of nextUids) {
      if (!prevUids.has(uid)) newConflictCount += 1
    }

    if (newConflictCount > 0) {
      setToast({
        message: `${nextUids.size} playlist${nextUids.size === 1 ? '' : 's'} need${nextUids.size === 1 ? 's' : ''} attention.`,
        expiresAt: now + TOAST_DURATION_MS
      })
      setAutoOpenUntilMs(now + AUTO_OPEN_DURATION_MS)
    } else if (prevUids.size > 0 && nextUids.size === 0) {
      setToast({ message: 'Sync conflicts resolved.', expiresAt: now + TOAST_DURATION_MS })
      setAutoOpenUntilMs(now + AUTO_OPEN_DURATION_MS)
    } else if (
      sync.lastSyncedAt !== null &&
      sync.lastSyncedAt !== prevLastSyncedAt &&
      prevRequestedAt !== null
    ) {
      // Completion signal for a desktop-initiated Sync Now.
      setToast({ message: 'Phone synced.', expiresAt: now + TOAST_DURATION_MS })
      setAutoOpenUntilMs(now + AUTO_OPEN_DURATION_MS)
    }

    prevConflictUidsRef.current = nextUids
    prevLastSyncedAtRef.current = sync.lastSyncedAt
    prevRequestedAtRef.current = sync.requestedAt
  }, [status])

  // Toast/auto-open expiry — timers driven by their own deadlines.
  useEffect(() => {
    if (!toast) return
    const remaining = toast.expiresAt - Date.now()
    if (remaining <= 0) {
      setToast(null)
      return
    }
    const t = setTimeout(() => setToast(null), remaining)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!autoOpenUntilMs) return
    const remaining = autoOpenUntilMs - Date.now()
    if (remaining <= 0) {
      setAutoOpenUntilMs(null)
      return
    }
    const t = setTimeout(() => setAutoOpenUntilMs(null), remaining)
    return () => clearTimeout(t)
  }, [autoOpenUntilMs])

  const conflicts = useMemo(() => status?.sync?.conflicts ?? [], [status])
  const hasConflicts = conflicts.length > 0

  // Event-driven surface: only present while there's something to say.
  if (!status?.sync?.enabled || (!hasConflicts && !toast)) return null

  const popoverForceOpen = (autoOpenUntilMs !== null && autoOpenUntilMs > Date.now()) || toast !== null
  const pillState = hasConflicts ? 'warning' : 'ok'
  const label = hasConflicts ? 'SYNC ⚠' : 'SYNC'

  const handleClick = () => {
    setAutoOpenUntilMs(null)
    if (hasConflicts) {
      openSyncConflictResolver()
    } else {
      setActiveView('settings')
    }
  }

  return (
    <span
      className={`titlebar-parallax-pill is-${pillState} ${popoverForceOpen ? 'is-popover-open' : ''}`.trim()}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      aria-label={`${label} — open Library Sync settings`}
    >
      <span className="titlebar-parallax-pill-dot" aria-hidden="true" />
      <span>{label}</span>
      <div className="titlebar-parallax-pill-popover" role="tooltip">
        <div className="titlebar-parallax-pill-popover-inner">
          <div className="titlebar-parallax-pill-popover-header">Library Sync</div>
          {hasConflicts && (
            <div className="titlebar-parallax-pill-popover-warnings">
              {conflicts.map((conflict) => (
                <div key={conflict.syncUid} className="titlebar-parallax-pill-popover-warning">
                  <span className="titlebar-parallax-pill-popover-warning-icon" aria-hidden="true">⚠</span>
                  <span>
                    “{conflict.name || conflict.desktopName}” differs between desktop and phone
                  </span>
                </div>
              ))}
            </div>
          )}
          {toast && <div className="titlebar-parallax-pill-popover-toast">{toast.message}</div>}
          <div className="titlebar-parallax-pill-popover-footer">
            {hasConflicts ? 'Click to choose which versions to keep' : 'Click to open Library Sync settings'}
          </div>
        </div>
      </div>
    </span>
  )
}
