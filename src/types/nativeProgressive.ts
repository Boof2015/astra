import type { NativeAudioPlaybackSnapshot, NativeAudioSampleFormat, NativeAudioTrackGain } from './nativeAudio'

/** Internal preload/addon boundary. Never expose these handles across contextBridge. */
export interface NativeProgressiveInputOptions {
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  capacityFrames: number
  startFrame?: number
  duration?: number
  gain?: NativeAudioTrackGain
}

export interface NativeProgressiveInputStatus {
  sessionId: number
  startFrame: number
  retainedFrame: number
  publishedFrame: number
  capacityFrames: number
  sampleRate: number
  bytesPerFrame: number
  state: 'open' | 'ended' | 'cancelled'
}

export interface NativeProgressiveInput {
  /** Returns accepted complete frames, which may be fewer than supplied. */
  append(pcm: Uint8Array): number
  finish(): boolean
  cancel(): void
  status(): NativeProgressiveInputStatus
  load(): NativeAudioPlaybackSnapshot
  preloadNext(): void
  seek(expectedSessionId: number): Promise<NativeAudioPlaybackSnapshot>
}
