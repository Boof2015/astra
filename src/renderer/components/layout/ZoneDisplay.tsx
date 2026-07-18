import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useEndpointIdentity, type EndpointIdentity } from '../parallax/parallaxHelpers'
import { useIdleChrome } from '../../hooks/useIdleChrome'
import ZoneSettingsOverlay from './ZoneSettingsOverlay'
import ParallaxIncomingPairCard from './ParallaxIncomingPairCard'
import PhoneRemoteIncomingPairCard from './PhoneRemoteIncomingPairCard'
import type { ParallaxStatus, ParallaxStreamInfo } from '../../../types/parallax'

type SyncPillState = 'ready' | 'stabilizing' | 'locked' | 'no-signal' | 'disconnected'

// §14.1.4 / §19.18(c) — sync state derived from observable signals only. No fake "N/15" counters
// (`predictorTrustTickCount` is not anchor count — Codex correction). The pill is now *quiet*: it
// only renders for the transient/abnormal states (syncing / buffering); once locked it disappears,
// so a steady-state appliance screen carries no telemetry noise.
function pickSyncPillState(args: {
  activeStreamId: string | null
  snapshotStreamId: string | null
  bufferedFrames: number
  rebuffering: boolean
}): SyncPillState {
  if (!args.activeStreamId) return 'ready'
  if (args.rebuffering) return 'no-signal'
  if (args.snapshotStreamId !== args.activeStreamId) return 'stabilizing'
  if (args.bufferedFrames <= 0) return 'stabilizing'
  return 'locked'
}

