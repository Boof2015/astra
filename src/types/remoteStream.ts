export type RemoteStreamSourceType = 'subsonic' | 'jellyfin'

export type RemoteLoadStage = 'downloading' | 'streaming' | 'complete' | 'failed'

export interface RemoteAudioLoadProgress {
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
  sessionId: number
  path: string
  sourceType: RemoteStreamSourceType
  sampleRate: number
  channels: number
  durationSeconds: number | null
  initialChunk?: RemoteStreamChunk | null
}

export interface RemoteStreamChunk {
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

export type RemoteStreamEvent =
  | {
      sessionId: number
      path: string
      sourceType: RemoteStreamSourceType
      type: 'started'
      sampleRate: number
      channels: number
      durationSeconds: number | null
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
