import type { MiniPlayerVisualizerMode } from '../types/miniPlayer'

// One consumer drains the audio queue; both windows can request different channels.
export function resolveMiniVisualizerDemand(mini: MiniPlayerVisualizerMode, notch: MiniPlayerVisualizerMode, active: boolean) {
  return {
    miniOscilloscope: active && (mini === 'oscilloscope' || notch === 'oscilloscope'),
    miniSpectrum: active && (mini === 'spectrum' || notch === 'spectrum'),
  }
}
