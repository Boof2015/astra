// Type definitions for visualizer_dsp native addon

export interface OscilloscopeResult {
  triggerIndex: number; // float for sub-sample precision (position in circular buffer)
  samplesToShow: number;
  detectedPitch: number;
  writePos: number; // current write position in circular buffer
}

export interface VectorscopeResult {
  x: Float32Array;
  y: Float32Array;
}

export interface VectorscopePointsResult {
  x: Float32Array;
  y: Float32Array;
  count: number;
}

// Circular buffer size (must match native code)
export const OSCILLOSCOPE_BUFFER_SIZE = 32768;

export interface OscilloscopeModule {
  setSampleRate(sampleRate: number): void;
  setPitchLock(enabled: boolean): void;
  setDisplaySamples(samples: number): void;

  // Push samples to circular buffer (for continuous capture)
  pushSamples(samples: Float32Array): void;

  // Process using circular buffer (continuous mode)
  processContinuous(): OscilloscopeResult;

  // Legacy: process snapshot (pushes to buffer and processes)
  process(audioData: Float32Array): OscilloscopeResult;

  // Get current write position in circular buffer
  getWritePos(): number;

  // Get samples from circular buffer for rendering
  getSamples(startPos: number, count: number): Float32Array;

  reset(): void;
}

export interface SpectrumModule {
  setFFTSize(size: number): void;
  getFFTSize(): number;
  setSampleRate(sampleRate: number): void;
  setSmoothing(smoothing: number): void;
  process(audioData: Float32Array): Float32Array;
  binToFrequency(bin: number): number;
  reset(): void;
}

export interface VectorscopeModule {
  setSampleRate(sampleRate: number): void;
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void;
  getPoints(maxPoints: number): VectorscopePointsResult;
  setBufferSize(size: number): void;
  getBufferSize(): number;
  process(leftChannel: Float32Array, rightChannel: Float32Array): VectorscopeResult;
  reset(): void;
}

export interface VisualizerDSP {
  oscilloscope: OscilloscopeModule;
  spectrum: SpectrumModule;
  vectorscope: VectorscopeModule;
}

declare const visualizerDSP: VisualizerDSP;
export default visualizerDSP;
