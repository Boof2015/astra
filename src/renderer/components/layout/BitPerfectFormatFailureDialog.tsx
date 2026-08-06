import { useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import BitPerfectFormatFailureModal from '../settings/BitPerfectFormatFailureModal'

/**
 * Mounted app-wide because a device format rejection can happen on any track load, not just
 * from the settings screen. Unlike the timed cue banners this stays up until dismissed —
 * it reflects persistent device state, not a passing event.
 */
export default function BitPerfectFormatFailureDialog() {
  const notice = usePlayerStore((state) => state.bitPerfectFormatNotice)
  const clearNotice = usePlayerStore((state) => state.clearBitPerfectFormatNotice)
  const setPlaybackOutputMode = useAudioSettingsStore((state) => state.setPlaybackOutputMode)
  const playbackOutputMode = useAudioSettingsStore((state) => state.playbackOutputMode)
  const [switching, setSwitching] = useState(false)

  const handleSwitchToStandard = async () => {
    if (switching) return
    setSwitching(true)
    try {
      await setPlaybackOutputMode('standard')
      clearNotice()
    } catch (error) {
      console.error('Failed to switch to standard output:', error)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <BitPerfectFormatFailureModal
      notice={notice}
      onDismiss={clearNotice}
      onSwitchToStandard={handleSwitchToStandard}
      outputMode={playbackOutputMode}
    />
  )
}
