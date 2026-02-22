import { create } from 'zustand'

export type FFTSize = 1024 | 2048 | 4096 | 8192 | 16384

export const OSCILLOSCOPE_UNDERFILL_STORAGE_KEY = 'astra-oscilloscope-underfill-enabled'

interface VisualizerSettingsStore {
  lineColor: string
  fftSize: FFTSize
  pitchLock: boolean
  oscilloscopeUnderfillEnabled: boolean
  isRunning: boolean
  setLineColor: (color: string) => void
  setFftSize: (size: FFTSize) => void
  setPitchLock: (enabled: boolean) => void
  setOscilloscopeUnderfillEnabled: (enabled: boolean) => void
  setIsRunning: (running: boolean) => void
  resetToDefaults: () => void
}

const DEFAULT_LINE_COLOR = '#38bdf8'
const DEFAULT_FFT_SIZE: FFTSize = 4096
const DEFAULT_PITCH_LOCK = true
const DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED = false
const DEFAULT_RUNNING = true

function readOscilloscopeUnderfillPreference(): boolean {
  try {
    return localStorage.getItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY) === '1'
  } catch {
    return DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED
  }
}

function persistOscilloscopeUnderfillPreference(enabled: boolean): void {
  try {
    localStorage.setItem(OSCILLOSCOPE_UNDERFILL_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and keep in-memory behavior.
  }
}

const initialOscilloscopeUnderfillEnabled = readOscilloscopeUnderfillPreference()

export const useVisualizerSettingsStore = create<VisualizerSettingsStore>((set) => ({
  lineColor: DEFAULT_LINE_COLOR,
  fftSize: DEFAULT_FFT_SIZE,
  pitchLock: DEFAULT_PITCH_LOCK,
  oscilloscopeUnderfillEnabled: initialOscilloscopeUnderfillEnabled,
  isRunning: DEFAULT_RUNNING,
  setLineColor: (color) => set({ lineColor: color }),
  setFftSize: (size) => set({ fftSize: size }),
  setPitchLock: (enabled) => set({ pitchLock: enabled }),
  setOscilloscopeUnderfillEnabled: (enabled) => {
    persistOscilloscopeUnderfillPreference(enabled)
    set({ oscilloscopeUnderfillEnabled: enabled })
  },
  setIsRunning: (running) => set({ isRunning: running }),
  resetToDefaults: () => {
    persistOscilloscopeUnderfillPreference(DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED)
    set({
      lineColor: DEFAULT_LINE_COLOR,
      fftSize: DEFAULT_FFT_SIZE,
      pitchLock: DEFAULT_PITCH_LOCK,
      oscilloscopeUnderfillEnabled: DEFAULT_OSCILLOSCOPE_UNDERFILL_ENABLED,
      isRunning: DEFAULT_RUNNING,
    })
  },
}))
