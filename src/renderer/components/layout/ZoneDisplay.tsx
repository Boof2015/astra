import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useParallaxStore } from '../../stores/parallaxStore'
import ZoneSettingsOverlay from './ZoneSettingsOverlay'
import ParallaxIncomingPairCard from './ParallaxIncomingPairCard'

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
  const artworkUrl = useParallaxStore((s) => s.sinkActiveArtworkUrl)
  const identity = useEndpointIdentity()
  const [overlayOpen, setOverlayOpen] = useState(false)

  const hasPersistedConnection = status?.sink.hasPersistedConnection ?? false
  const persistedHostName = status?.sink.persistedHostName ?? null
  const removedByHost = status?.sink.removedByHost ?? false
  const connected = status?.sink.connected ?? false
  const stream = status?.sink.activeStream ?? null
  const outputLabel = status?.sink.outputDeviceLabel
    ?? status?.sink.outputDeviceId
    ?? null

  const showIdentityCard = !hasPersistedConnection || removedByHost

  const syncState = pickSyncPillState({
    connected,
    activeStreamId: stream?.streamId ?? null,
    snapshotStreamId: sinkSnapshot.streamId,
    bufferedFrames: sinkSnapshot.bufferedFrames,
    rebuffering: sinkSnapshot.rebuffering,
  })

  // Resolve the kicker label in the hero topbar. Mirrors FullscreenMode's "Now Playing / Paused
  // / Ready" pattern but in sink-side vocabulary.
  const kickerLabel = showIdentityCard
    ? 'This endpoint'
    : !connected
      ? 'Disconnected'
      : !stream
        ? 'Ready'
        : 'Parallax Sink'

  return (
    <div className="zone-display fullscreen-overlay" role="main">
      {/* Reuse fullscreen's backdrop machinery — art-bathed blurred image, color wash, scrim. */}
      <div className="fullscreen-backdrop" aria-hidden="true">
        <div className="fullscreen-backdrop-layer fullscreen-backdrop-layer-current">
          {artworkUrl ? (
            <img className="fullscreen-backdrop-image" src={artworkUrl} alt="" />
          ) : (
            <div className="fullscreen-backdrop-fallback" />
          )}
        </div>
        <div className="fullscreen-backdrop-colorwash" />
        <div className="fullscreen-backdrop-scrim" />
      </div>

      <button
        type="button"
        className="zone-display-exit"
        onClick={exitForSession}
        title="Return to library (this session only)"
      >
        ← Library
      </button>

      {!showIdentityCard && (
        <button
          type="button"
          className="zone-display-settings-btn"
          title="Zone settings"
          aria-label="Zone settings"
          onClick={() => setOverlayOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      <div className="fullscreen-content">
        <div className="fullscreen-stage">
          <div className="fullscreen-hero fullscreen-hero-steady">
            <div className="fullscreen-hero-topbar">
              <span className="fullscreen-status-label">{kickerLabel}</span>
              {!showIdentityCard && outputLabel && (
                <button
                  type="button"
                  className="zone-display-output-chip"
                  title="Open zone settings"
                  onClick={() => setOverlayOpen(true)}
                >
                  {outputLabel}
                </button>
              )}
            </div>

            {showIdentityCard ? (
              <div className="zone-display-identity-body">
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
            ) : (
              <div className="fullscreen-main-row">
                <div className="fullscreen-artwork">
                  {artworkUrl ? (
                    <img src={artworkUrl} alt={stream ? `Album art for ${stream.title}` : ''} />
                  ) : (
                    <div className="fullscreen-artwork-placeholder">&#9835;</div>
                  )}
                </div>

                <div className="fullscreen-track-info">
                  {stream ? (
                    <>
                      <h1 className="fullscreen-title">
                        <span className="fullscreen-title-inner">{stream.title || '—'}</span>
                      </h1>
                      <p className="fullscreen-artist">{stream.artist || '—'}</p>
                      <p className="fullscreen-album">{stream.album || '—'}</p>
                    </>
                  ) : (
                    <>
                      <h1 className="fullscreen-title">
                        <span className="fullscreen-title-inner">
                          {connected ? 'Awaiting playback' : 'Disconnected'}
                        </span>
                      </h1>
                      <p className="fullscreen-artist">
                        {persistedHostName
                          ? (connected ? `Connected to ${persistedHostName}` : `Reconnecting to ${persistedHostName}`)
                          : '—'}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Codex finding 3 (medium): identity-card mode hides the sync pill — there is no stream
          to sync against and the surface is "introduce this device", not "sync status". */}
      {!showIdentityCard && (
        <div className="zone-display-status-rail">
          <span className={`zone-display-sync-pill is-state-${syncState}`}>
            <span className="zone-display-sync-pill-dot" aria-hidden="true" />
            {syncPillCopy(syncState)}
          </span>
        </div>
      )}

      {overlayOpen && <ZoneSettingsOverlay onClose={() => setOverlayOpen(false)} />}
      <ParallaxIncomingPairCard variant="zone-display" />
    </div>
  )
}
