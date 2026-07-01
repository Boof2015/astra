import { useEffect, useState } from 'react'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import { useEndpointIdentity } from '../parallax/parallaxHelpers'

interface Props {
  onClose: () => void
}

// §14.1.4 / §19.18(d) — fullscreen-aesthetic mini settings overlay reachable from the Zone
// Display chrome. Hosts zone-scoped knobs only (output device picker + trim stepper). Full
// Settings still lives one click further away via the Library escape.
//
// Codex finding 2 (high, round 1): the trim row is now editable. The sink pushes the new value
// to the host via `parallax:requestSinkTrimUpdate`, which routes through the host's normal
// `setSinkTrim` path (clamps, persists, broadcasts back via SSE). Host stays state-of-truth
// (§15.2); the sink simply requests a write.
//
// Codex finding 1 (medium, round 2): repeat clicks based on `appliedAdvanceMs` race the SSE
// echo (`sink-trim-update` → telemetry → status push). A fast +5 +5 could send `5` twice instead
// of accumulating to `10` because the echo for the first request hadn't landed when the second
// click fired. Same class as the §14.1.1 host-side stepper bug. Fix: keep a local
// `desiredAdvanceMs` override that's used as the edit base; rolls back on POST failure; resets
// when the output device changes (trim is per `(sinkId, outputDeviceId)` so a device swap moves
// us to a different slot).
export default function ZoneSettingsOverlay({ onClose }: Props) {
  const status = useParallaxStore((s) => s.status)
  const assignedName = useParallaxStore((s) => s.assignedSinkName)
  const zoneNameOverride = useUIStore((s) => s.parallaxZoneName)
  const setZoneName = useUIStore((s) => s.setParallaxZoneName)
  const identity = useEndpointIdentity()
  const refreshDevices = useAudioSettingsStore((s) => s.refreshDevices)
  const availableDevices = useAudioSettingsStore((s) => s.availableDevices)
  const selectedDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const selectDevice = useAudioSettingsStore((s) => s.selectDevice)

  const [trimRequestPending, setTrimRequestPending] = useState(false)
  const [trimError, setTrimError] = useState<string | null>(null)
  const [desiredAdvanceMs, setDesiredAdvanceMs] = useState<number | null>(null)

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

  // Device swap moves the user to a different trim slot — clear any pending local override so
  // the next click starts from the new slot's persisted/applied value.
  useEffect(() => {
    setDesiredAdvanceMs(null)
    setTrimError(null)
  }, [outputDeviceId])

  // Codex finding (medium, round 3): once the SSE echo confirms our requested value (applied ≈
  // desired within tolerance), drop the local override so the displayed value re-binds to
  // telemetry. Without this, a third-party trim change from the host's Settings while this
  // overlay stays open would never reach the user — the stale local value would keep winning
  // and the next click would overwrite the host's newer state. Tolerance mirrors the host's
  // self-healing TRIM_APPLIED_TOLERANCE_MS = 0.5.
  useEffect(() => {
    if (desiredAdvanceMs === null) return
    if (typeof appliedAdvanceMs !== 'number') return
    if (Math.abs(appliedAdvanceMs - desiredAdvanceMs) <= 0.5) {
      setDesiredAdvanceMs(null)
    }
  }, [appliedAdvanceMs, desiredAdvanceMs])

  // The displayed/edit-base value: local override wins (covers in-flight requests + the gap
  // before SSE echo lands); falls back to telemetry's applied value otherwise.
  const effectiveAdvanceMs = desiredAdvanceMs ?? (typeof appliedAdvanceMs === 'number' ? appliedAdvanceMs : null)
  const trimKnown = effectiveAdvanceMs !== null
  const canEditTrim = !!outputDeviceId && trimKnown && !trimRequestPending

  const pushTrim = async (next: number) => {
    if (!outputDeviceId) return
    const previousDesired = desiredAdvanceMs
    setDesiredAdvanceMs(next)
    setTrimRequestPending(true)
    setTrimError(null)
    try {
      const ok = await window.electronAPI.parallax.requestSinkTrimUpdate(
        outputDeviceId,
        outputDeviceLabel,
        next
      )
      if (!ok) {
        // Rollback so a follow-up click doesn't compound off a value the host refused.
        setDesiredAdvanceMs(previousDesired)
        setTrimError('Could not reach host to update trim.')
      }
    } catch {
      setDesiredAdvanceMs(previousDesired)
      setTrimError('Could not reach host to update trim.')
    } finally {
      setTrimRequestPending(false)
    }
  }

  const handleTrimAdjust = async (deltaMs: number) => {
    if (!outputDeviceId || effectiveAdvanceMs === null) return
    const next = Math.max(-500, Math.min(500, effectiveAdvanceMs + deltaMs))
    if (next === effectiveAdvanceMs) return
    await pushTrim(next)
  }

  const handleTrimReset = async () => {
    if (!outputDeviceId || effectiveAdvanceMs === null || effectiveAdvanceMs === 0) return
    await pushTrim(0)
  }

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
            <span className="zone-settings-overlay-section-label">Zone name</span>
          </div>
          <input
            type="text"
            className="zone-settings-overlay-select"
            value={zoneNameOverride}
            placeholder={assignedName || identity?.hostname || 'Astra Speaker'}
            maxLength={60}
            onChange={(event) => setZoneName(event.target.value)}
            aria-label="Zone name"
          />
          <p className="zone-settings-overlay-note">
            {assignedName
              ? <>The host calls this speaker <strong>{assignedName}</strong>, which takes priority here. This local name only applies when no host name is set.</>
              : <>Shown on this display. Leave blank to use the device name ({identity?.hostname || 'hostname'}).</>}
          </p>
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
              {effectiveAdvanceMs !== null ? `${effectiveAdvanceMs.toFixed(0)} ms` : '—'}
            </span>
          </div>
          <div className="zone-settings-overlay-stepper">
            <button
              type="button"
              className="settings-btn"
              disabled={!canEditTrim}
              onClick={() => void handleTrimAdjust(-5)}
              title="Trim −5 ms"
            >-5</button>
            <button
              type="button"
              className="settings-btn"
              disabled={!canEditTrim}
              onClick={() => void handleTrimAdjust(-1)}
              title="Trim −1 ms"
            >-1</button>
            <button
              type="button"
              className="settings-btn"
              disabled={!canEditTrim}
              onClick={() => void handleTrimAdjust(+1)}
              title="Trim +1 ms"
            >+1</button>
            <button
              type="button"
              className="settings-btn"
              disabled={!canEditTrim}
              onClick={() => void handleTrimAdjust(+5)}
              title="Trim +5 ms"
            >+5</button>
            {effectiveAdvanceMs !== null && effectiveAdvanceMs !== 0 && (
              <button
                type="button"
                className="settings-btn"
                disabled={!canEditTrim}
                onClick={() => void handleTrimReset()}
                title="Reset trim to 0"
              >Reset</button>
            )}
          </div>
          <p className="zone-settings-overlay-note">
            {outputDeviceLabel || outputDeviceId
              ? <>Applied for <strong>{outputDeviceLabel ?? outputDeviceId}</strong>. Persisted on the host.</>
              : 'Awaiting telemetry from sink.'}
          </p>
          {trimError && (
            <p className="zone-settings-overlay-note zone-settings-overlay-note-error">{trimError}</p>
          )}
        </div>
      </div>
    </div>
  )
}
