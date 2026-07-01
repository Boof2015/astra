import { useEffect, useMemo, useRef, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'
import ParallaxPairingWizard from '../layout/ParallaxPairingWizard'
import ParallaxManagementView from './ParallaxManagementView'
import ParallaxSetupFlow from './ParallaxSetupFlow'
import { anyParallaxConfigPresent } from './parallaxHelpers'

/**
 * Top-level Parallax settings surface (rendered in the dedicated, experiment-gated Parallax
 * section). Coordinates the guided first-run overlay vs. the management view, owns the shared
 * feedback line, and brokers the existing pairing wizard so the setup flow can delegate to it
 * without stacking modals.
 */
export default function ParallaxSettingsPanel() {
  const status = useParallaxStore((s) => s.status)
  const pairedSinks = useParallaxStore((s) => s.pairedSinks)
  const errorMessage = useParallaxStore((s) => s.errorMessage)
  const setHostEnabled = useParallaxStore((s) => s.setHostEnabled)
  const isTestToneActive = useParallaxStore((s) => s.isTestToneActive)
  const stopTestTone = useParallaxStore((s) => s.stopTestTone)
  const setupComplete = useUIStore((s) => s.parallaxSetupComplete)
  const setSetupComplete = useUIStore((s) => s.setParallaxSetupComplete)

  const [setupOpen, setSetupOpen] = useState(false)
  const [showPairingWizard, setShowPairingWizard] = useState(false)
  const [feedback, setFeedback] = useState('')

  const activeSinkCount = useMemo(
    () => pairedSinks.filter((sink) => sink.revokedAt == null).length,
    [pairedSinks]
  )
  const configPresent = anyParallaxConfigPresent(status, activeSinkCount)

  // One-shot decision, taken once status has loaded: existing users (any config already present)
  // are migrated straight to the management view; genuine first-runs open the guided flow. Guarded
  // so that picking a role mid-setup — which makes config "present" — can't retroactively dismiss
  // the overlay or re-trigger migration. After this, `setupOpen` is controlled only by the user.
  const initRef = useRef(false)
  useEffect(() => {
    if (initRef.current || status == null) return
    initRef.current = true
    if (setupComplete) return
    if (configPresent) {
      setSetupComplete(true)
    } else {
      setSetupOpen(true)
    }
  }, [status, setupComplete, configPresent, setSetupComplete])

  useEffect(() => {
    if (!feedback) return
    const timeoutId = window.setTimeout(() => setFeedback(''), 2600)
    return () => window.clearTimeout(timeoutId)
  }, [feedback])

  // Stop the test tone if the user navigates away from the Parallax section while it's playing.
  const testToneActiveRef = useRef(isTestToneActive)
  testToneActiveRef.current = isTestToneActive
  useEffect(() => () => {
    if (testToneActiveRef.current) void stopTestTone()
  }, [stopTestTone])

  const handleAddSpeaker = async () => {
    if (!(status?.host.enabled ?? false)) {
      if (!window.confirm('Adding speakers needs this machine in “Plays music” mode. Switch it on now?')) return
      const next = await setHostEnabled(true)
      if (!next?.host.enabled) {
        setFeedback('Could not enable Parallax host.')
        return
      }
    }
    setShowPairingWizard(true)
  }

  const finishSetup = () => {
    setSetupComplete(true)
    setSetupOpen(false)
  }

  return (
    <>
      <ParallaxManagementView
        notify={setFeedback}
        onAddSpeaker={() => void handleAddSpeaker()}
        onChangeRole={() => setSetupOpen(true)}
      />

      {feedback && <p className="settings-note settings-note-success">{feedback}</p>}
      {errorMessage && <p className="settings-note settings-note-error">{errorMessage}</p>}

      {setupOpen && (
        <ParallaxSetupFlow
          onClose={finishSetup}
          onAddSpeaker={() => void handleAddSpeaker()}
          hidden={showPairingWizard}
        />
      )}

      {showPairingWizard && (
        <ParallaxPairingWizard onClose={() => setShowPairingWizard(false)} />
      )}
    </>
  )
}
