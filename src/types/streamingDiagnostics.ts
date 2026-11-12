/** In-memory observations only. No URLs, account IDs, playback handles or audio. */
export type DiagnosticSegmentQuality = import('../shared/stratumQuality').StratumQuality
export interface StreamingDiagnosticSegment {
  start: number
  end: number
  quality: DiagnosticSegmentQuality
  state: 'requesting' | 'downloading' | 'received' | 'decoded' | 'failed' | 'cancelled'
  receivedBytes: number
  payloadBytes: number | null
  /** Response size when supplied by Sidecar; not a playable time range. */
  transferTotalBytes?: number
  elapsedMs: number
  /** DNS/TCP/TLS connection, then request delivery/server wait through response headers. */
  connectionMs?: number
  responseWaitMs?: number
  transferMs: number | null
  decodeMs: number | null
  /** A report about this response, not the server's current cache contents. */
  serverCacheHit: boolean | null
  /** Retained by Astra; distinct from Sidecar’s conversion cache. */
  localCacheHit?: boolean
}

export interface StreamingDiagnosticCacheRange {
  start: number
  end: number
  qualities: DiagnosticSegmentQuality[]
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
  /** Current, pinned Astra inventory, including islands outside this seek session. */
  cachedRanges?: StreamingDiagnosticCacheRange[]
  state: 'preparing' | 'complete' | 'failed'
  segments: StreamingDiagnosticSegment[]
  omittedSegments: number
}
