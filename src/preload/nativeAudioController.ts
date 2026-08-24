import { access } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import { join } from 'path'
import type {
  AudioBufferMemoryStats,
  NativeAudioBackendKind,
  NativeAudioCapabilities,
  NativeAudioDspConfig,
  NativeAudioDeviceFormat,
  NativeAudioDeviceFormatProbe,
  NativeAudioDiagnosticReport,
  NativeAudioProbedSampleFormat,
  NativeAudioEvent,
  NativeAudioOutputDevice,
  NativeAudioOutputAttempt,
  NativeAudioOutputStatus,
  NativeAudioOutputRequest,
  NativeAudioProcessingStatus,
  NativePcmFormat,
  NativeAudioPlaybackSnapshot,
  NativeAudioSampleFormat,
  NativeAudioTrackLoadResult,
  NativeAudioTrackGain,
  NativeAudioTrackMetadata,
  NativeAudioVisualizerTapDemand,
  NativeAudioVUMeterChunk,
  NativeAudioVectorscopeChunk
} from '../types/nativeAudio'
import { createBitPerfectFormatError } from '../shared/audio/bitPerfectFormatError'

export interface NativeAudioAddonPlayback {
  getCapabilities(): NativeAudioCapabilities
  getNativeAudioDiagnosticReport?(): string
  setOutputDevice(deviceId: string): NativeAudioCapabilities
  configureOutput(request: NativeAudioOutputRequest): NativeAudioCapabilities
  setDspConfig(config: NativeAudioDspConfig): NativeAudioPlaybackSnapshot
  setCurrentTrackGain(gain: NativeAudioTrackGain): NativeAudioPlaybackSnapshot
  probeDeviceFormats?(deviceId: string, channels: number): NativeAudioDeviceFormatProbe
  loadTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number,
    gain?: NativeAudioTrackGain
  ): NativeAudioPlaybackSnapshot
  preloadNextTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number,
    gain?: NativeAudioTrackGain
  ): void
  promoteNextTrack(): NativeAudioPlaybackSnapshot
  play(): Promise<NativeAudioPlaybackSnapshot>
  pause(): NativeAudioPlaybackSnapshot
  stop(): NativeAudioPlaybackSnapshot
  seek(seconds: number): NativeAudioPlaybackSnapshot
  clearNextTrack(): void
  getPlaybackSnapshot(): NativeAudioPlaybackSnapshot
  setVisualizerTapDemand(demand: NativeAudioVisualizerTapDemand): void
  drainEvents(): NativeAudioEvent[]
  flushOscilloscopeSamples(): Float32Array | null
  flushSpectrumSamples(): Float32Array | null
  flushVectorscopeSamples(): { left: Float32Array; right: Float32Array } | null
  flushVUMeterSamples(): NativeAudioVUMeterChunk | null
}

export interface NativeAudioAddonModule {
  playback?: NativeAudioAddonPlayback
}

interface NativeAudioControllerApi {
  initialize: () => Promise<NativeAudioCapabilities>
  getCapabilities: () => Promise<NativeAudioCapabilities>
  setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
  configureNativeOutput: (request: NativeAudioOutputRequest) => Promise<NativeAudioCapabilities>
  setNativeDspConfig: (config: NativeAudioDspConfig) => Promise<NativeAudioPlaybackSnapshot>
  setNativeTrackGain: (gain: NativeAudioTrackGain) => Promise<NativeAudioPlaybackSnapshot>
  probeDeviceFormats: (deviceId?: string, channels?: number) => Promise<NativeAudioDeviceFormatProbe>
  loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata, gain?: NativeAudioTrackGain) => Promise<NativeAudioTrackLoadResult>
  preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata, gain?: NativeAudioTrackGain) => Promise<NativeAudioTrackLoadResult>
  promoteNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
  cancelPendingDecode: () => Promise<void>
  play: () => Promise<NativeAudioPlaybackSnapshot>
  pause: () => Promise<NativeAudioPlaybackSnapshot>
  stop: () => Promise<NativeAudioPlaybackSnapshot>
  seek: (seconds: number) => Promise<NativeAudioPlaybackSnapshot>
  clearNextTrack: () => Promise<void>
  getPlaybackSnapshot: () => Promise<NativeAudioPlaybackSnapshot>
  getNativeAudioDiagnosticReport: () => Promise<NativeAudioDiagnosticReport>
  getBufferMemoryStats: () => Promise<AudioBufferMemoryStats>
  setVisualizerTapDemand: (demand: NativeAudioVisualizerTapDemand) => Promise<void>
  flushOscilloscopeChunks: () => Float32Array[]
  flushSpectrumChunks: () => Float32Array[]
  flushVectorscopeChunks: () => NativeAudioVectorscopeChunk[]
  flushVUMeterChunks: () => NativeAudioVUMeterChunk[]
  onEvent: (callback: (event: NativeAudioEvent) => void) => () => void
}

export type NativeAudioBinaryResolver = (binary: 'ffmpeg' | 'ffprobe') => Promise<string | null>

export interface NativeAudioControllerOptions {
  unavailableReason?: string | null
  eventPolling?: boolean
  resolveBinary?: NativeAudioBinaryResolver
  runProbe?: (file: string, args: string[], signal: AbortSignal) => Promise<string>
  runDecode?: (file: string, args: string[], signal: AbortSignal) => Promise<Buffer>
}

class SupersededNativeAudioLoadError extends Error {
  constructor(message = 'Native audio load was superseded by a newer request.') {
    super(message)
    this.name = 'SupersededNativeAudioLoadError'
  }
}

interface DecodedPcmTrack {
  filePath: string
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
  pcmData: Buffer
  sourceMetadata: NativeAudioTrackMetadata
  timings: {
    binaryResolutionMs: number
    probeMs: number
    decodeMs: number
  }
}

interface DecodeFileOptions {
  backendKind?: NativeAudioBackendKind
  signal: AbortSignal
}

interface LoadedTrackRequest {
  filePath: string
  metadata?: NativeAudioTrackMetadata
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
  timings?: DecodedPcmTrack['timings']
  gain: NativeAudioTrackGain
}

interface FfprobeStreamInfo {
  codec_name?: string
  codec_type?: string
  sample_rate?: string
  channels?: number
  duration?: string
  sample_fmt?: string
  bits_per_raw_sample?: string
}

const LOSSY_CODECS = new Set([
  'aac',
  'mp3',
  'vorbis',
  'opus',
  'wma',
  'wmav2',
  'wmavoice',
  'ac3',
  'eac3',
  'dts',
  'atrac3',
  'atrac3p',
  'cook'
])

const DEFAULT_UNAVAILABLE_CAPABILITIES: NativeAudioCapabilities = {
  processedExclusiveAvailable: false,
  reasonProcessedExclusiveUnavailable: 'Native processed exclusive playback is unavailable in this build.',
  bitPerfectAvailable: false,
  reasonUnavailable: 'Native bit-perfect playback is unavailable in this build.',
  activeBackend: 'unavailable',
  selectedDeviceId: null,
  selectedDeviceMaxChannels: null,
  devices: []
}

const EMPTY_PROCESSING_STATUS: NativeAudioProcessingStatus = {
  outputPolicy: 'direct',
  exclusiveActive: false,
  processingActive: false,
  resamplingActive: false,
  resamplerName: null,
  resamplerQuality: null,
  sourceSampleRate: null,
  targetSampleRate: null,
  requestedSampleRate: null,
  rateSelectionMode: 'auto',
  rateSelectionReason: null,
  processingLatencyFrames: 0,
  gainMode: 'off',
  trackGainDb: 0,
  preampDb: 0,
  volume: 1,
  muted: false,
  eqEnabled: false,
  eqBandCount: 0,
  limiterEnabled: false,
  limiterGainReductionDb: 0,
  dither: null,
  clippedSamples: 0
}

