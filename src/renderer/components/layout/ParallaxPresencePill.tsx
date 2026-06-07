// §18 Parallax presence pill — title-bar surface (commit 1: pill + popover basics).
//
// Reads `useParallaxStore.status` and renders one of:
//   - null  — Parallax host not active AND not in sink mode (pill hidden).
//   - SINK  — this app instance is a sink, connected to a host.
//   - PXLX  — host is active, no sinks connected.
//   - PXLX • N — host is active with N connected sinks.
//
// Hover surfaces a popover with the per-mode glance content from share §18.2. Click opens the
// Settings view (deep-linking to the Parallax section is queued for a follow-up since today's
// SettingsView uses 'integrations' as the Parallax bucket; switching to a dedicated 'parallax'
// section ID is bigger than commit 1's scope).
//
// Event severity / warning state machine lives in commit 2; this commit is layout + state
// rendering only.

import { useMemo } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import type { ParallaxConnectedSinkState, ParallaxStatus } from '../../../types/parallax'

export default function ParallaxPresencePill() {
  const parallaxStatus = useParallaxStore((s) => s.status)
  const setActiveView = useUIStore((s) => s.setActiveView)

  const host = parallaxStatus?.host
  const sink = parallaxStatus?.sink

  const mode: 'sink' | 'host-active' | 'host-idle' | null = useMemo(() => {
    if (sink?.connected) return 'sink'
    if (host?.active) return host.connectedSinkCount > 0 ? 'host-active' : 'host-idle'
    return null
  }, [host?.active, host?.connectedSinkCount, sink?.connected])

  if (mode === null || !parallaxStatus) return null

  const label =
    mode === 'sink' ? 'SINK'
    : mode === 'host-active' ? `PXLX • ${host?.connectedSinkCount ?? 0}`
    : 'PXLX'

  const handleClick = () => setActiveView('settings')

  return (
    <span
      className="titlebar-parallax-pill"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      aria-label={`${label} — open Parallax settings`}
    >
      <span className="titlebar-parallax-pill-dot" aria-hidden="true" />
      <span>{label}</span>
      <div className="titlebar-parallax-pill-popover" role="tooltip">
        <ParallaxPresencePopoverContent mode={mode} status={parallaxStatus} />
      </div>
    </span>
  )
}

interface PopoverContentProps {
  mode: 'sink' | 'host-active' | 'host-idle'
  status: ParallaxStatus
}

function ParallaxPresencePopoverContent({ mode, status }: PopoverContentProps) {
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
        <div className="titlebar-parallax-pill-popover-footer">Click to open Parallax settings</div>
      </div>
    )
  }

  // Host modes — idle or active.
  const host = status.host
  const sinks = host.connectedSinks ?? []
  const count = host.connectedSinkCount

  return (
    <div className="titlebar-parallax-pill-popover-inner">
      <div className="titlebar-parallax-pill-popover-header">Parallax — Host</div>
      <div className="titlebar-parallax-pill-popover-row">
        <span className="titlebar-parallax-pill-popover-label">Status</span>
        <span className="titlebar-parallax-pill-popover-value">
          {count === 0 ? 'No sinks connected' : `${count} sink${count === 1 ? '' : 's'} connected`}
        </span>
      </div>
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
                  {s.outputDeviceLabel ?? 'Output unknown'} · Trim {trimText}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="titlebar-parallax-pill-popover-footer">Click to open Parallax settings</div>
    </div>
  )
}
