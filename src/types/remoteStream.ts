import type { RemotePlaybackQuality } from './streamingQuality'
export type ProgressiveStreamSourceType = 'local' | 'subsonic' | 'jellyfin' | 'plex'
export type RemoteStreamSourceType = ProgressiveStreamSourceType

export type RemoteLoadStage = 'downloading' | 'streaming' | 'complete' | 'failed'

export interface RemoteAudioLoadProgress {
  transport?: 'stratum-proof'
  quality?: RemotePlaybackQuality
  /** Encoded download completion is independent of bounded PCM lookahead. */
  downloadComplete?: boolean
  sessionId?: number
  slot?: 'current' | 'next'
  path: string
  sourceType: RemoteStreamSourceType
  stage: RemoteLoadStage
  loadedBytes: number
  totalBytes: number | null
  chunkCount: number
  percent: number | null
  done: boolean
  failed: boolean
  bufferedSeconds: number
  bufferedPercent: number | null
  analyzedSeconds: number
  analyzedPercent: number | null
  playable: boolean
}

export interface RemoteStreamInfo {
  /** Can restart decoding at a new position without retaining a client file. */
  restartable?: boolean
  transport?: 'stratum-proof'
  quality?: RemotePlaybackQuality
  sessionId: number
  path: string
  sourceType: RemoteStreamSourceType
  sampleRate: number
  channels: number
  durationSeconds: number | null
  startTimeSeconds: number
  /** This session can restart decoding from retained encoded bytes. */
  seekableCache?: boolean
  initialChunk?: RemoteStreamChunk | null
}

export interface RemoteStreamChunk {
  /** Output-frame boundaries relative to this session's seek origin, not arrival time. */
  qualityChanges?: RemoteStreamQualityChange[]
  sessionId: number
  path: string
  sourceType: RemoteStreamSourceType
  sampleRate: number
  channels: number
  frameCount: number
  pcmData: ArrayBuffer
  decodedFrames: number
  decodedSeconds: number
}

export interface RemoteStreamQualityChange { frame: number; quality: RemotePlaybackQuality }

export type RemoteStreamEvent =
  | {
      sessionId: number
      path: string
      sourceType: RemoteStreamSourceType
      type: 'started'
      sampleRate: number
      channels: number
      durationSeconds: number | null
      startTimeSeconds: number
    }
  | {
      sessionId: number
      path: string
      sourceType: RemoteStreamSourceType
      type: 'complete'
      decodedFrames: number
      decodedSeconds: number
    }
  | {
      sessionId: number
      path: string
      sourceType: RemoteStreamSourceType
      type: 'cancelled'
      decodedFrames: number
      decodedSeconds: number
    }
  | {
      sessionId: number
      path: string
      sourceType: RemoteStreamSourceType
      type: 'failed'
      message: string
      decodedFrames: number
      decodedSeconds: number
    }

export type ProgressiveAudioLoadProgress = RemoteAudioLoadProgress
export type ProgressiveStreamInfo = RemoteStreamInfo
export type ProgressiveStreamChunk = RemoteStreamChunk
export type ProgressiveStreamEvent = RemoteStreamEvent
