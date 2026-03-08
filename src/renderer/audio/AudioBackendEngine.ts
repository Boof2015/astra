import type {
  DifferentialCalibrationResult,
  OutputDelayCalibrationResult
} from './AudioEngine'
import type {
  AudioBackendFamily,
  AudioBackendMode,
  EQBand,
  GainApplicationMode,
  PlaybackState
} from '../types/audio'
import type { NativeAudioDevice } from './native/native-audio'

export interface AudioLoadDataOptions {
  replayGainDb?: number | null
}

export interface AudioBackendEventMap {
  stateChange: (state: PlaybackState) => void
  timeUpdate: (currentTime: number) => void
  durationChange: (duration: number) => void
  bufferReady: (buffer: AudioBuffer | null) => void
  gaplessTransition: () => void
  ended: () => void
  error: (error: Error) => void
}

export type AudioBackendEventName = keyof AudioBackendEventMap

export interface AudioBackendEngine {
  readonly family: AudioBackendFamily
  readonly backendMode: AudioBackendMode
  readonly decoderLabel: string
  readonly supportsExclusiveMode: boolean
  readonly usesNativePlayback: boolean
  readonly usesAppResampler: boolean
  readonly playbackState: PlaybackState
  readonly volume: number
  readonly isMuted: boolean
  readonly currentTime: number
  readonly duration: number
  readonly hasNextBuffered: boolean

  normalizationEnabled: boolean
  targetLufs: number

  on<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void
  off<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void
  onTrackChange(callback: () => void): () => void

  loadAudioData(arrayBuffer: ArrayBuffer, options?: AudioLoadDataOptions): Promise<void>
  preBufferNext(arrayBuffer: ArrayBuffer, options?: AudioLoadDataOptions): Promise<void>
  clearNextBuffer(): void

  play(): Promise<void>
  pause(): void
  togglePlay(): Promise<void>
  stop(): void
  seek(time: number): Promise<void>

  setVolume(value: number): void
  toggleMute(): void
  setMuted(muted: boolean): void

  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void
  updateEQBand(index: number, band: EQBand): void
  updatePreamp(dB: number): void

  setOutputDevice(deviceId: string): Promise<void>
  enumerateOutputDevices(): Promise<NativeAudioDevice[]>
  ensureContextReady(): Promise<void>
  isContextReady(): boolean

  getCurrentTrackChannelCount(): number | null
  getSampleRate(): number
  getDeviceSampleRate(): number | null
  getEQAnalyserNode(): AnalyserNode | null
  getOutputMaxChannelCount(): number | null
  getNormalizationGainDb(): number
  getNormalizationMode(): GainApplicationMode
  setCurrentReplayGainDb(replayGainDb: number | null): void
  setReplayGainEnabled(enabled: boolean): void
  setAnalysisDelayMs(ms: number): Promise<void>
  setMultichannelEnabled(enabled: boolean): Promise<void>
  setChannelRoutingMap(map: number[] | null): Promise<void>
  runOutputDelayCalibration(inputDeviceId?: string): Promise<OutputDelayCalibrationResult>
  runDifferentialCalibration(
    btOutputDeviceId: string,
    referenceOutputDeviceId: string,
    inputDeviceId?: string
  ): Promise<DifferentialCalibrationResult>

  flushPendingOscilloscopeSamples(): Float32Array[]
  flushPendingSpectrumSamples(): Float32Array[]
  flushPendingVectorscopeSamples(): Array<{ left: Float32Array; right: Float32Array }>
  flushPendingMiniVisualizerChunks(): Array<{ left: Float32Array; mono: Float32Array }>
  flushPendingPostEqSpectrumSamples(): Float32Array[]

  getOutputDeviceId(): string
  isExclusiveModeActive(): boolean
}

export interface AudioAnalysisFrame {
  bins: Float32Array
  sampleRate: number
  minDb: number
  maxDb: number
  capturedAt: number
}
