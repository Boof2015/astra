import { useMemo, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import ParallaxIncomingPairCard from '../layout/ParallaxIncomingPairCard'
import { useEndpointIdentity } from './parallaxHelpers'

type SetupStep = 'role' | 'host' | 'sink'

interface ParallaxSetupFlowProps {
  /** Finish (or skip) the guided flow. Marks setup complete and closes the overlay. */
  onClose: () => void
  /** Open the existing pairing wizard (the panel hides this overlay while the wizard is up). */
  onAddSpeaker: () => void
  /** Kept mounted but visually hidden while the pairing wizard is up, so step state survives. */
  hidden?: boolean
}

/**
 * Contextual, stepped first-run panel. Frames the whole feature around one question — "what is this
 * machine?" — then walks the chosen exclusive role to a working state. Pairing itself is delegated
 * to the existing ParallaxPairingWizard; incoming-PIN display to ParallaxIncomingPairCard.
 */
export default function ParallaxSetupFlow({ onClose, onAddSpeaker, hidden = false }: ParallaxSetupFlowProps) {
  const { status, pairedSinks, setHostEnabled, setSinkEnabled } = useParallaxStore()
  const openZoneDisplayOnLaunch = useUIStore((s) => s.openZoneDisplayOnLaunch)
  const setOpenZoneDisplayOnLaunch = useUIStore((s) => s.setOpenZoneDisplayOnLaunch)
  const identity = useEndpointIdentity()

  const [step, setStep] = useState<SetupStep>('role')
  const [busy, setBusy] = useState(false)

  const activeSinkCount = useMemo(
    () => pairedSinks.filter((sink) => sink.revokedAt == null).length,
    [pairedSinks]
  )

  const pickHost = async () => {
    setBusy(true)
    try {
      await setSinkEnabled(false)
      await setHostEnabled(true)
      // "Open Zone Display on launch" is a speaker-only setting, and its toggle is hidden once this
      // machine is a host — clear it here so it can't get stranded on with no way to turn it off.
      if (openZoneDisplayOnLaunch) setOpenZoneDisplayOnLaunch(false)
      setStep('host')
    } finally {
      setBusy(false)
    }
  }

  const pickSpeaker = async () => {
    setBusy(true)
    try {
      await setHostEnabled(false)
      await setSinkEnabled(true)
      setStep('sink')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="parallax-pairing-wizard-backdrop"
      role="dialog"
      aria-modal="true"
      style={hidden ? { display: 'none' } : undefined}
    >
      <div className="parallax-pairing-wizard-card parallax-setup-card">
        <div className="parallax-setup-head">
          <div>
            <span className="parallax-setup-kicker">Parallax setup</span>
            <h3 className="parallax-setup-title">
              {step === 'role' && 'What is this machine?'}
              {step === 'host' && 'Add your speakers'}
              {step === 'sink' && 'This machine is a speaker'}
            </h3>
          </div>
          <button type="button" className="modal-close parallax-setup-close" onClick={onClose} aria-label="Close setup">
            ✕
          </button>
        </div>

        {step === 'role' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">
              Parallax keeps audio in sync across machines on your network. Pick the job for this one.
            </p>
            <div className="parallax-choice-grid">
              <button className="parallax-choice-card" disabled={busy} onClick={() => void pickHost()}>
                <span className="parallax-choice-icon">♫</span>
                <span className="parallax-choice-title">Plays music</span>
                <span className="parallax-choice-desc">This is where you control playback. It sends audio to your speakers.</span>
              </button>
              <button className="parallax-choice-card" disabled={busy} onClick={() => void pickSpeaker()}>
                <span className="parallax-choice-icon">◉</span>
                <span className="parallax-choice-title">Is a speaker</span>
                <span className="parallax-choice-desc">This plays in sync with a host elsewhere on the network.</span>
              </button>
            </div>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={onClose}>Not now</button>
            </div>
          </div>
        )}

        {step === 'host' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">
              Find a nearby Astra running in speaker mode and pair it. You can add more anytime.
            </p>
            {activeSinkCount > 0 ? (
              <div className="parallax-setup-status is-good">
                ✓ {activeSinkCount} speaker{activeSinkCount === 1 ? '' : 's'} paired. Start playback to hear it in sync. Use <strong>Tune</strong> on a speaker if it sounds early or late.
              </div>
            ) : (
              <div className="parallax-setup-status">
                No speakers yet. On the other machine, open Parallax and choose “Is a speaker.”
              </div>
            )}
            <button className="settings-btn settings-btn-primary parallax-setup-cta" onClick={onAddSpeaker}>
              Add a speaker
            </button>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={() => setStep('role')}>Back</button>
              <button className="settings-btn settings-btn-primary" onClick={onClose}>
                {activeSinkCount > 0 ? 'Done' : 'Finish later'}
              </button>
            </div>
          </div>
        )}

        {step === 'sink' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">
              This machine is ready to play in sync. On your music machine, add this speaker, then confirm the PIN that appears here.
            </p>
            <div className="parallax-setup-identity">
              <div className="parallax-setup-identity-row">
                <span className="parallax-setup-identity-label">Find it as</span>
                <span className="parallax-setup-identity-value">{identity?.hostname || '—'}</span>
              </div>
              <div className="parallax-setup-identity-row">
                <span className="parallax-setup-identity-label">On network</span>
                <span className="parallax-setup-identity-value">
                  {identity && identity.lanIps.length > 0 ? identity.lanIps.join(' · ') : 'Finding address…'}
                </span>
              </div>
            </div>
            {status?.sink.incomingPairRequest
              ? <ParallaxIncomingPairCard variant="zone-display" />
              : <div className="parallax-setup-status">Waiting for a host to start pairing…</div>}
            <div className="settings-field settings-field-inline parallax-setup-inline-toggle">
              <span className="settings-field-label">Open Zone Display on launch</span>
              <button
                className={`settings-toggle ${openZoneDisplayOnLaunch ? 'active' : ''}`}
                onClick={() => setOpenZoneDisplayOnLaunch(!openZoneDisplayOnLaunch)}
              >
                {openZoneDisplayOnLaunch ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={() => setStep('role')}>Back</button>
              <button className="settings-btn settings-btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
