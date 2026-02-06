// Native visualizer DSP module loader
// This loads the native C++ addon for high-performance audio visualization

import type { VisualizerDSP, OscilloscopeResult, VectorscopeResult, VectorscopePointsResult } from './visualizer-dsp'

let nativeModule: VisualizerDSP | null = null
let loadError: Error | null = null

// Try to load the native module
// Try to load the native module from the exposed API
if (typeof window !== 'undefined' && window.visualizerAPI) {
  nativeModule = window.visualizerAPI
  console.log('Native visualizer DSP module loaded via preload')
} else {
  console.warn('Native visualizer DSP module not available (not found in window.visualizerAPI)')
  console.warn('Falling back to JavaScript implementation')
  loadError = new Error('Native module not found in window.visualizerAPI')
}

// Check if native module is available
export function isNativeAvailable(): boolean {
  return nativeModule !== null
}

export function getNativeLoadError(): Error | null {
  return loadError
}

// Circular buffer size (must match native code)
export const OSCILLOSCOPE_BUFFER_SIZE = 32768

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

  // Push samples to circular buffer (for continuous capture)
  pushSamples: (samples: Float32Array): void => {
    nativeModule?.oscilloscope.pushSamples(samples)
  },

  // Process using circular buffer (continuous mode)
  processContinuous: (): OscilloscopeResult | null => {
    if (!nativeModule) return null
    return nativeModule.oscilloscope.processContinuous()
  },

  // Legacy: process snapshot (pushes to buffer and processes)
  process: (audioData: Float32Array): OscilloscopeResult | null => {
    if (!nativeModule) return null
    return nativeModule.oscilloscope.process(audioData)
  },

  // Get current write position
  getWritePos: (): number => {
    return nativeModule?.oscilloscope.getWritePos() ?? 0
  },

  // Get samples from circular buffer for rendering
  getSamples: (startPos: number, count: number): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.oscilloscope.getSamples(startPos, count)
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
  setSampleRate: (sampleRate: number): void => {
    nativeModule?.vectorscope.setSampleRate(sampleRate)
  },

  pushSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.vectorscope.pushSamples(leftChannel, rightChannel)
  },

  getPoints: (maxPoints: number): VectorscopePointsResult | null => {
    if (!nativeModule) return null
    return nativeModule.vectorscope.getPoints(maxPoints)
  },

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

export type { OscilloscopeResult, VectorscopeResult, VectorscopePointsResult }