function syncPillCopy(state: SyncPillState): string {
  switch (state) {
    case 'ready': return 'Ready'
    case 'stabilizing': return 'Syncing…'
    case 'locked': return 'Locked'
    case 'no-signal': return 'Buffering…'
    case 'disconnected': return 'Reconnecting…'
  }
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Re-render at ~30fps while `active`, so the interpolated progress bar advances smoothly between
// the sink's (roughly per-second) telemetry snapshots. Idle/paused → no loop, static render.
function useFrameTick(active: boolean): void {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let lastTs = 0
    const loop = (ts: number) => {
      if (ts - lastTs >= 33) {
        lastTs = ts
        force((n) => (n + 1) % 1_000_000)
      }
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [active])
}

// 1s wall clock for the idle dashboard.
function useWallClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

// ── Now-playing hero ───────────────────────────────────────────────────────────────────────────
function ZoneNowPlaying({
  stream,
  artworkUrl,
  zoneName,
}: {
  stream: ParallaxStreamInfo
  artworkUrl: string | null
  zoneName: string
}) {
  const sinkSnapshot = useParallaxStore((s) => s.sinkSnapshot)
  const latestTimeline = useParallaxStore((s) => s.latestTimeline)

  const snapshotMatches = sinkSnapshot.streamId === stream.streamId
  const playing = snapshotMatches
    && latestTimeline?.playbackState === 'playing'
    && !sinkSnapshot.rebuffering
  useFrameTick(Boolean(playing))

  // Position the sink already knows: currentFrame at currentFrameAtWallMs (epoch ms). Interpolate
  // off the wall clock while playing; freeze on pause/rebuffer. No new wire plumbing.
  const sr = stream.sampleRate > 0 ? stream.sampleRate : 0
  const duration = stream.durationSeconds > 0 ? stream.durationSeconds : 0
  let frame = snapshotMatches ? sinkSnapshot.currentFrame : 0
  if (playing && sinkSnapshot.currentFrameAtWallMs > 0) {
    const deltaMs = Date.now() - sinkSnapshot.currentFrameAtWallMs
    frame = sinkSnapshot.currentFrame + (deltaMs / 1000) * sr * (1 + sinkSnapshot.playbackRatePpm / 1e6)
  }
  const elapsedSec = sr > 0 ? Math.max(0, duration > 0 ? Math.min(frame / sr, duration) : frame / sr) : 0
  const pct = duration > 0 ? Math.min(100, (elapsedSec / duration) * 100) : 0

  const syncState = pickSyncPillState({
    activeStreamId: stream.streamId,
    snapshotStreamId: sinkSnapshot.streamId,
    bufferedFrames: sinkSnapshot.bufferedFrames,
    rebuffering: sinkSnapshot.rebuffering,
  })
  const showPill = syncState === 'stabilizing' || syncState === 'no-signal'

  return (
    <div className="zone-display-np">
      <span className="zone-display-kicker">{zoneName}</span>

      <div className="zone-display-np-art">
        {artworkUrl ? (
          <img src={artworkUrl} alt={`Album art for ${stream.title}`} />
        ) : (
          <div className="fullscreen-artwork-placeholder">&#9835;</div>
        )}
      </div>

      <div className="zone-display-np-meta">
        <h1 className="zone-display-np-title">{stream.title || '—'}</h1>
        <p className="zone-display-np-artist">{stream.artist || '—'}</p>
        {stream.album && <p className="zone-display-np-album">{stream.album}</p>}
      </div>

      <div className="zone-display-progress">
        <div className="zone-display-progress-track">
          <div className="zone-display-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="zone-display-time">
          <span>{formatTime(elapsedSec)}</span>
          <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
        </div>
      </div>

      {/* Quiet sync pill — sits in the column flow (reserved height so it never shifts/overlaps the
          progress row), only while settling/buffering. */}
      <div className="zone-display-np-statusline">
        {showPill && (
          <span className={`zone-display-sync-pill is-state-${syncState}`}>
            <span className="zone-display-sync-pill-dot" aria-hidden="true" />
            {syncPillCopy(syncState)}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Idle dashboard — ambient corner clock ────────────────────────────────────────────────────────
// One calm ambient surface for every "no music right now" case: unpaired, removed-by-host, paired
// but the host is idle, or reconnecting. Alexa/Nest-style composition: a big clock anchored
// bottom-left owning the frame, a floating status card top-right, and (when pairing is relevant)
// the device's discoverable address demoted to a small "find me" line.
function ZoneIdleDashboard({
  status,
  identity,
  zoneName,
  hostReachable,
}: {
  status: ParallaxStatus | null
  identity: EndpointIdentity | null
  zoneName: string
  hostReachable: boolean
}) {
  const now = useWallClock()
  const sink = status?.sink ?? null
  const connected = sink?.connected ?? false
  const hasPersisted = sink?.hasPersistedConnection ?? false
  const removed = sink?.removedByHost ?? false
  const hostName = sink?.persistedHostName ?? null
  const playbackEnabled = sink?.playbackEnabled !== false

  let statusLabel: string
  let tone: 'idle' | 'good' | 'warn' = 'idle'
  let pairingRelevant = false
  if (removed) {
    statusLabel = 'Removed by host'
    tone = 'warn'
    pairingRelevant = true
  } else if (!hasPersisted) {
    statusLabel = 'Ready to pair'
    pairingRelevant = true
  } else if (!hostReachable) {
    // Connection config lingers for auto-reconnect, but the host is actually gone.
    statusLabel = hostName ? `Lost connection to ${hostName}` : 'Lost connection to host'
    tone = 'warn'
  } else if (connected && !playbackEnabled) {
    statusLabel = 'Connected, not selected for playback'
    tone = 'idle'
  } else if (connected) {
    statusLabel = hostName ? `Waiting for ${hostName}` : 'Waiting for music'
    tone = 'good'
  } else {
    statusLabel = hostName ? `Reconnecting to ${hostName}` : 'Reconnecting'
    tone = 'warn'
  }

  const [timeStr, ampm] = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).split(' ')
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  const findMe = identity && (identity.hostname || identity.lanIps.length > 0)
    ? [identity.hostname, identity.lanIps[0]].filter(Boolean).join(' · ')
    : null

  return (
    <div className="zone-display-idle">
      <div className="zone-display-idle-glow" aria-hidden="true" />

      <div className="zone-display-idle-card">
        <span className="zone-display-idle-card-glyph" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5 6 9H2v6h4l5 4z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M19 5a9 9 0 0 1 0 14" />
          </svg>
        </span>
        <div className="zone-display-idle-card-body">
          <span className="zone-display-idle-card-name">{zoneName}</span>
          <span className={`zone-display-idle-pill is-${tone}`}>
            <span className="zone-display-idle-pill-dot" aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="zone-display-idle-clock-block">
        <div className="zone-display-idle-clock">
          {timeStr}
          {ampm && <span className="zone-display-idle-ampm">{ampm}</span>}
        </div>
        <div className="zone-display-idle-date">{date}</div>
        {pairingRelevant && findMe && (
          <div className="zone-display-idle-find">{findMe}</div>
        )}
      </div>
    </div>
  )
}

export default function ZoneDisplay() {
  const exitForSession = useUIStore((s) => s.exitZoneDisplayForSession)
  const zoneNameOverride = useUIStore((s) => s.parallaxZoneName)
  const status = useParallaxStore((s) => s.status)
  const artworkUrl = useParallaxStore((s) => s.sinkActiveArtworkUrl)
  const assignedName = useParallaxStore((s) => s.assignedSinkName)
  const identity = useEndpointIdentity()
  const chromeVisible = useIdleChrome()
  const [overlayOpen, setOverlayOpen] = useState(false)

  const sink = status?.sink ?? null
  const connected = sink?.connected ?? false
  const hostReachable = sink?.hostReachable ?? true
  const playbackEnabled = sink?.playbackEnabled !== false
  const stream = sink?.activeStream ?? null
  const outputLabel = sink?.outputDeviceLabel ?? sink?.outputDeviceId ?? null

  // Name priority: host-assigned name → local Zone-settings override → OS hostname.
  const zoneName = (assignedName && assignedName.trim())
    || (zoneNameOverride && zoneNameOverride.trim())
    || identity?.hostname
    || 'Astra Speaker'
  // Only "now playing" when the host is actually reachable — a quit/unreachable host must not leave
  // a frozen, stale track on screen (the connection config lingers for auto-reconnect).
  const nowPlaying = connected && hostReachable && playbackEnabled && Boolean(stream)

  return (
    <div className={`zone-display fullscreen-overlay ${chromeVisible ? '' : 'is-idle'}`} role="main">
      {/* Reuse fullscreen's backdrop machinery — art-bathed blurred image, color wash, scrim. Only
          bathe in artwork while actually playing; idle/disconnected falls back to the plain wash so
          a stale album image doesn't linger after the host goes away. */}
      <div className="fullscreen-backdrop" aria-hidden="true">
        <div className="fullscreen-backdrop-layer fullscreen-backdrop-layer-current">
          {nowPlaying && artworkUrl ? (
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

      <div className="zone-display-top-right">
        {nowPlaying && outputLabel && (
          <button
            type="button"
            className="zone-display-output-chip"
            title="Open zone settings"
            onClick={() => setOverlayOpen(true)}
          >
            {outputLabel}
          </button>
        )}
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
      </div>

      {nowPlaying && stream ? (
        <div className="fullscreen-content">
          <div className="fullscreen-stage">
            <ZoneNowPlaying stream={stream} artworkUrl={artworkUrl} zoneName={zoneName} />
          </div>
        </div>
      ) : (
        <ZoneIdleDashboard status={status} identity={identity} zoneName={zoneName} hostReachable={hostReachable} />
      )}

      {overlayOpen && <ZoneSettingsOverlay onClose={() => setOverlayOpen(false)} />}
      <ParallaxIncomingPairCard variant="zone-display" />
      <PhoneRemoteIncomingPairCard variant="zone-display" />
    </div>
  )
}
