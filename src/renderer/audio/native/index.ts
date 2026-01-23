// Native visualizer DSP module loader
// This loads the native C++ addon for high-performance audio visualization

import type { VisualizerDSP, OscilloscopeResult, VectorscopeResult } from './visualizer-dsp'

let nativeModule: VisualizerDSP | null = null
let loadError: Error | null = null

// Try to load the native module
try {
  // In Electron, we need to use the main process to load native modules
  // and expose them via IPC, or use electron-rebuild
  if (typeof window !== 'undefined' && window.require) {
    // Try to load from the native directory
    const path = window.require('path')
    const modulePath = path.join(__dirname, '..', '..', '..', '..', 'native', 'build', 'Release', 'visualizer_dsp.node')
    nativeModule = window.require(modulePath) as VisualizerDSP
    console.log('Native visualizer DSP module loaded successfully')
  }
} catch (err) {
  loadError = err as Error
  console.warn('Failed to load native visualizer DSP module:', err)
  console.warn('Falling back to JavaScript implementation')
}

// Check if native module is available
export function isNativeAvailable(): boolean {
  return nativeModule !== null
}

export function getNativeLoadError(): Error | null {
  return loadError
}

// Export the native module functions with type safety
export const oscilloscope = {
  setSampleRate: (sampleRate: number): void => {
    nativeModule?.oscilloscope.setSampleRate(sampleRate)
  },

  setPitchLock: (enabled: boolean): void => {
    nativeModule?.oscilloscope.setPitchLock(enabled)
  },

  setDisplaySamples: (samples: number): void => {
    nativeModule?.oscilloscope.setDisplaySamples(samples)
  },

  setFilterFrequency: (frequency: number): void => {
    nativeModule?.oscilloscope.setFilterFrequency(frequency)
  },

  process: (audioData: Float32Array): OscilloscopeResult | null => {
    if (!nativeModule) return null
    return nativeModule.oscilloscope.process(audioData)
  },

  reset: (): void => {
    nativeModule?.oscilloscope.reset()
  }
}

export const spectrum = {
  setFFTSize: (size: number): void => {
    nativeModule?.spectrum.setFFTSize(size)
  },

  getFFTSize: (): number => {
    return nativeModule?.spectrum.getFFTSize() ?? 2048
  },

  setSampleRate: (sampleRate: number): void => {
    nativeModule?.spectrum.setSampleRate(sampleRate)
  },

  setSmoothing: (smoothing: number): void => {
    nativeModule?.spectrum.setSmoothing(smoothing)
  },

  process: (audioData: Float32Array): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.spectrum.process(audioData)
  },

  binToFrequency: (bin: number): number => {
    return nativeModule?.spectrum.binToFrequency(bin) ?? 0
  },

  reset: (): void => {
    nativeModule?.spectrum.reset()
  }
}

export const vectorscope = {
  setBufferSize: (size: number): void => {
    nativeModule?.vectorscope.setBufferSize(size)
  },

  getBufferSize: (): number => {
    return nativeModule?.vectorscope.getBufferSize() ?? 1024
  },

  process: (leftChannel: Float32Array, rightChannel: Float32Array): VectorscopeResult | null => {
    if (!nativeModule) return null
    return nativeModule.vectorscope.process(leftChannel, rightChannel)
  },

  reset: (): void => {
    nativeModule?.vectorscope.reset()
  }
}

export type { OscilloscopeResult, VectorscopeResult }
