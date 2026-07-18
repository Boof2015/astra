// §18 Parallax presence pill — title-bar surface.
//
// Commit 1: pill mode derivation (sink / host-active / host-idle / null) + popover layout.
// Commit 2: prev/next event reducer + tiered severity per share §18.9(a) + flap detection +
//           warning queue + transient toast notifications.
//
// Reads `useParallaxStore.status` and `useParallaxStore.pairedSinks`, holds the previous
// snapshot in refs, and emits SinkPresenceEvents on the deltas. The event severity decides
// whether the pill flips to amber (persistent warning state) or just shows a 3-second toast.
//
// First status push during boot is intentionally ignored — initial paired-sinks list with
// `online: false` would otherwise produce a flood of false "sink dropped" warnings.
// (Codex §18.9(b).)

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import type { ParallaxConnectedSinkState, ParallaxPairedSink, ParallaxStatus } from '../../../types/parallax'

type SinkPresenceEvent =
  | { kind: 'connected'; sinkId: string; name: string }
  | { kind: 'disconnected-unexpected'; sinkId: string; name: string; duringActivity: boolean }
  | { kind: 'disconnected-revoked'; sinkId: string; name: string }
  | { kind: 'flapping'; sinkId: string; name: string }

interface WarningEntry {
  sinkId: string
  name: string
  occurredAt: number
  reason: 'unexpected-during-activity' | 'flapping' | 'only-sink'
}

interface ToastEntry {
  message: string
  expiresAt: number
}

// Module-level state survives component remounts so a popover-closing remount during a flap
// window doesn't reset the flap detector. Reset paths fire on `host.active` going false.
const flapHistoryBySink = new Map<string, number[]>()
const sessionConnectedSinks = new Set<string>()
const FLAP_WINDOW_MS = 30_000
const FLAP_THRESHOLD = 3
const TOAST_DURATION_MS = 3000
const AUTO_OPEN_DURATION_MS = 3000

function resetSessionState(): void {
  flapHistoryBySink.clear()
  sessionConnectedSinks.clear()
}

