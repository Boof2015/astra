import { useEffect, useMemo, useState } from 'react'
import type {
  LocalApiPairedDevice,
  LocalApiPairingTicket,
  LocalApiPendingPairingRequest
} from '../../../types/localApi'
import { renderPairingQrSvg } from '../../utils/pairingQr'

interface LocalApiPairingModalProps {
  ticket: LocalApiPairingTicket | null
  pairedDevices: LocalApiPairedDevice[]
  pendingRequests: LocalApiPendingPairingRequest[]
  apiEnabled: boolean
  remoteWebEnabled: boolean
  controlsEnabled: boolean
  lanUrls: string[]
  selectedBaseUrl: string
  selectedControllerUrl: string
  feedbackMessage: string
  errorMessage: string
  onClose: () => void
  onSetApiEnabled: (enabled: boolean) => void
  onSetRemoteWebEnabled: (enabled: boolean) => void
  onSetControlsEnabled: (enabled: boolean) => void
  onSelectBaseUrl: (baseUrl: string) => void
  onGenerateTicket: () => void
  onRefreshTicket: () => void
  onCopyPairingUrl: () => void
  onApproveRequest: (id: string) => void
  onRejectRequest: (id: string) => void
  onRevokeDevice: (id: string) => void
  onRevokeAllDevices: () => void
}

