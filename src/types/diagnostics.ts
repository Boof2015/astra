import type { PlaybackOutputMode } from './nativeAudio'
import type { ScopeKind, ScopePopoutState } from './scopePopout'
import type { AppMemoryFootprintSource } from '../shared/processMemoryFootprint'

export type MemoryDiagnosticsSnapshotReason = 'timer' | 'event' | 'startup'

export interface MemoryDiagnosticsStatus {
  enabled: boolean
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
