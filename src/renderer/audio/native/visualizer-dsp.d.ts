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

export interface VectorscopeMultibandPointsResult {
  data: Float32Array;
  count: number;
}

export interface SpectrogramNativeOptions {
  fftSize: number;
  sampleRate: number;
  rowCount: number;
  minFrequency: number;
  maxFrequency: number;
  minDecibels: number;
  maxDecibels: number;
  scrollSpeed: number;
  contrast: number;
  tiltDbPerOctave: number;
  clarityMode: string;
  scaleMode: string;
  orientation: string;
}

export interface SpectrogramNativeResult {
  display: Float32Array;
  heat: Float32Array;
  columnCount: number;
  rowCount: number;
}

export interface LUFSMeterNativeSnapshot {
  momentaryLUFS: number;
  shortTermLUFS: number;
  integratedLUFS: number;
  vuLDb: number;
  vuRDb: number;
  barLDb: number;
  barRDb: number;
  peakLDb: number;
  peakRDb: number;
  correlation: number;
}

export interface VUMeterNativeSnapshot {
  vuLDb: number;
  vuRDb: number;
  barLDb: number;
  barRDb: number;
  peakLDb: number;
  peakRDb: number;
  correlation: number;
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

  // Fill a caller-owned buffer with rendered samples, returning the number written.
  fillSamples(startPos: number, output: Float32Array): number;

  // Get samples from circular buffer for rendering
  getSamples(startPos: number, count: number): Float32Array;

  reset(): void;
}

export interface SpectrumModule {
  setFFTSize(size: number): void;
  getFFTSize(): number;
  setSampleRate(sampleRate: number): void;
  setSmoothing(smoothing: number): void;
  pushSamples(audioData: Float32Array): void;
  pushStereoSamples(leftChannel: Float32Array, rightChannel: Float32Array): void;
  fillRawMagnitudes(output: Float32Array): number;
  fillMagnitudes(output: Float32Array): number;
  fillSideMagnitudes(output: Float32Array): number;
  getRawMagnitudes(): Float32Array;
  getMagnitudes(): Float32Array;
  getSideMagnitudes(): Float32Array;
  process(audioData: Float32Array): Float32Array;
  binToFrequency(bin: number): number;
  configureBars(options: SpectrumBarNativeConfig): void;
  getBarFrame(nowMs?: number): Float32Array;
  reset(): void;
}

export interface SpectrumBarNativeConfig {
  barCount: number;
  minFrequency: number;
  maxFrequency: number;
  minDecibels: number;
  maxDecibels: number;
  tiltDbPerOctave: number;
  heatmapTiltDbPerOctave: number;
  tiltReferenceHz: number;
  heatmapSmoothing: number;
  showPeaks: boolean;
}

export interface SpectrogramModule {
  configure(options: SpectrogramNativeOptions): void;
  process(audioData: Float32Array): SpectrogramNativeResult;
  reset(): void;
}

export interface VectorscopeModule {
  setSampleRate(sampleRate: number): void;
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void;
  pushMultibandSamples?: (leftChannel: Float32Array, rightChannel: Float32Array) => void;
  fillPoints(xOut: Float32Array, yOut: Float32Array): number;
  getPoints(maxPoints: number): VectorscopePointsResult;
  getMultibandPoints?: (maxPoints: number) => VectorscopeMultibandPointsResult;
  setBufferSize(size: number): void;
  getBufferSize(): number;
  process(leftChannel: Float32Array, rightChannel: Float32Array): VectorscopeResult;
  reset(): void;
}

export interface WaveformModule {
  configure(sampleRate: number, samplesPerColumn: number): void;
  processMono(samples: Float32Array): Float32Array;
  processStereo(leftChannel: Float32Array, rightChannel: Float32Array): Float32Array;
  reset(): void;
}

export interface LUFSMeterModule {
  setSampleRate(sampleRate: number): void;
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void;
  getSnapshot(): LUFSMeterNativeSnapshot;
  reset(): void;
}

export interface VUMeterModule {
  setSampleRate(sampleRate: number): void;
  pushSamples(leftChannel: Float32Array, rightChannel: Float32Array): void;
  getSnapshot(): VUMeterNativeSnapshot;
  reset(): void;
}

export interface VisualizerDSP {
  oscilloscope: OscilloscopeModule;
  spectrum: SpectrumModule;
  // Modules added by the Prism scope port. Optional so an older native build
  // (or the preload's leaner Window typing) is still assignable; every consumer
  // guards access with optional chaining / isAvailable().
  spectrogram?: SpectrogramModule;
  vectorscope: VectorscopeModule;
  waveform?: WaveformModule;
  vumeter?: VUMeterModule;
  lufsmeter?: LUFSMeterModule;
}

declare const visualizerDSP: VisualizerDSP;
export default visualizerDSP;
