import type { PlaybackState } from '../../types/audio'

export interface NativeAudioDevice {
  deviceId: string
  label: string
  groupId: string
  isDefaultAlias: boolean
  maxChannels: number
  supportsExclusive: boolean
}

export interface NativeAudioVisualizerSamples {
  mono: Float32Array
  left: Float32Array
  right: Float32Array
  count: number
}

export interface NativeAudioSpectrumSamples {
  mono: Float32Array
  count: number
}

export interface NativeAudioDecodedSamples {
  samples: Float32Array
  channels: number
  sampleRate: number
}

export interface NativeAudioAPI {
  initialize(): boolean
  shutdown(): void
  loadFromBuffer(buffer: ArrayBuffer): boolean
  preBufferFromBuffer(buffer: ArrayBuffer): boolean
  clearNextBuffer(): void
  play(): boolean
  pause(): void
  stop(): void
  seek(seconds: number): void
  getPosition(): number
  getDuration(): number
  getState(): PlaybackState
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setExclusiveMode(enabled: boolean): boolean
  isExclusiveModeActive(): boolean
  setDspEnabled(enabled: boolean): void
  setNormalizationGain(linearGain: number): void
  setAnalysisDelayMs(delayMs: number): void
  setMultichannelEnabled(enabled: boolean): void
  setChannelRoutingMap(map: number[] | null): void
  updateEQ(
    bands: Array<{
      type: 'lowshelf' | 'peaking' | 'highshelf'
      frequency: number
      gain: number
      Q: number
    }>,
    preampDb: number,
    enabled: boolean
  ): void
  enumerateDevices(): NativeAudioDevice[]
  selectDevice(deviceId: string): boolean
  getOutputMaxChannelCount(): number
  getCurrentTrackChannelCount(): number
  getSampleRate(): number
  getDeviceSampleRate(): number
  readVisualizerSamples(maxFrames: number): NativeAudioVisualizerSamples
  readPostEqSpectrumSamples(maxFrames: number): NativeAudioSpectrumSamples
  getDecodedSamples(): NativeAudioDecodedSamples | null
  didGaplessTransition(): boolean
}
