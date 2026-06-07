import { useEffect } from 'react'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useParallaxStore } from '../../stores/parallaxStore'

interface Props {
  onClose: () => void
}

// §14.1.4 / §19.18(d) — fullscreen-aesthetic mini settings overlay reachable from the Zone
// Display chrome. Hosts zone-scoped knobs only (output device picker + trim readout). Full
// Settings still lives one click further away via the Library escape.
//
// Trim is read-only in v1: today's trim is host-state-of-truth (§15.2) and there is no
// sink→host control wire to push edits back. Output device IS editable from here because the
// trim slot is keyed (sinkId, outputDeviceId) and the sink already owns its output device.
export default function ZoneSettingsOverlay({ onClose }: Props) {
  const status = useParallaxStore((s) => s.status)
  const refreshDevices = useAudioSettingsStore((s) => s.refreshDevices)
  const availableDevices = useAudioSettingsStore((s) => s.availableDevices)
  const selectedDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const selectDevice = useAudioSettingsStore((s) => s.selectDevice)

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const appliedAdvanceMs = status?.sink.appliedAdvanceMs
  const outputDeviceLabel = status?.sink.outputDeviceLabel ?? null
  const outputDeviceId = status?.sink.outputDeviceId ?? null
  const trimKnown = typeof appliedAdvanceMs === 'number'

  return (
    <div
      className="zone-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Zone settings"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="zone-settings-overlay-card">
        <div className="zone-settings-overlay-head">
          <span className="zone-settings-overlay-title">Zone settings</span>
          <button
            type="button"
            className="zone-settings-overlay-close"
            onClick={onClose}
            title="Close"
            aria-label="Close zone settings"
          >
            ×
          </button>
        </div>

        <div className="zone-settings-overlay-section">
          <div className="zone-settings-overlay-section-head">
            <span className="zone-settings-overlay-section-label">Output device</span>
          </div>
          <select
            className="zone-settings-overlay-select"
            value={selectedDeviceId}
            onChange={(event) => void selectDevice(event.target.value)}
          >
            {availableDevices.length === 0 && (
              <option value="">No output devices detected</option>
            )}
            {availableDevices.map((device) => (
              <option key={device.deviceId || device.label} value={device.deviceId}>
                {device.label || device.deviceId || 'Unknown device'}
              </option>
            ))}
          </select>
          <p className="zone-settings-overlay-note">
            Trim is keyed per output device. Changing this device may swap the trim slot too.
          </p>
        </div>

        <div className="zone-settings-overlay-section">
          <div className="zone-settings-overlay-section-head">
            <span className="zone-settings-overlay-section-label">Trim</span>
            <span className="zone-settings-overlay-section-value">
              {trimKnown ? `${(appliedAdvanceMs as number).toFixed(0)} ms` : '—'}
            </span>
          </div>
          <p className="zone-settings-overlay-note">
            {outputDeviceLabel || outputDeviceId
              ? <>Applied for <strong>{outputDeviceLabel ?? outputDeviceId}</strong>.</>
              : 'Awaiting telemetry from sink.'}
            {' '}Adjust the trim from the host: Settings → Parallax.
          </p>
        </div>
      </div>
    </div>
  )
}