const EMPTY_PCM_FORMAT: NativePcmFormat = {
  sampleRate: null,
  channels: null,
  sampleFormat: null,
  containerBits: null,
  validBits: null,
  channelMask: 0,
  channelLayout: null,
  representation: null
}

const EMPTY_OUTPUT_STATUS: NativeAudioOutputStatus = {
  outputOpen: false,
  deviceResolved: false,
  formatNegotiated: false,
  streamInitialized: false,
  streamStarted: false,
  streamRunning: false,
  exclusiveRequested: true,
  exclusiveAcquired: false,
  systemMixerBypassed: false,
  sourceSamplesModified: false,
  wireFormatCanCarrySourceExactly: false,
  bitPerfectActive: false,
  outputPolicy: 'direct',
  exclusiveActive: false,
  processingActive: false,
  resamplingActive: false,
  processing: EMPTY_PROCESSING_STATUS,
  sourceFormat: EMPTY_PCM_FORMAT,
  processingFormat: EMPTY_PCM_FORMAT,
  wireFormat: EMPTY_PCM_FORMAT,
  backend: 'unavailable',
  deviceId: null,
  deviceLabel: null,
  transport: null,
  requestedPeriodMs: 0,
  actualPeriodMs: 0,
  requestedPeriodFrames: 0,
  actualPeriodFrames: 0,
  bufferFrames: 0,
  failureStage: null,
  osErrorSymbol: null,
  osErrorCode: 0,
  failureSummary: null,
  attempts: []
}

const EMPTY_AUDIO_BUFFER_MEMORY_STATS: AudioBufferMemoryStats = {
  currentBytes: 0,
  nextBytes: 0,
  totalBytes: 0
}

const EMPTY_PCM_BUFFER = Buffer.alloc(0)

function releaseDecodedPcmBuffer(decoded: DecodedPcmTrack): void {
  // Native copies PCM synchronously; keep metadata/byte counts without pinning external memory.
  decoded.pcmData = EMPTY_PCM_BUFFER
}

function looksLikePath(candidate: string): boolean {
  return candidate.includes('/') || candidate.includes('\\') || /^[a-zA-Z]:[\\/]/.test(candidate)
}

function toAsarUnpackedPath(candidate: string): string {
  if (!candidate.includes('app.asar')) return candidate
  return candidate.replace('app.asar', 'app.asar.unpacked')
}

function normalizeBackendKind(value: unknown): NativeAudioBackendKind {
  if (value === 'coreaudio' || value === 'wasapi-exclusive' || value === 'alsa-hw') return value
  return 'unavailable'
}

function normalizeSampleFormat(value: unknown): NativeAudioSampleFormat | null {
  if (value === 's16' || value === 's24' || value === 's32' || value === 'f32') return value
  return null
}

function normalizeProbedSampleFormat(value: unknown): NativeAudioProbedSampleFormat | null {
  if (value === 's24in32') return value
  return normalizeSampleFormat(value)
}

function normalizeNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeNonNegativeNumber(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0
}

function normalizePcmFormat(value: unknown): NativePcmFormat {
  if (!value || typeof value !== 'object') return { ...EMPTY_PCM_FORMAT }
  const raw = value as Partial<NativePcmFormat>
  return {
    sampleRate: Number.isFinite(raw.sampleRate) && Number(raw.sampleRate) > 0 ? Math.round(Number(raw.sampleRate)) : null,
    channels: Number.isFinite(raw.channels) && Number(raw.channels) > 0 ? Math.round(Number(raw.channels)) : null,
    sampleFormat: raw.sampleFormat === 'f64' ? 'f64' : normalizeProbedSampleFormat(raw.sampleFormat),
    containerBits: Number.isFinite(raw.containerBits) && Number(raw.containerBits) > 0 ? Math.round(Number(raw.containerBits)) : null,
    validBits: Number.isFinite(raw.validBits) && Number(raw.validBits) > 0 ? Math.round(Number(raw.validBits)) : null,
    channelMask: normalizeNonNegativeNumber(raw.channelMask),
    channelLayout: normalizeNullableText(raw.channelLayout),
    representation: normalizeNullableText(raw.representation)
  }
}

function normalizeOutputAttempt(value: unknown): NativeAudioOutputAttempt | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<NativeAudioOutputAttempt>
  return {
    index: Math.max(0, Math.round(normalizeNonNegativeNumber(raw.index))),
    backend: normalizeBackendKind(raw.backend),
    deviceId: normalizeNullableText(raw.deviceId),
    deviceLabel: normalizeNullableText(raw.deviceLabel),
    sourceFormat: normalizePcmFormat(raw.sourceFormat),
    processingFormat: normalizePcmFormat(raw.processingFormat),
    wireFormat: normalizePcmFormat(raw.wireFormat),
    transport: normalizeNullableText(raw.transport),
    probeResult: normalizeNullableText(raw.probeResult),
    requestedPeriodMs: normalizeNonNegativeNumber(raw.requestedPeriodMs),
    alignedPeriodMs: normalizeNonNegativeNumber(raw.alignedPeriodMs),
    actualPeriodMs: normalizeNonNegativeNumber(raw.actualPeriodMs),
    bufferFrames: Math.round(normalizeNonNegativeNumber(raw.bufferFrames)),
    deviceResolved: Boolean(raw.deviceResolved),
    formatNegotiated: Boolean(raw.formatNegotiated),
    streamInitialized: Boolean(raw.streamInitialized),
    bufferPrimed: Boolean(raw.bufferPrimed),
    streamStarted: Boolean(raw.streamStarted),
    finalVerified: Boolean(raw.finalVerified),
    outputPolicy: raw.outputPolicy === 'processed' ? 'processed' : 'direct',
    exclusiveActive: Boolean(raw.exclusiveActive),
    processingActive: Boolean(raw.processingActive),
    resamplingActive: Boolean(raw.resamplingActive),
    requestedSampleRate: Math.round(normalizeNonNegativeNumber(raw.requestedSampleRate)),
    targetSampleRate: Math.round(normalizeNonNegativeNumber(raw.targetSampleRate)),
    rateSelectionReason: normalizeNullableText(raw.rateSelectionReason),
    failureStage: normalizeNullableText(raw.failureStage),
    osErrorSymbol: normalizeNullableText(raw.osErrorSymbol),
    osErrorCode: Number.isFinite(raw.osErrorCode) ? Number(raw.osErrorCode) : 0,
    message: normalizeNullableText(raw.message)
  }
}

