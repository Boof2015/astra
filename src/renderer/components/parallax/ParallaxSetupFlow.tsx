import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
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
            <span className="parallax-setup-kicker"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.parallax_setup" /></span>
            <h3 className="parallax-setup-title">
              {step === 'role' && 'What is this machine?'}
              {step === 'host' && 'Add your speakers'}
              {step === 'sink' && 'This machine is a speaker'}
            </h3>
          </div>
          <button type="button" className="modal-close parallax-setup-close" onClick={onClose} aria-label={translate('integrations:auto.parallaxsetupflow.close_setup')}>
            ✕
          </button>
        </div>

        {step === 'role' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">

              <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.parallax_keeps_audio_in_sync_across_machines_on_your_net" />
            </p>
            <div className="parallax-choice-grid">
              <button className="parallax-choice-card" disabled={busy} onClick={() => void pickHost()}>
                <span className="parallax-choice-icon">♫</span>
                <span className="parallax-choice-title"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.plays_music" /></span>
                <span className="parallax-choice-desc"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.this_is_where_you_control_playback_it_sends_audio_to_you" /></span>
              </button>
              <button className="parallax-choice-card" disabled={busy} onClick={() => void pickSpeaker()}>
                <span className="parallax-choice-icon">◉</span>
                <span className="parallax-choice-title"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.is_a_speaker" /></span>
                <span className="parallax-choice-desc"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.this_plays_in_sync_with_a_host_elsewhere_on_the_network" /></span>
              </button>
            </div>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={onClose}><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.not_now" /></button>
            </div>
          </div>
        )}

        {step === 'host' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">

              <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.find_a_nearby_astra_running_in_speaker_mode_and_pair_it_" />
            </p>
            {activeSinkCount > 0 ? (
              <div className="parallax-setup-status is-good">
                ✓ {activeSinkCount}  <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.speaker" />{activeSinkCount === 1 ? '' : translate('integrations:auto.parallaxsetupflow.s')}  <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.paired_start_playback_to_hear_it_in_sync_use" /> <strong><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.tune" /></strong>  <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.on_a_speaker_if_it_sounds_early_or_late" />
              </div>
            ) : (
              <div className="parallax-setup-status">

                <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.no_speakers_yet_on_the_other_machine_open_parallax_and_c" />
              </div>
            )}
            <button className="settings-btn settings-btn-primary parallax-setup-cta" onClick={onAddSpeaker}>

              <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.add_a_speaker" />
            </button>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={() => setStep('role')}><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.back" /></button>
              <button className="settings-btn settings-btn-primary" onClick={onClose}>
                {activeSinkCount > 0 ? translate('integrations:auto.parallaxsetupflow.done') : translate('integrations:auto.parallaxsetupflow.finish_later')}
              </button>
            </div>
          </div>
        )}

        {step === 'sink' && (
          <div className="parallax-setup-step">
            <p className="parallax-setup-lead">

              <LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.this_machine_is_ready_to_play_in_sync_on_your_music_mach" />
            </p>
            <div className="parallax-setup-identity">
              <div className="parallax-setup-identity-row">
                <span className="parallax-setup-identity-label"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.find_it_as" /></span>
                <span className="parallax-setup-identity-value">{identity?.hostname || '—'}</span>
              </div>
              <div className="parallax-setup-identity-row">
                <span className="parallax-setup-identity-label"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.on_network" /></span>
                <span className="parallax-setup-identity-value">
                  {identity && identity.lanIps.length > 0 ? identity.lanIps.join(' · ') : translate('integrations:auto.parallaxsetupflow.finding_address')}
                </span>
              </div>
            </div>
            {status?.sink.incomingPairRequest
              ? <ParallaxIncomingPairCard variant="zone-display" />
              : <div className="parallax-setup-status"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.waiting_for_a_host_to_start_pairing" /></div>}
            <div className="settings-field settings-field-inline parallax-setup-inline-toggle">
              <span className="settings-field-label"><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.open_zone_display_on_launch" /></span>
              <button
                className={`settings-toggle ${openZoneDisplayOnLaunch ? 'active' : ''}`}
                onClick={() => setOpenZoneDisplayOnLaunch(!openZoneDisplayOnLaunch)}
              >
                {openZoneDisplayOnLaunch ? translate('integrations:auto.parallaxsetupflow.enabled') : translate('integrations:auto.parallaxsetupflow.disabled')}
              </button>
            </div>
            <div className="parallax-setup-footer">
              <button className="settings-btn" onClick={() => setStep('role')}><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.back" /></button>
              <button className="settings-btn settings-btn-primary" onClick={onClose}><LocalizedText ns="integrations" i18nKey="auto.parallaxsetupflow.done" /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
