import { audioEngine } from '../AudioEngine'
import { isPlaybackAnalyzerActive } from '../visualizerSilence'

// Session-level signals shared by every visualizer's data source.
// In Astra these are driven by the playback AudioEngine (Prism drove them from a
// system-audio capture router); the scope classes only need sample rate, a
// "should the loop run" flag, and a reset signal on track/state changes.
export interface VisualizerSessionSource {
  getSampleRate: () => number
  isPlaying: () => boolean
  subscribeToSessionChanges: (listener: () => void) => () => void
}

export const defaultVisualizerSessionSource: VisualizerSessionSource = {
  getSampleRate: () => audioEngine.getSampleRate(),
  // Keep the scopes "alive" while paused (analyzer active = playing OR paused) so they
  // hold their last frame instead of blanking; they only reset/blank once stopped.
  isPlaying: () => isPlaybackAnalyzerActive(audioEngine.playbackState),
  subscribeToSessionChanges: (listener) => {
    const offTrackChange = audioEngine.onTrackChange(() => listener())
    const offStateChange = audioEngine.on('stateChange', () => listener())
    return () => {
      offTrackChange?.()
      offStateChange?.()
    }
  },
}
