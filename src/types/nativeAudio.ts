import type { MultichannelAudioChunk } from './audioAnalysis'

export type PlaybackOutputMode = 'standard' | 'bitperfect'

export type NativeAudioPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'

export type NativeAudioSampleFormat = 's16' | 's32' | 'f32'

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
  activeDeviceExclusive: boolean
  activeSampleRate: number | null
  activeSampleFormat: NativeAudioSampleFormat | null
  selectedDeviceId: string | null
  selectedDeviceMaxChannels?: number | null
  devices: NativeAudioOutputDevice[]
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
  playbackState: NativeAudioPlaybackState
  currentTime: number
  duration: number
  sampleRate: number | null
  channels: number | null
  sampleFormat: NativeAudioSampleFormat | null
  deviceId: string | null
  deviceLabel: string | null
  activeBackend: NativeAudioBackendKind
  activeDeviceExclusive: boolean
  bitPerfectActive: boolean
}

export interface NativeAudioTrackLoadResult {
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
  bitPerfectActive: boolean
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
      playbackState: NativeAudioPlaybackState
    }
  | {
      type: 'timeUpdate'
      currentTime: number
    }
  | {
      type: 'durationChange'
      duration: number
    }
  | {
      type: 'ended'
    }
  | {
      type: 'gaplessTransition'
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
