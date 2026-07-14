import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  PhoneRemotePairedDevice,
  PhoneRemotePairingTicket,
  PhoneRemotePendingPairingRequest
} from '../../../types/phoneRemote'
import { renderPairingQrSvg } from '../../utils/pairingQr'
import { usePresence } from '../../hooks/usePresence'
import type { CompanionApiScope } from '../../../types/companionApi'

interface LocalApiPairingModalProps {
  isOpen: boolean
  ticket: PhoneRemotePairingTicket | null
  pairedDevices: PhoneRemotePairedDevice[]
  pendingRequests: PhoneRemotePendingPairingRequest[]
  apiEnabled: boolean
  remoteWebEnabled: boolean
  controlsEnabled: boolean
  lanUrls: string[]
  selectedBaseUrl: string
  selectedControllerUrl: string
  feedbackMessage: string
  errorMessage: string
  onClose: () => void
  onEnableRemoteControl: () => void
  onSelectBaseUrl: (baseUrl: string) => void
  onGenerateTicket: () => void
  onGenerateWebTicket: () => void
  onRefreshTicket: () => void
  onCopyPairingUrl: () => void
  onApproveRequest: (id: string, scopes: CompanionApiScope[]) => void
  onRejectRequest: (id: string) => void
  onRevokeDevice: (id: string) => void
  onRevokeAllDevices: () => void
}

type WizardStep = 'enable' | 'qr' | 'approve'

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

const STEP_LABELS: { key: WizardStep; label: string }[] = [
  { key: 'enable', label: 'Setup' },
  { key: 'qr', label: 'Scan' },
  { key: 'approve', label: 'Approve' }
]

const SCOPE_LABELS: Record<CompanionApiScope, string> = {
  observe: 'Observe playback',
  'playback-control': 'Control playback',
  'library-search': 'Search the library',
  'library-write': 'Change favorites and playlists'
}

