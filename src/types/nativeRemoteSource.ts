import type { RemotePlaybackQuality } from './streamingQuality'
import type { NativeAudioOutputPolicy } from './nativeAudio'
export interface NativeRemoteRequest {
  policy: NativeAudioOutputPolicy
  slot: 'current' | 'next'
  startTimeSeconds: number
}
export interface NativeStratumInfo {
  sessionId: number
  sampleRate: number
  channels: number
  startFrame: number
  duration: number
  quality: RemotePlaybackQuality
}
/** Internal main/preload transport; never expose decoder URLs to the renderer. */
export interface NativeRemoteProgress {
  loadedBytes: number
  totalBytes: number | null
  complete: boolean
  error: string | null
  failureKind?: 'unsupported-format'
  quality?: RemotePlaybackQuality
  transport?: 'stratum-proof'
  analysisReady?: boolean
  diagnosticsSessionId?: number
}

export interface NativeRemoteSource {
  quality?: RemotePlaybackQuality
  url: string
  duration: number
  progress(position?: number, bufferedEnd?: number, outputRate?: number): Promise<NativeRemoteProgress>
  finished(): Promise<void>
  release(): void
  /** Source-rate signed 32-bit PCM for processed output only. No decoder URL. */
  pcm?: {
    info: NativeStratumInfo
    read(): Promise<ArrayBuffer | null>
    activate(): void
    close(): Promise<void>
  }
}
