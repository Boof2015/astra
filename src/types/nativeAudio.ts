import type { MultichannelAudioChunk } from './audioAnalysis'

export type PlaybackOutputMode = 'standard' | 'bitperfect'

export type NativeAudioPlaybackState = 'stopped' | 'starting' | 'playing' | 'paused' | 'loading'

// 's24' is packed 24-bit little-endian (3 bytes per sample), the native exclusive-mode
// format of most USB audio interfaces. Not the same as 24-in-32, which is reported by the
// device probe as 's24in32' and consumed as 's32'.
export type NativeAudioSampleFormat = 's16' | 's24' | 's32' | 'f32'

export type NativeAudioProbedSampleFormat = NativeAudioSampleFormat | 's24in32'

export interface NativeAudioDeviceFormat {
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioProbedSampleFormat
}

export interface NativeAudioDeviceFormatProbe {
  deviceId: string | null
  deviceLabel: string | null
  supported: boolean
  reason: string | null
  formats: NativeAudioDeviceFormat[]
}

export type NativeAudioBackendKind = 'unavailable' | 'coreaudio' | 'wasapi-exclusive' | 'alsa-hw'

export interface NativeAudioOutputDevice {
  deviceId: string
  label: string
  maxChannels: number
  isDefault: boolean
}

export interface NativeAudioCapabilities {
  bitPerfectAvailable: boolean
  reasonUnavailable: string | null
  activeBackend: NativeAudioBackendKind
  selectedDeviceId: string | null
  selectedDeviceMaxChannels?: number | null
  devices: NativeAudioOutputDevice[]
}

export interface NativePcmFormat {
  sampleRate: number | null
  channels: number | null
  sampleFormat: NativeAudioProbedSampleFormat | null
  containerBits: number | null
  validBits: number | null
  channelMask: number
  channelLayout: string | null
  representation: string | null
}

export interface NativeAudioOutputAttempt {
  index: number
  backend: NativeAudioBackendKind
  deviceId: string | null
  deviceLabel: string | null
  sourceFormat: NativePcmFormat
  processingFormat: NativePcmFormat
  wireFormat: NativePcmFormat
  transport: string | null
  probeResult: string | null
  requestedPeriodMs: number
  alignedPeriodMs: number
  actualPeriodMs: number
  bufferFrames: number
  deviceResolved: boolean
  formatNegotiated: boolean
  streamInitialized: boolean
  bufferPrimed: boolean
  streamStarted: boolean
  finalVerified: boolean
  failureStage: string | null
  osErrorSymbol: string | null
  osErrorCode: number
  message: string | null
}

export interface NativeAudioOutputStatus {
  outputOpen: boolean
  deviceResolved: boolean
  formatNegotiated: boolean
  streamInitialized: boolean
  streamStarted: boolean
  streamRunning: boolean
  exclusiveRequested: boolean
  exclusiveAcquired: boolean
  systemMixerBypassed: boolean
  sourceSamplesModified: boolean
  wireFormatCanCarrySourceExactly: boolean
  bitPerfectActive: boolean
  sourceFormat: NativePcmFormat
  processingFormat: NativePcmFormat
  wireFormat: NativePcmFormat
  backend: NativeAudioBackendKind
  deviceId: string | null
  deviceLabel: string | null
  transport: string | null
  requestedPeriodMs: number
  actualPeriodMs: number
  requestedPeriodFrames: number
  actualPeriodFrames: number
  bufferFrames: number
  failureStage: string | null
  osErrorSymbol: string | null
  osErrorCode: number
  failureSummary: string | null
  attempts: NativeAudioOutputAttempt[]
}

export interface NativeAudioDiagnosticReport {
  generatedAt: string
  text: string
  outputStatus: NativeAudioOutputStatus
  track: NativeAudioTrackMetadata | null
}

export interface NativeAudioTrackMetadata {
  path: string
  title?: string
  artist?: string
  album?: string
  format?: string
  sampleRate?: number
  bitDepth?: number
  channels?: number
  codec?: string
  codecProfile?: string
}

export interface AudioBufferMemoryStats {
  currentBytes: number
  nextBytes: number
  totalBytes: number
}

export interface NativeAudioPlaybackSnapshot {
  playbackSequence?: number
  playbackState: NativeAudioPlaybackState
  currentTime: number
  duration: number
  sampleRate: number | null
  channels: number | null
  sampleFormat: NativeAudioSampleFormat | null
  deviceId: string | null
  deviceLabel: string | null
  outputStatus: NativeAudioOutputStatus
}

export interface NativeAudioTrackLoadResult {
  playbackSequence: number
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
  timings?: NativeAudioTrackLoadTimings
}

export interface NativeAudioTrackLoadTimings {
  binaryResolutionMs: number
  probeMs: number
  decodeMs: number
  nativeLoadMs: number
}

export interface NativeAudioVectorscopeChunk {
  left: Float32Array
  right: Float32Array
}

export interface NativeAudioVUMeterChunk extends MultichannelAudioChunk {}

export interface NativeAudioVisualizerTapDemand {
  oscilloscope: boolean
  spectrum: boolean
  vectorscope: boolean
  vumeter: boolean
}

export type NativeAudioEvent =
  | {
      type: 'stateChange'
      playbackSequence: number
      playbackState: NativeAudioPlaybackState
    }
  | {
      type: 'timeUpdate'
      playbackSequence: number
      currentTime: number
    }
  | {
      type: 'durationChange'
      playbackSequence: number
      duration: number
    }
  | {
      type: 'ended'
      playbackSequence: number
    }
  | {
      type: 'gaplessTransition'
      playbackSequence: number
    }
  | {
      type: 'deviceReopened'
      sampleRate: number | null
      sampleFormat: NativeAudioSampleFormat | null
      deviceId: string | null
    }
  | {
      type: 'sampleRateChanged'
      sampleRate: number | null
    }
  | {
      type: 'error'
      message: string
    }
  | {
      type: 'outputStatusChanged'
      message?: string
    }