export default function LocalApiPairingModal(props: LocalApiPairingModalProps) {
  const {
    isOpen,
    ticket,
    pairedDevices,
    pendingRequests,
    apiEnabled,
    remoteWebEnabled,
    controlsEnabled,
    lanUrls,
    selectedBaseUrl,
    feedbackMessage,
    errorMessage,
    onClose,
    onEnableRemoteControl,
    onSelectBaseUrl,
    onGenerateTicket,
    onGenerateWebTicket,
    onRefreshTicket,
    onCopyPairingUrl,
    onApproveRequest,
    onRejectRequest,
    onRevokeDevice,
    onRevokeAllDevices
  } = props
  const presence = usePresence(isOpen)

  const [now, setNow] = useState(() => Date.now())
  const [showLinkOnlyQr, setShowLinkOnlyQr] = useState(false)
  const [grantedScopesByRequest, setGrantedScopesByRequest] = useState<Record<string, CompanionApiScope[]>>({})
  const autoGenerateAttempted = useRef(false)

  useEffect(() => {
    if (!isOpen) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [isOpen])

  const remoteControlReady = apiEnabled && remoteWebEnabled && controlsEnabled
  const canGenerateTicket = remoteControlReady && lanUrls.length > 0
  const remainingMs = ticket ? Math.max(0, ticket.expiresAt - now) : 0
  const hasLiveTicket = ticket != null && remainingMs > 0
  const hasPendingRequests = pendingRequests.length > 0
  const activeDevices = useMemo(() => pairedDevices.filter((d) => d.revokedAt == null), [pairedDevices])
  const hasPairedDevices = activeDevices.length > 0
  const prevDeviceCount = useRef(activeDevices.length)

  // Auto-close after a device is approved (device count increases)
  useEffect(() => {
    if (!isOpen) {
      prevDeviceCount.current = activeDevices.length
      return
    }
    if (activeDevices.length > prevDeviceCount.current) {
      onClose()
    }
    prevDeviceCount.current = activeDevices.length
  }, [activeDevices.length, isOpen, onClose])

  const wizardStep: WizardStep = !remoteControlReady
    ? 'enable'
    : hasPendingRequests
      ? 'approve'
      : 'qr'

  // Auto-generate ticket when entering QR step
  useEffect(() => {
    if (!isOpen) {
      autoGenerateAttempted.current = false
      return
    }
    if (wizardStep === 'qr' && !hasLiveTicket && canGenerateTicket && !autoGenerateAttempted.current) {
      autoGenerateAttempted.current = true
      onGenerateTicket()
    }
    if (wizardStep !== 'qr') {
      autoGenerateAttempted.current = false
    }
  }, [wizardStep, hasLiveTicket, canGenerateTicket, isOpen, onGenerateTicket])

  const controllerUrl = selectedBaseUrl ? `${selectedBaseUrl}/remote/` : props.selectedControllerUrl

  const svgMarkup = useMemo(() => {
    if (!ticket) return ''
    try {
      return renderPairingQrSvg(ticket.pairingUrl)
    } catch {
      return ''
    }
  }, [ticket])

  const linkOnlyQrSvg = useMemo(() => {
    if (!controllerUrl) return ''
    try {
      return renderPairingQrSvg(controllerUrl)
    } catch {
      return ''
    }
  }, [controllerUrl])

  const stepIndex = STEP_LABELS.findIndex((s) => s.key === wizardStep)

  if (!presence.shouldRender) return null

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={onClose}>
      <div
        className="modal-content local-api-pairing-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-api-pairing-title"
      >
        <div className="modal-header">
          <h3 id="local-api-pairing-title">Pair a Phone</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body local-api-pairing-body">
          {feedbackMessage && wizardStep !== 'approve' && <p className="settings-note settings-note-success">{feedbackMessage}</p>}
          {errorMessage && wizardStep !== 'approve' && <p className="settings-note settings-note-error">{errorMessage}</p>}

          {/* Step indicator */}
          <div className="local-api-pairing-steps" aria-hidden="true">
            {STEP_LABELS.map((step, i) => {
              const isCompleted = i < stepIndex
              const isActive = i === stepIndex
              return (
                <div key={step.key} className="local-api-pairing-step-item">
                  <div
                    className={`local-api-pairing-step-dot${isActive ? ' is-active' : ''}${isCompleted ? ' is-completed' : ''}`}
                  >
                    {isCompleted && (
                      <svg viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <span className="local-api-pairing-step-label">{step.label}</span>
                </div>
              )
            })}
          </div>

          {/* Enable step */}
          {wizardStep === 'enable' && (
            <div className="local-api-pairing-enable" key="enable">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                <rect x="12" y="4" width="24" height="40" rx="4" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" fill="none" />
                <circle cx="24" cy="38" r="2" fill="rgba(255,255,255,0.2)" />
                <path d="M20 10h8" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeLinecap="round" />
                <path d="M32 24l6-3v10l-6-3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
                <path d="M10 24l-6-3v10l6-3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
              </svg>
              <p>Enable phone remote hosting to get started.</p>
              <button className="settings-btn settings-btn-primary" onClick={onEnableRemoteControl}>
                Enable Phone Remote
              </button>
            </div>
          )}

          {/* QR step */}
          {wizardStep === 'qr' && (
            <div className="local-api-pairing-qr-hero" key="qr">
              {canGenerateTicket ? (
                <>
                  <div className="local-api-pairing-qr-wrap">
                    {hasLiveTicket && svgMarkup ? (
                      <div className="local-api-pairing-qr" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
                    ) : hasLiveTicket && !svgMarkup ? (
                      <p className="settings-note settings-note-error" style={{ margin: 0 }}>
                        Could not render QR code. Use the copy button below.
                      </p>
                    ) : ticket && remainingMs <= 0 ? (
                      <div className="local-api-pairing-qr-expired">
                        <div className="local-api-pairing-qr local-api-pairing-qr-dim" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
                        <button className="settings-btn settings-btn-primary local-api-pairing-qr-expired-btn" onClick={onRefreshTicket}>
                          Regenerate
                        </button>
                      </div>
                    ) : (
                      <div className="local-api-pairing-qr-loading">Generating...</div>
                    )}
                  </div>

                  {hasLiveTicket && (
                    <>
                      <p className="local-api-pairing-scan-hint">
                        {ticket?.clientKind === 'web'
                          ? 'Open in a browser for playback control only'
                          : 'Scan in Astra Mobile for secure control and sync'}
                      </p>
                      {ticket?.clientKind === 'web' && (
                        <p className="settings-note">
                          Your browser will show a warning for Astra's private certificate. Verify this SHA-256 fingerprint before continuing: <code>{ticket.certificateFingerprint}</code>
                        </p>
                      )}
                      <div className="local-api-pairing-qr-actions">
                        <span className={`local-api-pairing-countdown${remainingMs < 60000 ? ' is-expiring' : ''}`}>
                          {formatCountdown(remainingMs)}
                        </span>
                        <button className="settings-btn settings-btn-primary" onClick={onCopyPairingUrl}>
                          Copy Link
                        </button>
                        <button className="settings-btn" onClick={ticket?.clientKind === 'web' ? onGenerateTicket : onGenerateWebTicket}>
                          {ticket?.clientKind === 'web' ? 'Astra Mobile' : 'Browser Controller'}
                        </button>
                        <button className="settings-btn local-api-pairing-refresh-btn" onClick={onRefreshTicket} aria-label="Refresh pairing code">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M1.5 7a5.5 5.5 0 0 1 9.36-3.93M12.5 7a5.5 5.5 0 0 1-9.36 3.93" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                            <path d="M10.5 1v2.5H13M3.5 13v-2.5H1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}

                  {ticket && remainingMs <= 0 && (
                    <p className="local-api-pairing-scan-hint">Pairing code expired</p>
                  )}

                  {lanUrls.length > 1 && (
                    <select
                      className="settings-select local-api-pairing-url-select"
                      value={selectedBaseUrl}
                      onChange={(event) => onSelectBaseUrl(event.target.value)}
                    >
                      {lanUrls.map((url) => (
                        <option key={url} value={url}>{url}</option>
                      ))}
                    </select>
                  )}
                </>
              ) : (
                <div className="local-api-pairing-waiting">
                  Waiting for a LAN address...
                </div>
              )}
            </div>
          )}

          {/* Approve step */}
          {wizardStep === 'approve' && (
            <div className="local-api-pairing-approve" key="approve">
              <h4 className="local-api-pairing-approve-title">A device or integration wants to connect</h4>
              {pendingRequests.map((request) => {
                const isPinRequest = request.pairingMode === 'pin' && Boolean(request.pin)
                const pinDigits = request.pin?.split('') ?? []
                const grantedScopes = grantedScopesByRequest[request.id] ?? request.requestedScopes
                return (
                  <div key={request.id} className="local-api-pairing-approve-card">
                    <div className="local-api-pairing-approve-info">
                      <span className="local-api-pairing-approve-name">{request.deviceName}</span>
                      <span className="local-api-pairing-approve-detail">
                        {request.clientLabel} &middot; expires {new Date(request.expiresAt).toLocaleTimeString()}
                      </span>
                      <div className="local-api-pairing-scope-list">
                        {request.requestedScopes.map((scope) => (
                          <label key={scope} className="local-api-pairing-scope-option">
                            <input
                              type="checkbox"
                              checked={grantedScopes.includes(scope)}
                              disabled={scope === 'observe' || isPinRequest}
                              onChange={(event) => {
                                setGrantedScopesByRequest((current) => {
                                  const nextScopes = event.target.checked
                                    ? Array.from(new Set([...(current[request.id] ?? request.requestedScopes), scope]))
                                    : (current[request.id] ?? request.requestedScopes).filter((candidate) => candidate !== scope)
                                  return { ...current, [request.id]: nextScopes }
                                })
                              }}
                            />
                            <span>{SCOPE_LABELS[scope]}</span>
                          </label>
                        ))}
                      </div>
                      {isPinRequest && (
                        <>
                          <div className="local-api-pairing-pin" aria-label={`PIN ${request.pin}`}>
                            {pinDigits.map((digit, index) => (
                              <span key={index} className="local-api-pairing-pin-digit">{digit}</span>
                            ))}
                          </div>
                          <span className="local-api-pairing-approve-detail">
                            Enter this PIN in the requesting app to finish pairing.
                          </span>
                        </>
                      )}
                    </div>
                    <div className="local-api-pairing-approve-actions">
                      {!isPinRequest && (
                        <button
                          className="settings-btn settings-btn-primary"
                          onClick={() => onApproveRequest(request.id, grantedScopes)}
                        >
                          Approve
                        </button>
                      )}
                      <button
                        className="settings-btn"
                        onClick={() => onRejectRequest(request.id)}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Paired devices — only on QR step */}
          {hasPairedDevices && wizardStep === 'qr' && (
            <div className="local-api-pairing-paired">
              <div className="local-api-pairing-paired-header">
                <span className="local-api-pairing-paired-count">
                  {activeDevices.length} paired device{activeDevices.length !== 1 ? 's' : ''}
                </span>
                {controllerUrl && (
                  <button
                    className={`settings-btn${showLinkOnlyQr ? ' settings-btn-primary' : ''}`}
                    onClick={() => setShowLinkOnlyQr((prev) => !prev)}
                    title="Show a QR code that opens the remote controller — no pairing needed for already-paired phones"
                  >
                    {showLinkOnlyQr ? 'Hide QR' : 'Open on Phone'}
                  </button>
                )}
              </div>

              {showLinkOnlyQr && controllerUrl && linkOnlyQrSvg && (
                <div className="local-api-pairing-link-qr">
                  <div className="local-api-pairing-qr" dangerouslySetInnerHTML={{ __html: linkOnlyQrSvg }} />
                  <p className="local-api-pairing-scan-hint">Scan to open the remote — no new pairing required</p>
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={() => {
                      void navigator.clipboard.writeText(controllerUrl)
                    }}
                  >
                    Copy Link
                  </button>
                </div>
              )}

              <div className="local-api-pairing-paired-list">
                {activeDevices.map((device) => (
                  <div key={device.id} className="local-api-pairing-paired-device">
                    <div className="local-api-pairing-paired-device-info">
                      <span className="local-api-pairing-paired-device-name">{device.name}</span>
                      <span className="local-api-pairing-paired-device-detail">
                        Last seen {formatTimestamp(device.lastSeenAt)}
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
                {activeDevices.length >= 2 && (
                  <button className="settings-btn settings-btn-danger" onClick={onRevokeAllDevices}>
                    Revoke All
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