function normalizeProcessingStatus(value: unknown): NativeAudioProcessingStatus {
  if (!value || typeof value !== 'object') return { ...EMPTY_PROCESSING_STATUS }
  const raw = value as Partial<NativeAudioProcessingStatus>
  return {
    outputPolicy: raw.outputPolicy === 'processed' ? 'processed' : 'direct',
    exclusiveActive: Boolean(raw.exclusiveActive),
    processingActive: Boolean(raw.processingActive),
    resamplingActive: Boolean(raw.resamplingActive),
    resamplerName: normalizeNullableText(raw.resamplerName),
    resamplerQuality: normalizeNullableText(raw.resamplerQuality),
    sourceSampleRate: Number.isFinite(raw.sourceSampleRate) && Number(raw.sourceSampleRate) > 0 ? Math.round(Number(raw.sourceSampleRate)) : null,
    targetSampleRate: Number.isFinite(raw.targetSampleRate) && Number(raw.targetSampleRate) > 0 ? Math.round(Number(raw.targetSampleRate)) : null,
    requestedSampleRate: Number.isFinite(raw.requestedSampleRate) && Number(raw.requestedSampleRate) > 0 ? Math.round(Number(raw.requestedSampleRate)) : null,
    rateSelectionMode: raw.rateSelectionMode === 'fixed' ? 'fixed' : 'auto',
    rateSelectionReason: normalizeNullableText(raw.rateSelectionReason),
    processingLatencyFrames: Math.round(normalizeNonNegativeNumber(raw.processingLatencyFrames)),
    gainMode: raw.gainMode === 'normalization' || raw.gainMode === 'replaygain' ? raw.gainMode : 'off',
    trackGainDb: Number.isFinite(raw.trackGainDb) ? Number(raw.trackGainDb) : 0,
    preampDb: Number.isFinite(raw.preampDb) ? Number(raw.preampDb) : 0,
    volume: Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, Number(raw.volume))) : 1,
    muted: Boolean(raw.muted),
    eqEnabled: Boolean(raw.eqEnabled),
    eqBandCount: Math.round(normalizeNonNegativeNumber(raw.eqBandCount)),
    limiterEnabled: Boolean(raw.limiterEnabled),
    limiterGainReductionDb: normalizeNonNegativeNumber(raw.limiterGainReductionDb),
    dither: normalizeNullableText(raw.dither),
    clippedSamples: Math.round(normalizeNonNegativeNumber(raw.clippedSamples))
  }
}

export function normalizeNativeAudioOutputStatus(value: unknown): NativeAudioOutputStatus {
  if (!value || typeof value !== 'object') {
    return {
      ...EMPTY_OUTPUT_STATUS,
      sourceFormat: { ...EMPTY_PCM_FORMAT },
      processingFormat: { ...EMPTY_PCM_FORMAT },
      wireFormat: { ...EMPTY_PCM_FORMAT },
      processing: { ...EMPTY_PROCESSING_STATUS },
      attempts: []
    }
  }
  const raw = value as Partial<NativeAudioOutputStatus>
  const streamRunning = Boolean(raw.streamRunning)
  const exclusiveAcquired = Boolean(raw.exclusiveAcquired)
  const systemMixerBypassed = Boolean(raw.systemMixerBypassed)
  const sourceSamplesModified = Boolean(raw.sourceSamplesModified)
  const wireFormatCanCarrySourceExactly = Boolean(raw.wireFormatCanCarrySourceExactly)
  const processing = normalizeProcessingStatus(raw.processing)
  const exclusiveActive = streamRunning && exclusiveAcquired && systemMixerBypassed
  return {
    outputOpen: Boolean(raw.outputOpen),
    deviceResolved: Boolean(raw.deviceResolved),
    formatNegotiated: Boolean(raw.formatNegotiated),
    streamInitialized: Boolean(raw.streamInitialized),
    streamStarted: Boolean(raw.streamStarted),
    streamRunning,
    exclusiveRequested: raw.exclusiveRequested !== false,
    exclusiveAcquired,
    systemMixerBypassed,
    sourceSamplesModified,
    wireFormatCanCarrySourceExactly,
    bitPerfectActive: streamRunning
      && exclusiveAcquired
      && systemMixerBypassed
      && !sourceSamplesModified
      && wireFormatCanCarrySourceExactly,
    outputPolicy: processing.outputPolicy,
    exclusiveActive,
    processingActive: processing.processingActive,
    resamplingActive: processing.resamplingActive,
    processing: {
      ...processing,
      exclusiveActive
    },
    sourceFormat: normalizePcmFormat(raw.sourceFormat),
    processingFormat: normalizePcmFormat(raw.processingFormat),
    wireFormat: normalizePcmFormat(raw.wireFormat),
    backend: normalizeBackendKind(raw.backend),
    deviceId: normalizeNullableText(raw.deviceId),
    deviceLabel: normalizeNullableText(raw.deviceLabel),
    transport: normalizeNullableText(raw.transport),
    requestedPeriodMs: normalizeNonNegativeNumber(raw.requestedPeriodMs),
    actualPeriodMs: normalizeNonNegativeNumber(raw.actualPeriodMs),
    requestedPeriodFrames: Math.round(normalizeNonNegativeNumber(raw.requestedPeriodFrames)),
    actualPeriodFrames: Math.round(normalizeNonNegativeNumber(raw.actualPeriodFrames)),
    bufferFrames: Math.round(normalizeNonNegativeNumber(raw.bufferFrames)),
    failureStage: normalizeNullableText(raw.failureStage),
    osErrorSymbol: normalizeNullableText(raw.osErrorSymbol),
    osErrorCode: Number.isFinite(raw.osErrorCode) ? Number(raw.osErrorCode) : 0,
    failureSummary: normalizeNullableText(raw.failureSummary),
    attempts: Array.isArray(raw.attempts)
      ? raw.attempts.flatMap((attempt) => {
          const normalized = normalizeOutputAttempt(attempt)
          return normalized ? [normalized] : []
        })
      : []
  }
}

function normalizeOutputDevices(value: unknown): NativeAudioOutputDevice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Partial<NativeAudioOutputDevice>
    if (typeof raw.deviceId !== 'string' || raw.deviceId.trim().length === 0) return []
    const label = typeof raw.label === 'string' && raw.label.trim().length > 0
      ? raw.label.trim()
      : raw.deviceId
    return [{
      deviceId: raw.deviceId.trim(),
      label,
      maxChannels: Number.isFinite(raw.maxChannels) ? Math.max(1, Math.round(Number(raw.maxChannels))) : 2,
      isDefault: Boolean(raw.isDefault)
    }]
  })
}

function normalizeCapabilities(value: unknown): NativeAudioCapabilities {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_UNAVAILABLE_CAPABILITIES }
  }

  const raw = value as Partial<NativeAudioCapabilities>
  return {
    processedExclusiveAvailable: Boolean(raw.processedExclusiveAvailable),
    reasonProcessedExclusiveUnavailable: typeof raw.reasonProcessedExclusiveUnavailable === 'string' && raw.reasonProcessedExclusiveUnavailable.trim().length > 0
      ? raw.reasonProcessedExclusiveUnavailable.trim()
      : null,
    bitPerfectAvailable: Boolean(raw.bitPerfectAvailable),
    reasonUnavailable: typeof raw.reasonUnavailable === 'string' && raw.reasonUnavailable.trim().length > 0
      ? raw.reasonUnavailable.trim()
      : null,
    activeBackend: normalizeBackendKind(raw.activeBackend),
    selectedDeviceId: typeof raw.selectedDeviceId === 'string' && raw.selectedDeviceId.trim().length > 0
      ? raw.selectedDeviceId.trim()
      : null,
    selectedDeviceMaxChannels: Number.isFinite(raw.selectedDeviceMaxChannels)
      ? Math.max(1, Math.round(Number(raw.selectedDeviceMaxChannels)))
      : null,
    devices: normalizeOutputDevices(raw.devices)
  }
}

function normalizePlaybackSnapshot(value: unknown): NativeAudioPlaybackSnapshot {
  if (!value || typeof value !== 'object') {
    return {
      playbackState: 'stopped',
      currentTime: 0,
      duration: 0,
      sampleRate: null,
      channels: null,
      sampleFormat: null,
      deviceId: null,
      deviceLabel: null,
      outputStatus: normalizeNativeAudioOutputStatus(null)
    }
  }

  const raw = value as Partial<NativeAudioPlaybackSnapshot>
  const playbackState = raw.playbackState === 'starting' || raw.playbackState === 'playing' || raw.playbackState === 'paused' || raw.playbackState === 'loading'
    ? raw.playbackState
    : 'stopped'

  return {
    playbackState,
    currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, Number(raw.currentTime)) : 0,
    duration: Number.isFinite(raw.duration) ? Math.max(0, Number(raw.duration)) : 0,
    sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null,
    channels: Number.isFinite(raw.channels) ? Math.max(1, Math.round(Number(raw.channels))) : null,
    sampleFormat: normalizeSampleFormat(raw.sampleFormat),
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.trim().length > 0 ? raw.deviceId.trim() : null,
    deviceLabel: typeof raw.deviceLabel === 'string' && raw.deviceLabel.trim().length > 0 ? raw.deviceLabel.trim() : null,
    outputStatus: normalizeNativeAudioOutputStatus(raw.outputStatus)
  }
}

