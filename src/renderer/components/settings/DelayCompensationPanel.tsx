import { useMemo } from 'react'
import {
  useAudioSettingsStore,
  type CalibrationInputDevice,
  type DelayCalibrationMethod,
  type DelayCompensationMode
} from '../../stores/audioSettingsStore'

const MODES: Array<{ value: DelayCompensationMode; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto Guess' },
]
const CALIBRATION_METHODS: Array<{ value: DelayCalibrationMethod; label: string }> = [
  { value: 'differential', label: 'New (Differential)' },
  { value: 'legacy', label: 'Old (Legacy)' }
]
const OUTPUT_GROUP_PROFILE_KEY_PREFIX = 'group:'
const MANUAL_OFFSET_MAX_MS = 2500

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
    setDelayCalibrationMethod,
    setDifferentialReferenceOutputDeviceId,
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

    if (activeDelayProfileKey.startsWith(OUTPUT_GROUP_PROFILE_KEY_PREFIX)) {
      const groupId = activeDelayProfileKey.slice(OUTPUT_GROUP_PROFILE_KEY_PREFIX.length)
      const groupMatchedDevice = availableDevices.find((device) => (
        !device.isDefaultAlias
        && device.groupId.length > 0
        && device.groupId === groupId
      )) ?? availableDevices.find((device) => (
        device.groupId.length > 0
        && device.groupId === groupId
      ))

      if (groupMatchedDevice) {
        return groupMatchedDevice.label
      }

      return 'System Default (resolved profile group)'
    }

    return availableDevices.find((device) => device.deviceId === activeDelayProfileKey)?.label
      ?? `Device ${activeDelayProfileKey}`
  }, [activeDelayProfileKey, availableDevices])

  const isDifferentialMethod = activeDelayProfile.calibrationMethod === 'differential'
  const modeDescription = activeDelayProfile.mode === 'manual'
    ? 'Manual offset only.'
    : isDifferentialMethod
      ? 'New (Differential): More accurate for Bluetooth, but requires reference output setup and mic placement.'
      : 'Old (Legacy): Easier setup, less accurate on Bluetooth.'

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
  const referenceOutputLabel = useMemo(() => {
    const referenceId = activeDelayProfile.differentialReferenceOutputDeviceId
    if (!referenceId) return 'System Default Output'
    return availableDevices.find((device) => device.deviceId === referenceId)?.label ?? 'Selected Reference Output'
  }, [activeDelayProfile.differentialReferenceOutputDeviceId, availableDevices])

  const statusLine = delayCalibrationMessage
    ?? (hasAutoEstimate
      ? `Stored auto estimate: ${activeDelayProfile.autoOffsetMs} ms (confidence ${formatConfidence(activeDelayProfile.lastCalibrationConfidence)}).`
      : isDifferentialMethod
        ? 'New method estimates output delay directly using a reference output.'
        : 'Old method measures round-trip delay and subtracts input latency baseline.')

  const handleManualOffsetChange = (value: number) => {
    void setDelayCompensationManualOffsetMs(value)
  }

  const manualOffsetMin = activeDelayProfile.mode === 'auto' ? -MANUAL_OFFSET_MAX_MS : 0
  const manualOffsetMax = MANUAL_OFFSET_MAX_MS
  const runButtonLabel = isRunningCalibration
    ? 'Calibrating...'
    : (isDifferentialMethod && delayCalibrationState === 'error'
      ? 'Retry New Method'
      : (isDifferentialMethod ? 'Run New Method Calibration' : 'Run Old Method Calibration'))

  return (
    <div className="delay-comp-panel">
      <div className="delay-comp-header">
        <div className="delay-comp-title">Delay Compensation</div>
        <div className="delay-comp-device">{selectedOutputLabel}</div>
      </div>

      <div className="delay-comp-meta">
        <span className="delay-comp-chip">Profile: {activeProfileLabel}</span>
        <span className="delay-comp-chip">
          Calibration: {isDifferentialMethod ? 'New (Differential)' : 'Old (Legacy)'}
        </span>
        {!isDifferentialMethod && (
          <span className="delay-comp-chip">Round-trip: {formatMetricMs(activeDelayProfile.lastRoundTripMs)}</span>
        )}
        {!isDifferentialMethod && (
          <span className="delay-comp-chip">Input baseline: {formatMetricMs(baselineRttMs)}</span>
        )}
        {isDifferentialMethod && (
          <span className="delay-comp-chip">Reference output: {referenceOutputLabel}</span>
        )}
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
          <span className="settings-field-label">Calibration Method</span>
          <select
            className="settings-select"
            value={activeDelayProfile.calibrationMethod}
            onChange={(event) => void setDelayCalibrationMethod(event.target.value as DelayCalibrationMethod)}
          >
            {CALIBRATION_METHODS.map((method) => (
              <option key={method.value} value={method.value}>{method.label}</option>
            ))}
          </select>
        </label>

        {isDifferentialMethod && (
          <label className="settings-field">
            <span className="settings-field-label">Reference Output</span>
            <select
              className="settings-select"
              value={activeDelayProfile.differentialReferenceOutputDeviceId}
              onChange={(event) => void setDifferentialReferenceOutputDeviceId(event.target.value)}
            >
              <option value="">System Default Output</option>
              {availableDevices
                .filter((device) => device.deviceId !== selectedDeviceId)
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
            </select>
          </label>
        )}

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
          {runButtonLabel}
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
