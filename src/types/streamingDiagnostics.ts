/** In-memory observations only. No URLs, account IDs, playback handles or audio. */
export type DiagnosticSegmentQuality = 'lossless' | 'opus-64' | 'opus-128'
export interface StreamingDiagnosticSegment {
  start: number
  end: number
  quality: DiagnosticSegmentQuality
  state: 'requesting' | 'downloading' | 'received' | 'decoded' | 'failed' | 'cancelled'
  receivedBytes: number
  payloadBytes: number | null
  elapsedMs: number
  transferMs: number | null
  decodeMs: number | null
  /** A report about this response, not the server's current cache contents. */
  serverCacheHit: boolean | null
  /** Retained by Astra; distinct from Sidecar’s conversion cache. */
  localCacheHit?: boolean
}

export interface StreamingDiagnosticsSession {
  sessionId: number
  transport: 'stratum' | 'stream' | 'local'
  start: number
  duration: number | null
  bufferedEnd: number
  sourceRate: number | null
  outputRate: number
  channels: number
  loadedBytes: number
  totalBytes: number | null
  localCacheComplete: boolean
  state: 'preparing' | 'complete' | 'failed'
  segments: StreamingDiagnosticSegment[]
  omittedSegments: number
}