function normalizeEvent(value: unknown): NativeAudioEvent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<NativeAudioEvent> & { message?: unknown }
  switch (raw.type) {
    case 'stateChange':
      return {
        type: 'stateChange',
        playbackSequence: 0,
        playbackState: raw.playbackState === 'starting' || raw.playbackState === 'playing' || raw.playbackState === 'paused' || raw.playbackState === 'loading'
          ? raw.playbackState
          : 'stopped'
      }
    case 'timeUpdate':
      return {
        type: 'timeUpdate',
        playbackSequence: 0,
        currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, Number(raw.currentTime)) : 0
      }
    case 'durationChange':
      return {
        type: 'durationChange',
        playbackSequence: 0,
        duration: Number.isFinite(raw.duration) ? Math.max(0, Number(raw.duration)) : 0
      }
    case 'ended':
      return { type: 'ended', playbackSequence: 0 }
    case 'gaplessTransition':
      return { type: 'gaplessTransition', playbackSequence: 0 }
    case 'deviceReopened':
      return {
        type: 'deviceReopened',
        sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null,
        sampleFormat: normalizeSampleFormat(raw.sampleFormat),
        deviceId: typeof raw.deviceId === 'string' && raw.deviceId.trim().length > 0 ? raw.deviceId.trim() : null
      }
    case 'sampleRateChanged':
      return {
        type: 'sampleRateChanged',
        sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null
      }
    case 'error':
      return {
        type: 'error',
        message: typeof raw.message === 'string' && raw.message.trim().length > 0
          ? raw.message.trim()
          : 'Unknown native audio error.'
      }
    case 'outputStatusChanged':
      return {
        type: 'outputStatusChanged',
        ...(typeof raw.message === 'string' && raw.message.trim().length > 0 ? { message: raw.message.trim() } : {})
      }
    default:
      return null
  }
}

function normalizeTrackLoadResult(
  snapshot: NativeAudioPlaybackSnapshot,
  decoded: DecodedPcmTrack,
  nativeLoadMs: number,
  playbackSequence: number
): NativeAudioTrackLoadResult {
  return {
    playbackSequence,
    sampleRate: snapshot.sampleRate ?? decoded.sampleRate,
    channels: snapshot.channels ?? decoded.channels,
    sampleFormat: snapshot.sampleFormat ?? decoded.sampleFormat,
    duration: snapshot.duration > 0 ? snapshot.duration : decoded.duration,
    timings: {
      ...decoded.timings,
      nativeLoadMs
    }
  }
}

function normalizePromotedTrackLoadResult(
  snapshot: NativeAudioPlaybackSnapshot,
  fallback: LoadedTrackRequest | null,
  nativeLoadMs: number,
  playbackSequence: number
): NativeAudioTrackLoadResult {
  return {
    playbackSequence,
    sampleRate: snapshot.sampleRate ?? fallback?.sampleRate ?? fallback?.metadata?.sampleRate ?? 0,
    channels: snapshot.channels ?? fallback?.channels ?? fallback?.metadata?.channels ?? 2,
    sampleFormat: snapshot.sampleFormat ?? fallback?.sampleFormat ?? 'f32',
    duration: snapshot.duration > 0 ? snapshot.duration : fallback?.duration ?? 0,
    timings: {
      binaryResolutionMs: fallback?.timings?.binaryResolutionMs ?? 0,
      probeMs: fallback?.timings?.probeMs ?? 0,
      decodeMs: fallback?.timings?.decodeMs ?? 0,
      nativeLoadMs
    }
  }
}

function throwIfDecodeAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SupersededNativeAudioLoadError()
  }
}

function createExecFilePromise(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SupersededNativeAudioLoadError())
      return
    }

    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message
        finish(() => reject(signal?.aborted
          ? new SupersededNativeAudioLoadError()
          : new Error(message)))
        return
      }
      finish(() => resolve(stdout))
    })
    const onAbort = () => {
      child.kill()
      finish(() => reject(new SupersededNativeAudioLoadError()))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function spawnDecodePromise(file: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SupersededNativeAudioLoadError())
      return
    }

    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new SupersededNativeAudioLoadError()))
    }

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk))
    })
    child.on('error', (error) => finish(() => reject(
      signal.aborted ? new SupersededNativeAudioLoadError() : error
    )))
    child.on('close', (code) => finish(() => {
      if (signal.aborted) {
        reject(new SupersededNativeAudioLoadError())
        return
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `ffmpeg exited with code ${code}`))
        return
      }
      resolve(Buffer.concat(chunks))
    }))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function resolveStaticBinary(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  try {
    if (binary === 'ffmpeg') {
      const mod = await import('ffmpeg-static')
      return typeof mod.default === 'string' ? mod.default : null
    }
    const mod = await import('ffprobe-static') as { path?: string; default?: { path?: string } }
    const modulePath = mod.path ?? mod.default?.path
    return typeof modulePath === 'string' ? modulePath : null
  } catch {
    return null
  }
}