export default function ParallaxPresencePill() {
  const parallaxStatus = useParallaxStore((s) => s.status)
  const pairedSinks = useParallaxStore((s) => s.pairedSinks)
  const setActiveView = useUIStore((s) => s.setActiveView)

  const [warnings, setWarnings] = useState<WarningEntry[]>([])
  const [toast, setToast] = useState<ToastEntry | null>(null)
  const [autoOpenUntilMs, setAutoOpenUntilMs] = useState<number | null>(null)

  // Snapshot refs for delta detection. `null` means "no prior snapshot yet" — first effect run
  // becomes the baseline and emits no events.
  const prevConnectedRef = useRef<Map<string, ParallaxConnectedSinkState> | null>(null)
  const prevPairedRef = useRef<Map<string, ParallaxPairedSink> | null>(null)
  const prevHostActiveRef = useRef<boolean>(false)

  // Diff prev vs next and emit events. Runs on every parallax-store push.
  useEffect(() => {
    if (!parallaxStatus) return

    const nextConnectedMap = new Map<string, ParallaxConnectedSinkState>(
      (parallaxStatus.host.connectedSinks ?? []).map((s) => [s.sinkId, s])
    )
    const nextPairedMap = new Map<string, ParallaxPairedSink>(
      pairedSinks.map((s) => [s.id, s])
    )

    const prevConnected = prevConnectedRef.current
    const prevPaired = prevPairedRef.current
    const prevHostActive = prevHostActiveRef.current

    // Session reset when host transitions to inactive — hard UI/session boundary per §18 round
    // 2 review (Codex). Clears module-level bookkeeping AND component state so a later host
    // reactivation doesn't resurrect stale warnings as `PXLX ⚠`. Also prevents the intentional
    // host stop from emitting per-sink "disconnected" toasts as every previously-connected
    // sink falls off — those drops are by design, not user-actionable.
    if (prevHostActive && !parallaxStatus.host.active) {
      resetSessionState()
      setWarnings([])
      setToast(null)
      setAutoOpenUntilMs(null)
      prevConnectedRef.current = nextConnectedMap
      prevPairedRef.current = nextPairedMap
      prevHostActiveRef.current = parallaxStatus.host.active
      return
    }

    // First push becomes the baseline. No events emitted.
    if (!prevConnected || !prevPaired) {
      prevConnectedRef.current = nextConnectedMap
      prevPairedRef.current = nextPairedMap
      prevHostActiveRef.current = parallaxStatus.host.active
      // Seed sessionConnectedSinks with whatever sinks are online right now.
      for (const [sinkId, sink] of nextConnectedMap) {
        if (sink.online) sessionConnectedSinks.add(sinkId)
      }
      return
    }

    const events: SinkPresenceEvent[] = []
    const now = Date.now()

    // §18 commit 2 follow-up (Codex). Revoke detection runs FIRST as its own pass, regardless of
    // whether the same diff contains an online→offline transition. The renderer receives
    // `connectedSinks` and `pairedSinks` through separate paths (status push vs paired-sinks
    // refresh) — main triggers them in close succession but they can arrive in different ticks.
    // Without this pass:
    //   - Same-tick batch: would emit `disconnected-unexpected` (paired-sinks still stale at the
    //     time we see the connected-sinks transition).
    //   - Cross-tick: first tick emits a false `disconnected-unexpected`; second tick has no
    //     connected-sinks transition left to reconsider, so the warning persists.
    // This pass catches both — by emitting `disconnected-revoked` whenever the revoke timestamp
    // transitioned null → number, even without an online/offline delta in this same diff. The
    // revoked sinkIds are tracked so the disconnect-classification pass below doesn't
    // double-emit `disconnected-unexpected` for the same drop.
    const revokedSinkIdsThisDiff = new Set<string>()
    for (const [sinkId, prevPairedSink] of prevPaired) {
      const nextPairedSink = nextPairedMap.get(sinkId)
      const prevRevokedAt = prevPairedSink.revokedAt ?? null
      const nextRevokedAt = nextPairedSink?.revokedAt ?? null
      if (prevRevokedAt === null && nextRevokedAt !== null) {
        // Name preference: previously-connected name, else paired-sink name, else fallback.
        const name = prevConnected.get(sinkId)?.name ?? prevPairedSink.name ?? sinkId
        events.push({ kind: 'disconnected-revoked', sinkId, name })
        revokedSinkIdsThisDiff.add(sinkId)
      }
    }

    // New connections: in next as online, but in prev was offline / absent.
    for (const [sinkId, sink] of nextConnectedMap) {
      if (!sink.online) continue
      const prev = prevConnected.get(sinkId)
      if (!prev || !prev.online) {
        events.push({ kind: 'connected', sinkId, name: sink.name })
        sessionConnectedSinks.add(sinkId)
      }
    }

    // Disconnections: was online in prev, now offline or absent. Skip sinks already classified
    // as revoked in the same diff above — those are intentional, not unexpected.
    for (const [sinkId, prevSink] of prevConnected) {
      if (!prevSink.online) continue
      if (revokedSinkIdsThisDiff.has(sinkId)) continue
      const nextSink = nextConnectedMap.get(sinkId)
      if (nextSink && nextSink.online) continue
      const duringActivity = prevSink.playbackEnabled && parallaxStatus.host.activeStream !== null
      events.push({ kind: 'disconnected-unexpected', sinkId, name: prevSink.name, duringActivity })
      // Flap detection: rolling window of unexpected drops per sink.
      const history = flapHistoryBySink.get(sinkId) ?? []
      const pruned = history.filter((t) => now - t < FLAP_WINDOW_MS)
      pruned.push(now)
      flapHistoryBySink.set(sinkId, pruned)
      if (pruned.length >= FLAP_THRESHOLD) {
        events.push({ kind: 'flapping', sinkId, name: prevSink.name })
      }
    }

    // Apply events to UI state. Order matters slightly: reconnects clear stale warnings for
    // that sinkId before we add new warnings from any concurrent drop event.
    if (events.length > 0) {
      let nextWarnings = warnings
      let nextToast: ToastEntry | null = toast
      let nextAutoOpen: number | null = autoOpenUntilMs

      for (const event of events) {
        if (event.kind === 'connected') {
          // Reconnect clears any active warning for this sink + suppresses the connect toast
          // when it's already-known. Always show a brief informational toast.
          nextWarnings = nextWarnings.filter((w) => w.sinkId !== event.sinkId)
          nextToast = { message: `${event.name} connected.`, expiresAt: now + TOAST_DURATION_MS }
        } else if (event.kind === 'disconnected-revoked') {
          nextWarnings = nextWarnings.filter((w) => w.sinkId !== event.sinkId)
          nextToast = { message: `${event.name} revoked.`, expiresAt: now + TOAST_DURATION_MS }
        } else if (event.kind === 'disconnected-unexpected') {
          // Tiered severity per §18.9(a). "Only sink in session" interpreted as historical:
          // this sink was the only sinkId ever seen connected across the current host session,
          // so its drop means the user lost their entire Parallax setup. Alternative reading
          // would be "only currently-online sink" (`host.connectedSinkCount` going 0); that
          // would alarm on every-final-sink-drop including the third sink dropping in a
          // multi-sink session that's been shrinking. The historical reading is the more
          // conservative match for the appliance-sink framing in §14.1 (a single dedicated
          // sink in a fixed location). Re-evaluate if user feedback suggests otherwise.
          const onlySinkInSession = sessionConnectedSinks.size === 1
            && sessionConnectedSinks.has(event.sinkId)
          if (event.duringActivity || onlySinkInSession) {
            // Don't double-add if a warning for this sinkId already exists.
            if (!nextWarnings.find((w) => w.sinkId === event.sinkId)) {
              nextWarnings = [
                ...nextWarnings,
                {
                  sinkId: event.sinkId,
                  name: event.name,
                  occurredAt: now,
                  reason: onlySinkInSession ? 'only-sink' : 'unexpected-during-activity'
                }
              ]
            }
            nextAutoOpen = now + AUTO_OPEN_DURATION_MS
          } else {
            // Quieter toast during idle multi-sink — user knows other sinks are still around.
            nextToast = { message: `${event.name} disconnected.`, expiresAt: now + TOAST_DURATION_MS }
          }
        } else if (event.kind === 'flapping') {
          // Promote to warning even when otherwise quiet.
          if (!nextWarnings.find((w) => w.sinkId === event.sinkId)) {
            nextWarnings = [
              ...nextWarnings,
              { sinkId: event.sinkId, name: event.name, occurredAt: now, reason: 'flapping' }
            ]
          } else {
            // Already warning — bump the reason if it was only-during-activity to escalate.
            nextWarnings = nextWarnings.map((w) =>
              w.sinkId === event.sinkId ? { ...w, reason: 'flapping' } : w
            )
          }
          nextAutoOpen = now + AUTO_OPEN_DURATION_MS
        }
      }

      if (nextWarnings !== warnings) setWarnings(nextWarnings)
      if (nextToast !== toast) setToast(nextToast)
      if (nextAutoOpen !== autoOpenUntilMs) setAutoOpenUntilMs(nextAutoOpen)
    }

    prevConnectedRef.current = nextConnectedMap
    prevPairedRef.current = nextPairedMap
    prevHostActiveRef.current = parallaxStatus.host.active
  }, [parallaxStatus, pairedSinks, warnings, toast, autoOpenUntilMs])

  // Toast expiry — single timer driven by the toast's own expiresAt so re-rendering doesn't
  // shift the clear time.
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

  // Auto-open expiry — same shape.
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

  const host = parallaxStatus?.host
  const sink = parallaxStatus?.sink

  const mode: 'sink' | 'host-active' | 'host-idle' | null = useMemo(() => {
    if (sink?.connected) return 'sink'
    if (host?.active) return host.activePlaybackSinkCount > 0 ? 'host-active' : 'host-idle'
    return null
  }, [host?.active, host?.activePlaybackSinkCount, sink?.connected])

  if (mode === null || !parallaxStatus) return null

  const hasWarnings = warnings.length > 0
  const popoverForceOpen = (autoOpenUntilMs !== null && autoOpenUntilMs > Date.now()) || toast !== null
  const pillState = hasWarnings ? 'warning' : 'ok'

  const label =
    mode === 'sink' ? 'SINK'
    : mode === 'host-active' ? `PXLX • ${host?.activePlaybackSinkCount ?? 0}`
    : 'PXLX'
  const labelWithIndicator = hasWarnings ? `${label} ⚠` : label

  const handleClick = () => {
    // Acknowledging a warning clears the queue AND collapses the auto-open.
    if (hasWarnings) {
      setWarnings([])
      setAutoOpenUntilMs(null)
    }
    setActiveView('settings')
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
      aria-label={`${labelWithIndicator} — open Parallax settings`}
    >
      <span className="titlebar-parallax-pill-dot" aria-hidden="true" />
      <span>{labelWithIndicator}</span>
      <div className="titlebar-parallax-pill-popover" role="tooltip">
        <ParallaxPresencePopoverContent
          mode={mode}
          status={parallaxStatus}
          warnings={warnings}
          toast={toast}
        />
      </div>
    </span>
  )
}

