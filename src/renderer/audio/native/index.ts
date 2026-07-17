// Native visualizer DSP module loader
// This loads the native C++ addon for high-performance audio visualization

import type {
  VisualizerDSP,
  OscilloscopeResult,
  LUFSMeterNativeSnapshot,
  SpectrogramNativeOptions,
  SpectrogramNativeResult,
  VectorscopeMultibandPointsResult,
  VectorscopeResult,
  VectorscopePointsResult,
  VUMeterNativeSnapshot,
  SpectrumBarNativeConfig,
} from './visualizer-dsp'

let nativeModule: VisualizerDSP | null = null
let loadError: Error | null = null
let nativeUnavailableWarningEmitted = false

export function warnNativeUnavailableOnce(context?: string): void {
  if (nativeModule || nativeUnavailableWarningEmitted) {
    return
  }

  nativeUnavailableWarningEmitted = true
  const message = loadError?.message ?? 'Native visualizer DSP module is unavailable.'
  const prefix = context ? `${context}: ` : ''
  console.error(`${prefix}${message} Native-only visualizers will remain idle.`)
}

// Try to load the native module from the exposed API
if (typeof window !== 'undefined' && window.visualizerAPI) {
  // The preload's Window typing under-declares visualizerAPI (older 3-module shape);
  // the runtime object is the full native module, so assert the canonical type here.
  nativeModule = window.visualizerAPI as unknown as VisualizerDSP
  console.log('Native visualizer DSP module loaded via preload')
} else {
  // Prefer the preload's specific load-failure message (e.g. a missing .node file vs a
  // shared-library/ABI mismatch) so the console warning and the in-app notice both point at
  // the actual cause; fall back to a generic message if the diagnostics global is absent.
  const reason = typeof window !== 'undefined' ? window.visualizerAddonStatus?.reason : null
  loadError = new Error(reason ?? 'Native module not found in window.visualizerAPI')
  warnNativeUnavailableOnce()
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

export interface SpectrumNativeAnalyzer {
  setFFTSize(size: number): void
  getFFTSize(): number
  setSampleRate(sampleRate: number): void
  setSmoothing(smoothing: number): void
  pushSamples(audioData: Float32Array): void
  pushStereoSamples(leftChannel: Float32Array, rightChannel: Float32Array): void
  fillRawMagnitudes(output: Float32Array): number
  fillMagnitudes(output: Float32Array): number
  fillSideMagnitudes(output: Float32Array): number
  getRawMagnitudes(): Float32Array | null
  getMagnitudes(): Float32Array | null
  getSideMagnitudes(): Float32Array | null
  process(audioData: Float32Array): Float32Array | null
  binToFrequency(bin: number): number
  configureBars?: (options: SpectrumBarNativeConfig) => void
  getBarFrame?: () => Float32Array | null
  supportsBarFrames?: () => boolean
  reset(): void
  isAvailable?: () => boolean
}

// Injectable interface for the oscilloscope DSP (mirrors SpectrumNativeAnalyzer)
// so the visualizer can be driven by a non-N-API source (e.g. a plugin webview).
export interface OscilloscopeNativeAnalyzer {
  setSampleRate(sampleRate: number): void
  setPitchLock(enabled: boolean): void
  setDisplaySamples(samples: number): void
  pushSamples(samples: Float32Array): void
  processContinuous(): OscilloscopeResult | null
  fillSamples(startPos: number, output: Float32Array): number
  reset(): void
  isAvailable?: () => boolean
}

// Export the native module functions with type safety
export const oscilloscope = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.oscilloscope)
  },

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

  fillSamples: (startPos: number, output: Float32Array): number => {
    if (!nativeModule) return 0
    // `visualizerAPI` crosses Electron's context bridge, so mutating a renderer-owned
    // typed array in preload/native does not write back into the caller's buffer.
    const samples = nativeModule.oscilloscope.getSamples(startPos, output.length)
    const count = Math.min(output.length, samples.length)
    if (count > 0) {
      output.set(samples.subarray(0, count), 0)
    }
    return count
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

export const spectrum: SpectrumNativeAnalyzer = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.spectrum)
  },

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

  pushSamples: (audioData: Float32Array): void => {
    nativeModule?.spectrum.pushSamples(audioData)
  },

  pushStereoSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.spectrum.pushStereoSamples(leftChannel, rightChannel)
  },

  fillRawMagnitudes: (output: Float32Array): number => {
    if (!nativeModule) return 0
    const magnitudes = nativeModule.spectrum.getRawMagnitudes()
    const count = Math.min(output.length, magnitudes.length)
    if (count > 0) {
      output.set(magnitudes.subarray(0, count), 0)
    }
    return count
  },

  fillMagnitudes: (output: Float32Array): number => {
    if (!nativeModule) return 0
    const magnitudes = nativeModule.spectrum.getMagnitudes()
    const count = Math.min(output.length, magnitudes.length)
    if (count > 0) {
      output.set(magnitudes.subarray(0, count), 0)
    }
    return count
  },

  fillSideMagnitudes: (output: Float32Array): number => {
    if (!nativeModule) return 0
    const magnitudes = nativeModule.spectrum.getSideMagnitudes()
    const count = Math.min(output.length, magnitudes.length)
    if (count > 0) {
      output.set(magnitudes.subarray(0, count), 0)
    }
    return count
  },

  getMagnitudes: (): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.spectrum.getMagnitudes()
  },

  getRawMagnitudes: (): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.spectrum.getRawMagnitudes()
  },

  getSideMagnitudes: (): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.spectrum.getSideMagnitudes()
  },

  process: (audioData: Float32Array): Float32Array | null => {
    if (!nativeModule) return null
    return nativeModule.spectrum.process(audioData)
  },

  binToFrequency: (bin: number): number => {
    return nativeModule?.spectrum.binToFrequency(bin) ?? 0
  },

  supportsBarFrames: (): boolean => {
    return typeof nativeModule?.spectrum.configureBars === 'function'
      && typeof nativeModule?.spectrum.getBarFrame === 'function'
  },

  configureBars: (options: SpectrumBarNativeConfig): void => {
    nativeModule?.spectrum.configureBars?.(options)
  },

  getBarFrame: (): Float32Array | null => {
    if (!nativeModule?.spectrum.getBarFrame) return null
    return nativeModule.spectrum.getBarFrame()
  },

  reset: (): void => {
    nativeModule?.spectrum.reset()
  }
}

