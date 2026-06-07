import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useParallaxStore } from '../../stores/parallaxStore'

type SyncPillState = 'ready' | 'stabilizing' | 'locked' | 'no-signal' | 'disconnected'

// §14.1.4 / §19.18(c) — sync state derived from observable signals only. No fake "N/15" counters
// (`predictorTrustTickCount` is not anchor count — Codex correction). When trustworthy public
// telemetry exists for fit confidence + acoustic drift, the "Locked" copy can include a "±X.X ms"
// readout; until then it stays generic.
function pickSyncPillState(args: {
  connected: boolean
  activeStreamId: string | null
  snapshotStreamId: string | null
  bufferedFrames: number
  rebuffering: boolean
}): SyncPillState {
  if (!args.connected) return 'disconnected'
  if (!args.activeStreamId) return 'ready'
  if (args.rebuffering) return 'no-signal'
  if (args.snapshotStreamId !== args.activeStreamId) return 'stabilizing'
  if (args.bufferedFrames <= 0) return 'stabilizing'
  return 'locked'
}

function syncPillCopy(state: SyncPillState): string {
  switch (state) {
    case 'ready': return 'Ready'
    case 'stabilizing': return 'Stabilizing'
    case 'locked': return 'Locked'
    case 'no-signal': return 'No host signal'
    case 'disconnected': return 'Disconnected'
  }
}

interface EndpointIdentity {
  hostname: string
  lanIps: string[]
}

function useEndpointIdentity(): EndpointIdentity | null {
  const [identity, setIdentity] = useState<EndpointIdentity | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.parallax.getEndpointIdentity().then((value) => {
      if (!cancelled) setIdentity(value)
    }).catch(() => {
      if (!cancelled) setIdentity({ hostname: '', lanIps: [] })
    })
    return () => { cancelled = true }
  }, [])
  return identity
}

export default function ZoneDisplay() {
  const exitForSession = useUIStore((s) => s.exitZoneDisplayForSession)
  const status = useParallaxStore((s) => s.status)
  const sinkSnapshot = useParallaxStore((s) => s.sinkSnapshot)
  const identity = useEndpointIdentity()

  const hasPersistedConnection = status?.sink.hasPersistedConnection ?? false
  const persistedHostName = status?.sink.persistedHostName ?? null
  const removedByHost = status?.sink.removedByHost ?? false
  const connected = status?.sink.connected ?? false
  const stream = status?.sink.activeStream ?? null
  const outputLabel = status?.sink.outputDeviceLabel
    ?? status?.sink.outputDeviceId
    ?? null

  // Unpaired or host revoked → identity card. Per user direction, this stays visible when zone
  // display is the active surface and helps locate the physical device across the room. No PIN,
  // no URL, no implied pairing flow — pairing lives in Settings / §14.1.5.
  const showIdentityCard = !hasPersistedConnection || removedByHost

  if (showIdentityCard) {
    return (
      <div className="zone-display" role="main">
        <button
          type="button"
          className="zone-display-exit"
          onClick={exitForSession}
          title="Return to library (this session only)"
        >
          ← Library
        </button>
        <div className="zone-display-body zone-display-body-identity">
          <div className="zone-display-kicker">This endpoint</div>
          {removedByHost && (
            <div className="zone-display-revoke-note">Host revoked pairing.</div>
          )}
          <div className="zone-display-identity-rows">
            <div className="zone-display-identity-row">
              <span className="zone-display-identity-label">Hostname</span>
              <span className="zone-display-identity-value">
                {identity?.hostname || '—'}
              </span>
            </div>
            <div className="zone-display-identity-row">
              <span className="zone-display-identity-label">LAN</span>
              <span className="zone-display-identity-value">
                {identity && identity.lanIps.length > 0
                  ? identity.lanIps.join(' · ')
                  : '—'}
              </span>
            </div>
          </div>
          <p className="zone-display-note">Use this to identify the device.</p>
        </div>
      </div>
    )
  }

  const syncState = pickSyncPillState({
    connected,
    activeStreamId: stream?.streamId ?? null,
    snapshotStreamId: sinkSnapshot.streamId,
    bufferedFrames: sinkSnapshot.bufferedFrames,
    rebuffering: sinkSnapshot.rebuffering,
  })

  return (
    <div className="zone-display" role="main">
      <div className="zone-display-chrome zone-display-chrome-top">
        <button
          type="button"
          className="zone-display-exit"
          onClick={exitForSession}
          title="Return to library (this session only)"
        >
          ← Library
        </button>
        <div className="zone-display-chrome-end">
          {outputLabel && (
            <span className="zone-display-output-chip" title="Output device">
              {outputLabel}
            </span>
          )}
        </div>
      </div>

      <div className="zone-display-body">
        {stream ? (
          <>
            {/* Step 4 replaces this placeholder with hero artwork via /v1/parallax/artwork/current. */}
            <div className="zone-display-artwork-placeholder" aria-hidden="true">&#9835;</div>
            <div className="zone-display-track-info">
              <div className="zone-display-title">{stream.title || '—'}</div>
              <div className="zone-display-subtitle">
                {[stream.artist, stream.album].filter(Boolean).join(' · ') || '—'}
              </div>
            </div>
          </>
        ) : (
          <div className="zone-display-idle">
            <div className="zone-display-kicker">{connected ? 'Ready' : 'Disconnected'}</div>
            {persistedHostName && (
              <div className="zone-display-host-line">
                {connected ? 'Connected to ' : 'Reconnecting to '}<strong>{persistedHostName}</strong>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="zone-display-chrome zone-display-chrome-bottom">
        <span className={`zone-display-sync-pill is-state-${syncState}`}>
          <span className="zone-display-sync-pill-dot" aria-hidden="true" />
          {syncPillCopy(syncState)}
        </span>
      </div>
    </div>
  )
}
