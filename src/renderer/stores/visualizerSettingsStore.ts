import { create } from 'zustand'

export type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384

interface VisualizerSettingsStore {
  lineColor: string
  fftSize: FFTSize
  pitchLock: boolean
  isRunning: boolean
  setLineColor: (color: string) => void
  setFftSize: (size: FFTSize) => void
  setPitchLock: (enabled: boolean) => void
  setIsRunning: (running: boolean) => void
  resetToDefaults: () => void
}

const DEFAULT_LINE_COLOR = '#38bdf8'
const DEFAULT_FFT_SIZE: FFTSize = 4096
const DEFAULT_PITCH_LOCK = true
const DEFAULT_RUNNING = true

export const useVisualizerSettingsStore = create<VisualizerSettingsStore>((set) => ({
  lineColor: DEFAULT_LINE_COLOR,
  fftSize: DEFAULT_FFT_SIZE,
  pitchLock: DEFAULT_PITCH_LOCK,
  isRunning: DEFAULT_RUNNING,
  setLineColor: (color) => set({ lineColor: color }),
  setFftSize: (size) => set({ fftSize: size }),
  setPitchLock: (enabled) => set({ pitchLock: enabled }),
  setIsRunning: (running) => set({ isRunning: running }),
  resetToDefaults: () => set({
    lineColor: DEFAULT_LINE_COLOR,
    fftSize: DEFAULT_FFT_SIZE,
    pitchLock: DEFAULT_PITCH_LOCK,
    isRunning: DEFAULT_RUNNING,
  }),
}))