export interface SpectrogramNativeAnalyzer {
  configure(options: SpectrogramNativeOptions): void
  process(audioData: Float32Array): SpectrogramNativeResult | null
  reset(): void
  isAvailable?: () => boolean
}

export interface LUFSMeterNativeAnalyzer {
  setSampleRate(sampleRate: number): void
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void
  getSnapshot(): LUFSMeterNativeSnapshot | null
  reset(): void
  isAvailable?: () => boolean
}

export interface VUMeterNativeAnalyzer {
  setSampleRate(sampleRate: number): void
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void
  getSnapshot(): VUMeterNativeSnapshot | null
  reset(): void
  isAvailable?: () => boolean
}

export interface VectorscopeNativeAnalyzer {
  setSampleRate(sampleRate: number): void
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void
  pushMultibandSamples?: (leftChannel: Float32Array, rightChannel: Float32Array) => void
  fillPoints(xOut: Float32Array, yOut: Float32Array): number
  getMultibandPoints?: (maxPoints: number) => VectorscopeMultibandPointsResult | null
  reset(): void
  isAvailable?: () => boolean
  isMultibandAvailable?: () => boolean
}

export interface WaveformNativeAnalyzer {
  configure(sampleRate: number, samplesPerColumn: number): void
  processMono(samples: Float32Array): Float32Array | null
  processStereo(leftChannel: Float32Array, rightChannel: Float32Array): Float32Array | null
  reset(): void
  isAvailable?: () => boolean
}

export const spectrogram: SpectrogramNativeAnalyzer = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.spectrogram)
  },

  configure: (options: SpectrogramNativeOptions): void => {
    nativeModule?.spectrogram?.configure(options)
  },

  process: (audioData: Float32Array): SpectrogramNativeResult | null => {
    if (!nativeModule?.spectrogram) return null
    return nativeModule.spectrogram.process(audioData)
  },

  reset: (): void => {
    nativeModule?.spectrogram?.reset()
  },
}

