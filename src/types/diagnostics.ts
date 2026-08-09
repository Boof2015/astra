import type { PlaybackOutputMode } from './nativeAudio'
import type { ScopeKind, ScopePopoutState } from './scopePopout'
import type { AppMemoryFootprintSource } from '../shared/processMemoryFootprint'

export type MemoryDiagnosticsSnapshotReason = 'timer' | 'event' | 'startup'

export type LocalPcmOutputSink =
  | 'stdout_pipe'
  | 'rechunked_pipe'
  | 'native_pipe'
  | 'worker_thread'
  | 'temporary_file'

export interface MemoryDiagnosticsStatus {
  enabled: boolean
  /** Runtime-only foreground Standard decode route. Omitted by older builds. */
  localPcmOutputSink?: LocalPcmOutputSink
  /** Compatibility alias derived from localPcmOutputSink. */
  localPcmTempFileSinkEnabled?: boolean
  sampleIntervalMs: number
  currentLogPath: string
  previousLogPath: string
  hasCurrentLog: boolean
  hasPreviousLog: boolean
  sessionStartedAt: number | null
}

export interface MemoryDiagnosticsSnapshotRequest {
  requestId: string
  reason: MemoryDiagnosticsSnapshotReason
  requestedAt: number
}

export interface MemoryDiagnosticsAudioSnapshot {
  playbackOutputMode: PlaybackOutputMode
  bitPerfectActive: boolean
  hasContext: boolean
  hasAudioBuffer: boolean
  hasNextBuffer: boolean
  currentBufferTrackPath: string | null
  nextBufferTrackPath: string | null
  currentBufferBytes: number
  nextBufferBytes: number
  totalBufferBytes: number
  nativeNextTrackBuffered: boolean
  gaplessScheduled: boolean
  gaplessTargetDeltaSeconds: number | null
  remoteStreamActive: boolean
  remoteStreamSessionId: number | null
  remoteStreamSourceType: string | null
  remoteBufferedSeconds: number
  remoteBufferedFrames: number
  remoteAnalyzedFrames: number
  normalizationApproximate: boolean
  visualizerConsumerCount: number
  activeVisualizerScopes: ScopeKind[]
  activeMiniVisualizerModes: Array<'spectrum' | 'oscilloscope'>
  pendingOscilloscopeChunks: number
  pendingSpectrumChunks: number
  pendingSpectrogramChunks: number
  pendingVectorscopeChunks: number
  pendingVUMeterChunks: number
  pendingLUFSMeterChunks: number
  pendingWaveformChunks: number
  pendingMiniVisualizerChunks: number
  pendingVisualizerChunksTotal: number
}

export interface MemoryDiagnosticsQueueSnapshot {
  userQueueCount: number
  autoQueueCount: number
  playbackHistoryCount: number
  playbackFutureCount: number
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'
  retainedTrackCount: number
  distinctRetainedTrackCount: number
  retainedArtworkTrackCount: number
  retainedArtworkDataBytes: number
}

export interface MemoryDiagnosticsVisualizerSnapshot {
  isRunning: boolean
  fftSize: number
  spectrogramFftSize: number
  hiddenScopeCount: number
  activeScopeCount: number
  openScopes: ScopeKind[]
  activeScopes: ScopeKind[]
  miniVisualizerMode: string
}

export interface MemoryDiagnosticsLibrarySnapshot {
  totalTrackCount: number
  visibleTrackCount: number
  fullTrackCount: number
  albumCount: number
  artistCount: number
  genreCount: number
  folderCount: number
  favoriteCount: number
  favoriteTrackCount: number
  recentlyPlayedCount: number
  searchResultCount: number
  selectionHistoryCount: number
  selectionHistoryTrackCount: number
  selectedDetailTrackCount: number
  scanInProgress: boolean
}

