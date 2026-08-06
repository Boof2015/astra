import { useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import type { PlaybackOutputMode } from '../../../types/nativeAudio'

export interface BitPerfectFormatFailureNotice {
  id: number
  trackTitle: string
  deviceLabel: string | null
  sampleRate: number | null
  channels: number | null
  sampleFormat: string | null
  message: string
  failureStage: string | null
  osCode: string | number | null
  report: string | null
}

interface BitPerfectFormatFailureModalProps {
  notice: BitPerfectFormatFailureNotice | null
  onDismiss: () => void
  onSwitchToStandard: () => void
  outputMode: PlaybackOutputMode
}

const SAMPLE_FORMAT_LABELS: Record<string, string> = {
  s16: '16-bit',
  s24: '24-bit',
  s24in32: '24-bit (32-bit container)',
  s32: '32-bit',
  f32: '32-bit float'
}

function formatRate(sampleRate: number | null): string | null {
  if (!sampleRate || sampleRate <= 0) return null
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

function resolveDeviceHint(deviceLabel: string | null): string {
  const label = (deviceLabel ?? '').toLowerCase()
  if (label.includes('focusrite') || label.includes('scarlett') || label.includes('clarett')) {
    return 'On Focusrite interfaces, set the hardware rate in Focusrite Control, then retry.'
  }
  if (label.includes('rme') || label.includes('fireface') || label.includes('babyface')) {
    return 'On RME interfaces, check the rate and clock source in TotalMix or the RME settings panel.'
  }
  if (label.includes('motu')) {
    return 'On MOTU interfaces, check the rate and clock source in the MOTU Pro Audio control panel.'
  }
  return 'For USB interfaces, also check the device vendor’s control panel for its hardware rate and clock source.'
}

function resolveStageGuidance(stage: string | null): string {
  switch (stage) {
    case 'ownership':
    case 'device-resolution':
      return 'The device could not be reserved exclusively. Close other audio apps, verify the selected device is connected, then retry.'
    case 'format':
    case 'format-negotiation':
      return 'The device did not accept an exact-carry wire format. Check its hardware rate or use Standard output for this track.'
    case 'period':
      return 'The driver rejected the exclusive buffer-period attempts, including alignment and conservative fallbacks.'
    case 'initialization':
      return 'The operating-system audio client could not initialize exclusively after resolving the device and format.'
    case 'priming':
      return 'Astra could not submit the initial unmodified PCM buffer, so the stream was never reported active.'
    case 'start':
      return 'The native start call failed after setup or priming. Astra rolled back the speculative render cursor.'
    case 'runtime':
    case 'runtime-recovery':
      return 'The verified native stream terminated while running. Reconnect the device or resolve the driver error, then retry.'
    case 'verification':
      return 'The device, rate, ownership, or complete wire format changed during start, so verification failed closed.'
    case 'source':
      return 'This source cannot use Astra’s local native decode path. Remote, progressive, IAMF, and Parallax playback remain Standard-only.'
    default:
      return 'Exclusive playback could not be verified. Copy the diagnostics for the complete native attempt history.'
  }
}

export default function BitPerfectFormatFailureModal({
  notice,
  onDismiss,
  onSwitchToStandard,
  outputMode
}: BitPerfectFormatFailureModalProps) {
  const presence = usePresence(notice !== null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  if (!presence.shouldRender || !notice) return null

  const deviceName = notice.deviceLabel ?? 'the selected output device'
  const requestedRate = formatRate(notice.sampleRate)
  const requestedDepth = notice.sampleFormat
    ? SAMPLE_FORMAT_LABELS[notice.sampleFormat] ?? notice.sampleFormat
    : null
  const requested = [requestedRate, requestedDepth].filter(Boolean).join(' ')
  const processedMode = outputMode === 'exclusive'

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
          <h2>{processedMode ? 'Exclusive DSP Playback' : 'Bit-Perfect Playback'} Couldn&apos;t Start</h2>
          <button className="modal-close" onClick={onDismiss} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body confirm-action-body">
          <p className="confirm-action-message">
            Astra could not verify exclusive playback of {requested ? <strong>{requested}</strong> : 'this track'} on{' '}
            {deviceName}, so <em>{notice.trackTitle}</em> was not started in {processedMode ? 'Exclusive DSP' : 'Bit-Perfect'} mode.
          </p>
          <p className="bit-perfect-format-detail">{notice.message}</p>
          <p className="bit-perfect-format-hint">
            Failure stage: <strong>{notice.failureStage ?? 'unknown'}</strong>
            {notice.osCode != null ? ` (${notice.osCode})` : ''}. {resolveStageGuidance(notice.failureStage)}
          </p>
          <p className="bit-perfect-format-hint">{resolveDeviceHint(notice.deviceLabel)}</p>
          <p className="bit-perfect-format-hint">
            {processedMode
              ? 'Exclusive DSP may resample only within the verified native path, but never switches output paths automatically.'
              : 'Bit-Perfect never resamples, re-quantizes, or switches output paths automatically.'}{' '}
            Switch to Standard output explicitly to play this track through Web Audio.
          </p>
        </div>

        <div className="modal-footer confirm-action-footer">
          <button
            className="settings-btn"
            disabled={!notice.report}
            onClick={() => {
              if (!notice.report) return
              void navigator.clipboard.writeText(notice.report).then(
                () => setCopyStatus('Diagnostics copied.'),
                () => setCopyStatus('Copy failed.')
              )
            }}
          >
            {copyStatus ?? 'Copy Diagnostics'}
          </button>
          <button className="settings-btn" onClick={onDismiss}>
            Keep {processedMode ? 'Exclusive DSP' : 'Bit-Perfect'}
          </button>
          <button className="settings-btn settings-btn-primary" onClick={onSwitchToStandard}>
            Switch to Standard Output
          </button>
        </div>
      </div>
    </div>
  )
}
