import { useMemo } from 'react'
import {
  useAudioSettingsStore,
  type CalibrationInputDevice,
  type DelayCompensationMode
} from '../../stores/audioSettingsStore'

const MODES: Array<{ value: DelayCompensationMode; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto Guess' },
]

function formatConfidence(value: number | null): string {
  if (!Number.isFinite(value)) return 'n/a'
  return `${Math.round((value as number) * 100)}%`
}

function formatMetricMs(value: number | null): string {
  if (!Number.isFinite(value)) return 'n/a'
  return `${Math.round(value as number)} ms`
}

function resolvePhysicalDefaultInputDeviceId(inputs: CalibrationInputDevice[]): string | null {
  const defaultAlias = inputs.find((input) => input.isDefaultAlias)
  if (!defaultAlias || !defaultAlias.groupId) return null

  const physicalInput = inputs.find((input) => (
    !input.isDefaultAlias
    && input.groupId.length > 0
    && input.groupId === defaultAlias.groupId
  ))

  return physicalInput?.deviceId ?? null
}

function resolveCalibrationInputDeviceKey(
  selectedInputDeviceId: string,
  inputs: CalibrationInputDevice[]
): string {
  const normalizedSelection = selectedInputDeviceId.trim()
  if (normalizedSelection.length > 0 && normalizedSelection !== 'default') {
    return normalizedSelection
  }

  return resolvePhysicalDefaultInputDeviceId(inputs) ?? 'default-input'
}

export default function DelayCompensationPanel() {
  const {
    availableDevices,
    availableInputDevices,
    selectedDeviceId,
    selectedCalibrationInputDeviceId,
    activeDelayProfileKey,
    activeDelayProfile,
    inputBaselinesByKey,
    effectiveDelayMs,
    delayCalibrationState,
    delayCalibrationMessage,
    setDelayCompensationEnabled,
    setDelayCompensationMode,
    setDelayCompensationManualOffsetMs,
    setCalibrationInputDeviceId,
    runDelayAutoCalibration,
    resetDelayToAutoGuess,
  } = useAudioSettingsStore()

  const selectedOutputLabel = useMemo(() => {
    if (!selectedDeviceId) return 'System Default Output'
    return availableDevices.find((device) => device.deviceId === selectedDeviceId)?.label
      ?? 'Selected Output'
  }, [availableDevices, selectedDeviceId])

  const activeProfileLabel = useMemo(() => {
    if (activeDelayProfileKey === 'default') {
      return 'System Default (unresolved physical target)'
    }
    return availableDevices.find((device) => device.deviceId === activeDelayProfileKey)?.label
      ?? `Device ${activeDelayProfileKey}`
  }, [activeDelayProfileKey, availableDevices])

  const modeDescription = activeDelayProfile.mode === 'manual'
    ? 'Manual offset only.'
    : 'Auto mode uses round-trip calibration minus input baseline, plus manual fine-tune.'

  const isRunningCalibration = delayCalibrationState === 'running'
  const hasAutoEstimate = activeDelayProfile.autoOffsetMs != null
  const calibrationInputKey = useMemo(
    () => resolveCalibrationInputDeviceKey(selectedCalibrationInputDeviceId, availableInputDevices),
    [availableInputDevices, selectedCalibrationInputDeviceId]
  )

  const baselineRttMs = useMemo(() => {
    const sampleRate = activeDelayProfile.lastCalibrationSampleRate
    if (!sampleRate || sampleRate <= 0) return null

    const key = activeDelayProfile.lastCalibrationInputKey
      ? `${activeDelayProfile.lastCalibrationInputKey}@${sampleRate}`
      : `${calibrationInputKey}@${sampleRate}`
    return inputBaselinesByKey[key]?.baselineRttMs ?? null
  }, [
    activeDelayProfile.lastCalibrationInputKey,
    activeDelayProfile.lastCalibrationSampleRate,
    calibrationInputKey,
    inputBaselinesByKey
  ])

  const statusLine = delayCalibrationMessage
    ?? (hasAutoEstimate
      ? `Stored auto estimate: ${activeDelayProfile.autoOffsetMs} ms (confidence ${formatConfidence(activeDelayProfile.lastCalibrationConfidence)}).`
      : 'Auto calibration measures round-trip delay and subtracts input latency baseline.')

  const handleManualOffsetChange = (value: number) => {
    void setDelayCompensationManualOffsetMs(value)
  }

  const manualOffsetMin = activeDelayProfile.mode === 'auto' ? -1500 : 0
  const manualOffsetMax = 1500

  return (
    <div className="delay-comp-panel">
      <div className="delay-comp-header">
        <div className="delay-comp-title">Delay Compensation</div>
        <div className="delay-comp-device">{selectedOutputLabel}</div>
      </div>

      <div className="delay-comp-meta">
        <span className="delay-comp-chip">Profile: {activeProfileLabel}</span>
        <span className="delay-comp-chip">Round-trip: {formatMetricMs(activeDelayProfile.lastRoundTripMs)}</span>
        <span className="delay-comp-chip">Input baseline: {formatMetricMs(baselineRttMs)}</span>
      </div>

      <div className="delay-comp-meta">
        <span className="delay-comp-chip">Derived output: {formatMetricMs(activeDelayProfile.autoOffsetMs)}</span>
        <span className="delay-comp-chip">Effective output: {effectiveDelayMs} ms</span>
      </div>

      <div className="settings-grid">
        <div className="settings-field settings-field-inline">
          <span className="settings-field-label">Compensation</span>
          <button
            type="button"
            className={`settings-toggle ${activeDelayProfile.enabled ? 'active' : ''}`}
            onClick={() => void setDelayCompensationEnabled(!activeDelayProfile.enabled)}
          >
            {activeDelayProfile.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        <label className="settings-field">
          <span className="settings-field-label">Mode</span>
          <select
            className="settings-select"
            value={activeDelayProfile.mode}
            onChange={(event) => void setDelayCompensationMode(event.target.value as DelayCompensationMode)}
          >
            {MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span className="settings-field-label">Calibration Input</span>
          <select
            className="settings-select"
            value={selectedCalibrationInputDeviceId}
            onChange={(event) => setCalibrationInputDeviceId(event.target.value)}
          >
            <option value="">System Default Input</option>
            {availableInputDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>

        <div className="settings-field">
          <span className="settings-field-label">
            {activeDelayProfile.mode === 'auto' ? 'Fine Tune Offset (ms)' : 'Manual Offset (ms)'}
          </span>
          <div className="delay-comp-offset-row">
            <input
              className="delay-comp-slider"
              type="range"
              min={manualOffsetMin}
              max={manualOffsetMax}
              step={5}
              value={activeDelayProfile.manualOffsetMs}
              onChange={(event) => handleManualOffsetChange(Number(event.target.value))}
            />
            <input
              className="settings-select delay-comp-number"
              type="number"
              min={manualOffsetMin}
              max={manualOffsetMax}
              step={5}
              value={activeDelayProfile.manualOffsetMs}
              onChange={(event) => handleManualOffsetChange(Number(event.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="delay-comp-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={() => void runDelayAutoCalibration()}
          disabled={isRunningCalibration}
        >
          {isRunningCalibration ? 'Calibrating...' : 'Run Auto Calibration'}
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={() => void resetDelayToAutoGuess()}
          disabled={!hasAutoEstimate || isRunningCalibration}
        >
          Reset to Auto Guess
        </button>
      </div>

      <p className={`settings-note delay-comp-note delay-comp-note-${delayCalibrationState}`}>
        {modeDescription} {statusLine}
      </p>
    </div>
  )
}
