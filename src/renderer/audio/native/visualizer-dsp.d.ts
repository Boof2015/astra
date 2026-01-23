// Type definitions for visualizer_dsp native addon

export interface OscilloscopeResult {
  triggerIndex: number;
  samplesToShow: number;
  detectedPitch: number;
}

export interface VectorscopeResult {
  x: Float32Array;
  y: Float32Array;
}

export interface OscilloscopeModule {
  setSampleRate(sampleRate: number): void;
  setPitchLock(enabled: boolean): void;
  setDisplaySamples(samples: number): void;
  setFilterFrequency(frequency: number): void;
  process(audioData: Float32Array): OscilloscopeResult;
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
