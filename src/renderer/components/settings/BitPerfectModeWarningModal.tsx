import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
import { usePresence } from '../../hooks/usePresence'

interface BitPerfectModeWarningModalProps {
  isOpen: boolean
  dontShowAgain: boolean
  onDontShowAgainChange: (checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export default function BitPerfectModeWarningModal({
  isOpen,
  dontShowAgain,
  onDontShowAgainChange,
  onCancel,
  onConfirm,
}: BitPerfectModeWarningModalProps) {
  const presence = usePresence(isOpen)
  if (!presence.shouldRender) return null

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={onCancel}>
      <div
        className="modal-content confirm-action-modal confirm-action-modal-danger exclusive-mode-warning-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.enable_bit_perfect_exclusive_mode" /></h2>
          <button className="modal-close" onClick={onCancel} aria-label={translate('settings:auto.bitperfectmodewarningmodal.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">

            <LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.bit_perfect_mode_is_experimental_and_takes_exclusive_dir" />
          </p>
          <ul className="exclusive-mode-warning-list">
            <li><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.system_and_app_volume_controls_may_stop_working_on_that_" /></li>
            <li><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.other_apps_may_lose_audio_while_astra_owns_the_device" /></li>
            <li><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.sample_rate_switching_can_interrupt_playback_when_tracks" /></li>
            <li><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.eq_normalization_routing_and_delay_compensation_are_disa" /></li>
            <li><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.use_standard_mode_if_you_want_normal_shared_device_playb" /></li>
          </ul>
          <label className="exclusive-mode-warning-checkbox">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => onDontShowAgainChange(event.target.checked)}
            />
            <span><LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.don_apos_t_show_this_again" /></span>
          </label>
        </div>

        <div className="modal-footer confirm-action-footer">
          <button className="settings-btn" onClick={onCancel}>

            <LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.stay_in_standard" />
          </button>
          <button className="settings-btn settings-btn-danger" onClick={onConfirm}>

            <LocalizedText ns="settings" i18nKey="auto.bitperfectmodewarningmodal.enable_exclusive_mode" />
          </button>
        </div>
      </div>
    </div>
  )
}