function formatCountdown(remainingMs: number): string {
  const safeSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatTimestamp(value: number | null): string {
  if (value == null) return 'Never'
  return new Date(value).toLocaleString()
}

export default function LocalApiPairingModal(props: LocalApiPairingModalProps) {
  const {
    ticket,
    pairedDevices,
    pendingRequests,
    apiEnabled,
    remoteWebEnabled,
    controlsEnabled,
    lanUrls,
    selectedBaseUrl,
    selectedControllerUrl,
    feedbackMessage,
    errorMessage,
    onClose,
    onSetApiEnabled,
    onSetRemoteWebEnabled,
    onSetControlsEnabled,
    onSelectBaseUrl,
    onGenerateTicket,
    onRefreshTicket,
    onCopyPairingUrl,
    onApproveRequest,
    onRejectRequest,
    onRevokeDevice,
    onRevokeAllDevices
  } = props
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 250)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const desktopReady = apiEnabled && remoteWebEnabled
  const canGenerateTicket = desktopReady && lanUrls.length > 0
  const remainingMs = ticket ? Math.max(0, ticket.expiresAt - now) : 0
  const hasPendingRequests = pendingRequests.length > 0
  const hasPairedDevices = pairedDevices.length > 0
  const svgMarkup = useMemo(() => {
    if (!ticket) return ''
    try {
      return renderPairingQrSvg(ticket.pairingUrl)
    } catch {
      return ''
    }
  }, [ticket])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content local-api-pairing-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-api-pairing-title"
      >
        <div className="modal-header">
          <div>
            <h3 id="local-api-pairing-title">Phone Remote Setup</h3>
            <p className="local-api-pairing-subtitle">
              Experimental guided setup for the LAN phone controller. Start here, then follow the steps in order.
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body local-api-pairing-body">
          {feedbackMessage && <p className="settings-note settings-note-success">{feedbackMessage}</p>}
          {errorMessage && <p className="settings-note settings-note-error">{errorMessage}</p>}

          <section className={`local-api-pairing-flow-step ${desktopReady ? 'is-active' : 'is-blocked'}`}>
            <div className="local-api-pairing-flow-head">
              <div className="local-api-pairing-flow-number">1</div>
              <div className="local-api-pairing-flow-copy">
                <h4>Prepare Astra</h4>
                <p>Turn on the pieces the phone remote needs. Playback controls are optional and can stay read-only.</p>
              </div>
              <span className={`settings-chip ${desktopReady ? '' : 'settings-chip-danger'}`}>
                {desktopReady ? 'Ready' : 'Setup Needed'}
              </span>
            </div>
            <div className="local-api-pairing-toggle-grid">
              <div className="local-api-pairing-toggle-card">
                <div className="local-api-pairing-toggle-copy">
                  <span className="settings-field-label">Local Integration API</span>
                  <p className="settings-note">Required before Astra can create any pairing link.</p>
                </div>
                <button
                  className={`settings-toggle ${apiEnabled ? 'active' : ''}`}
                  onClick={() => onSetApiEnabled(!apiEnabled)}
                >
                  {apiEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="local-api-pairing-toggle-card">
                <div className="local-api-pairing-toggle-copy">
                  <span className="settings-field-label">Phone Remote Host</span>
                  <p className="settings-note">Exposes the phone controller on your LAN and allows pairing tickets.</p>
                </div>
                <button
                  className={`settings-toggle ${remoteWebEnabled ? 'active' : ''}`}
                  onClick={() => onSetRemoteWebEnabled(!remoteWebEnabled)}
                  disabled={!apiEnabled}
                >
                  {remoteWebEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="local-api-pairing-toggle-card">
                <div className="local-api-pairing-toggle-copy">
                  <span className="settings-field-label">Playback Controls</span>
                  <p className="settings-note">Optional. Leave off if the phone should only view playback state.</p>
                </div>
                <button
                  className={`settings-toggle ${controlsEnabled ? 'active' : ''}`}
                  onClick={() => onSetControlsEnabled(!controlsEnabled)}
                  disabled={!apiEnabled}
                >
                  {controlsEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
          </section>

          <section className={`local-api-pairing-flow-step ${canGenerateTicket ? 'is-active' : 'is-blocked'}`}>
            <div className="local-api-pairing-flow-head">
              <div className="local-api-pairing-flow-number">2</div>
              <div className="local-api-pairing-flow-copy">
                <h4>Create the phone pairing code</h4>
                <p>Astra prefers `192.168.*` addresses here. Generate a pairing code, then scan or open it on the phone.</p>
              </div>
              <span className={`settings-chip ${ticket ? '' : 'settings-chip-danger'}`}>
                {ticket ? 'Pairing Live' : canGenerateTicket ? 'Ready' : 'Blocked'}
              </span>
            </div>
            {canGenerateTicket ? (
              <>
                <div className="local-api-pairing-action-row">
                  <select
                    className="settings-select settings-inline-input settings-inline-input-grow"
                    value={selectedBaseUrl}
                    onChange={(event) => onSelectBaseUrl(event.target.value)}
                  >
                    {lanUrls.map((url) => (
                      <option key={url} value={url}>
                        {url}
                      </option>
                    ))}
                  </select>
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={ticket ? onRefreshTicket : onGenerateTicket}
                  >
                    {ticket ? 'Refresh Pairing Code' : 'Generate Pairing Code'}
                  </button>
                </div>
                {selectedControllerUrl && (
                  <div className="local-api-pairing-inline-chip-row">
                    <span className="settings-chip settings-chip-mono settings-chip-grow">{selectedControllerUrl}</span>
                  </div>
                )}
                {ticket ? (
                  <div className="local-api-pairing-hero">
                    <div className="local-api-pairing-qr-wrap">
                      {svgMarkup ? (
                        <div className="local-api-pairing-qr" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
                      ) : (
                        <p className="settings-note settings-note-error">
                          Astra could not render a QR code for this pairing link. Use the copy button instead.
                        </p>
                      )}
                    </div>
                    <div className="local-api-pairing-meta">
                      <div className="local-api-pairing-meta-row">
                        <span className="settings-field-label">Expires In</span>
                        <span className={`settings-chip settings-chip-mono ${remainingMs > 0 ? '' : 'settings-chip-danger'}`}>
                          {remainingMs > 0 ? formatCountdown(remainingMs) : 'Expired'}
                        </span>
                      </div>
                      <div className="local-api-pairing-meta-row">
                        <span className="settings-field-label">Selected Pairing URL</span>
                        <span className="settings-chip settings-chip-mono settings-chip-grow">{ticket.controllerUrl}</span>
                      </div>
                      <div className="local-api-pairing-actions">
                        <button className="settings-btn settings-btn-primary" onClick={onCopyPairingUrl}>
                          Copy Pairing Link
                        </button>
                        <button className="settings-btn" onClick={onRefreshTicket}>
                          Regenerate
                        </button>
                      </div>
                      <p className="settings-note">
                        Keep the popup open. Once the phone claims this link, Astra will show its approval request below.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="local-api-pairing-waiting">
                    Generate a pairing code to show the QR and copyable link for the phone.
                  </div>
                )}
              </>
            ) : (
              <div className="local-api-pairing-waiting">
                {!apiEnabled
                  ? 'Enable the Local Integration API first.'
                  : !remoteWebEnabled
                    ? 'Enable the Phone Remote Host first.'
                    : 'Astra could not find a usable `192.168.*` LAN address yet.'}
              </div>
            )}
          </section>

          <section className={`local-api-pairing-flow-step ${hasPendingRequests ? 'is-active' : ''}`}>
            <div className="local-api-pairing-flow-head">
              <div className="local-api-pairing-flow-number">3</div>
              <div className="local-api-pairing-flow-copy">
                <h4>Approve the phone</h4>
                <p>A phone only receives its per-device credential after you approve it here.</p>
              </div>
              <span className={`settings-chip ${hasPendingRequests ? 'settings-chip-danger' : ''}`}>
                {hasPendingRequests ? `${pendingRequests.length} Waiting` : 'Waiting'}
              </span>
            </div>
            {hasPendingRequests ? (
              <div className="local-api-pairing-request-list">
                {pendingRequests.map((request) => (
                  <div key={request.id} className="settings-pairing-request">
                    <div className="settings-pairing-request-copy">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {request.deviceName}
                      </span>
                      <span className="settings-note">
                        {request.clientLabel} • expires {new Date(request.expiresAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="settings-inline-row">
                      <button
                        className="settings-btn settings-btn-primary"
                        onClick={() => onApproveRequest(request.id)}
                      >
                        Approve
                      </button>
                      <button
                        className="settings-btn"
                        onClick={() => onRejectRequest(request.id)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="local-api-pairing-waiting">
                Astra is waiting for the phone to claim the pairing link and ask for approval.
              </div>
            )}
          </section>

          <section className={`local-api-pairing-flow-step ${hasPairedDevices ? 'is-active' : ''}`}>
            <div className="local-api-pairing-flow-head">
              <div className="local-api-pairing-flow-number">4</div>
              <div className="local-api-pairing-flow-copy">
                <h4>Manage paired phones</h4>
                <p>Each phone gets its own revocable device token. Remove access here if a phone is lost or replaced.</p>
              </div>
              <span className={`settings-chip ${hasPairedDevices ? '' : 'settings-chip-danger'}`}>
                {hasPairedDevices ? `${pairedDevices.length} Paired` : 'None'}
              </span>
            </div>
            {hasPairedDevices ? (
              <>
                <div className="local-api-pairing-request-list">
                  {pairedDevices.map((device) => (
                    <div key={device.id} className="settings-paired-device">
                      <div className="settings-pairing-request-copy">
                        <span className="settings-chip settings-chip-mono settings-chip-grow">{device.name}</span>
                        <span className="settings-note">
                          {device.clientLabel} • added {formatTimestamp(device.createdAt)}
                        </span>
                        <span className="settings-note">
                          last seen {formatTimestamp(device.lastSeenAt)} • token {device.tokenPrefix}...
                        </span>
                      </div>
                      <button
                        className="settings-btn settings-btn-danger"
                        onClick={() => onRevokeDevice(device.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
                <div className="local-api-pairing-actions">
                  <button className="settings-btn settings-btn-danger" onClick={onRevokeAllDevices}>
                    Revoke All Phones
                  </button>
                </div>
              </>
            ) : (
              <div className="local-api-pairing-waiting">
                No phones are paired yet. Once you approve one, it will show up here for later management.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
