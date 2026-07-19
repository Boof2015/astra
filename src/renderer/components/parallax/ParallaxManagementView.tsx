import { useEffect, useMemo, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import {
  PARALLAX_DEFAULT_PORT,
  PARALLAX_MAX_PORT,
  PARALLAX_MIN_PORT,
  type ParallaxConnectedSinkState
} from '../../../types/parallax'
import ParallaxSpeakerRow from './ParallaxSpeakerRow'
import { deriveParallaxRole } from './parallaxHelpers'

interface ParallaxManagementViewProps {
  notify: (message: string) => void
  onAddSpeaker: () => void
  onChangeRole: () => void
}

/**
 * Post-setup management surface, organized by the machine's (exclusive) role. The default view is
 * intentionally sparse — every raw/power control lives one click away inside the Advanced
 * disclosure, which is where the demoted host/sink toggles + port + host address now live.
 */
export default function ParallaxManagementView({ notify, onAddSpeaker, onChangeRole }: ParallaxManagementViewProps) {
  const {
    status,
    pairedSinks,
    setHostEnabled,
    setSinkEnabled,
    setHostPort,
    revokeAllPairedSinks,
    reconnectFromPersisted,
    disconnectSink,
    clearHostPresenceCache,
    setAllSinksPlaybackEnabled
  } = useParallaxStore()
  const openZoneDisplayOnLaunch = useUIStore((s) => s.openZoneDisplayOnLaunch)
  const setOpenZoneDisplayOnLaunch = useUIStore((s) => s.setOpenZoneDisplayOnLaunch)

  const role = deriveParallaxRole(status)
  const hostEnabled = status?.host.enabled ?? false
  const sinkEnabled = status?.sink.sinkEnabled ?? false
  const lanUrls = status?.host.lanUrls ?? []
  const hostUrl = lanUrls[0] ?? `https://127.0.0.1:${PARALLAX_DEFAULT_PORT}`
  const sinkConnected = status?.sink.connected ?? false
  const removedByHost = status?.sink.removedByHost ?? false
  const hasPersistedConnection = status?.sink.hasPersistedConnection ?? false
  const persistedHostName = status?.sink.persistedHostName ?? null
  const connectedSinkCount = status?.host.connectedSinkCount ?? 0
  const activePlaybackSinkCount = status?.host.activePlaybackSinkCount ?? 0

  const activeSinks = useMemo(() => pairedSinks.filter((sink) => sink.revokedAt == null), [pairedSinks])
  const selectedSinkCount = useMemo(
    () => activeSinks.filter((sink) => sink.playbackEnabled !== false).length,
    [activeSinks]
  )
  const connectedBySinkId = useMemo(() => {
    const rows = status?.host.connectedSinks ?? []
    return new Map<string, ParallaxConnectedSinkState>(rows.map((sink) => [sink.sinkId, sink]))
  }, [status?.host.connectedSinks])
  const managedSinks = useMemo(() => {
    return activeSinks
      .map((sink, index) => ({ sink, index, connected: connectedBySinkId.get(sink.id) ?? null }))
      .sort((left, right) => {
        const leftOnline = left.connected?.online ? 1 : 0
        const rightOnline = right.connected?.online ? 1 : 0
        if (leftOnline !== rightOnline) return rightOnline - leftOnline
        const createdDelta = right.sink.createdAt - left.sink.createdAt
        return createdDelta || left.index - right.index
      })
  }, [activeSinks, connectedBySinkId])
  const activeStreamLabel = status?.host.activeStream
    ? `Streaming ${status.host.activeStream.title || 'current track'}`
    : 'No active stream'

  const [portInput, setPortInput] = useState(String(status?.host.port ?? PARALLAX_DEFAULT_PORT))
  useEffect(() => {
    if (!status) return
    setPortInput(String(status.host.port))
  }, [status?.host.port])

  const roleSummary = (() => {
    if (role === 'host') {
      return connectedSinkCount > 0
        ? `This machine plays music. ${activePlaybackSinkCount} playing · ${connectedSinkCount} connected.`
        : 'This machine plays music. No speakers connected yet.'
    }
    if (role === 'sink') {
      if (removedByHost) return 'This machine is a speaker, removed by host. Re-pair to reconnect.'
      if (sinkConnected) return `This machine is a speaker, paired to ${persistedHostName ?? 'a host'}.`
      return 'This machine is a speaker, waiting for a host to pair it.'
    }
    return 'Parallax has no active role on this machine yet.'
  })()

  const handleSavePort = () => {
    const parsed = Number(portInput)
    if (!Number.isInteger(parsed) || parsed < PARALLAX_MIN_PORT || parsed > PARALLAX_MAX_PORT) {
      notify(`Port must be an integer between ${PARALLAX_MIN_PORT} and ${PARALLAX_MAX_PORT}.`)
      return
    }
    void setHostPort(parsed).then((next) => {
      if (next) notify(`Parallax port set to ${next.host.port}.`)
    })
  }

  const handleCopyHostUrl = async () => {
    try {
      await navigator.clipboard.writeText(hostUrl)
      notify('Host address copied.')
    } catch {
      notify('Failed to copy host address.')
    }
  }

  const handleReconnect = () => {
    void reconnectFromPersisted().then((next) => {
      if (next) notify(next.sink.connected ? 'Reconnected to host.' : 'Reconnect started.')
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to reconnect to host.')
    })
  }

  const handleDisconnect = () => {
    void disconnectSink().then(() => notify('Disconnected from host.')).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to disconnect from host.')
    })
  }

  const handleForgetHost = () => {
    if (!window.confirm('Forget this host? You will need to re-pair to reconnect.')) return
    void window.electronAPI.parallax.forgetSinkConnection().then(() => {
      notify('Forgot host. Pair again to reconnect.')
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to forget host.')
    })
  }

  const handleClearAllCache = () => {
    if (!window.confirm('Clear all cached speaker status rows? Pairings are preserved.')) return
    void clearHostPresenceCache().then((next) => {
      if (next) notify('Cleared cached status rows.')
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to clear cached status.')
    })
  }

  const handleSetAllPlayback = (enabled: boolean) => {
    void setAllSinksPlaybackEnabled(enabled).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to update zone playback.')
    })
  }

  return (
    <div className="parallax-management">
      {status?.securityMigrationRequired && (
        <div className="settings-card parallax-security-migration-card" role="status">
          <div className="settings-card-label">Parallax security update</div>
          <p>Previous pairings were removed so Parallax can use encrypted, identity-pinned connections. Pair each speaker again once.</p>
        </div>
      )}
      {/* This machine — role identity + the one control that flips it */}
      <div className="settings-card">
        <div className="settings-card-label">This machine</div>
        <div className="settings-grid">
          <div className="settings-field settings-field-inline">
            <span className="settings-field-label">{roleSummary}</span>
            <button className="settings-btn" onClick={onChangeRole}>Change role</button>
          </div>
        </div>
      </div>

      {role === 'host' && (
        <div className="settings-card parallax-speakers-card">
          <div className="parallax-card-header">
            <div className="settings-card-label settings-card-label-bare">
              Speakers ({activePlaybackSinkCount} playing · {connectedSinkCount} connected)
            </div>
            <div className="parallax-card-header-actions">
              <button
                className="settings-btn"
                disabled={activeSinks.length === 0 || selectedSinkCount === activeSinks.length}
                onClick={() => handleSetAllPlayback(true)}
              >
                Play all
              </button>
              <button
                className="settings-btn"
                disabled={activeSinks.length === 0 || selectedSinkCount === 0}
                onClick={() => handleSetAllPlayback(false)}
              >
                Play none
              </button>
              <button className="settings-btn settings-btn-primary" onClick={onAddSpeaker}>Add speaker</button>
            </div>
          </div>
          {managedSinks.length > 0 ? (
            <div className="parallax-speaker-list">
              {managedSinks.map(({ sink, connected }) => (
                <ParallaxSpeakerRow
                  key={sink.id}
                  sink={sink}
                  connected={connected}
                  activeStreamLabel={activeStreamLabel}
                  notify={notify}
                />
              ))}
              {activeSinks.length >= 2 && (
                <div className="parallax-speaker-list-footer">
                  <button className="settings-btn" onClick={handleClearAllCache}>Clear cached status</button>
                  <button className="settings-btn settings-btn-danger" onClick={() => void revokeAllPairedSinks()}>
                    Remove all
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="parallax-speaker-empty">
              <span>No speakers yet.</span>
              <button className="settings-btn settings-btn-primary" onClick={onAddSpeaker}>Add speaker</button>
            </div>
          )}
        </div>
      )}

      {role === 'sink' && (
        <div className="settings-card">
          <div className="settings-card-label">This speaker</div>
          <div className="settings-grid">
            {hasPersistedConnection ? (
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Paired host</span>
                <div className="settings-inline-row">
                  <span className="settings-info-value">{persistedHostName ?? '—'}</span>
                  {sinkConnected ? (
                    <button className="settings-btn" onClick={handleDisconnect}>Disconnect</button>
                  ) : (
                    <button
                      className="settings-btn settings-btn-primary"
                      disabled={!sinkEnabled}
                      onClick={handleReconnect}
                      title={sinkEnabled ? 'Reconnect to paired host' : 'Enable Parallax to reconnect'}
                    >
                      Reconnect
                    </button>
                  )}
                  <button className="settings-btn settings-btn-danger" onClick={handleForgetHost}>Forget host</button>
                </div>
              </div>
            ) : (
              <div className="settings-field">
                <span className="settings-field-label">Not paired to a host yet</span>
                <p className="settings-note">
                  Open this machine's host and add it as a speaker. A PIN will appear here to confirm.
                </p>
              </div>
            )}
            <div className="settings-field settings-field-inline">
              <span className="settings-field-label">Open Zone Display on launch</span>
              <button
                className={`settings-toggle ${openZoneDisplayOnLaunch ? 'active' : ''}`}
                onClick={() => setOpenZoneDisplayOnLaunch(!openZoneDisplayOnLaunch)}
              >
                {openZoneDisplayOnLaunch ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          </div>
        </div>
      )}

      {role === 'none' && (
        <div className="settings-card">
          <div className="settings-grid">
            <div className="settings-field settings-field-inline">
              <span className="settings-field-label">Parallax is on, but no role is chosen.</span>
              <button className="settings-btn settings-btn-primary" onClick={onChangeRole}>Choose role</button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced — demoted raw controls */}
      <details className="parallax-advanced-disclosure">
        <summary className="parallax-advanced-summary">Advanced</summary>
        <div className="settings-grid">
          <div className="settings-field settings-field-inline">
            <span className="settings-field-label">Enable Parallax Host</span>
            <button
              className={`settings-toggle ${hostEnabled ? 'active' : ''}`}
              onClick={() => void setHostEnabled(!hostEnabled)}
            >
              {hostEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div className="settings-field settings-field-inline">
            <span className="settings-field-label">Enable Parallax Sink</span>
            <button
              className={`settings-toggle ${sinkEnabled ? 'active' : ''}`}
              onClick={() => void setSinkEnabled(!sinkEnabled)}
            >
              {sinkEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div className="settings-field">
            <span className="settings-field-label">Parallax Port</span>
            <div className="settings-inline-row">
              <input
                className="settings-select settings-inline-input settings-inline-input-compact"
                type="number"
                min={PARALLAX_MIN_PORT}
                max={PARALLAX_MAX_PORT}
                step={1}
                value={portInput}
                onChange={(event) => setPortInput(event.target.value)}
                onBlur={handleSavePort}
              />
              <button className="settings-btn" onClick={handleSavePort}>Save</button>
            </div>
          </div>
          <div className="settings-field">
            <span className="settings-field-label">Host Address</span>
            <div className="settings-inline-row">
              <span className="settings-chip settings-chip-mono settings-chip-grow">{hostUrl}</span>
              <button className="settings-btn" disabled={!hostEnabled} onClick={() => void handleCopyHostUrl()}>
                Copy
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  )
}