export const vectorscope: VectorscopeNativeAnalyzer & {
  getPoints: (maxPoints: number) => VectorscopePointsResult | null
  getBufferSize: () => number
  setBufferSize: (size: number) => void
  process: (leftChannel: Float32Array, rightChannel: Float32Array) => VectorscopeResult | null
} = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.vectorscope)
  },

  isMultibandAvailable: (): boolean => {
    return Boolean(
      nativeModule?.vectorscope?.pushMultibandSamples
        && nativeModule?.vectorscope?.getMultibandPoints,
    )
  },

  setSampleRate: (sampleRate: number): void => {
    nativeModule?.vectorscope?.setSampleRate(sampleRate)
  },

  pushSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.vectorscope?.pushSamples(leftChannel, rightChannel)
  },

  pushMultibandSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.vectorscope?.pushMultibandSamples?.(leftChannel, rightChannel)
  },

  fillPoints: (xOut: Float32Array, yOut: Float32Array): number => {
    if (!nativeModule?.vectorscope) return 0
    const result = nativeModule.vectorscope.getPoints(Math.min(xOut.length, yOut.length))
    const count = Math.min(xOut.length, yOut.length, result.count, result.x.length, result.y.length)
    if (count > 0) {
      xOut.set(result.x.subarray(0, count), 0)
      yOut.set(result.y.subarray(0, count), 0)
    }
    return count
  },

  getMultibandPoints: (maxPoints: number): VectorscopeMultibandPointsResult | null => {
    if (!nativeModule?.vectorscope?.getMultibandPoints) return null
    return nativeModule.vectorscope.getMultibandPoints(maxPoints)
  },

  getPoints: (maxPoints: number): VectorscopePointsResult | null => {
    if (!nativeModule?.vectorscope) return null
    return nativeModule.vectorscope.getPoints(maxPoints)
  },

  setBufferSize: (size: number): void => {
    nativeModule?.vectorscope?.setBufferSize(size)
  },

  getBufferSize: (): number => {
    return nativeModule?.vectorscope.getBufferSize() ?? 1024
  },

  process: (leftChannel: Float32Array, rightChannel: Float32Array): VectorscopeResult | null => {
    if (!nativeModule?.vectorscope) return null
    return nativeModule.vectorscope.process(leftChannel, rightChannel)
  },

  reset: (): void => {
    nativeModule?.vectorscope?.reset()
  }
}

export const waveform: WaveformNativeAnalyzer = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.waveform)
  },

  configure: (sampleRate: number, samplesPerColumn: number): void => {
    nativeModule?.waveform?.configure(sampleRate, samplesPerColumn)
  },

  processMono: (samples: Float32Array): Float32Array | null => {
    if (!nativeModule?.waveform) return null
    return nativeModule.waveform.processMono(samples)
  },

  processStereo: (leftChannel: Float32Array, rightChannel: Float32Array): Float32Array | null => {
    if (!nativeModule?.waveform) return null
    return nativeModule.waveform.processStereo(leftChannel, rightChannel)
  },

  reset: (): void => {
    nativeModule?.waveform?.reset()
  },
}

export const vumeter: VUMeterNativeAnalyzer = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.vumeter)
  },

  setSampleRate: (sampleRate: number): void => {
    nativeModule?.vumeter?.setSampleRate(sampleRate)
  },

  pushSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.vumeter?.pushSamples(leftChannel, rightChannel)
  },

  getSnapshot: (): VUMeterNativeSnapshot | null => {
    if (!nativeModule?.vumeter) return null
    return nativeModule.vumeter.getSnapshot()
  },

  reset: (): void => {
    nativeModule?.vumeter?.reset()
  },
}

export const lufsmeter: LUFSMeterNativeAnalyzer = {
  isAvailable: (): boolean => {
    return Boolean(nativeModule?.lufsmeter)
  },

  setSampleRate: (sampleRate: number): void => {
    nativeModule?.lufsmeter?.setSampleRate(sampleRate)
  },

  pushSamples: (leftChannel: Float32Array, rightChannel: Float32Array): void => {
    nativeModule?.lufsmeter?.pushSamples(leftChannel, rightChannel)
  },

  getSnapshot: (): LUFSMeterNativeSnapshot | null => {
    if (!nativeModule?.lufsmeter) return null
    return nativeModule.lufsmeter.getSnapshot()
  },

  reset: (): void => {
    nativeModule?.lufsmeter?.reset()
  },
}

export type {
  LUFSMeterNativeSnapshot,
  OscilloscopeResult,
  SpectrogramNativeOptions,
  SpectrogramNativeResult,
  VectorscopeResult,
  VectorscopePointsResult,
  VectorscopeMultibandPointsResult,
  VUMeterNativeSnapshot,
}