export interface MemoryDiagnosticsRendererHeapSpacesSnapshot {
  oldSpaceUsedBytes: number | null
  newSpaceUsedBytes: number | null
  codeSpaceUsedBytes: number | null
  mapSpaceUsedBytes: number | null
  largeObjectSpaceUsedBytes: number | null
}

export interface MemoryDiagnosticsProcessMemoryStats {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

export interface MemoryDiagnosticsRendererMemoryStats extends MemoryDiagnosticsProcessMemoryStats {
  privateMb: number
  heapSpaces: MemoryDiagnosticsRendererHeapSpacesSnapshot
}

export interface MemoryDiagnosticsBlinkResourceUsageBucketSnapshot {
  count: number
  liveSize: number
  size: number
}

export interface MemoryDiagnosticsBlinkResourceUsageSnapshot {
  images: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
  scripts: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
  cssStyleSheets: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
  xslStyleSheets: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
  fonts: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
  other: MemoryDiagnosticsBlinkResourceUsageBucketSnapshot
}

export interface MemoryDiagnosticsUserAgentSpecificMemoryBreakdownSnapshot {
  bytes: number
  types: string[]
  attribution: Array<Record<string, string | null>>
}

export interface MemoryDiagnosticsUserAgentSpecificMemorySnapshot {
  bytes: number
  breakdown: MemoryDiagnosticsUserAgentSpecificMemoryBreakdownSnapshot[]
}

export interface MemoryDiagnosticsTitleBarSampleSnapshot {
  sampledAt: number | null
  appFootprintMb: number | null
  childProcessFootprintMb: number | null
  combinedFootprintMb: number | null
  appFootprintSource: AppMemoryFootprintSource | null
  appFootprintComplete: boolean | null
  appFootprintFailedPids: number[]
  appFootprintProcessCount: number | null
  appFootprintChildProcessCount: number | null
  rendererPrivateMb: number | null
  appMemoryMb: number | null
  bufferMemoryMb: number | null
  currentBufferMemoryMb: number | null
  nextBufferMemoryMb: number | null
  otherProcessMemoryMb: number | null
  mainProcessMemoryMb: number | null
  helperProcessesMemoryMb: number | null
  totalPrivateMb: number | null
  totalWorkingSetMb: number | null
  rendererHeapUsedMb: number | null
  rendererExternalMb: number | null
  rendererArrayBuffersMb: number | null
  rendererOldSpaceMb: number | null
  rendererLargeObjectSpaceMb: number | null
  mainRssMb: number | null
  mainHeapUsedMb: number | null
  mainExternalMb: number | null
  mainArrayBuffersMb: number | null
}

export interface MemoryDiagnosticsTitleBarPeakSnapshot {
  capturedAt: number | null
  appFootprintMb: number | null
  childProcessFootprintMb: number | null
  combinedFootprintMb: number | null
  appFootprintSource: AppMemoryFootprintSource | null
  appFootprintComplete: boolean | null
  appFootprintFailedPids: number[]
  appFootprintProcessCount: number | null
  appFootprintChildProcessCount: number | null
  rendererPrivateMb: number | null
  appMemoryMb: number | null
  bufferMemoryMb: number | null
  currentBufferMemoryMb: number | null
  nextBufferMemoryMb: number | null
  otherProcessMemoryMb: number | null
  mainProcessMemoryMb: number | null
  helperProcessesMemoryMb: number | null
  totalPrivateMb: number | null
  totalWorkingSetMb: number | null
  rendererHeapUsedMb: number | null
  rendererExternalMb: number | null
  rendererArrayBuffersMb: number | null
  rendererOldSpaceMb: number | null
  rendererLargeObjectSpaceMb: number | null
  mainRssMb: number | null
  mainHeapUsedMb: number | null
  mainExternalMb: number | null
  mainArrayBuffersMb: number | null
}

export interface MemoryDiagnosticsRemoteLoadSnapshot {
  stage: 'downloading' | 'streaming' | 'complete' | 'failed'
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

export interface MemoryDiagnosticsCacheSnapshot {
  waveformEntries: number
  waveformBytes: number
  currentWaveformBytes: number
  artworkFullEntries: number
  artworkFullBytes: number
  artworkThumbnailEntries: number
  artworkThumbnailBytes: number
  artworkCardEntries: number
  artworkCardBytes: number
  artworkRequests: number
  coverArtAccentEntries: number
  coverArtAccentBytes: number
  discordCoverArtEntries: number
  discordCoverArtHitEntries: number
  discordCoverArtNotFoundEntries: number
  discordCoverArtTransientErrorEntries: number
  discordCoverArtEstimatedBytes: number
  discordCoverArtOldestEntryAgeMs: number | null
  discordCoverArtNewestEntryAgeMs: number | null
  discordCoverArtMaxEntries: number
  discordPendingLookups: number
}

export interface MemoryDiagnosticsRendererSnapshot {
  capturedAt: number
  rendererPrivateMb: number | null
  rendererProcessRssBytes: number | null
  rendererProcessHeapUsedBytes: number | null
  rendererProcessHeapTotalBytes: number | null
  rendererProcessExternalBytes: number | null
  rendererProcessArrayBuffersBytes: number | null
  jsHeapUsedBytes: number | null
  jsHeapTotalBytes: number | null
  jsHeapLimitBytes: number | null
  userAgentSpecificMemory: MemoryDiagnosticsUserAgentSpecificMemorySnapshot | null
  blinkResourceUsage: MemoryDiagnosticsBlinkResourceUsageSnapshot | null
  heapSpaces: MemoryDiagnosticsRendererHeapSpacesSnapshot
  titleBar: MemoryDiagnosticsTitleBarSampleSnapshot
  titleBarPeaks: MemoryDiagnosticsTitleBarPeakSnapshot
  gaplessPrebufferDisabledDev: boolean
  standardAnalysisGraphDisabledDev: boolean
  playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
  currentTimeSeconds: number
  currentTrackPath: string | null
  currentTrackSourceType: string | null
  currentTrackDurationSeconds: number | null
  currentTrackArtworkDataBytes: number
  nextTrackPath: string | null
  nextTrackSourceType: string | null
  remoteStreamSessionId: number | null
  remoteBufferedSeconds: number
  remoteLoad: MemoryDiagnosticsRemoteLoadSnapshot | null
  discordEnabled: boolean
  discordCoverArtEnabled: boolean
  queue: MemoryDiagnosticsQueueSnapshot
  audio: MemoryDiagnosticsAudioSnapshot
  visualizer: MemoryDiagnosticsVisualizerSnapshot
  scopePopouts: ScopePopoutState
  library: MemoryDiagnosticsLibrarySnapshot
  caches: MemoryDiagnosticsCacheSnapshot
}

export interface MemoryDiagnosticsCaptureBundleResult {
  capturedAt: number
  tag: string | null
  directoryPath: string
  summaryPath: string
  heapSnapshotPath: string
  files: string[]
}

export interface MemoryDiagnosticsEventPayload {
  name: string
  source: 'main' | 'renderer'
  details?: Record<string, unknown> | null
}

export interface MemoryDiagnosticsLogEventOptions {
  captureSample?: boolean
}

export interface LocalAudioPcmTransportTimings {
  decodeRequestId: number
  validPcmBytes: number
  backingBufferBytes: number
  allocationGrowthCount: number
  /** Bulk delivery route. Omitted by older builds and treated as invoke. */
  transportRoute?: 'invoke' | 'message_port_stream'
  mainHandlerMs: number
  binaryResolutionMs: number
  probeMs: number
  /** Whether probe metadata came from cache, a fresh probe, or a non-cacheable path. */
  probeCacheStatus?: 'hit' | 'miss' | 'bypass'
  /** Whether probing and FFmpeg decode startup were intentionally overlapped. */
  probeDecodeOverlapEnabled?: boolean
  /** Wall time during which probing and FFmpeg decoding overlapped. */
  probeFfmpegOverlapMs?: number
  /** FFmpeg child spawn-to-close wall time, including stdout blocking and process scheduling. */
  ffmpegMs: number
  /** FFmpeg's decoded-PCM output destination. Omitted by older builds. */
  ffmpegOutputSink?: LocalPcmOutputSink
  tempPcmCreateMs?: number
  tempPcmStatMs?: number
  tempPcmReadMs?: number
  tempPcmReadChunkCount?: number
  tempPcmBytes?: number
  tempPcmCleanupMs?: number
  tempPcmCleanupSucceeded?: boolean
  /** Worker creation/request handshake before FFmpeg begins producing PCM. */
  ffmpegWorkerStartupMs?: number
  /** Worker-owned decode request wall span. */
  ffmpegWorkerTotalMs?: number
  ffmpegWorkerSpawnMs?: number
  ffmpegWorkerFfmpegMs?: number
  ffmpegWorkerSpawnToFirstPcmMs?: number
  ffmpegWorkerPcmOutputSpanMs?: number
  ffmpegWorkerCloseTailMs?: number
  /** Main-thread request dispatch until the worker's terminal message is observed. */
  ffmpegWorkerRequestMs?: number
  /** First worker PCM batch observed by main until the terminal message is observed. */
  ffmpegWorkerMainDeliverySpanMs?: number
  ffmpegWorkerBatchCount?: number
  ffmpegWorkerBatchBytes?: number
  ffmpegWorkerBatchMinBytes?: number
  ffmpegWorkerBatchMaxBytes?: number
  /** Copying FFmpeg stdout into transferable worker batches. */
  ffmpegWorkerAggregationCopyMs?: number
  ffmpegWorkerAggregationCopyMaxMs?: number
  ffmpegWorkerBatchCopyMs?: number
  ffmpegWorkerBatchPostMs?: number
  /** Copying transferred worker batches into the authoritative main PCM buffer. */
  ffmpegWorkerMainCopyMs?: number
  ffmpegWorkerMainCopyMaxMs?: number
  /** Worker time spent waiting for bounded main-ingestion credits. */
  ffmpegWorkerCreditWaitCount?: number
  ffmpegWorkerCreditWaitMs?: number
  ffmpegWorkerCreditWaitMaxMs?: number
  /** Main-only native capture setup and Win32 pipe-drain telemetry. */
  nativePcmCaptureSpawnMs?: number
  nativePcmCaptureProcessMs?: number
  nativePcmCaptureFirstByteMs?: number
  nativePcmCaptureStdoutReadSpanMs?: number
  nativePcmCaptureStdoutReadCount?: number
  nativePcmCaptureStdoutReadMinBytes?: number
  nativePcmCaptureStdoutReadMaxBytes?: number
  nativePcmCaptureOutputBytes?: number
  nativePcmCaptureRequestedPipeBufferBytes?: number
  nativePcmCaptureEffectivePipeBufferBytes?: number
  nativePcmCaptureBufferCopyMs?: number
  nativePcmCaptureUsedExternalBuffer?: boolean
  nativePcmCaptureDeliveryMode?: 'complete_buffer' | 'progress_batches'
  nativePcmCaptureBatchTargetBytes?: number
  nativePcmCaptureBatchCount?: number
  nativePcmCaptureBatchBytes?: number
  nativePcmCaptureBatchMinBytes?: number
  nativePcmCaptureBatchMaxBytes?: number
  nativePcmCaptureBatchCreditWaitCount?: number
  nativePcmCaptureBatchCreditWaitMs?: number
  nativePcmCaptureBatchCreditWaitMaxMs?: number
  nativePcmCaptureBatchCopyMs?: number
  nativePcmCaptureBatchCopyMaxMs?: number
  nativePcmCaptureBatchCallbackMs?: number
  nativePcmCaptureBatchCallbackMaxMs?: number
  nativePcmCaptureMainCopyMs?: number
  nativePcmCaptureMainCopyMaxMs?: number
  nativePcmCaptureFirstBatchMs?: number
  nativePcmCaptureMainBatchSpanMs?: number
  /** FFmpeg spawn until the first decoded PCM bytes were observed. */
  ffmpegSpawnToFirstPcmMs?: number
  /** First decoded PCM bytes until the last decoded PCM bytes were observed. */
  ffmpegPcmOutputSpanMs?: number
  /** Last stdout callback entry until FFmpeg closed; overlaps the final callback's work. */
  ffmpegCloseTailMs?: number
  /** Raw FFmpeg stdout delivery observed by the process that owns the decode route. */
  ffmpegStdoutChunkCount?: number
  ffmpegStdoutBytes?: number
  ffmpegStdoutChunkMinBytes?: number
  ffmpegStdoutChunkMaxBytes?: number
  /** First stdout callback entry through the final stdout callback exit. */
  ffmpegStdoutDrainSpanMs?: number
  /** Final stdout callback exit until FFmpeg close was observed. */
  ffmpegStdoutDrainToCloseMs?: number
  /** Synchronous work performed inside stdout data callbacks. */
  ffmpegStdoutCallbackWorkMs?: number
  ffmpegStdoutCallbackMaxMs?: number
  /** Time between stdout callback exit and the next callback entry. */
  ffmpegStdoutInterCallbackGapMs?: number
  ffmpegStdoutInterCallbackGapMaxMs?: number
  /**
   * Successful PCM chunk post completion until the next stdout callback entry.
   * This is a correlation window and does not by itself attribute the delay to IPC.
   */
  ffmpegStdoutPostDispatchGapCount?: number
  ffmpegStdoutPostDispatchGapMs?: number
  ffmpegStdoutPostDispatchGapMaxMs?: number
  /** Copying raw stdout chunks into the authoritative main PCM buffer. */
  ffmpegStdoutCopyMs?: number
  ffmpegStdoutCopyMaxMs?: number
  /** Checking and dispatching completed MessagePort chunks after each append. */
  ffmpegStdoutFlushMs?: number
  ffmpegStdoutFlushMaxMs?: number
  /** Explicit pre-probe stdout backpressure; absent from ordinary warm hits. */
  ffmpegStdoutPauseCount?: number
  ffmpegStdoutPausedMs?: number
  ffmpegStdoutPauseMaxMs?: number
  allocationMs: number
  /** Initial full-buffer allocation after authoritative probe metadata is ready. */
  initialAllocationMs?: number
  /** Capacity-growth allocations which occur inside the FFmpeg wall span. */
  growthAllocationMs?: number
  payloadFinalizationMs: number
  preloadInvokeMs: number
  /** MessagePort stream diagnostics. These are absent on the invoke route. */
  streamChunkCount?: number
  streamDispatchCopyMs?: number
  streamDispatchPostMs?: number
  /** Matching renderer credit acknowledgements observed before stream completion. */
  streamCreditAckCount?: number
  /**
   * Sum of main post-return to matching renderer-credit arrival durations.
   * Includes delivery, cloning, renderer copy/scheduling, and return dispatch.
   */
  streamCreditRoundTripMs?: number
  streamCreditRoundTripMaxMs?: number
  streamTailMs?: number
  benchmarkMainGenerationMs?: number
  benchmarkMainFillMs?: number
  rendererPcmAssemblyAllocationMs?: number
  rendererPcmAssemblyCopyMs?: number
  rendererPortRequestMs?: number
}

export interface PcmTransferBenchmarkProbeResult {
  sizeBytes: number
  byteLength: number
  payload: ArrayBuffer
  allocationMs: number
  fillMs: number
  mainHandlerMs?: number
  preloadInvokeMs?: number
  preloadServiceMs?: number
}
