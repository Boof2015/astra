import { usePresence } from '../../hooks/usePresence'

export interface BitPerfectFormatFailureNotice {
  id: number
  trackTitle: string
  deviceLabel: string | null
  sampleRate: number | null
  channels: number | null
  sampleFormat: string | null
  message: string
}

interface BitPerfectFormatFailureModalProps {
  notice: BitPerfectFormatFailureNotice | null
  onDismiss: () => void
  onSwitchToStandard: () => void
}

const SAMPLE_FORMAT_LABELS: Record<string, string> = {
  s16: '16-bit',
  s24: '24-bit',
  s32: '32-bit',
  f32: '32-bit float'
}

function formatRate(sampleRate: number | null): string | null {
  if (!sampleRate || sampleRate <= 0) return null
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

/**
 * Names the most likely cause so the advice is actionable rather than generic. Focusrite,
 * RME and MOTU interfaces all set the hardware clock from their own control panel, and the
 * WDM endpoint then advertises only that one rate — which is what usually produces this.
 */
function resolveDeviceHint(deviceLabel: string | null): string {
  const label = (deviceLabel ?? '').toLowerCase()

  if (label.includes('focusrite') || label.includes('scarlett') || label.includes('clarett')) {
    return 'On Focusrite interfaces the sample rate is set in Focusrite Control, not in Windows Sound settings. Open Focusrite Control and set the device to this track’s rate.'
  }
  if (label.includes('rme') || label.includes('fireface') || label.includes('babyface')) {
    return 'On RME interfaces the sample rate is set in TotalMix / the RME settings panel rather than Windows Sound settings.'
  }
  if (label.includes('motu')) {
    return 'On MOTU interfaces the sample rate is set in the MOTU Pro Audio control panel rather than Windows Sound settings.'
  }

  return 'Many USB audio interfaces lock the hardware clock to a single rate chosen in their own control panel, rather than following Windows. Check the device’s control panel for a sample rate setting.'
}

export default function BitPerfectFormatFailureModal({
  notice,
  onDismiss,
  onSwitchToStandard
}: BitPerfectFormatFailureModalProps) {
  const presence = usePresence(notice !== null)
  if (!presence.shouldRender || !notice) return null

  const deviceName = notice.deviceLabel ?? 'The selected output device'
  const requestedRate = formatRate(notice.sampleRate)
  const requestedDepth = notice.sampleFormat ? SAMPLE_FORMAT_LABELS[notice.sampleFormat] ?? notice.sampleFormat : null
  const requested = [requestedRate, requestedDepth].filter(Boolean).join(' ')

  return (
    <div
      className="modal-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={onDismiss}
    >
      <div
        className="modal-content confirm-action-modal bit-perfect-format-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Bit-Perfect Playback Couldn&apos;t Start</h2>
          <button className="modal-close" onClick={onDismiss} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">
            {deviceName} refused {requested ? <strong>{requested}</strong> : 'this track’s format'} in exclusive
            mode, so <em>{notice.trackTitle}</em> can&apos;t be played bit-perfect.
          </p>

          <p className="bit-perfect-format-detail">{notice.message}</p>

          <p className="bit-perfect-format-hint">{resolveDeviceHint(notice.deviceLabel)}</p>

          <p className="bit-perfect-format-hint">
            Astra never resamples or re-quantizes in bit-perfect mode, so it stops rather than quietly changing your
            audio. Switch to Standard output to play this track now.
          </p>
        </div>

        <div className="modal-footer confirm-action-footer">
          <button className="settings-btn" onClick={onDismiss}>
            Keep Bit-Perfect
          </button>
          <button className="settings-btn settings-btn-primary" onClick={onSwitchToStandard}>
            Switch to Standard Output
          </button>
        </div>
      </div>
    </div>
  )
}