interface PopoverContentProps {
  mode: 'sink' | 'host-active' | 'host-idle'
  status: ParallaxStatus
  warnings: WarningEntry[]
  toast: ToastEntry | null
}

function ParallaxPresencePopoverContent({ mode, status, warnings, toast }: PopoverContentProps) {
  if (mode === 'sink') {
    const sink = status.sink
    const hostLabel = sink.persistedHostName ?? sink.baseUrl ?? 'host'
    const trimText = typeof sink.appliedAdvanceMs === 'number'
      ? `${sink.appliedAdvanceMs >= 0 ? '+' : ''}${sink.appliedAdvanceMs.toFixed(0)} ms`
      : '0 ms'
    return (
      <div className="titlebar-parallax-pill-popover-inner">
        <div className="titlebar-parallax-pill-popover-header">Parallax — Sink</div>
        <div className="titlebar-parallax-pill-popover-row">
          <span className="titlebar-parallax-pill-popover-label">Paired with</span>
          <span className="titlebar-parallax-pill-popover-value">{hostLabel}</span>
        </div>
        {sink.outputDeviceLabel && (
          <div className="titlebar-parallax-pill-popover-row">
            <span className="titlebar-parallax-pill-popover-label">Output</span>
            <span className="titlebar-parallax-pill-popover-value">{sink.outputDeviceLabel}</span>
          </div>
        )}
        <div className="titlebar-parallax-pill-popover-row">
          <span className="titlebar-parallax-pill-popover-label">Trim</span>
          <span className="titlebar-parallax-pill-popover-value">{trimText}</span>
        </div>
        {typeof sink.rttMs === 'number' && (
          <div className="titlebar-parallax-pill-popover-row">
            <span className="titlebar-parallax-pill-popover-label">RTT</span>
            <span className="titlebar-parallax-pill-popover-value">{sink.rttMs.toFixed(0)} ms</span>
          </div>
        )}
        {toast && (
          <div className="titlebar-parallax-pill-popover-toast">{toast.message}</div>
        )}
        <div className="titlebar-parallax-pill-popover-footer">Click to open Parallax settings</div>
      </div>
    )
  }

  // Host modes — idle or active.
  const host = status.host
  const sinks = (host.connectedSinks ?? []).filter((sink) => sink.online)
  const count = host.connectedSinkCount
  const playbackCount = host.activePlaybackSinkCount

  return (
    <div className="titlebar-parallax-pill-popover-inner">
      <div className="titlebar-parallax-pill-popover-header">Parallax — Host</div>
      <div className="titlebar-parallax-pill-popover-row">
        <span className="titlebar-parallax-pill-popover-label">Status</span>
        <span className="titlebar-parallax-pill-popover-value">
          {count === 0
            ? 'No sinks connected'
            : `${playbackCount} playing · ${count} connected`}
        </span>
      </div>
      {warnings.length > 0 && (
        <div className="titlebar-parallax-pill-popover-warnings">
          {warnings.map((w) => (
            <div key={w.sinkId} className="titlebar-parallax-pill-popover-warning">
              <span className="titlebar-parallax-pill-popover-warning-icon" aria-hidden="true">⚠</span>
              <span>
                {w.reason === 'flapping' ? `${w.name} keeps dropping` : `${w.name} dropped`}
              </span>
            </div>
          ))}
        </div>
      )}
      {sinks.length > 0 && (
        <div className="titlebar-parallax-pill-popover-sinks">
          {sinks.map((s: ParallaxConnectedSinkState) => {
            const trimText = `${s.appliedAdvanceMs >= 0 ? '+' : ''}${s.appliedAdvanceMs.toFixed(0)} ms`
            return (
              <div key={s.sinkId} className="titlebar-parallax-pill-popover-sink">
                <div className="titlebar-parallax-pill-popover-sink-head">
                  <span
                    className={`titlebar-parallax-pill-popover-sink-dot ${s.online ? 'online' : 'offline'}`}
                    aria-hidden="true"
                  />
                  <span className="titlebar-parallax-pill-popover-sink-name">{s.name}</span>
                </div>
                <div className="titlebar-parallax-pill-popover-sink-detail">
                  {s.playbackEnabled
                    ? `${s.outputDeviceLabel ?? 'Output unknown'} · Trim ${trimText}`
                    : 'Not selected for playback'}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {toast && (
        <div className="titlebar-parallax-pill-popover-toast">{toast.message}</div>
      )}
      <div className="titlebar-parallax-pill-popover-footer">Click to open Parallax settings</div>
    </div>
  )
}
