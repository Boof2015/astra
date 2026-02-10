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
}

export const useVisualizerSettingsStore = create<VisualizerSettingsStore>((set) => ({
  lineColor: '#38bdf8',
  fftSize: 4096,
  pitchLock: true,
  isRunning: true,
  setLineColor: (color) => set({ lineColor: color }),
  setFftSize: (size) => set({ fftSize: size }),
  setPitchLock: (enabled) => set({ pitchLock: enabled }),
  setIsRunning: (running) => set({ isRunning: running }),
}))