async function resolveBinaryUncached(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  const isWindows = process.platform === 'win32'
  const executable = `${binary}${isWindows ? '.exe' : ''}`
  const staticModulePath = await resolveStaticBinary(binary)
  const packagedStaticCandidates = process.env.NODE_ENV === 'development'
    ? []
    : (
        binary === 'ffmpeg'
          ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable)]
          : [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, executable)]
      )
  const candidates = [
    ...(process.env.NODE_ENV === 'development' ? [] : [
      join(process.resourcesPath, executable),
      join(process.resourcesPath, 'bin', executable)
    ]),
    ...packagedStaticCandidates,
    ...(staticModulePath ? [staticModulePath] : []),
    ...(binary === 'ffmpeg'
      ? (isWindows ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
      : (isWindows ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']))
  ]

  for (const rawCandidate of candidates) {
    const candidate = toAsarUnpackedPath(rawCandidate)
    if (looksLikePath(candidate)) {
      try {
        await access(candidate)
      } catch {
        continue
      }
    }
    try {
      await createExecFilePromise(candidate, ['-version'])
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  return null
}

export function createCachedNativeAudioBinaryResolver(
  resolveUncached: NativeAudioBinaryResolver
): NativeAudioBinaryResolver {
  const resolutions = new Map<'ffmpeg' | 'ffprobe', Promise<string | null>>()
  return (binary) => {
    let resolution = resolutions.get(binary)
    if (!resolution) {
      resolution = resolveUncached(binary)
      resolutions.set(binary, resolution)
    }
    return resolution
  }
}

// Binary discovery can involve several filesystem probes and process launches. Cache both
// successful and unavailable results for the preload process lifetime.
const resolveBinary = createCachedNativeAudioBinaryResolver(resolveBinaryUncached)

function parseSampleRate(value: string | number | undefined): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.round(numeric)
}

function resolveSampleFormat(
  stream: FfprobeStreamInfo,
  metadata?: NativeAudioTrackMetadata,
  backendKind: NativeAudioBackendKind = 'unavailable'
): NativeAudioSampleFormat {
  const codec = (stream.codec_name ?? metadata?.codec ?? '').trim().toLowerCase()
  const sampleFormat = (stream.sample_fmt ?? '').trim().toLowerCase()
  const bitDepth = Number(stream.bits_per_raw_sample ?? metadata?.bitDepth ?? 0)

  // Many ALSA hw devices reject float PCM in direct mode, especially for common
  // 44.1 kHz lossy material. Keep the exact sample rate, but prefer integer PCM
  // for Linux hardware output when the source does not provide integer samples.
  if (backendKind === 'alsa-hw') {
    if (sampleFormat.startsWith('u8') || sampleFormat.startsWith('s8') || sampleFormat.startsWith('s16')) {
      return 's16'
    }

    if (sampleFormat.startsWith('s24')) {
      return 's24'
    }

    if (sampleFormat.startsWith('s32') || sampleFormat.startsWith('s64')) {
      return Number.isFinite(bitDepth) && bitDepth > 0 && bitDepth <= 24 ? 's24' : 's32'
    }

    if (Number.isFinite(bitDepth) && bitDepth > 0) {
      if (bitDepth <= 16) return 's16'
      return bitDepth <= 24 ? 's24' : 's32'
    }

    if (LOSSY_CODECS.has(codec)) {
      return 'f32'
    }

    if (sampleFormat.startsWith('flt') || sampleFormat.startsWith('dbl')) {
      return 'f32'
    }
  }

  // WASAPI exclusive endpoints on pro interfaces almost universally reject IEEE float, and
  // many accept only packed 24-bit. Stay in integer PCM and match the source depth exactly;
  // the sink's negotiation ladder widens from here if the device wants a bigger container.
  if (backendKind === 'wasapi-exclusive') {
    if (sampleFormat.startsWith('u8') || sampleFormat.startsWith('s8') || sampleFormat.startsWith('s16')) {
      return 's16'
    }

    if (sampleFormat.startsWith('s24')) {
      return 's24'
    }

    if (sampleFormat.startsWith('s32') || sampleFormat.startsWith('s64')) {
      // ffprobe reports 24-bit FLAC/ALAC as s32 with bits_per_raw_sample of 24.
      return Number.isFinite(bitDepth) && bitDepth > 0 && bitDepth <= 24 ? 's24' : 's32'
    }

    if (Number.isFinite(bitDepth) && bitDepth > 0) {
      if (bitDepth <= 16) return 's16'
      return bitDepth <= 24 ? 's24' : 's32'
    }

    // Lossy and float sources have no original integer depth to preserve; 24-bit is the
    // widest container these devices reliably accept.
    return 's24'
  }

  if (LOSSY_CODECS.has(codec)) {
    return 'f32'
  }

  if (sampleFormat.startsWith('flt') || sampleFormat.startsWith('dbl')) {
    return 'f32'
  }

  if (sampleFormat.startsWith('u8') || sampleFormat.startsWith('s8') || sampleFormat.startsWith('s16')) {
    return 's16'
  }

  if (sampleFormat.startsWith('s24') || sampleFormat.startsWith('s32') || sampleFormat.startsWith('s64')) {
    return 's32'
  }

  if (Number.isFinite(bitDepth) && bitDepth > 16) {
    return 's32'
  }

  if (Number.isFinite(bitDepth) && bitDepth > 0 && bitDepth <= 16) {
    return 's16'
  }

  return 'f32'
}

function getFfmpegFormatArgs(sampleFormat: NativeAudioSampleFormat): string[] {
  switch (sampleFormat) {
    case 's16':
      return ['-c:a', 'pcm_s16le', '-f', 's16le']
    case 's24':
      // Packed 3-byte little-endian, exactly what WASAPI exclusive wants for 24-bit.
      return ['-c:a', 'pcm_s24le', '-f', 's24le']
    case 's32':
      return ['-c:a', 'pcm_s32le', '-f', 's32le']
    case 'f32':
      return ['-c:a', 'pcm_f32le', '-f', 'f32le']
  }
}

export function createNativeAudioController(
  nativeModule: NativeAudioAddonModule | null,
  options: NativeAudioControllerOptions = {}
): NativeAudioControllerApi {
  const playback = nativeModule?.playback ?? null
  const listeners = new Set<(event: NativeAudioEvent) => void>()
  let eventPollTimer: ReturnType<typeof setInterval> | null = null
  let currentTrackRequest: LoadedTrackRequest | null = null
  let nextTrackRequest: LoadedTrackRequest | null = null
  const deviceFormatProbeCache = new Map<string, NativeAudioDeviceFormatProbe>()
  let loadGeneration = 0
  let prebufferGeneration = 0
  let nextPlaybackSequence = 1
  let currentPlaybackSequence: number | null = null
  let bufferedPlaybackSequence: number | null = null
  let activeLoadDecode: { generation: number; controller: AbortController } | null = null
  let activePrebufferDecode: { generation: number; controller: AbortController } | null = null
  let currentBufferBytes = 0
  let nextBufferBytes = 0
  let lastDiagnosticReport: NativeAudioDiagnosticReport | null = null
  let outputRequestCache: NativeAudioOutputRequest = { policy: 'direct', requestedSampleRate: null }
  let dspConfigCache: NativeAudioDspConfig = {
    volume: 1,
    muted: false,
    eqEnabled: false,
    preampDb: 0,
    eqBands: [],
    limiterEnabled: true
  }
  let trackGainCache: NativeAudioTrackGain = { mode: 'off', gainDb: 0 }
  const fallbackUnavailableReason = options.unavailableReason?.trim() || DEFAULT_UNAVAILABLE_CAPABILITIES.reasonUnavailable
  let capabilitiesCache: NativeAudioCapabilities = {
    ...DEFAULT_UNAVAILABLE_CAPABILITIES,
    reasonUnavailable: fallbackUnavailableReason
  }
  const binaryResolver = options.resolveBinary ?? resolveBinary
  const runProbe = options.runProbe ?? ((file, args, signal) => createExecFilePromise(file, args, signal))
  const runDecode = options.runDecode ?? spawnDecodePromise

  const buildBufferMemoryStats = (): AudioBufferMemoryStats => ({
    currentBytes: currentBufferBytes,
    nextBytes: nextBufferBytes,
    totalBytes: currentBufferBytes + nextBufferBytes
  })

  const buildDiagnosticReport = (engine: NativeAudioAddonPlayback): NativeAudioDiagnosticReport => {
    const snapshot = normalizePlaybackSnapshot(engine.getPlaybackSnapshot())
    const track: NativeAudioTrackMetadata | null = currentTrackRequest
      ? {
          ...currentTrackRequest.metadata,
          path: currentTrackRequest.filePath,
          sampleRate: currentTrackRequest.sampleRate,
          channels: currentTrackRequest.channels
        }
      : null
    const sourceLines = track
      ? [
          '',
          'Track / FFprobe Metadata',
          `Path: ${track.path}`,
          `Codec: ${track.codec ?? 'unknown'}`,
          `Original bit depth: ${track.bitDepth ?? 'unknown'}`,
          `Decoded PCM: ${currentTrackRequest?.sampleRate ?? 'unknown'} Hz, ${currentTrackRequest?.channels ?? 'unknown'} ch, ${currentTrackRequest?.sampleFormat ?? 'unknown'}`
        ]
      : []
    const nativeText = engine.getNativeAudioDiagnosticReport?.().trim()
      || 'Astra Native Audio Diagnostic Report\nNative diagnostic text is unavailable in this addon build.'
    const processingLines = [
      '',
      'Processing Configuration',
      `Output request: ${JSON.stringify(outputRequestCache)}`,
      `DSP: ${JSON.stringify(dspConfigCache)}`,
      `Track gain: ${JSON.stringify(trackGainCache)}`
    ]
    return {
      generatedAt: new Date().toISOString(),
      text: [nativeText, ...processingLines, ...sourceLines].join('\n'),
      outputStatus: snapshot.outputStatus,
      track
    }
  }

  const beginLoadOperation = (): number => {
    activeLoadDecode?.controller.abort()
    activePrebufferDecode?.controller.abort()
    loadGeneration += 1
    prebufferGeneration += 1
    return loadGeneration
  }

  const invalidateLoadOperations = (): void => {
    activeLoadDecode?.controller.abort()
    activePrebufferDecode?.controller.abort()
    loadGeneration += 1
    prebufferGeneration += 1
  }

  const beginPrebufferOperation = (): number => {
    activePrebufferDecode?.controller.abort()
    prebufferGeneration += 1
    return prebufferGeneration
  }

  const invalidatePrebufferOperations = (): void => {
    activePrebufferDecode?.controller.abort()
    prebufferGeneration += 1
  }

  const assertCurrentLoadOperation = (generation: number): void => {
    if (generation !== loadGeneration) {
      throw new SupersededNativeAudioLoadError()
    }
  }

  const assertCurrentPrebufferOperation = (generation: number): void => {
    if (generation !== prebufferGeneration) {
      throw new SupersededNativeAudioLoadError('Native audio prebuffer was superseded by a newer request.')
    }
  }

  const applyGaplessTransitionBookkeeping = (): void => {
    currentBufferBytes = nextBufferBytes
    nextBufferBytes = 0
    currentTrackRequest = nextTrackRequest
    nextTrackRequest = null
  }

  const notify = (event: NativeAudioEvent) => {
    if (event.type === 'gaplessTransition') applyGaplessTransitionBookkeeping()

    if (event.type === 'outputStatusChanged' && playback) {
      lastDiagnosticReport = buildDiagnosticReport(playback)
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  const allocatePlaybackSequence = (): number => {
    const sequence = nextPlaybackSequence
    nextPlaybackSequence += 1
    return sequence
  }

  const stampPlaybackSequence = (event: NativeAudioEvent): NativeAudioEvent | null => {
    switch (event.type) {
      case 'gaplessTransition': {
        if (bufferedPlaybackSequence === null) return null
        currentPlaybackSequence = bufferedPlaybackSequence
        bufferedPlaybackSequence = null
        return { ...event, playbackSequence: currentPlaybackSequence }
      }
      case 'stateChange':
      case 'timeUpdate':
      case 'durationChange':
      case 'ended':
        return currentPlaybackSequence === null
          ? null
          : { ...event, playbackSequence: currentPlaybackSequence }
      default:
        return event
    }
  }

  const refreshCapabilities = (): NativeAudioCapabilities => {
    if (!playback) {
      capabilitiesCache = {
        ...DEFAULT_UNAVAILABLE_CAPABILITIES,
        reasonUnavailable: fallbackUnavailableReason
      }
      return capabilitiesCache
    }
    capabilitiesCache = normalizeCapabilities(playback.getCapabilities())
    return capabilitiesCache
  }

  const normalizeDeviceFormatProbe = (raw: NativeAudioDeviceFormatProbe): NativeAudioDeviceFormatProbe => ({
    deviceId: typeof raw?.deviceId === 'string' ? raw.deviceId : null,
    deviceLabel: typeof raw?.deviceLabel === 'string' ? raw.deviceLabel : null,
    supported: raw?.supported === true,
    reason: typeof raw?.reason === 'string' ? raw.reason : null,
    formats: Array.isArray(raw?.formats)
      ? raw.formats.filter(
          (entry): entry is NativeAudioDeviceFormat =>
            Number.isFinite(entry?.sampleRate) && typeof entry?.sampleFormat === 'string'
        )
      : []
  })

  const getDeviceFormatProbe = (deviceId: string, channels: number): NativeAudioDeviceFormatProbe | null => {
    if (!playback?.probeDeviceFormats) return null

    const cacheKey = `${deviceId}|${channels}`
    const cached = deviceFormatProbeCache.get(cacheKey)
    if (cached) return cached

    try {
      const probe = normalizeDeviceFormatProbe(playback.probeDeviceFormats(deviceId, channels))
      deviceFormatProbeCache.set(cacheKey, probe)
      return probe
    } catch {
      // Probing is an optimization; a failure just means we try the format and find out.
      return null
    }
  }

  const invalidateDeviceFormatProbes = (): void => {
    deviceFormatProbeCache.clear()
  }

  const isPlaybackLifecycleEvent = (event: NativeAudioEvent): boolean => (
    event.type === 'stateChange'
    || event.type === 'timeUpdate'
    || event.type === 'durationChange'
    || event.type === 'gaplessTransition'
    || event.type === 'ended'
  )

  const asNativeOutputFailure = (
    engine: NativeAudioAddonPlayback,
    error: unknown,
    request: LoadedTrackRequest | null
  ): Error => {
    const message = error instanceof Error ? error.message : 'Native exclusive output failed.'
    invalidateDeviceFormatProbes()
    lastDiagnosticReport = buildDiagnosticReport(engine)
    const status = lastDiagnosticReport.outputStatus
    const osCode = status.osErrorSymbol ?? (status.osErrorCode !== 0 ? status.osErrorCode : null)
    return createBitPerfectFormatError({
      deviceLabel: status.deviceLabel,
      sampleRate: request?.sampleRate ?? status.sourceFormat.sampleRate,
      channels: request?.channels ?? status.sourceFormat.channels,
      sampleFormat: request?.sampleFormat ?? status.sourceFormat.sampleFormat,
      message: status.failureSummary ?? message,
      failureStage: status.failureStage ?? 'start',
      osCode,
      report: lastDiagnosticReport.text
    })
  }

  const dispatchNativeEvents = (
    engine: NativeAudioAddonPlayback,
    rawEvents: readonly unknown[],
    suppressLifecycle = false
  ): void => {
    for (const rawEvent of rawEvents) {
      const normalizedEvent = normalizeEvent(rawEvent)
      if (!normalizedEvent) continue
      const event = stampPlaybackSequence(normalizedEvent)
      if (!event) continue
      if (suppressLifecycle && isPlaybackLifecycleEvent(event)) {
        if (event.type === 'gaplessTransition') applyGaplessTransitionBookkeeping()
        continue
      }
      if (event.type === 'error') {
        const failure = asNativeOutputFailure(engine, new Error(event.message), currentTrackRequest)
        notify({ type: 'error', message: failure.message })
      } else {
        notify(event)
      }
    }
  }

  const ensureEventPoller = (): void => {
    if (!playback || eventPollTimer !== null || options.eventPolling === false) return
    eventPollTimer = setInterval(() => {
      try {
        const drained = playback.drainEvents()
        dispatchNativeEvents(playback, drained)
      } catch (error) {
        notify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to poll native audio events.'
        })
      }
    }, 50)
  }

  const ensureAvailable = async (): Promise<NativeAudioAddonPlayback> => {
    const caps = refreshCapabilities()
    if (!playback || (!caps.bitPerfectAvailable && !caps.processedExclusiveAvailable)) {
      throw new Error(caps.reasonUnavailable ?? caps.reasonProcessedExclusiveUnavailable ?? 'Native exclusive playback is unavailable.')
    }
    ensureEventPoller()
    return playback
  }

  const decodeFileToPcm = async (
    filePath: string,
    metadata: NativeAudioTrackMetadata | undefined,
    options: DecodeFileOptions
  ): Promise<DecodedPcmTrack> => {
    const binaryResolutionStartedAt = performance.now()
    const [ffprobePath, ffmpegPath] = await Promise.all([
      binaryResolver('ffprobe'),
      binaryResolver('ffmpeg')
    ])
    const binaryResolutionMs = Math.round(performance.now() - binaryResolutionStartedAt)
    throwIfDecodeAborted(options.signal)
    if (!ffprobePath || !ffmpegPath) {
      throw new Error('FFmpeg/ffprobe could not be resolved for native playback.')
    }

    const probeStartedAt = performance.now()
    const ffprobeStdout = await runProbe(ffprobePath, [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      filePath
    ], options.signal)
    const probeMs = Math.round(performance.now() - probeStartedAt)
    throwIfDecodeAborted(options.signal)
    const ffprobePayload = JSON.parse(ffprobeStdout) as {
      streams?: FfprobeStreamInfo[]
    }
    const stream = ffprobePayload.streams?.find((entry) => entry.codec_type === 'audio') ?? ffprobePayload.streams?.[0]
    if (!stream) {
      throw new Error('No audio stream found for native playback.')
    }

    const sampleRate = parseSampleRate(stream.sample_rate) ?? metadata?.sampleRate
    if (!sampleRate || sampleRate <= 0) {
      throw new Error('Could not determine sample rate for native playback.')
    }
    const channels = Number.isFinite(stream.channels) ? Math.max(1, Math.round(Number(stream.channels))) : (metadata?.channels ?? 2)
    const duration = Number.isFinite(Number(stream.duration))
      ? Math.max(0, Number(stream.duration))
      : 0
    const backendKind = options.backendKind ?? capabilitiesCache.activeBackend
    // Processed output decodes the source into its natural PCM representation;
    // hardware wire constraints are handled only after planar-f64 processing.
    const sampleFormat = resolveSampleFormat(
      stream,
      metadata,
      outputRequestCache.policy === 'processed' ? 'unavailable' : backendKind
    )

    // Probes are advisory only. Native start attempts still run for probe-negative formats
    // because real drivers sometimes accept Initialize even after IsFormatSupported refused.
    if (backendKind === 'wasapi-exclusive') {
      getDeviceFormatProbe(capabilitiesCache.selectedDeviceId ?? '', channels)
    }

    const ffmpegArgs = [
      '-v', 'error',
      '-i', filePath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      ...getFfmpegFormatArgs(sampleFormat),
      'pipe:1'
    ]

    const decodeStartedAt = performance.now()
    const pcmData = await runDecode(ffmpegPath, ffmpegArgs, options.signal)
    const decodeMs = Math.round(performance.now() - decodeStartedAt)
    throwIfDecodeAborted(options.signal)

    return {
      filePath,
      sampleRate,
      channels,
      sampleFormat,
      duration,
      pcmData,
      sourceMetadata: {
        ...metadata,
        path: filePath,
        codec: stream.codec_name ?? metadata?.codec,
        sampleRate,
        channels,
        bitDepth: Number.isFinite(Number(stream.bits_per_raw_sample)) && Number(stream.bits_per_raw_sample) > 0
          ? Number(stream.bits_per_raw_sample)
          : metadata?.bitDepth,
        format: stream.sample_fmt ?? metadata?.format
      },
      timings: {
        binaryResolutionMs,
        probeMs,
        decodeMs
      }
    }
  }

  const loadDecodedTrack = (
    engine: NativeAudioAddonPlayback,
    decoded: DecodedPcmTrack,
    playbackSequence: number,
    gain: NativeAudioTrackGain = { mode: 'off', gainDb: 0 }
  ): NativeAudioTrackLoadResult => {
    const nativeLoadStartedAt = performance.now()
    const snapshot = normalizePlaybackSnapshot(engine.loadTrack(
      new Uint8Array(decoded.pcmData.buffer, decoded.pcmData.byteOffset, decoded.pcmData.byteLength),
      decoded.sampleRate,
      decoded.channels,
      decoded.sampleFormat,
      decoded.duration,
      gain
    ))
    return normalizeTrackLoadResult(
      snapshot,
      decoded,
      Math.round(performance.now() - nativeLoadStartedAt),
      playbackSequence
    )
  }

  return {
    initialize: async () => {
      const caps = refreshCapabilities()
      if (caps.bitPerfectAvailable || caps.processedExclusiveAvailable) {
        ensureEventPoller()
      }
      return caps
    },

    getCapabilities: async () => refreshCapabilities(),

    setOutputDevice: async (deviceId: string) => {
      const engine = await ensureAvailable()
      invalidateDeviceFormatProbes()
      capabilitiesCache = normalizeCapabilities(engine.setOutputDevice(deviceId))
      return capabilitiesCache
    },

    configureNativeOutput: async (request: NativeAudioOutputRequest) => {
      const engine = await ensureAvailable()
      outputRequestCache = {
        policy: request.policy === 'processed' ? 'processed' : 'direct',
        requestedSampleRate: Number.isFinite(request.requestedSampleRate) && Number(request.requestedSampleRate) > 0
          ? Math.round(Number(request.requestedSampleRate))
          : null
      }
      capabilitiesCache = normalizeCapabilities(engine.configureOutput(outputRequestCache))
      return capabilitiesCache
    },

    setNativeDspConfig: async (config: NativeAudioDspConfig) => {
      const engine = await ensureAvailable()
      dspConfigCache = {
        ...config,
        eqBands: config.eqBands.map((band) => ({ ...band }))
      }
      return normalizePlaybackSnapshot(engine.setDspConfig(dspConfigCache))
    },

    setNativeTrackGain: async (gain: NativeAudioTrackGain) => {
      const engine = await ensureAvailable()
      trackGainCache = { ...gain }
      return normalizePlaybackSnapshot(engine.setCurrentTrackGain(trackGainCache))
    },

    probeDeviceFormats: async (deviceId?: string, channels = 2) => {
      const caps = refreshCapabilities()
      const targetDeviceId = deviceId ?? caps.selectedDeviceId ?? ''
      return (
        getDeviceFormatProbe(targetDeviceId, channels) ?? {
          deviceId: targetDeviceId || null,
          deviceLabel: null,
          supported: false,
          reason: caps.reasonUnavailable ?? 'This audio backend cannot enumerate device formats.',
          formats: []
        }
      )
    },

    loadTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata, gain: NativeAudioTrackGain = { mode: 'off', gainDb: 0 }) => {
      const loadOperation = beginLoadOperation()
      currentPlaybackSequence = null
      bufferedPlaybackSequence = null
      const engine = await ensureAvailable()
      assertCurrentLoadOperation(loadOperation)
      const backendKind = capabilitiesCache.activeBackend
      const decodeController = new AbortController()
      activeLoadDecode = { generation: loadOperation, controller: decodeController }
      let decoded: DecodedPcmTrack
      try {
        decoded = await decodeFileToPcm(filePath, metadata, {
          backendKind,
          signal: decodeController.signal
        })
      } finally {
        if (activeLoadDecode?.generation === loadOperation) {
          activeLoadDecode = null
        }
      }
      const decodedByteLength = decoded.pcmData.byteLength
      try {
        assertCurrentLoadOperation(loadOperation)
        currentTrackRequest = {
          filePath,
          metadata: decoded.sourceMetadata,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sampleFormat: decoded.sampleFormat,
          duration: decoded.duration,
          timings: decoded.timings,
          gain
        }
        const playbackSequence = allocatePlaybackSequence()
        trackGainCache = { ...gain }
        const result = loadDecodedTrack(engine, decoded, playbackSequence, gain)
        currentPlaybackSequence = playbackSequence
        currentBufferBytes = decodedByteLength
        nextBufferBytes = 0
        nextTrackRequest = null
        return result
      } finally {
        releaseDecodedPcmBuffer(decoded)
      }
    },

    preloadNextTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata, gain: NativeAudioTrackGain = { mode: 'off', gainDb: 0 }) => {
      const prebufferOperation = beginPrebufferOperation()
      bufferedPlaybackSequence = null
      const engine = await ensureAvailable()
      assertCurrentPrebufferOperation(prebufferOperation)
      const decodeController = new AbortController()
      activePrebufferDecode = { generation: prebufferOperation, controller: decodeController }
      let decoded: DecodedPcmTrack
      try {
        decoded = await decodeFileToPcm(filePath, metadata, {
          backendKind: capabilitiesCache.activeBackend,
          signal: decodeController.signal
        })
      } finally {
        if (activePrebufferDecode?.generation === prebufferOperation) {
          activePrebufferDecode = null
        }
      }
      const decodedByteLength = decoded.pcmData.byteLength
      try {
        assertCurrentPrebufferOperation(prebufferOperation)
        const nativeLoadStartedAt = performance.now()
        const playbackSequence = allocatePlaybackSequence()
        engine.preloadNextTrack(
          new Uint8Array(decoded.pcmData.buffer, decoded.pcmData.byteOffset, decoded.pcmData.byteLength),
          decoded.sampleRate,
          decoded.channels,
          decoded.sampleFormat,
          decoded.duration,
          gain
        )
        bufferedPlaybackSequence = playbackSequence
        nextBufferBytes = decodedByteLength
        nextTrackRequest = {
          filePath,
          metadata: decoded.sourceMetadata,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sampleFormat: decoded.sampleFormat,
          duration: decoded.duration,
          timings: decoded.timings,
          gain
        }
        const snapshot = normalizePlaybackSnapshot(engine.getPlaybackSnapshot())
        return normalizeTrackLoadResult(
          snapshot,
          decoded,
          Math.round(performance.now() - nativeLoadStartedAt),
          playbackSequence
        )
      } finally {
        releaseDecodedPcmBuffer(decoded)
      }
    },

    promoteNextTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata) => {
      const loadOperation = beginLoadOperation()
      const engine = await ensureAvailable()
      assertCurrentLoadOperation(loadOperation)
      const promotedRequest = nextTrackRequest?.filePath === filePath
        ? nextTrackRequest
        : null
      const promotedPlaybackSequence = bufferedPlaybackSequence ?? allocatePlaybackSequence()
      const nativeLoadStartedAt = performance.now()
      const snapshot = normalizePlaybackSnapshot(engine.promoteNextTrack())
      currentTrackRequest = promotedRequest ?? (
        snapshot.sampleRate && snapshot.channels && snapshot.sampleFormat
          ? {
              filePath,
              metadata,
              sampleRate: snapshot.sampleRate,
              channels: snapshot.channels,
              sampleFormat: snapshot.sampleFormat,
              duration: snapshot.duration,
              gain: { mode: 'off', gainDb: 0 }
            }
          : null
      )
      trackGainCache = { ...(currentTrackRequest?.gain ?? { mode: 'off', gainDb: 0 }) }
      currentBufferBytes = nextBufferBytes
      nextBufferBytes = 0
      nextTrackRequest = null
      currentPlaybackSequence = promotedPlaybackSequence
      bufferedPlaybackSequence = null
      return normalizePromotedTrackLoadResult(
        snapshot,
        currentTrackRequest,
        Math.round(performance.now() - nativeLoadStartedAt),
        promotedPlaybackSequence
      )
    },

    cancelPendingDecode: async () => {
      // Cancellation is deliberately scoped to ffprobe/FFmpeg. Once decoded PCM has been
      // handed to the addon, native load/play (including an active device-start handshake)
      // is allowed to finish under the existing serialization policy.
      // Always advance both generations so a request still awaiting controller setup
      // cannot slip through and begin an obsolete decode after this call returns.
      loadGeneration += 1
      prebufferGeneration += 1
      activeLoadDecode?.controller.abort()
      activePrebufferDecode?.controller.abort()
    },

    play: async () => {
      const engine = await ensureAvailable()
      // Anything queued before this command belongs to the prior playback
      // epoch. Preserve diagnostics, but discard its lifecycle notifications
      // before assigning a fresh identity to the device-start handshake.
      dispatchNativeEvents(engine, engine.drainEvents(), true)
      const playbackSequence = allocatePlaybackSequence()
      currentPlaybackSequence = playbackSequence
      try {
        const snapshot = normalizePlaybackSnapshot(await engine.play())
        lastDiagnosticReport = buildDiagnosticReport(engine)
        return { ...snapshot, playbackSequence }
      } catch (error) {
        // Exclusive mode is fail-closed. The user explicitly chooses Standard mode from
        // the failure dialog; preload never re-decodes or falls back automatically.
        throw asNativeOutputFailure(engine, error, currentTrackRequest)
      }
    },

    pause: async () => {
      const engine = await ensureAvailable()
      return {
        ...normalizePlaybackSnapshot(engine.pause()),
        ...(currentPlaybackSequence === null ? {} : { playbackSequence: currentPlaybackSequence })
      }
    },

    stop: async () => {
      invalidateLoadOperations()
      const engine = await ensureAvailable()
      return {
        ...normalizePlaybackSnapshot(engine.stop()),
        ...(currentPlaybackSequence === null ? {} : { playbackSequence: currentPlaybackSequence })
      }
    },

    seek: async (seconds: number) => {
      const engine = await ensureAvailable()
      return {
        ...normalizePlaybackSnapshot(engine.seek(seconds)),
        ...(currentPlaybackSequence === null ? {} : { playbackSequence: currentPlaybackSequence })
      }
    },

    clearNextTrack: async () => {
      invalidatePrebufferOperations()
      bufferedPlaybackSequence = null
      const engine = await ensureAvailable()
      nextBufferBytes = 0
      nextTrackRequest = null
      engine.clearNextTrack()
    },

    getPlaybackSnapshot: async () => {
      const engine = await ensureAvailable()
      return {
        ...normalizePlaybackSnapshot(engine.getPlaybackSnapshot()),
        ...(currentPlaybackSequence === null ? {} : { playbackSequence: currentPlaybackSequence })
      }
    },

    getNativeAudioDiagnosticReport: async () => {
      if (playback) {
        lastDiagnosticReport = buildDiagnosticReport(playback)
      }
      return lastDiagnosticReport ?? {
        generatedAt: new Date().toISOString(),
        text: `Astra Native Audio Diagnostic Report\n${fallbackUnavailableReason}`,
        outputStatus: normalizeNativeAudioOutputStatus(null),
        track: null
      }
    },

    getBufferMemoryStats: async () => {
      if (!playback) return { ...EMPTY_AUDIO_BUFFER_MEMORY_STATS }
      return buildBufferMemoryStats()
    },

    setVisualizerTapDemand: async (demand: NativeAudioVisualizerTapDemand) => {
      const engine = await ensureAvailable()
      engine.setVisualizerTapDemand({
        oscilloscope: Boolean(demand.oscilloscope),
        spectrum: Boolean(demand.spectrum),
        vectorscope: Boolean(demand.vectorscope),
        vumeter: Boolean(demand.vumeter),
      })
    },

    flushOscilloscopeChunks: () => {
      if (!playback) return []
      const samples = playback.flushOscilloscopeSamples()
      return samples && samples.length > 0 ? [samples] : []
    },

    flushSpectrumChunks: () => {
      if (!playback) return []
      const samples = playback.flushSpectrumSamples()
      return samples && samples.length > 0 ? [samples] : []
    },

    flushVectorscopeChunks: () => {
      if (!playback) return []
      const samples = playback.flushVectorscopeSamples()
      return samples && samples.left.length > 0 && samples.right.length > 0 ? [samples] : []
    },

    flushVUMeterChunks: () => {
      if (!playback) return []
      const samples = playback.flushVUMeterSamples()
      return samples && samples.channels.some((channel) => channel.length > 0) ? [samples] : []
    },

    onEvent: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
