import type { PlaybackState, EQBand, Track } from '../types/audio'
import type { RemoteStreamChunk, RemoteStreamEvent, RemoteStreamInfo } from '../../types/remoteStream'
import type {
  ParallaxAudioChunk,
  ParallaxNormalizationMode,
  ParallaxOutputLatencyMetrics,
  ParallaxStreamInfo,
  ParallaxTimelineState
} from '../../types/parallax'
import {
  PARALLAX_AUDIO_CHUNK_FRAMES,
  clampParallaxPlaybackRatePpm,
  mapHostTimeToSinkTimeMs,
  resolveParallaxStreamNormalization
} from '../../types/parallax'
import type {
  AudioBufferMemoryStats,
  NativeAudioCapabilities,
  NativeAudioEvent,
  NativeAudioPlaybackSnapshot,
  NativeAudioTrackMetadata,
  NativeAudioTrackLoadResult,
  NativeAudioVisualizerTapDemand,
  PlaybackOutputMode
} from '../../types/nativeAudio'
import type { MultichannelAudioChunk } from '../../types/audioAnalysis'
import type { ScopeKind } from '../../types/scopePopout'
import { SCOPE_KINDS } from '../../types/scopePopout'
import { ProgressiveWaveformAccumulator } from './waveformExtractor'
import { detectIamfContainer, type IamfContainerKind } from '../../shared/iamf/detect'
import {
  IamfDecodeCancelledError,
  IamfDecoderClient,
  type IamfDecodeHandle,
} from './iamfDecoder'
import {
  ProgressiveKWeightedLoudnessAnalyzer,
  analyzeAudioBufferLoudness,
  dbToLinear,
  resolveStaticNormalizationGain,
  type LoudnessAnalysis
} from './loudness'
import {
  canUseStereoAmbientUpmix,
  isIdentityChannelMixMatrix,
  normalizeStereoUpmixMode,
  resolveChannelMixMatrix,
  resolveStereoAmbientUpmixPlan,
  type ChannelMixMatrix,
  type StereoAmbientUpmixRoute,
  type StereoUpmixMode
} from '../utils/sourceChannelLayout'
import {
  buildSpatialSpeakerMessage,
  resolveRoutingTargetChannelCount,
  SPATIAL_MAX_SPEAKERS,
  type SpatialMode,
  type VirtualSpeaker
} from '../utils/virtualSpeakerLayout'

type EventCallback = (...args: unknown[]) => void

export type SpatialWorkletState = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported-samplerate'

export interface SpatialStatus {
  state: SpatialWorkletState
  sampleRate: number | null
  taps: number
  message: string | null
}

const ANALYSIS_DELAY_MAX_MS = 2500
const ANALYSIS_DELAY_MAX_SEC = ANALYSIS_DELAY_MAX_MS / 1000
const BIT_PERFECT_UNSUPPORTED_MESSAGE = 'Bit-perfect mode bypasses all app DSP and uses exclusive/direct device output.'
const REMOTE_STREAM_PLAYABLE_SECONDS = 0.75
const REMOTE_NORMALIZATION_UPDATE_SECONDS = 5
const REMOTE_NORMALIZATION_MIN_DELTA_DB = 1
const REMOTE_NORMALIZATION_SLEW_MS = 250
const REMOTE_WAVEFORM_UPDATE_INTERVAL_MS = 250
const LOCAL_PROGRESSIVE_WAVEFORM_SAMPLE_BUDGET = 4096
const PARALLAX_HOST_STREAM_LOOKAHEAD_MS = 3000
const PARALLAX_HOST_STREAM_SLEEP_SLICE_MS = 250

// Short fade applied to standard Web Audio playback so play/pause/skip transitions are not abrupt.
const PLAYBACK_FADE_MS = 150
// Extra delay before tearing down a faded-out source, so the audio-thread ramp fully reaches 0.
const FADE_STOP_EPSILON_MS = 20
// Sub-perceptual fade-node dip used when an instant manual skip promotes the prebuffered next
// track immediately: the outgoing source is stopped at the bottom of the dip so its mid-sample
// cutoff lands in silence (no click), while the incoming source's onset rides the dip back up.
const SKIP_DECLICK_MS = 12

const NORMALIZATION_MIN_GAIN_DB = -18
const NORMALIZATION_MAX_GAIN_DB = 6
const NORMALIZATION_PEAK_CEILING_LINEAR = 0.98
const BIT_PERFECT_OSCILLOSCOPE_QUANTUM = 128
const BIT_PERFECT_VISUALIZER_TARGET_PEAK = 0.92
const BIT_PERFECT_VISUALIZER_GAIN_RISE_SMOOTHING = 0.08
const BIT_PERFECT_VISUALIZER_GAIN_FALL_SMOOTHING = 0.28
const BIT_PERFECT_VISUALIZER_SILENCE_RMS = 1e-4

const CALIBRATION_RTT_MAX_MS = 2500
const CALIBRATION_CAPTURE_WINDOW_SEC = 4
const CALIBRATION_PASSES = 3
const CALIBRATION_MIN_SUCCESSFUL_PASSES = 2
const CALIBRATION_MIN_CONFIDENCE = 0.22
const CALIBRATION_MIN_CORRELATION = 0.12
const CALIBRATION_MIN_PEAK_RATIO = 0.6
const CALIBRATION_CHIRP_DURATION_SEC = 0.3
const CALIBRATION_GAP_SEC = 0
const CALIBRATION_BURST_COUNT = 1
const CALIBRATION_BURST_WEIGHTS: readonly number[] = [1.0]
const CALIBRATION_LEAD_IN_SEC = 0.12
const CALIBRATION_OUTPUT_GAIN = 0.72
const CALIBRATION_START_FREQ_HZ = 2000
const CALIBRATION_END_FREQ_HZ = 8000
const CALIBRATION_DOWNSAMPLE_FACTOR = 4
const CALIBRATION_PRE_ROLL_SEC = 0.02
const CALIBRATION_SEARCH_TAIL_SEC = 0.2
const CALIBRATION_PEAK_SEPARATION_SEC = 0.03
const CALIBRATION_DIRECT_PATH_RELATIVE_THRESHOLD = 0.72
const CALIBRATION_MIN_RELATIVE_SEGMENT_ENERGY = 0.08
const CALIBRATION_MIN_CORRELATION_FOR_PEAK_SCAN = 0.08
const CALIBRATION_MAX_PEAK_CANDIDATES = 10
const CALIBRATION_PERIOD_ALIAS_CORRELATION_THRESHOLD = 0.93
const CALIBRATION_PERIOD_ALIAS_ENERGY_THRESHOLD = 0.75
const CALIBRATION_ROUNDTRIP_OVERSHOOT_TOLERANCE_MS = 225
const CALIBRATION_EDGE_LOCK_MARGIN_MS = 40
const CALIBRATION_EDGE_LOCK_MIN_CONFIDENCE = 0.72
const CALIBRATION_EDGE_LOCK_MAX_SPREAD_MS = 35
const DIFFERENTIAL_STAGGER_MS = 700
const DIFFERENTIAL_SCHEDULE_HEADROOM_MS = 220
const DIFFERENTIAL_SEARCH_PRE_ROLL_MS = 180
const DIFFERENTIAL_WIRED_SEARCH_WINDOW_MS = 550
const DIFFERENTIAL_BT_SEARCH_WINDOW_MS = 1200
const DIFFERENTIAL_MIN_BT_LATENCY_MS = 15
const DIFFERENTIAL_WIRED_FALLBACK_LATENCY_MS = 20
const DIFFERENTIAL_REFERENCE_PREVIEW_DELAY_MS = 80
const DIFFERENTIAL_REFERENCE_PREVIEW_TAIL_MS = 220
const DIFFERENTIAL_MIN_CORRELATION = 0.06
const DIFFERENTIAL_BT_GAIN_MULTIPLIER = 1.25
const DIFFERENTIAL_START_FREQ_HZ = 900
const DIFFERENTIAL_END_FREQ_HZ = 4200
const EMPTY_AUDIO_BUFFER_MEMORY_STATS: AudioBufferMemoryStats = {
  currentBytes: 0,
  nextBytes: 0,
  totalBytes: 0
}

export class SupersededAudioLoadError extends Error {
  constructor(message = 'Audio load was superseded by a newer request.') {
    super(message)
    this.name = 'SupersededAudioLoadError'
  }
}

export function isSupersededAudioLoadError(error: unknown): boolean {
  return error instanceof SupersededAudioLoadError
    || (
      error instanceof Error
      && (
        error.name === 'SupersededAudioLoadError'
        || error.name === 'SupersededNativeAudioLoadError'
      )
    )
}

type GainApplicationMode = ParallaxNormalizationMode

interface GainState {
  gainDb: number
  linearGain: number
  mode: GainApplicationMode
}

export interface VisualizerConsumerDemand {
  spectrum?: boolean
  // Stereo side-line feed for the spectrum scope; only enqueued when a consumer
  // actually renders it (side-line enabled), so the queue stays empty otherwise.
  spectrumStereo?: boolean
  oscilloscope?: boolean
  vectorscope?: boolean
  spectrogram?: boolean
  vumeter?: boolean
  lufsmeter?: boolean
  waveform?: boolean
  // Stereo waveform feed; only enqueued while a consumer runs in stereo mode.
  waveformStereo?: boolean
  miniSpectrum?: boolean
  miniOscilloscope?: boolean
}

export interface ExternalLoudnessResult {
  loudnessLufs: number
  peakLinear: number | null
}

export interface AudioLoadTimings {
  decodeMs: number
  analysisMs: number
}

interface AudioLoadDataOptions {
  replayGainDb?: number | null
  trackPath?: string | null
  // Pre-resolved loudness (DB lookup or main-process ffmpeg pass) so the
  // load path can skip the in-renderer full-buffer analysis.
  loudnessAnalysis?: Promise<ExternalLoudnessResult | null> | null
}

interface RemoteStreamLoadOptions {
  replayGainDb?: number | null
  loudnessAnalysis?: ExternalLoudnessResult | null
  startTimeSeconds?: number | null
}

interface PlaybackModeSwitchResult {
  activeMode: PlaybackOutputMode
  capabilities: NativeAudioCapabilities
  message: string | null
}

interface ProgressiveNormalizationAccumulator {
  analyzer: ProgressiveKWeightedLoudnessAnalyzer
  nextUpdateFrameThreshold: number
  approximate: boolean
}

interface RemoteStreamRuntimeState {
  sessionId: number
  path: string
  sourceType: 'local' | 'subsonic' | 'jellyfin'
  track: Track
  sampleRate: number
  channels: number
  durationSeconds: number
  startFrame: number
  bufferedFrames: number
  analyzedFrames: number
  currentFrame: number
  playRequested: boolean
  started: boolean
  paused: boolean
  sourceEnded: boolean
  waveform: ProgressiveWaveformAccumulator
  lastWaveformUpdateAt: number
  waveformUpdateTimer: ReturnType<typeof setTimeout> | null
  normalization: ProgressiveNormalizationAccumulator | null
}

interface ParallaxSinkRuntimeState {
  streamId: string
  sampleRate: number
  channels: number
  durationSeconds: number
  normalizationGainDb: number
  normalizationMode: GainApplicationMode
  currentFrame: number
  // Wall time (performance.timeOrigin + performance.now() domain, ms) at which the worklet's
  // currentFrame was reported — derived by mapping the worklet's contextTime through our own
  // AudioContext.currentTime at receipt. Lets the renderer compute drift at the report's actual
  // instant instead of the next 1 Hz tick. 0 until the first position message arrives.
  currentFrameAtWallMs: number
  bufferedFrames: number
  bufferedEndFrame: number
  underruns: number
  playbackRatePpm: number
  starvedFrames: number
  rebuffering: boolean
}

export type OutputDelayCalibrationFailureCode =
  | 'not-supported'
  | 'mic-denied'
  | 'mic-unavailable'
  | 'worklet-unavailable'
  | 'low-confidence'
  | 'timeout'
  | 'unknown'

export type OutputDelayCalibrationResult =
  | {
      ok: true
      roundTripMs: number
      confidence: number
      sampleRate: number
      inputLatencyMs: number | null
      outputLatencyMs: number | null
      baseLatencyMs: number | null
    }
  | {
      ok: false
      code: OutputDelayCalibrationFailureCode
      message: string
    }

export type DifferentialCalibrationResult =
  | {
      ok: true
      btOutputLatencyMs: number
      refOutputLatencyMs: number
      propagationBiasWarning: boolean
      confidence: number
      sampleRate: number
    }
  | {
      ok: false
      code: OutputDelayCalibrationFailureCode
      message: string
    }

type OutputDelayCalibrationPassResult =
  | {
      ok: true
      roundTripMs: number
      confidence: number
    }
  | {
      ok: false
      code: OutputDelayCalibrationFailureCode
      message: string
    }

interface CalibrationToneSignal {
  buffer: AudioBuffer
  referenceSequence: Float32Array
  leadInSamples: number
}

/**
 * AudioEngine - Core Web Audio API wrapper for audio playback and analysis
 *
 * Supports gapless playback through pre-buffering and sample-accurate scheduling.
 *
 * Audio Graph:
 * Playback: Source -> [optional remap matrix] -> NormalizationGain -> Preamp/EQ -> GainNode (volume) -> Destination
 * Analysis tap: Source -> AnalysisNormalizationGain -> AnalysisDelay -> AudioWorklet -> Silent sink (for pull)
 * EQ visual tap: Post-EQ -> EQAnalysisDelay -> EQAnalyser -> Silent sink (for delayed EQ/fullscreen visuals)
 */
export class AudioEngine {
  private context: AudioContext | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  // Final-stage gain used only for play/pause/skip fades, independent of volume/mute and normalization.
  private fadeGainNode: GainNode | null = null
  // Pending teardown of a faded-out source after pause(); cleared if play/stop/seek/load takes over.
  private pauseFadeTimer: ReturnType<typeof setTimeout> | null = null
  private normalizationGainNode: GainNode | null = null
  private analysisNormalizationGainNode: GainNode | null = null
  private analysisDelayNode: DelayNode | null = null
  private analysisTapSinkNode: GainNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private remoteStreamNode: AudioWorkletNode | null = null
  private parallaxSinkNode: AudioWorkletNode | null = null
  private workletLoaded: boolean = false
  private disableStandardAnalysisGraphDev: boolean = false
  private analysisDelayMs: number = 0

  // EQ nodes
  private preampNode: GainNode | null = null
  private eqFilters: BiquadFilterNode[] = []
  private eqAnalyserNode: AnalyserNode | null = null
  private eqAnalysisDelayNode: DelayNode | null = null
  private eqDisplayAnalyserNode: AnalyserNode | null = null
  private eqAnalysisTapSinkNode: GainNode | null = null
  private requestedEQBands: EQBand[] = []
  private requestedEQPreampDb: number = 0
  private requestedEQEnabled: boolean = false

  // Latest audio data from worklet (for visualizers)
  private latestLeftChannel: Float32Array = new Float32Array(0)
  private latestRightChannel: Float32Array = new Float32Array(0)
  private latestMonoChannel: Float32Array = new Float32Array(0)

  // Queue for accumulating oscilloscope samples (prevents sample loss)
  private pendingOscilloscopeSamples: Float32Array[] = []
  private pendingSpectrumSamples: Float32Array[] = []
  // Stereo spectrum chunks for the ported mid/side spectrum mode (references the same
  // left/right buffers; no extra allocation, only queued when spectrum is demanded).
  private pendingSpectrumStereoSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingSpectrogramSamples: Float32Array[] = []
  private pendingVectorscopeSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingVUMeterSamples: MultichannelAudioChunk[] = []
  private pendingLUFSMeterSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingWaveformSamples: Float32Array[] = []
  // Stereo waveform chunks for the ported stereo/multiband waveform mode.
  private pendingWaveformStereoSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingMiniVisualizerChunks: { left: Float32Array; mono: Float32Array }[] = []
  private visualizerConsumerDemand: Map<string, VisualizerConsumerDemand> = new Map()
  private static readonly EMPTY_SAMPLES = new Float32Array(0)
  private static readonly MAX_PENDING_CHUNKS = 20 // ~2560 samples at 128/chunk
  private static readonly MAX_PENDING_SPECTRUM_CHUNKS = 96 // ~0.25s at 48k/128
  private static readonly MAX_PENDING_VECTORSCOPE_CHUNKS = 20
  private static readonly MAX_PENDING_MINI_VISUALIZER_CHUNKS = 160 // ~0.42s at 48k/128

  private audioBuffer: AudioBuffer | null = null
  private currentBufferTrackPath: string | null = null
  private nextBufferTrackPath: string | null = null
  private currentNormalizationAnalysis: LoudnessAnalysis | null = null
  private nextNormalizationAnalysis: LoudnessAnalysis | null = null
  private pendingCurrentLoudnessTrackPath: string | null = null
  private lastLoadTimings: AudioLoadTimings | null = null
  private startTime: number = 0
  private pauseTime: number = 0
  private _playbackState: PlaybackState = 'stopped'
  private _volume: number = 0.7
  private _isMuted: boolean = false
  private _normalizationEnabled: boolean = true
  private _replayGainEnabled: boolean = false
  private _targetLufs: number = -14 // Target loudness in dB RMS
  private _normalizationGainDb: number = 0
  private _normalizationMode: GainApplicationMode = 'off'
  private currentReplayGainDb: number | null = null
  private nextReplayGainDb: number | null = null
  private nextNormalizationGainDb: number | null = null
  private nextNormalizationLinearGain: number | null = null
  private nextNormalizationMode: GainApplicationMode | null = null
  private bitPerfectVisualizerGain: number = 1
  private bitPerfectVisualizerGainInitialized: boolean = false
  private bitPerfectOscilloscopeRemainder: Float32Array = new Float32Array(0)

  // Gapless playback support
  private nextBuffer: AudioBuffer | null = null
  private nextSourceNode: AudioBufferSourceNode | null = null
  private scheduledEndTime: number = 0
  private isGaplessTransition: boolean = false

  private animationFrame: number | null = null
  private eventListeners: Map<string, Set<EventCallback>> = new Map()
  private multichannelEnabled: boolean = false
  private includeLfeInDownmix: boolean = false
  private stereoUpmixMode: StereoUpmixMode = 'off'
  private manualChannelRoutingMap: number[] | null = null
  // Astra Spatial Engine (binaural render stage). The worklet node is lazy:
  // created on first enable, then kept for the AudioContext's lifetime.
  private spatialMode: SpatialMode = 'off'
  private virtualSpeakers: VirtualSpeaker[] = []
  private spatialWorkletNode: AudioWorkletNode | null = null
  private spatialWorkletState: SpatialWorkletState = 'idle'
  private spatialWorkletModuleLoaded: boolean = false
  private spatialWorkletConnected: boolean = false
  private spatialTailTaps: number = 0
  private spatialStatusMessage: string | null = null
  private spatialReadyResolver: (() => void) | null = null
  private iamfDecoder: IamfDecoderClient | null = null
  private activeIamfDecodes: Set<IamfDecodeHandle> = new Set()
  private sourceRoutingNodes: WeakMap<AudioNode, {
    inputNode: AudioNode | null
    nodes: AudioNode[]
  }> = new WeakMap()
  private playbackOutputMode: PlaybackOutputMode = 'standard'
  private nativeCapabilities: NativeAudioCapabilities = {
    bitPerfectAvailable: false,
    reasonUnavailable: 'Native bit-perfect playback is unavailable in this build.',
    activeBackend: 'unavailable',
    activeDeviceExclusive: false,
    activeSampleRate: null,
    activeSampleFormat: null,
    selectedDeviceId: null,
    selectedDeviceMaxChannels: null,
    devices: []
  }
  private nativeSnapshot: NativeAudioPlaybackSnapshot | null = null
  private nativeScopePollFrameId: number | null = null
  private nativeEventUnsubscribe: (() => void) | null = null
  private remoteStreamChunkUnsubscribe: (() => void) | null = null
  private remoteStreamEventUnsubscribe: (() => void) | null = null
  private nativeModeMessage: string | null = null
  private nativeNextTrackBuffered: boolean = false
  private lastNativeVisualizerTapDemand: NativeAudioVisualizerTapDemand | null = null
  private nativeSeekPromise: Promise<void> | null = null
  private pendingNativeSeekTime: number | null = null
  private remoteStreamState: RemoteStreamRuntimeState | null = null
  private parallaxSinkState: ParallaxSinkRuntimeState | null = null
  // §21 Gapless sink handoff. Staged next stream, held alongside `parallaxSinkState` from
  // pre-announce until the boundary crossover. Its worklet node is created via the normal factory,
  // so its onmessage stays inert (gated on `node !== this.parallaxSinkNode`) until `promoteParallaxNextSink`
  // swaps it into the active slot.
  private parallaxNextSinkState: ParallaxSinkRuntimeState | null = null
  private parallaxNextSinkNode: AudioWorkletNode | null = null
  private remotePlayPromise: Promise<void> | null = null
  private remotePlayResolver: (() => void) | null = null
  private remotePlayRejecter: ((error: Error) => void) | null = null
  private normalizationApproximate: boolean = false
  private loadGeneration = 0
  private prebufferGeneration = 0
  private parallaxHostPublishGeneration = 0
  // §21 Gapless sink handoff (host side). The next-buffer publish loop streams the WHOLE next track
  // (captured by reference) and must survive the gapless swap that makes that buffer the current
  // one — so it can't share the integer generation a fresh pre-announce would bump. Each loop holds
  // a unique token in this set; `parallaxPendingNextPublishToken` marks the not-yet-promoted loop a
  // new pre-announce / cancel may supersede. `promoteParallaxHostNextPublish` detaches the pending
  // token so the loop keeps running as the current stream.
  private readonly parallaxNextPublishTokens = new Set<symbol>()
  private parallaxPendingNextPublishToken: symbol | null = null
  // Parallax trim test tone (a synced metronome) — fully separate from track playback so it never
  // touches _playbackState / gapless / now-playing. It rides the same host-stream sync path.
  private testToneBuffer: AudioBuffer | null = null
  private testToneSourceNode: AudioBufferSourceNode | null = null
  private testToneNormalizationBypassNode: GainNode | null = null
  private testTonePublishGeneration = 0
  // Phase 0 diagnostics: rolling window of (currentTime - getOutputTimestamp().contextTime) in ms,
  // median-filtered to a stable un-quantized output-latency estimate.
  private parallaxTimestampLatencySamples: number[] = []
  private readonly parallaxTimestampLatencyWindow = 31
  // §14.1.1 — per-sink manual trim. Positive = emit earlier. Flows into
  // `getParallaxEndpointLatencyMs()` so all three scheduling sites + the drift loop + the predictor
  // snap target see it on the next tick. Pushed by the host via `sink-trim-update` events.
  private parallaxSinkAdvanceMs = 0

  // Track change callbacks (for visualizer reset)
  private trackChangeCallbacks: (() => void)[] = []

  constructor() {
    // Lazy init AudioContext on first user interaction
  }

  getPlaybackOutputMode(): PlaybackOutputMode {
    return this.playbackOutputMode
  }

  getBitPerfectUnavailableMessage(): string {
    return this.nativeModeMessage ?? this.nativeCapabilities.reasonUnavailable ?? BIT_PERFECT_UNSUPPORTED_MESSAGE
  }

  getNativeAudioCapabilities(): NativeAudioCapabilities {
    return this.nativeCapabilities
  }

  async refreshNativeAudioCapabilities(): Promise<NativeAudioCapabilities> {
    await this.initNativeAudio()
    return this.refreshNativeCapabilities()
  }

  isBitPerfectActive(): boolean {
    return this.playbackOutputMode === 'bitperfect' && Boolean(this.nativeSnapshot?.bitPerfectActive)
  }

  isBitPerfectRouteActive(): boolean {
    return this.isBitPerfectActive()
  }

  getPlaybackModeStatusMessage(): string | null {
    if (this.playbackOutputMode !== 'bitperfect') return null
    if (this.nativeCapabilities.bitPerfectAvailable && this.nativeSnapshot?.bitPerfectActive) {
      return null
    }
    return this.getBitPerfectUnavailableMessage()
  }

  async setPlaybackOutputMode(mode: PlaybackOutputMode): Promise<PlaybackModeSwitchResult> {
    if (mode === 'standard') {
      if (this.playbackOutputMode === 'bitperfect') {
        void window.nativeAudioAPI.stop()
      }
      this.playbackOutputMode = 'standard'
      this.nativeModeMessage = null
      this.nativeSnapshot = null
      this.nativeNextTrackBuffered = false
      this.stopNativeScopePolling()
      this.notifyTrackChange()
      if (this.context) {
        this.rebuildStandardAnalysisGraphRouting()
      }
      if (this.spatialMode === 'binaural') {
        // Re-arm the binaural renderer (it was inert while bit-perfect
        // bypassed the Web Audio graph). Playback is stopped at this point,
        // so this only prepares the worklet + routing prefs.
        void this.setSpatialMode('binaural')
      }
      this.syncVisualizerTransportState()
      return {
        activeMode: this.playbackOutputMode,
        capabilities: this.nativeCapabilities,
        message: null
      }
    }

    const capabilities = await this.initNativeAudio()
    if (!capabilities.bitPerfectAvailable) {
      this.playbackOutputMode = 'standard'
      this.nativeModeMessage = capabilities.reasonUnavailable
      this.stopNativeScopePolling()
      this.syncVisualizerTransportState()
      return {
        activeMode: this.playbackOutputMode,
        capabilities,
        message: capabilities.reasonUnavailable
      }
    }

    if (this._playbackState === 'playing' || this._playbackState === 'paused') {
      this.stop()
    }
    this.clearNextBuffer()
    this.audioBuffer = null
    this.currentNormalizationAnalysis = null
    this.playbackOutputMode = 'bitperfect'
    this.nativeModeMessage = BIT_PERFECT_UNSUPPORTED_MESSAGE
    this.syncSpatialNodeConnection()
    this.notifyTrackChange()
    this.syncVisualizerTransportState()
    return {
      activeMode: this.playbackOutputMode,
      capabilities,
      message: null
    }
  }

  // Register callback for track changes (for visualizer reset)
  onTrackChange(callback: () => void): () => void {
    this.trackChangeCallbacks.push(callback)
    // Return unsubscribe function
    return () => {
      const index = this.trackChangeCallbacks.indexOf(callback)
      if (index !== -1) {
        this.trackChangeCallbacks.splice(index, 1)
      }
    }
  }

  // Notify all track change listeners
  private notifyTrackChange(): void {
    // Clear pending samples from previous track to prevent buffer pollution
    this.pendingOscilloscopeSamples = []
    this.pendingSpectrumSamples = []
    this.pendingSpectrumStereoSamples = []
    this.pendingSpectrogramSamples = []
    this.pendingVectorscopeSamples = []
    this.pendingVUMeterSamples = []
    this.pendingLUFSMeterSamples = []
    this.pendingWaveformSamples = []
    this.pendingWaveformStereoSamples = []
    this.pendingMiniVisualizerChunks = []
    this.clearLatestVisualizerChannels()
    this.resetBitPerfectVisualizerGain()
    this.bitPerfectOscilloscopeRemainder = new Float32Array(0)
    this.trackChangeCallbacks.forEach(cb => cb())
  }

  setVisualizerConsumerDemand(consumerId: string, demand: VisualizerConsumerDemand): void {
    const nextDemand: VisualizerConsumerDemand = {
      spectrum: Boolean(demand.spectrum),
      spectrumStereo: Boolean(demand.spectrumStereo),
      oscilloscope: Boolean(demand.oscilloscope),
      vectorscope: Boolean(demand.vectorscope),
      spectrogram: Boolean(demand.spectrogram),
      vumeter: Boolean(demand.vumeter),
      lufsmeter: Boolean(demand.lufsmeter),
      waveform: Boolean(demand.waveform),
      waveformStereo: Boolean(demand.waveformStereo),
      miniSpectrum: Boolean(demand.miniSpectrum),
      miniOscilloscope: Boolean(demand.miniOscilloscope),
    }

    const hasAnyDemand = Object.values(nextDemand).some(Boolean)
    if (hasAnyDemand) {
      this.visualizerConsumerDemand.set(consumerId, nextDemand)
    } else {
      this.visualizerConsumerDemand.delete(consumerId)
    }
    this.pruneVisualizerQueuesForDemand()
    this.syncVisualizerTransportState()
  }

  clearVisualizerConsumerDemand(consumerId: string): void {
    if (this.visualizerConsumerDemand.delete(consumerId)) {
      this.pruneVisualizerQueuesForDemand()
      this.syncVisualizerTransportState()
    }
  }

  private hasVisualizerDemand(scope: Exclude<keyof VisualizerConsumerDemand, 'miniSpectrum' | 'miniOscilloscope'>): boolean {
    for (const demand of this.visualizerConsumerDemand.values()) {
      if (demand[scope]) {
        return true
      }
    }
    return false
  }

  private hasMiniVisualizerDemand(mode: 'spectrum' | 'oscilloscope'): boolean {
    const demandKey = mode === 'spectrum' ? 'miniSpectrum' : 'miniOscilloscope'
    for (const demand of this.visualizerConsumerDemand.values()) {
      if (demand[demandKey]) {
        return true
      }
    }
    return false
  }

  private hasAnyVisualizerDemand(): boolean {
    for (const demand of this.visualizerConsumerDemand.values()) {
      if (Object.values(demand).some(Boolean)) {
        return true
      }
    }
    return false
  }

  private clearLatestVisualizerChannels(): void {
    this.latestLeftChannel = new Float32Array(0)
    this.latestRightChannel = new Float32Array(0)
    this.latestMonoChannel = new Float32Array(0)
  }

  private shouldBypassStandardAnalysisGraph(): boolean {
    return this.playbackOutputMode === 'standard' && this.disableStandardAnalysisGraphDev
  }

  private syncStandardVisualizerStreaming(): void {
    if (!this.workletNode) return
    this.workletNode.port.postMessage({
      type: 'set-visualizer-streaming-enabled',
      enabled: (
        this.playbackOutputMode === 'standard'
        && !this.shouldBypassStandardAnalysisGraph()
        && this.hasAnyVisualizerDemand()
      )
    })
  }

  private getNativeVisualizerTapDemand(): NativeAudioVisualizerTapDemand {
    return {
      oscilloscope: this.hasVisualizerDemand('oscilloscope') || this.hasMiniVisualizerDemand('oscilloscope'),
      spectrum: (
        this.hasVisualizerDemand('spectrum')
        || this.hasVisualizerDemand('spectrogram')
        || this.hasMiniVisualizerDemand('spectrum')
      ),
      vectorscope: (
        this.hasVisualizerDemand('vectorscope')
        || this.hasVisualizerDemand('lufsmeter')
        || this.hasVisualizerDemand('waveform')
      ),
      vumeter: this.hasVisualizerDemand('vumeter'),
    }
  }

  private syncNativeVisualizerTapDemand(): void {
    if (this.playbackOutputMode !== 'bitperfect' && this.lastNativeVisualizerTapDemand === null) {
      return
    }

    const demand = this.playbackOutputMode === 'bitperfect'
      ? this.getNativeVisualizerTapDemand()
      : {
          oscilloscope: false,
          spectrum: false,
          vectorscope: false,
          vumeter: false,
        }

    if (
      this.lastNativeVisualizerTapDemand
      && this.lastNativeVisualizerTapDemand.oscilloscope === demand.oscilloscope
      && this.lastNativeVisualizerTapDemand.spectrum === demand.spectrum
      && this.lastNativeVisualizerTapDemand.vectorscope === demand.vectorscope
      && this.lastNativeVisualizerTapDemand.vumeter === demand.vumeter
    ) {
      return
    }

    this.lastNativeVisualizerTapDemand = demand
    void window.nativeAudioAPI.setVisualizerTapDemand(demand).catch(() => {
      // Ignore demand sync failures while native playback is unavailable or switching modes.
    })
  }

  private shouldPollNativeScopeData(): boolean {
    return this.playbackOutputMode === 'bitperfect'
      && this._playbackState === 'playing'
      && this.hasAnyVisualizerDemand()
  }

  private syncNativeScopePolling(): void {
    if (this.shouldPollNativeScopeData()) {
      this.startNativeScopePolling()
    } else {
      this.stopNativeScopePolling()
    }
  }

  private syncVisualizerTransportState(): void {
    this.syncStandardVisualizerStreaming()
    this.syncNativeVisualizerTapDemand()
    this.syncNativeScopePolling()
  }

  private discardNativeScopeChunks(): void {
    if (this.playbackOutputMode !== 'bitperfect') return
    try {
      window.nativeAudioAPI.flushOscilloscopeChunks()
      window.nativeAudioAPI.flushSpectrumChunks()
      window.nativeAudioAPI.flushVectorscopeChunks()
      window.nativeAudioAPI.flushVUMeterChunks()
    } catch {
      // Ignore flush failures while tearing down visualizer demand.
    }
  }

  private pruneVisualizerQueuesForDemand(): void {
    if (!this.hasVisualizerDemand('oscilloscope')) {
      this.pendingOscilloscopeSamples = []
      this.bitPerfectOscilloscopeRemainder = new Float32Array(0)
    }
    if (!this.hasVisualizerDemand('spectrum')) {
      this.pendingSpectrumSamples = []
    }
    if (!this.hasVisualizerDemand('spectrumStereo')) {
      this.pendingSpectrumStereoSamples = []
    }
    if (!this.hasVisualizerDemand('spectrogram')) {
      this.pendingSpectrogramSamples = []
    }
    if (!this.hasVisualizerDemand('vectorscope')) {
      this.pendingVectorscopeSamples = []
    }
    if (!this.hasVisualizerDemand('vumeter')) {
      this.pendingVUMeterSamples = []
    }
    if (!this.hasVisualizerDemand('lufsmeter')) {
      this.pendingLUFSMeterSamples = []
    }
    if (!this.hasVisualizerDemand('waveform')) {
      this.pendingWaveformSamples = []
    }
    if (!this.hasVisualizerDemand('waveformStereo')) {
      this.pendingWaveformStereoSamples = []
    }
    if (!this.hasMiniVisualizerDemand('spectrum') && !this.hasMiniVisualizerDemand('oscilloscope')) {
      this.pendingMiniVisualizerChunks = []
    }
    if (!this.hasAnyVisualizerDemand()) {
      this.clearLatestVisualizerChannels()
      this.discardNativeScopeChunks()
    }
  }

  private queueVisualizerSamples(
    channels: Float32Array[],
    options: {
      includeCompatibility?: boolean
      includeVUMeter?: boolean
    } = {}
  ): void {
    const includeCompatibility = options.includeCompatibility ?? true
    const includeVUMeter = options.includeVUMeter ?? true
    if (channels.length === 0 || channels[0].length === 0) return
    if (!this.hasAnyVisualizerDemand()) {
      this.clearLatestVisualizerChannels()
      return
    }

    const normalizedChannels = this.normalizeBitPerfectVisualizerSamples(channels) ?? channels

    if (includeCompatibility) {
      this.queueCompatibilityVisualizerSamples(normalizedChannels)
    }

    if (includeVUMeter) {
      this.queueVUMeterSamples(normalizedChannels)
    }
  }

  // Queued chunks are shared by reference across queues and consumers:
  // every source hands the engine exclusively owned arrays (structured-clone
  // worklet messages, native flush results, normalization copies) and flush
  // consumers treat chunks as read only, so per-queue copies are unnecessary.
  private queueCompatibilityVisualizerSamples(channels: Float32Array[]): void {
    const normalizedLeft = channels[0]
    const normalizedRight = channels[1] ?? normalizedLeft
    this.latestLeftChannel = normalizedLeft
    this.latestRightChannel = normalizedRight

    const oscilloscopeDemand = this.hasVisualizerDemand('oscilloscope')
    const spectrumDemand = this.hasVisualizerDemand('spectrum')
    const spectrumStereoDemand = this.hasVisualizerDemand('spectrumStereo')
    const spectrogramDemand = this.hasVisualizerDemand('spectrogram')
    const vectorscopeDemand = this.hasVisualizerDemand('vectorscope')
    const lufsMeterDemand = this.hasVisualizerDemand('lufsmeter')
    const waveformDemand = this.hasVisualizerDemand('waveform')
    const waveformStereoDemand = this.hasVisualizerDemand('waveformStereo')
    const miniSpectrumDemand = this.hasMiniVisualizerDemand('spectrum')
    const miniOscilloscopeDemand = this.hasMiniVisualizerDemand('oscilloscope')

    const shouldComputeMono = spectrumDemand || spectrogramDemand || miniSpectrumDemand
    let mono: Float32Array | null = null
    if (shouldComputeMono) {
      mono = new Float32Array(Math.min(normalizedLeft.length, normalizedRight.length))
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (normalizedLeft[i] + normalizedRight[i]) / 2
      }
      this.latestMonoChannel = mono
    } else {
      this.latestMonoChannel = new Float32Array(0)
    }

    if (oscilloscopeDemand) {
      this.enqueueOscilloscopeSamples(normalizedLeft)
    }

    if (spectrumDemand && mono) {
      if (this.pendingSpectrumSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingSpectrumSamples = this.pendingSpectrumSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingSpectrumSamples.push(mono)
    }

    if (spectrumStereoDemand) {
      if (this.pendingSpectrumStereoSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingSpectrumStereoSamples = this.pendingSpectrumStereoSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingSpectrumStereoSamples.push({ left: normalizedLeft, right: normalizedRight })
    }

    if (spectrogramDemand && mono) {
      if (this.pendingSpectrogramSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingSpectrogramSamples = this.pendingSpectrogramSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingSpectrogramSamples.push(mono)
    }

    if (miniSpectrumDemand || miniOscilloscopeDemand) {
      if (this.pendingMiniVisualizerChunks.length >= AudioEngine.MAX_PENDING_MINI_VISUALIZER_CHUNKS) {
        this.pendingMiniVisualizerChunks = this.pendingMiniVisualizerChunks.slice(
          -Math.floor(AudioEngine.MAX_PENDING_MINI_VISUALIZER_CHUNKS / 2)
        )
      }
      this.pendingMiniVisualizerChunks.push({
        left: miniOscilloscopeDemand ? normalizedLeft : AudioEngine.EMPTY_SAMPLES,
        mono: miniSpectrumDemand && mono ? mono : AudioEngine.EMPTY_SAMPLES,
      })
    }

    if (vectorscopeDemand) {
      if (this.pendingVectorscopeSamples.length >= AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS) {
        this.pendingVectorscopeSamples = this.pendingVectorscopeSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS / 2)
        )
      }
      this.pendingVectorscopeSamples.push({
        left: normalizedLeft,
        right: normalizedRight
      })
    }

    if (lufsMeterDemand) {
      if (this.pendingLUFSMeterSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingLUFSMeterSamples = this.pendingLUFSMeterSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingLUFSMeterSamples.push({
        left: normalizedLeft,
        right: normalizedRight
      })
    }

    if (waveformDemand) {
      if (this.pendingWaveformSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingWaveformSamples = this.pendingWaveformSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingWaveformSamples.push(normalizedLeft)
    }

    if (waveformStereoDemand) {
      if (this.pendingWaveformStereoSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingWaveformStereoSamples = this.pendingWaveformStereoSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingWaveformStereoSamples.push({ left: normalizedLeft, right: normalizedRight })
    }
  }

  private queueVUMeterSamples(channels: Float32Array[]): void {
    if (!this.hasVisualizerDemand('vumeter') || channels.length === 0) return

    if (this.pendingVUMeterSamples.length >= AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS) {
      this.pendingVUMeterSamples = this.pendingVUMeterSamples.slice(
        -Math.floor(AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS / 2)
      )
    }

    this.pendingVUMeterSamples.push({ channels })
  }

  private enqueueOscilloscopeSamples(chunk: Float32Array): void {
    if (this.playbackOutputMode !== 'bitperfect') {
      if (this.pendingOscilloscopeSamples.length >= AudioEngine.MAX_PENDING_CHUNKS) {
        this.pendingOscilloscopeSamples = this.pendingOscilloscopeSamples.slice(
          -AudioEngine.MAX_PENDING_CHUNKS / 2
        )
      }
      this.pendingOscilloscopeSamples.push(chunk)
      return
    }

    const remainderLength = this.bitPerfectOscilloscopeRemainder.length
    const merged = new Float32Array(remainderLength + chunk.length)
    if (remainderLength > 0) {
      merged.set(this.bitPerfectOscilloscopeRemainder, 0)
    }
    merged.set(chunk, remainderLength)

    const quantumCount = Math.floor(merged.length / BIT_PERFECT_OSCILLOSCOPE_QUANTUM)
    if (quantumCount === 0) {
      this.bitPerfectOscilloscopeRemainder = merged
      return
    }

    if ((this.pendingOscilloscopeSamples.length + quantumCount) >= AudioEngine.MAX_PENDING_CHUNKS) {
      this.pendingOscilloscopeSamples = this.pendingOscilloscopeSamples.slice(
        -Math.floor(AudioEngine.MAX_PENDING_CHUNKS / 2)
      )
    }

    for (let quantumIndex = 0; quantumIndex < quantumCount; quantumIndex++) {
      const start = quantumIndex * BIT_PERFECT_OSCILLOSCOPE_QUANTUM
      const end = start + BIT_PERFECT_OSCILLOSCOPE_QUANTUM
      this.pendingOscilloscopeSamples.push(merged.slice(start, end))
    }

    const remainderStart = quantumCount * BIT_PERFECT_OSCILLOSCOPE_QUANTUM
    this.bitPerfectOscilloscopeRemainder = remainderStart < merged.length
      ? merged.slice(remainderStart)
      : new Float32Array(0)
  }

  private resetBitPerfectVisualizerGain(): void {
    this.bitPerfectVisualizerGain = 1
    this.bitPerfectVisualizerGainInitialized = false
  }

  private normalizeBitPerfectVisualizerSamples(channels: Float32Array[]): Float32Array[] | null {
    if (this.playbackOutputMode !== 'bitperfect' || (!this._normalizationEnabled && !this._replayGainEnabled)) {
      return null
    }

    const desiredGain = this.resolveBitPerfectVisualizerGain(channels)
    if (!Number.isFinite(desiredGain) || Math.abs(desiredGain - 1) < 1e-4) {
      this.bitPerfectVisualizerGain = 1
      this.bitPerfectVisualizerGainInitialized = true
      return null
    }

    const appliedGain = this.bitPerfectVisualizerGainInitialized
      ? this.smoothBitPerfectVisualizerGain(desiredGain)
      : desiredGain

    this.bitPerfectVisualizerGain = appliedGain
    this.bitPerfectVisualizerGainInitialized = true

    return channels.map((channel) => {
      const normalizedChannel = new Float32Array(channel.length)
      for (let i = 0; i < channel.length; i++) {
        normalizedChannel[i] = Math.max(-1, Math.min(1, channel[i] * appliedGain))
      }
      return normalizedChannel
    })
  }

  private smoothBitPerfectVisualizerGain(desiredGain: number): number {
    const smoothing = desiredGain > this.bitPerfectVisualizerGain
      ? BIT_PERFECT_VISUALIZER_GAIN_RISE_SMOOTHING
      : BIT_PERFECT_VISUALIZER_GAIN_FALL_SMOOTHING

    return this.bitPerfectVisualizerGain + ((desiredGain - this.bitPerfectVisualizerGain) * smoothing)
  }

  private resolveBitPerfectVisualizerGain(channels: Float32Array[]): number {
    if (!this._normalizationEnabled) {
      return 1
    }

    let desiredGainDb: number
    if (this._replayGainEnabled && this.currentReplayGainDb != null) {
      desiredGainDb = this.currentReplayGainDb
    } else {
      const chunkLoudnessDb = this.calculateChunkLoudness(channels)
      if (chunkLoudnessDb == null) {
        return this.bitPerfectVisualizerGainInitialized ? this.bitPerfectVisualizerGain : 1
      }
      desiredGainDb = this._targetLufs - chunkLoudnessDb
    }

    const clampedGain = this.toLinearGain(this.clampGainDb(desiredGainDb))
    const peak = this.getChunkPeak(channels)
    if (!Number.isFinite(peak) || peak <= 0) {
      return clampedGain
    }

    return Math.min(clampedGain, BIT_PERFECT_VISUALIZER_TARGET_PEAK / peak)
  }

  private calculateChunkLoudness(channels: Float32Array[]): number | null {
    const sampleCount = channels.reduce((minimum, channel) => (
      minimum === null ? channel.length : Math.min(minimum, channel.length)
    ), null as number | null)
    if (sampleCount == null || sampleCount === 0 || channels.length === 0) return null

    let sumSquares = 0
    for (const channel of channels) {
      for (let i = 0; i < sampleCount; i++) {
        const sample = channel[i]
        sumSquares += sample * sample
      }
    }

    const rms = Math.sqrt(sumSquares / (sampleCount * channels.length))
    if (!Number.isFinite(rms) || rms < BIT_PERFECT_VISUALIZER_SILENCE_RMS) {
      return null
    }

    return 20 * Math.log10(rms + 1e-10)
  }

  private getChunkPeak(channels: Float32Array[]): number {
    let peak = 0

    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) {
        peak = Math.max(peak, Math.abs(channel[i]))
      }
    }

    return peak
  }

  private async initNativeAudio(): Promise<NativeAudioCapabilities> {
    this.nativeCapabilities = await window.nativeAudioAPI.initialize()
    if (this.nativeEventUnsubscribe === null) {
      this.nativeEventUnsubscribe = window.nativeAudioAPI.onEvent((event) => {
        this.handleNativeAudioEvent(event)
      })
    }
    await this.refreshNativeSnapshot()
    return this.nativeCapabilities
  }

  private async refreshNativeCapabilities(): Promise<NativeAudioCapabilities> {
    this.nativeCapabilities = await window.nativeAudioAPI.getCapabilities()
    this.emit('nativeCapabilitiesChange', this.nativeCapabilities)
    return this.nativeCapabilities
  }

  private async refreshNativeSnapshot(): Promise<NativeAudioPlaybackSnapshot | null> {
    if (this.playbackOutputMode !== 'bitperfect' && this.nativeSnapshot === null) {
      return null
    }
    try {
      this.nativeSnapshot = await window.nativeAudioAPI.getPlaybackSnapshot()
      return this.nativeSnapshot
    } catch {
      return this.nativeSnapshot
    }
  }

  private handleNativeAudioEvent(event: NativeAudioEvent): void {
    switch (event.type) {
      case 'stateChange':
        if (this.nativeSnapshot) {
          this.nativeSnapshot = {
            ...this.nativeSnapshot,
            playbackState: event.playbackState
          }
        }
        this._playbackState = event.playbackState as PlaybackState
        this.emit('stateChange', this._playbackState)
        if (this._playbackState !== 'playing' || this.playbackOutputMode === 'bitperfect') {
          this.stopTimeUpdate()
        }
        this.syncNativeScopePolling()
        break
      case 'timeUpdate':
        if (this.nativeSnapshot) {
          this.nativeSnapshot = {
            ...this.nativeSnapshot,
            currentTime: event.currentTime
          }
        }
        this.emit('timeUpdate', event.currentTime)
        break
      case 'durationChange':
        if (this.nativeSnapshot) {
          this.nativeSnapshot = {
            ...this.nativeSnapshot,
            duration: event.duration
          }
        }
        this.emit('durationChange', event.duration)
        break
      case 'gaplessTransition':
        this.nativeNextTrackBuffered = false
        this.currentBufferTrackPath = this.nextBufferTrackPath
        this.nextBufferTrackPath = null
        void this.refreshNativeSnapshot()
        this.notifyTrackChange()
        this.emit('gaplessTransition')
        break
      case 'ended':
        this.nativeNextTrackBuffered = false
        this.currentBufferTrackPath = null
        this.nextBufferTrackPath = null
        if (this.nativeSnapshot) {
          this.nativeSnapshot = {
            ...this.nativeSnapshot,
            playbackState: 'stopped',
            currentTime: 0
          }
        }
        this.notifyTrackChange()
        this.syncNativeScopePolling()
        this.emit('ended')
        break
      case 'deviceReopened':
        if (this.nativeSnapshot) {
          this.nativeSnapshot = {
            ...this.nativeSnapshot,
            sampleRate: event.sampleRate,
            sampleFormat: event.sampleFormat,
            deviceId: event.deviceId
          }
        }
        void this.refreshNativeCapabilities()
        void this.refreshNativeSnapshot()
        this.notifyTrackChange()
        break
      case 'sampleRateChanged':
        void this.refreshNativeCapabilities()
        void this.refreshNativeSnapshot()
        this.notifyTrackChange()
        break
      case 'error':
        this.emit('error', new Error(event.message))
        break
    }
  }

  private pollNativeScopeData = (): void => {
    if (!this.shouldPollNativeScopeData()) {
      this.nativeScopePollFrameId = null
      return
    }

    const leftChunks = window.nativeAudioAPI.flushOscilloscopeChunks()
    const monoChunks = window.nativeAudioAPI.flushSpectrumChunks()
    const stereoChunks = window.nativeAudioAPI.flushVectorscopeChunks()
    const vuChunks = window.nativeAudioAPI.flushVUMeterChunks()

    if (vuChunks.length > 0) {
      for (const chunk of vuChunks) {
        this.queueVisualizerSamples(chunk.channels, {
          includeCompatibility: false,
          includeVUMeter: true,
        })
      }
    }

    if (stereoChunks.length > 0) {
      for (const chunk of stereoChunks) {
        this.queueVisualizerSamples([chunk.left, chunk.right], {
          includeCompatibility: true,
          includeVUMeter: false,
        })
      }
    } else if (leftChunks.length > 0 || monoChunks.length > 0) {
      const mono = monoChunks[monoChunks.length - 1] ?? new Float32Array(0)
      const left = leftChunks[leftChunks.length - 1] ?? mono
      const right = mono.length === left.length && mono.length > 0
        ? mono
        : left
      if (left.length > 0) {
        this.queueVisualizerSamples([left, right], {
          includeCompatibility: true,
          includeVUMeter: false,
        })
      }
    }

    this.nativeScopePollFrameId = window.requestAnimationFrame(this.pollNativeScopeData)
  }

  private startNativeScopePolling(): void {
    if (this.nativeScopePollFrameId !== null) return
    this.nativeScopePollFrameId = window.requestAnimationFrame(this.pollNativeScopeData)
  }

  private stopNativeScopePolling(): void {
    if (this.nativeScopePollFrameId !== null) {
      window.cancelAnimationFrame(this.nativeScopePollFrameId)
      this.nativeScopePollFrameId = null
    }
    this.discardNativeScopeChunks()
  }

  private buildNativeTrackMetadata(track: Track): NativeAudioTrackMetadata {
    return {
      path: track.path,
      title: track.title,
      artist: track.artist,
      album: track.album,
      format: track.format,
      sampleRate: track.sampleRate,
      bitDepth: track.bitDepth,
      channels: track.channels,
      codec: track.codec,
      codecProfile: track.codecProfile
    }
  }

  private beginLoadOperation(): number {
    // A new load supersedes any pending pause-fade teardown (its stopSource runs in the load flow).
    this.clearPauseFadeTimer()
    this.loadGeneration += 1
    this.prebufferGeneration += 1
    this.cancelParallaxHostPublishing()
    return this.loadGeneration
  }

  private invalidateLoadOperations(): void {
    this.loadGeneration += 1
    this.prebufferGeneration += 1
    this.cancelParallaxHostPublishing()
  }

  cancelParallaxHostPublishing(): void {
    this.parallaxHostPublishGeneration += 1
  }

  // If the final playback zone is disabled during Parallax's pre-roll, collapse only the still-
  // pending scheduled start to an ordinary immediate local start. Once audio has begun we leave it
  // untouched so changing zones never restarts or skips audible host playback.
  releasePendingParallaxHostStartDelay(): boolean {
    const ctx = this.context
    const buffer = this.audioBuffer
    if (
      this.playbackOutputMode === 'bitperfect'
      || !ctx
      || !buffer
      || !this.sourceNode
      || this._playbackState !== 'playing'
    ) return false

    const offset = Math.max(0, Math.min(buffer.duration, this.pauseTime))
    const scheduledStartTime = this.startTime + offset
    if (!Number.isFinite(scheduledStartTime) || scheduledStartTime <= ctx.currentTime) return false

    this.stopSource()
    this.cancelScheduledNext()
    this.sourceNode = ctx.createBufferSource()
    this.sourceNode.buffer = buffer
    this.connectSourceWithRouting(this.sourceNode, buffer.numberOfChannels)
    this.connectSourceToAnalysisTap(this.sourceNode, buffer.numberOfChannels)
    this.sourceNode.onended = () => {
      if (this._playbackState === 'playing') this.performGaplessTransition()
    }
    const startAt = ctx.currentTime
    this.startTime = startAt - offset
    this.pauseTime = offset
    if (this.fadeGainNode) {
      const fade = this.fadeGainNode.gain
      fade.cancelScheduledValues(startAt)
      fade.setValueAtTime(0, startAt)
      fade.linearRampToValueAtTime(1, startAt + PLAYBACK_FADE_MS / 1000)
    }
    this.sourceNode.start(startAt, offset)
    if (this.nextBuffer) this.scheduleGaplessTransition()
    return true
  }

  // Phase 2A — produce one host-emit-anchor's worth of state, derived from the live
  // `getOutputTimestamp()`. Returns null when there's no active host playback (no audioBuffer,
  // suspended/stopped context, source not started) — the store ignores nulls and waits for the
  // next tick. The anchor lives entirely in the output clock domain: `sourceFrameAtHostOutput` is
  // the frame the host's speaker is emitting at `hostWallTimeMs`, computed as
  // `(ts.contextTime − this.startTime) * buffer.sampleRate`. `this.startTime` is already set in
  // `playCurrentBufferOnParallaxTimeline` to `actualStartAtContextTime − offset` so seeks/non-zero
  // startFrame are handled without reaching back through the timeline.
  getHostEmitAnchor(): {
    sourceFrameAtHostOutput: number
    hostWallTimeMs: number
    hostOutputLatencyMs: number
    hostBaseLatencyMs: number
    observedRatePpm: number | null
  } | null {
    const ctx = this.context
    const buffer = this.audioBuffer
    if (!ctx || !buffer || this.playbackOutputMode === 'bitperfect') return null
    if (this._playbackState !== 'playing') return null
    if (!Number.isFinite(this.startTime) || this.startTime <= 0) return null

    const snapshot = this.getContextClockSnapshot(ctx)
    if (!Number.isFinite(snapshot.contextTime) || !Number.isFinite(snapshot.performanceTime)) return null
    // Before the source has started (startTime in the future relative to current OUTPUT time),
    // there is nothing at the speaker yet — drop the anchor and let the next tick try.
    if (snapshot.contextTime <= this.startTime) return null

    const sourceFrameAtHostOutput = (snapshot.contextTime - this.startTime) * buffer.sampleRate
    const hostWallTimeMs = performance.timeOrigin + snapshot.performanceTime
    const outMs = this.normalizeReportedLatencyMs((ctx as AudioContext & { outputLatency?: number }).outputLatency)
    const baseMs = this.normalizeReportedLatencyMs((ctx as AudioContext & { baseLatency?: number }).baseLatency)
    return {
      sourceFrameAtHostOutput,
      hostWallTimeMs,
      hostOutputLatencyMs: outMs ?? 0,
      hostBaseLatencyMs: baseMs ?? 0,
      // Per share doc §3 this is diagnostic only; the sink's fit is authoritative. Leaving null
      // until/unless we have a reason to spend cycles on a host-side estimate.
      observedRatePpm: null
    }
  }

  private beginPrebufferOperation(): number {
    this.prebufferGeneration += 1
    return this.prebufferGeneration
  }

  private invalidatePrebufferOperations(): void {
    this.prebufferGeneration += 1
  }

  private assertCurrentLoadOperation(generation: number): void {
    if (generation !== this.loadGeneration) {
      throw new SupersededAudioLoadError()
    }
  }

  private assertCurrentPrebufferOperation(generation: number): void {
    if (generation !== this.prebufferGeneration) {
      throw new SupersededAudioLoadError('Audio prebuffer was superseded by a newer request.')
    }
  }

  async loadTrackFromPath(track: Track): Promise<NativeAudioTrackLoadResult> {
    const loadOperation = this.beginLoadOperation()
    await this.initNativeAudio()
    this.assertCurrentLoadOperation(loadOperation)
    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()
    if (this.nativeSnapshot?.playbackState === 'playing' || this.nativeSnapshot?.playbackState === 'paused') {
      try {
        await window.nativeAudioAPI.stop()
      } catch {
        // Ignore stop failures here; the next load attempt will surface a hard error if the backend is unhealthy.
      }
      this.assertCurrentLoadOperation(loadOperation)
    }
    await this.clearRemoteStreamState(true)
    this.assertCurrentLoadOperation(loadOperation)
    this.audioBuffer = null
    this.currentNormalizationAnalysis = null
    this.currentBufferTrackPath = null

    const canPromoteNativeNext = this.nativeNextTrackBuffered && this.nextBufferTrackPath === track.path
    if (canPromoteNativeNext) {
      let result: NativeAudioTrackLoadResult | null = null
      try {
        result = await window.nativeAudioAPI.promoteNextTrack(track.path, this.buildNativeTrackMetadata(track))
      } catch (error) {
        if (isSupersededAudioLoadError(error) || loadOperation !== this.loadGeneration) {
          throw new SupersededAudioLoadError()
        }
        this.nativeNextTrackBuffered = false
        this.nextBufferTrackPath = null
      }
      if (result) {
        this.assertCurrentLoadOperation(loadOperation)
        this.nativeNextTrackBuffered = false
        this.nextBufferTrackPath = null
        this.currentBufferTrackPath = track.path
        await this.refreshNativeCapabilities()
        this.assertCurrentLoadOperation(loadOperation)
        await this.refreshNativeSnapshot()
        this.assertCurrentLoadOperation(loadOperation)
        this.notifyTrackChange()
        this._playbackState = 'stopped'
        this.emit('stateChange', this._playbackState)
        this.emit('durationChange', result.duration)
        return result
      }
    }

    this.clearNextBuffer()
    this.nativeNextTrackBuffered = false
    let result: NativeAudioTrackLoadResult
    try {
      result = await window.nativeAudioAPI.loadTrack(track.path, this.buildNativeTrackMetadata(track))
    } catch (error) {
      if (isSupersededAudioLoadError(error) || loadOperation !== this.loadGeneration) {
        throw new SupersededAudioLoadError()
      }
      throw error
    }
    this.assertCurrentLoadOperation(loadOperation)
    this.currentBufferTrackPath = track.path
    await this.refreshNativeCapabilities()
    this.assertCurrentLoadOperation(loadOperation)
    await this.refreshNativeSnapshot()
    this.assertCurrentLoadOperation(loadOperation)
    this.notifyTrackChange()
    this._playbackState = 'stopped'
    this.emit('stateChange', this._playbackState)
    this.emit('durationChange', result.duration)
    return result
  }

  async preBufferNextTrackFromPath(track: Track): Promise<NativeAudioTrackLoadResult> {
    const prebufferOperation = this.beginPrebufferOperation()
    await this.initNativeAudio()
    this.assertCurrentPrebufferOperation(prebufferOperation)
    let result: NativeAudioTrackLoadResult
    try {
      result = await window.nativeAudioAPI.preloadNextTrack(track.path, this.buildNativeTrackMetadata(track))
    } catch (error) {
      if (isSupersededAudioLoadError(error) || prebufferOperation !== this.prebufferGeneration) {
        throw new SupersededAudioLoadError('Audio prebuffer was superseded by a newer request.')
      }
      throw error
    }
    this.assertCurrentPrebufferOperation(prebufferOperation)
    this.nativeNextTrackBuffered = true
    this.nextBufferTrackPath = track.path
    return result
  }

  private getMaxDestinationChannelCount(): number {
    return Math.max(1, Math.min(32, this.context?.destination.maxChannelCount ?? 2))
  }

  private getDecodedAudioBufferBytes(buffer: AudioBuffer | null): number {
    if (!buffer) return 0
    return buffer.length * buffer.numberOfChannels * 4
  }

  /**
   * True when the binaural spatial stage is live in the graph. Requires the
   * worklet to be fully ready — a failed/unsupported renderer leaves the
   * routing exactly as it was (Direct mode).
   */
  private isBinauralActive(): boolean {
    return (
      this.spatialMode === 'binaural' &&
      this.playbackOutputMode === 'standard' &&
      this.spatialWorkletState === 'ready' &&
      this.spatialWorkletNode !== null &&
      this.virtualSpeakers.length > 0
    )
  }

  /** Output layout of the binaural render bus: one id per virtual speaker. */
  private getVirtualSpeakerChannelIds(): string[] {
    return this.virtualSpeakers.map((sp) => sp.sourceChannel)
  }

  /**
   * The node per-source routing connects into: the spatial render stage when
   * binaural is active, otherwise the normalization gain (legacy behavior).
   */
  private getRoutingSinkNode(): AudioNode | null {
    if (this.isBinauralActive()) return this.spatialWorkletNode
    return this.normalizationGainNode
  }

  private getRoutingOutputChannelCount(sourceChannels?: number): number {
    return resolveRoutingTargetChannelCount({
      multichannelEnabled: this.multichannelEnabled,
      binauralActive: this.isBinauralActive(),
      virtualSpeakerCount: this.virtualSpeakers.length,
      maxDestinationChannels: this.getMaxDestinationChannelCount(),
      manualMapLength: this.manualChannelRoutingMap?.length ?? 0,
      hasSourceChannels: Boolean(
        (sourceChannels && sourceChannels > 0) || (this.audioBuffer?.numberOfChannels ?? 0) > 0
      ),
    })
  }

  private applyNodeRoutingMode(
    node: AudioNode | AudioDestinationNode | null,
    channelCount: number,
    mode: ChannelCountMode,
    interpretation: ChannelInterpretation
  ): void {
    if (!node) return

    const channelNode = node as AudioNode & {
      channelCount: number
      channelCountMode: ChannelCountMode
      channelInterpretation: ChannelInterpretation
    }

    try {
      channelNode.channelCountMode = mode
    } catch {
      // Some nodes may not allow this property to be set.
    }

    try {
      channelNode.channelInterpretation = interpretation
    } catch {
      // Some nodes may not allow this property to be set.
    }

    try {
      channelNode.channelCount = channelCount
    } catch {
      // Some nodes may not allow this property to be set.
    }
  }

  private applyChannelRoutingPreferences(preferredChannels?: number): void {
    if (!this.context) return

    const routingChannels = this.getRoutingOutputChannelCount(preferredChannels)
    const binauralActive = this.isBinauralActive()
    // When binaural is active the multichannel render bus ends at the spatial
    // node; everything downstream of it (EQ, volume, destination) is plain
    // stereo headphone audio.
    const downstreamChannels = binauralActive ? 2 : routingChannels
    const useDiscreteRouting = downstreamChannels > 2
    const mode: ChannelCountMode = useDiscreteRouting ? 'explicit' : 'max'
    const interpretation: ChannelInterpretation = useDiscreteRouting ? 'discrete' : 'speakers'

    const nodes: Array<AudioNode | AudioDestinationNode | null> = [
      this.context.destination,
      this.normalizationGainNode,
      this.preampNode,
      this.eqAnalyserNode,
      this.eqAnalysisDelayNode,
      this.eqDisplayAnalyserNode,
      this.eqAnalysisTapSinkNode,
      this.gainNode
    ]

    for (const node of nodes) {
      this.applyNodeRoutingMode(node, downstreamChannels, mode, interpretation)
    }

    if (this.spatialWorkletNode) {
      // Pin the spatial node's input to the render bus width so the worklet
      // never sees a surprise channel-count change mid-process.
      const spatialInputChannels = Math.max(
        1,
        Math.min(SPATIAL_MAX_SPEAKERS, binauralActive ? routingChannels : this.virtualSpeakers.length || 2)
      )
      this.applyNodeRoutingMode(this.spatialWorkletNode, spatialInputChannels, 'explicit', 'discrete')
    }
  }

  private applyAnalysisRoutingPreferences(sourceChannels?: number): void {
    const analysisChannels = Math.max(1, sourceChannels ?? this.audioBuffer?.numberOfChannels ?? 2)
    const useDiscreteRouting = analysisChannels > 2
    const mode: ChannelCountMode = useDiscreteRouting ? 'explicit' : 'max'
    const interpretation: ChannelInterpretation = useDiscreteRouting ? 'discrete' : 'speakers'

    const nodes: Array<AudioNode | null> = [
      this.analysisNormalizationGainNode,
      this.analysisDelayNode,
      this.workletNode,
      this.analysisTapSinkNode,
    ]

    for (const node of nodes) {
      this.applyNodeRoutingMode(node, analysisChannels, mode, interpretation)
    }
  }

  private connectSourceWithRouting(sourceNode: AudioNode, sourceChannels: number): void {
    if (!this.context || !this.normalizationGainNode) return

    this.applyChannelRoutingPreferences(sourceChannels)

    // Binaural rendering consumes the same multichannel render bus the
    // Direct path produces — it just must not depend on the physical
    // multichannel toggle (headphones are 2ch; that's the point). The manual
    // routing map keeps physical-device semantics and is ignored here.
    const binauralActive = this.isBinauralActive()
    const effectiveMultichannel = this.multichannelEnabled || binauralActive
    const manualRoutingMap = binauralActive ? null : this.manualChannelRoutingMap
    // The binaural render bus is ordered by the virtual speaker list, which
    // for height layouts (5.1.2) is not the standard layout for its channel
    // count — routing must see the explicit ids.
    const outputChannelIds = binauralActive ? this.getVirtualSpeakerChannelIds() : null

    const outputChannels = this.getRoutingOutputChannelCount(sourceChannels)
    const shouldUseStereoAmbientUpmix = canUseStereoAmbientUpmix({
      sourceChannels,
      outputChannels,
      multichannelEnabled: effectiveMultichannel,
      standardMode: this.playbackOutputMode === 'standard',
      stereoUpmixMode: this.stereoUpmixMode,
      outputChannelIds,
    })

    if (shouldUseStereoAmbientUpmix) {
      this.connectStereoAmbientUpmix(sourceNode, outputChannels, outputChannelIds)
      return
    }

    const channelMixMatrix = resolveChannelMixMatrix({
      sourceChannels,
      outputChannels,
      multichannelEnabled: effectiveMultichannel,
      manualRoutingMap,
      includeLfeInDownmix: this.includeLfeInDownmix,
      outputChannelIds,
    })
    const hasManualRouting = Boolean(
      effectiveMultichannel && manualRoutingMap && manualRoutingMap.length > 0
    )
    const shouldUseRoutingMatrix = (
      hasManualRouting ||
      sourceChannels !== outputChannels ||
      outputChannels > 2 ||
      !isIdentityChannelMixMatrix(channelMixMatrix, sourceChannels, outputChannels)
    )

    const routingSink = this.getRoutingSinkNode()
    if (!routingSink) return

    if (!shouldUseRoutingMatrix) {
      sourceNode.connect(routingSink)
      this.sourceRoutingNodes.set(sourceNode, { inputNode: null, nodes: [] })
      return
    }

    const splitter = this.context.createChannelSplitter(Math.max(1, sourceChannels))
    const merger = this.context.createChannelMerger(Math.max(1, outputChannels))
    this.applyNodeRoutingMode(splitter, sourceChannels, 'explicit', 'discrete')
    this.applyNodeRoutingMode(
      merger,
      outputChannels,
      'explicit',
      'discrete'
    )

    sourceNode.connect(splitter)

    const gainNodes = this.connectChannelMixMatrix(splitter, merger, channelMixMatrix)
    const connectedOutputs = new Set<number>()
    for (let outputIndex = 0; outputIndex < channelMixMatrix.length; outputIndex++) {
      if ((channelMixMatrix[outputIndex]?.length ?? 0) > 0) {
        connectedOutputs.add(outputIndex)
      }
    }
    const silenceNodes = this.connectSilentMergerInputs(merger, outputChannels, connectedOutputs)

    merger.connect(routingSink)
    this.sourceRoutingNodes.set(sourceNode, {
      inputNode: splitter,
      nodes: [splitter, ...gainNodes, ...silenceNodes, merger],
    })
  }

  private connectStereoAmbientUpmix(
    sourceNode: AudioNode,
    outputChannels: number,
    outputChannelIds: readonly string[] | null = null
  ): void {
    if (!this.context || !this.normalizationGainNode) return
    const routingSink = this.getRoutingSinkNode()
    if (!routingSink) return

    const plan = resolveStereoAmbientUpmixPlan(outputChannels, outputChannelIds)
    const splitter = this.context.createChannelSplitter(2)
    const merger = this.context.createChannelMerger(Math.max(1, plan.outputChannels))
    const nodes: AudioNode[] = [splitter, merger]

    this.applyNodeRoutingMode(splitter, 2, 'explicit', 'discrete')
    this.applyNodeRoutingMode(merger, plan.outputChannels, 'explicit', 'discrete')

    sourceNode.connect(splitter)

    const connectedOutputs = new Set<number>()
    for (const route of plan.routes) {
      if (route.kind === 'direct') {
        this.connectStereoUpmixDirectRoute(splitter, merger, route, nodes)
      } else {
        this.connectStereoUpmixAmbienceRoute(splitter, merger, route, nodes)
      }
      connectedOutputs.add(route.outputIndex)
    }
    nodes.push(...this.connectSilentMergerInputs(merger, plan.outputChannels, connectedOutputs))

    merger.connect(routingSink)
    this.sourceRoutingNodes.set(sourceNode, {
      inputNode: splitter,
      nodes,
    })
  }

  private connectStereoUpmixDirectRoute(
    splitter: ChannelSplitterNode,
    merger: ChannelMergerNode,
    route: StereoAmbientUpmixRoute,
    nodes: AudioNode[]
  ): void {
    if (!this.context) return

    for (const input of route.inputs) {
      if (Math.abs(input.gain - 1) <= 1e-6) {
        splitter.connect(merger, input.sourceIndex, route.outputIndex)
        continue
      }

      const gainNode = this.context.createGain()
      gainNode.gain.value = input.gain
      this.applyNodeRoutingMode(gainNode, 1, 'explicit', 'discrete')
      splitter.connect(gainNode, input.sourceIndex)
      gainNode.connect(merger, 0, route.outputIndex)
      nodes.push(gainNode)
    }
  }

  private connectStereoUpmixAmbienceRoute(
    splitter: ChannelSplitterNode,
    merger: ChannelMergerNode,
    route: StereoAmbientUpmixRoute,
    nodes: AudioNode[]
  ): void {
    if (!this.context) return

    const sumNode = this.context.createGain()
    const highpass1 = this.context.createBiquadFilter()
    const highpass2 = this.context.createBiquadFilter()
    const lowpass = this.context.createBiquadFilter()
    const delayNode = this.context.createDelay(0.08)
    const routeNodes: AudioNode[] = [sumNode, highpass1, highpass2, lowpass]

    sumNode.gain.value = 1
    const highpassHz = route.highpassHz ?? 120
    highpass1.type = 'highpass'
    highpass1.frequency.value = highpassHz
    highpass1.Q.value = 0.707
    highpass2.type = 'highpass'
    highpass2.frequency.value = highpassHz
    highpass2.Q.value = 0.707
    lowpass.type = 'lowpass'
    lowpass.frequency.value = route.lowpassHz ?? 7000
    lowpass.Q.value = 0.707
    delayNode.delayTime.value = route.delaySeconds

    const allpassNodes: BiquadFilterNode[] = []
    for (const frequency of route.allpassFrequenciesHz) {
      const allpass = this.context.createBiquadFilter()
      allpass.type = 'allpass'
      allpass.frequency.value = frequency
      allpass.Q.value = 0.707
      allpassNodes.push(allpass)
      routeNodes.push(allpass)
    }
    routeNodes.push(delayNode)

    for (const node of routeNodes) {
      this.applyNodeRoutingMode(node, 1, 'explicit', 'discrete')
    }

    for (const input of route.inputs) {
      const gainNode = this.context.createGain()
      gainNode.gain.value = input.gain
      this.applyNodeRoutingMode(gainNode, 1, 'explicit', 'discrete')
      splitter.connect(gainNode, input.sourceIndex)
      gainNode.connect(sumNode)
      nodes.push(gainNode)
    }

    sumNode.connect(highpass1)
    highpass1.connect(highpass2)
    highpass2.connect(lowpass)
    let tail: AudioNode = lowpass
    for (const allpass of allpassNodes) {
      tail.connect(allpass)
      tail = allpass
    }
    tail.connect(delayNode)
    delayNode.connect(merger, 0, route.outputIndex)
    nodes.push(...routeNodes)
  }

  private connectChannelMixMatrix(
    splitter: ChannelSplitterNode,
    merger: ChannelMergerNode,
    matrix: ChannelMixMatrix
  ): GainNode[] {
    const gainNodes: GainNode[] = []

    for (let outputIndex = 0; outputIndex < matrix.length; outputIndex++) {
      for (const input of matrix[outputIndex]) {
        if (!Number.isFinite(input.gain) || input.gain <= 0) continue

        if (Math.abs(input.gain - 1) <= 1e-6) {
          splitter.connect(merger, input.sourceIndex, outputIndex)
          continue
        }

        const gainNode = this.context?.createGain()
        if (!gainNode) continue
        gainNode.gain.value = input.gain
        this.applyNodeRoutingMode(gainNode, 1, 'explicit', 'discrete')
        splitter.connect(gainNode, input.sourceIndex)
        gainNode.connect(merger, 0, outputIndex)
        gainNodes.push(gainNode)
      }
    }

    return gainNodes
  }

  private connectSilentMergerInputs(
    merger: ChannelMergerNode,
    outputChannels: number,
    connectedOutputs: ReadonlySet<number>
  ): AudioNode[] {
    if (!this.context) return []

    const emptyOutputIndexes = Array.from({ length: outputChannels }, (_, index) => index)
      .filter((index) => !connectedOutputs.has(index))
    if (emptyOutputIndexes.length === 0) return []

    const silenceSource = this.context.createConstantSource()
    silenceSource.offset.value = 0
    this.applyNodeRoutingMode(silenceSource, 1, 'explicit', 'discrete')

    for (const outputIndex of emptyOutputIndexes) {
      silenceSource.connect(merger, 0, outputIndex)
    }

    silenceSource.start()
    return [silenceSource]
  }

  private connectSourceToAnalysisTap(sourceNode: AudioNode, sourceChannels: number): void {
    if (!this.analysisNormalizationGainNode || this.shouldBypassStandardAnalysisGraph()) return

    this.applyAnalysisRoutingPreferences(sourceChannels)

    try {
      sourceNode.disconnect(this.analysisNormalizationGainNode)
    } catch {
      // Ignore missing connections while reconfiguring the analysis graph.
    }
    sourceNode.connect(this.analysisNormalizationGainNode)
  }

  private disconnectSourceFromAnalysisTap(sourceNode: AudioNode | null): void {
    if (!sourceNode || !this.analysisNormalizationGainNode) return

    try {
      sourceNode.disconnect(this.analysisNormalizationGainNode)
    } catch {
      // Ignore missing connections while reconfiguring the analysis graph.
    }
  }

  private syncSourceAnalysisTapConnection(sourceNode: AudioNode | null, sourceChannels?: number): void {
    if (!sourceNode) return

    this.disconnectSourceFromAnalysisTap(sourceNode)
    if (this.shouldBypassStandardAnalysisGraph()) return
    if (!sourceChannels || sourceChannels <= 0) return

    this.connectSourceToAnalysisTap(sourceNode, sourceChannels)
  }

  private syncLiveSourceAnalysisTapConnections(): void {
    this.syncSourceAnalysisTapConnection(this.sourceNode, this.audioBuffer?.numberOfChannels)
    this.syncSourceAnalysisTapConnection(this.nextSourceNode, this.nextBuffer?.numberOfChannels)
    this.syncSourceAnalysisTapConnection(this.remoteStreamNode, this.remoteStreamState?.channels)
    this.syncSourceAnalysisTapConnection(this.parallaxSinkNode, this.parallaxSinkState?.channels)
  }

  private getPostEQOutputNode(): AudioNode | null {
    if (this.playbackOutputMode === 'bitperfect') {
      return null
    }
    return this.shouldBypassStandardAnalysisGraph()
      ? this.gainNode
      : this.eqAnalyserNode
  }

  private rebuildStandardAnalysisGraphRouting(): void {
    if (this.playbackOutputMode === 'bitperfect') return
    if (!this.context || !this.normalizationGainNode || !this.preampNode || !this.gainNode) return

    try { this.normalizationGainNode.disconnect() } catch { /* ignore */ }
    this.normalizationGainNode.connect(this.preampNode)

    this._disconnectEQChain()
    try { this.eqAnalyserNode?.disconnect() } catch { /* ignore */ }
    try { this.eqAnalysisDelayNode?.disconnect() } catch { /* ignore */ }
    try { this.eqDisplayAnalyserNode?.disconnect() } catch { /* ignore */ }
    try { this.eqAnalysisTapSinkNode?.disconnect() } catch { /* ignore */ }
    try { this.analysisNormalizationGainNode?.disconnect() } catch { /* ignore */ }
    try { this.analysisDelayNode?.disconnect() } catch { /* ignore */ }
    try { this.workletNode?.disconnect() } catch { /* ignore */ }
    try { this.analysisTapSinkNode?.disconnect() } catch { /* ignore */ }
    try { this.gainNode.disconnect() } catch { /* ignore */ }
    try { this.fadeGainNode?.disconnect() } catch { /* ignore */ }

    if (this.fadeGainNode) {
      this.gainNode.connect(this.fadeGainNode)
      this.fadeGainNode.connect(this.context.destination)
    } else {
      this.gainNode.connect(this.context.destination)
    }

    if (!this.shouldBypassStandardAnalysisGraph()) {
      if (this.eqAnalyserNode) {
        this.eqAnalyserNode.connect(this.gainNode)
        if (this.eqAnalysisDelayNode && this.eqDisplayAnalyserNode && this.eqAnalysisTapSinkNode) {
          this.eqAnalyserNode.connect(this.eqAnalysisDelayNode)
          this.eqAnalysisDelayNode.connect(this.eqDisplayAnalyserNode)
          this.eqDisplayAnalyserNode.connect(this.eqAnalysisTapSinkNode)
          this.eqAnalysisTapSinkNode.connect(this.context.destination)
        }
      }

      if (this.workletNode && this.analysisNormalizationGainNode && this.analysisDelayNode && this.analysisTapSinkNode) {
        this.analysisNormalizationGainNode.connect(this.analysisDelayNode)
        this.analysisDelayNode.connect(this.workletNode)
        this.workletNode.connect(this.analysisTapSinkNode)
        this.analysisTapSinkNode.connect(this.context.destination)
      }
    } else {
      this.pendingOscilloscopeSamples = []
      this.pendingSpectrumSamples = []
      this.pendingSpectrumStereoSamples = []
      this.pendingSpectrogramSamples = []
      this.pendingVectorscopeSamples = []
      this.pendingVUMeterSamples = []
      this.pendingLUFSMeterSamples = []
      this.pendingWaveformSamples = []
      this.pendingWaveformStereoSamples = []
      this.pendingMiniVisualizerChunks = []
      this.clearLatestVisualizerChannels()
      this.bitPerfectOscilloscopeRemainder = new Float32Array(0)
    }

    this.updateEQ(this.requestedEQBands, this.requestedEQPreampDb, this.requestedEQEnabled)
    this.syncLiveSourceAnalysisTapConnections()
    this.syncStandardVisualizerStreaming()
  }

  setDisableStandardAnalysisGraphDev(disabled: boolean): void {
    const normalized = Boolean(disabled)
    if (this.disableStandardAnalysisGraphDev === normalized) {
      return
    }

    this.disableStandardAnalysisGraphDev = normalized

    if (this.playbackOutputMode === 'standard' && this.context) {
      this.rebuildStandardAnalysisGraphRouting()
      return
    }

    this.syncStandardVisualizerStreaming()
  }

  private disconnectSourceRouting(sourceNode: AudioNode | null): void {
    if (!sourceNode) return

    const routingNodes = this.sourceRoutingNodes.get(sourceNode)
    if (!routingNodes) return

    if (this.normalizationGainNode) {
      try { sourceNode.disconnect(this.normalizationGainNode) } catch { /* ignore */ }
    }

    if (this.spatialWorkletNode) {
      try { sourceNode.disconnect(this.spatialWorkletNode) } catch { /* ignore */ }
    }

    if (routingNodes.inputNode) {
      try { sourceNode.disconnect(routingNodes.inputNode) } catch { /* ignore */ }
    }

    for (const node of routingNodes.nodes) {
      try { node.disconnect() } catch { /* ignore */ }
      if ('stop' in node && typeof node.stop === 'function') {
        try { node.stop() } catch { /* ignore */ }
      }
    }
    this.sourceRoutingNodes.delete(sourceNode)
  }

  private resetRemotePlayPromise(error?: Error): void {
    if (error) {
      this.remotePlayRejecter?.(error)
    } else {
      this.remotePlayResolver?.()
    }
    this.remotePlayPromise = null
    this.remotePlayResolver = null
    this.remotePlayRejecter = null
  }

  private disconnectRemoteStreamNode(): void {
    if (!this.remoteStreamNode) return
    this.remoteStreamNode.port.onmessage = null
    this.disconnectSourceRouting(this.remoteStreamNode)
    try {
      this.remoteStreamNode.disconnect()
    } catch {
      // Ignore disconnect races while replacing the remote stream node.
    }
    this.remoteStreamNode = null
  }

  private disconnectParallaxSinkNode(): void {
    if (!this.parallaxSinkNode) return
    this.parallaxSinkNode.port.onmessage = null
    this.disconnectSourceRouting(this.parallaxSinkNode)
    try {
      this.parallaxSinkNode.disconnect()
    } catch {
      // Ignore disconnect races while replacing the Parallax sink node.
    }
    this.parallaxSinkNode = null
  }

  private rebuildRemoteStreamRoutingIfActive(): boolean {
    if (!this.remoteStreamNode || !this.remoteStreamState || this.playbackOutputMode === 'bitperfect') {
      return false
    }

    this.disconnectSourceRouting(this.remoteStreamNode)
    this.connectSourceWithRouting(this.remoteStreamNode, this.remoteStreamState.channels)
    return true
  }

  private rebuildParallaxSinkRoutingIfActive(): boolean {
    if (!this.parallaxSinkNode || !this.parallaxSinkState || this.playbackOutputMode === 'bitperfect') {
      return false
    }

    this.disconnectSourceRouting(this.parallaxSinkNode)
    this.connectSourceWithRouting(this.parallaxSinkNode, this.parallaxSinkState.channels)
    return true
  }

  private async clearRemoteStreamState(cancelSession: boolean): Promise<void> {
    const remoteState = this.remoteStreamState
    if (remoteState?.waveformUpdateTimer) {
      clearTimeout(remoteState.waveformUpdateTimer)
      remoteState.waveformUpdateTimer = null
    }
    this.remoteStreamState = null
    this.currentBufferTrackPath = null
    this.disconnectRemoteStreamNode()
    this.stopTimeUpdate()
    this.normalizationApproximate = false
    this.resetRemotePlayPromise(cancelSession ? new Error('Remote stream was cancelled.') : undefined)

    if (remoteState && cancelSession) {
      try {
        await window.electronAPI.cancelProgressiveStream(remoteState.sessionId)
      } catch {
        // Ignore cancellation failures while switching tracks or stopping playback.
      }
    }
  }

  private clearParallaxSinkState(): void {
    // §21. A hard reset of the current sink stream (stop / fresh stream-start) also drops any staged
    // next stream. NOT called by promoteParallaxNextSink (which uses disconnectParallaxSinkNode).
    this.clearParallaxNextSink()
    this.parallaxSinkState = null
    this.disconnectParallaxSinkNode()
    this.stopTimeUpdate()
    this.normalizationApproximate = false
    if (!this.remoteStreamState && !this.audioBuffer) {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    }
  }

  private createRemoteStreamNode(channelCount: number): AudioWorkletNode {
    if (!this.context) {
      throw new Error('AudioContext not initialized')
    }

    const node = new AudioWorkletNode(this.context, 'remote-stream-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, channelCount)]
    })

    node.port.onmessage = (event: MessageEvent) => {
      if (node !== this.remoteStreamNode) {
        return
      }

      const payload = event.data ?? {}
      if (!payload || typeof payload !== 'object') return

      if (payload.type === 'position' && this.remoteStreamState) {
        this.remoteStreamState.currentFrame = Number.isFinite(payload.frame)
          ? Math.max(0, Math.floor(payload.frame))
          : this.remoteStreamState.currentFrame
        this.emit('timeUpdate', this.currentTime)
      }

      if (payload.type === 'ended' && this.remoteStreamState) {
        this.remoteStreamState.currentFrame = Number.isFinite(payload.frame)
          ? Math.max(0, Math.floor(payload.frame))
          : this.remoteStreamState.currentFrame
        this.remoteStreamState.started = false
        this.remoteStreamState.paused = false
        this.remoteStreamState.playRequested = false
        this._playbackState = 'stopped'
        this.emit('stateChange', this._playbackState)
        this.emit('timeUpdate', 0)
        this.notifyTrackChange()
        this.stopTimeUpdate()
        void this.clearRemoteStreamState(false)
        this.emit('ended')
      }
    }

    this.connectSourceWithRouting(node, channelCount)
    this.connectSourceToAnalysisTap(node, channelCount)
    return node
  }

  private createParallaxSinkNode(channelCount: number, sourceSampleRate?: number): AudioWorkletNode {
    if (!this.context) {
      throw new Error('AudioContext not initialized')
    }

    const node = new AudioWorkletNode(this.context, 'parallax-sink-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, channelCount)],
      processorOptions: {
        sourceSampleRate: Number.isFinite(sourceSampleRate) && Number(sourceSampleRate) > 0
          ? Math.round(Number(sourceSampleRate))
          : this.context.sampleRate
      }
    })

    node.port.onmessage = (event: MessageEvent) => {
      if (node !== this.parallaxSinkNode) return
      const payload = event.data ?? {}
      if (!payload || typeof payload !== 'object') return

      if (payload.type === 'position' && this.parallaxSinkState) {
        this.parallaxSinkState.currentFrame = Number.isFinite(payload.frame)
          ? Math.max(0, Math.floor(payload.frame))
          : this.parallaxSinkState.currentFrame
        // Map the worklet's processing-context time at the report instant back to wall time.
        // ctxNow and payload.contextTime are the same audio clock viewed from two threads, so
        // (ctxNow − payload.contextTime) is approximately the IPC delay since the message was
        // posted. Subtracting that from perf.now()-at-receipt yields the wall time at the send
        // instant — i.e. the wall time the worklet's currentFrame was actually at `frame`.
        const ctxNow = this.context?.currentTime ?? 0
        const ctxSent = Number(payload.contextTime)
        const elapsedSec = Number.isFinite(ctxSent) ? Math.max(0, ctxNow - ctxSent) : 0
        this.parallaxSinkState.currentFrameAtWallMs =
          performance.timeOrigin + performance.now() - elapsedSec * 1000
        this.parallaxSinkState.bufferedFrames = Number.isFinite(payload.bufferedFrames)
          ? Math.max(0, Math.floor(payload.bufferedFrames))
          : this.parallaxSinkState.bufferedFrames
        this.parallaxSinkState.bufferedEndFrame = Number.isFinite(payload.bufferedEndFrame)
          ? Math.max(0, Math.floor(payload.bufferedEndFrame))
          : this.parallaxSinkState.bufferedEndFrame
        this.parallaxSinkState.underruns = Number.isFinite(payload.underruns)
          ? Math.max(0, Math.floor(payload.underruns))
          : this.parallaxSinkState.underruns
        this.parallaxSinkState.starvedFrames = Number.isFinite(payload.starvedFrames)
          ? Math.max(0, Math.floor(payload.starvedFrames))
          : this.parallaxSinkState.starvedFrames
        this.parallaxSinkState.rebuffering = Boolean(payload.rebuffering)
        this.parallaxSinkState.playbackRatePpm = clampParallaxPlaybackRatePpm(Number(payload.playbackRatePpm))
        this.sampleParallaxTimestampLatency()
        this.emit('timeUpdate', this.currentTime)
      }

      if (payload.type === 'underrun' && this.parallaxSinkState) {
        this.parallaxSinkState.underruns = Number.isFinite(payload.underruns)
          ? Math.max(0, Math.floor(payload.underruns))
          : this.parallaxSinkState.underruns + 1
        this.emit('parallaxUnderrun', this.parallaxSinkState.underruns)
      }
    }

    this.connectSourceWithRouting(node, channelCount)
    this.connectSourceToAnalysisTap(node, channelCount)
    return node
  }

  private createProgressiveNormalizationAccumulator(sampleRate: number): ProgressiveNormalizationAccumulator {
    return {
      analyzer: new ProgressiveKWeightedLoudnessAnalyzer(sampleRate),
      nextUpdateFrameThreshold: 0,
      approximate: true
    }
  }

  private resolveProgressiveNormalizationGain(accumulator: ProgressiveNormalizationAccumulator): GainState | null {
    const analysis = accumulator.analyzer.getAnalysis()
    if (!analysis) return null
    return this.computeNormalizationForAnalysis(analysis, { log: false })
  }

  private applyRemoteNormalizationIfNeeded(
    remoteState: RemoteStreamRuntimeState,
    options: { force?: boolean; markComplete?: boolean } = {}
  ): void {
    if (this.playbackOutputMode === 'bitperfect') return
    if (!this._normalizationEnabled) {
      this.normalizationApproximate = false
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
      return
    }

    if (remoteState.sourceType === 'local') {
      if (this.shouldAnalyzeLoudnessForLoad(this.currentReplayGainDb) && !this.currentNormalizationAnalysis) {
        return
      }
      this.normalizationApproximate = false
      this.applyNormalization()
      return
    }

    if (this._replayGainEnabled && this.currentReplayGainDb != null) {
      this.normalizationApproximate = false
      const clampedGainDb = this.clampGainDb(this.currentReplayGainDb)
      this.applyGainState({
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      })
      return
    }

    if (!remoteState.normalization) return
    const gainState = this.resolveProgressiveNormalizationGain(remoteState.normalization)
    if (!gainState) return

    const currentGainDb = this._normalizationMode === 'normalization'
      ? this._normalizationGainDb
      : Number.NaN
    const shouldApplyImmediately = !Number.isFinite(currentGainDb)
    const shouldApply = shouldApplyImmediately
      || options.force === true
      || Math.abs(gainState.gainDb - currentGainDb) >= REMOTE_NORMALIZATION_MIN_DELTA_DB

    if (!shouldApply) return

    this.normalizationApproximate = options.markComplete !== true
    if (options.force === true || !this.context) {
      this.applyGainState(gainState)
      return
    }

    const now = this.context.currentTime
    const params = [this.normalizationGainNode?.gain, this.analysisNormalizationGainNode?.gain].filter(Boolean) as AudioParam[]
    this._normalizationGainDb = gainState.gainDb
    this._normalizationMode = gainState.mode
    for (const param of params) {
      param.cancelScheduledValues(now)
      param.setValueAtTime(param.value, now)
      param.linearRampToValueAtTime(gainState.linearGain, now + (REMOTE_NORMALIZATION_SLEW_MS / 1000))
    }
  }

  private emitRemoteWaveformUpdate(remoteState: RemoteStreamRuntimeState): void {
    const durationFrames = Math.max(1, Math.round(remoteState.durationSeconds * remoteState.sampleRate))
    const bufferedAbsoluteFrames = remoteState.startFrame + remoteState.bufferedFrames
    const analyzedAbsoluteFrames = remoteState.startFrame + remoteState.analyzedFrames
    const bufferedRatio = Math.max(0, Math.min(1, bufferedAbsoluteFrames / durationFrames))
    const analyzedRatio = Math.max(0, Math.min(1, analyzedAbsoluteFrames / durationFrames))
    this.emit('remoteWaveformUpdate', {
      waveformData: remoteState.waveform.getPeaks(),
      bufferedRatio,
      analyzedRatio,
      bufferedSeconds: bufferedAbsoluteFrames / remoteState.sampleRate
    })
  }

  private requestRemoteWaveformUpdate(
    remoteState: RemoteStreamRuntimeState,
    options: { force?: boolean } = {}
  ): void {
    if (this.remoteStreamState !== remoteState) return

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const force = options.force === true
    const elapsedMs = now - remoteState.lastWaveformUpdateAt

    if (force || remoteState.lastWaveformUpdateAt === 0 || elapsedMs >= REMOTE_WAVEFORM_UPDATE_INTERVAL_MS) {
      if (remoteState.waveformUpdateTimer) {
        clearTimeout(remoteState.waveformUpdateTimer)
        remoteState.waveformUpdateTimer = null
      }
      remoteState.lastWaveformUpdateAt = now
      this.emitRemoteWaveformUpdate(remoteState)
      return
    }

    if (remoteState.waveformUpdateTimer) return
    remoteState.waveformUpdateTimer = setTimeout(() => {
      remoteState.waveformUpdateTimer = null
      if (this.remoteStreamState !== remoteState) return
      remoteState.lastWaveformUpdateAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      this.emitRemoteWaveformUpdate(remoteState)
    }, Math.max(0, REMOTE_WAVEFORM_UPDATE_INTERVAL_MS - elapsedMs))
  }

  private maybeStartRemotePlayback(): void {
    const remoteState = this.remoteStreamState
    if (!remoteState || !this.remoteStreamNode) return
    if (!remoteState.playRequested || remoteState.started) return

    const playableFrames = Math.floor(remoteState.sampleRate * REMOTE_STREAM_PLAYABLE_SECONDS)
    const hasEnoughBuffered = remoteState.bufferedFrames >= playableFrames
      || (remoteState.sourceEnded && remoteState.bufferedFrames > 0)
    if (!hasEnoughBuffered) return

    remoteState.started = true
    remoteState.paused = false
    this.remoteStreamNode.port.postMessage({
      type: 'set-playing',
      playing: true
    })
    this._playbackState = 'playing'
    this.emit('stateChange', this._playbackState)
    this.startTimeUpdate()
    this.resetRemotePlayPromise()
  }

  private deinterleaveRemoteChunk(chunk: RemoteStreamChunk): Float32Array[] {
    const interleaved = new Float32Array(chunk.pcmData)
    const channelData = Array.from({ length: chunk.channels }, () => new Float32Array(chunk.frameCount))
    for (let frameIndex = 0; frameIndex < chunk.frameCount; frameIndex++) {
      for (let channelIndex = 0; channelIndex < chunk.channels; channelIndex++) {
        channelData[channelIndex][frameIndex] = interleaved[(frameIndex * chunk.channels) + channelIndex] ?? 0
      }
    }
    return channelData
  }

  private handleLocalStreamChunk(chunk: RemoteStreamChunk, remoteState: RemoteStreamRuntimeState): void {
    if (!this.remoteStreamNode) return

    const interleaved = new Float32Array(chunk.pcmData)
    const startFrame = remoteState.bufferedFrames
    remoteState.bufferedFrames = Math.max(remoteState.bufferedFrames, chunk.decodedFrames)
    remoteState.analyzedFrames = remoteState.bufferedFrames
    remoteState.waveform.ingestInterleavedChunk(
      interleaved,
      chunk.channels,
      chunk.frameCount,
      remoteState.startFrame + startFrame,
      { maxSamples: LOCAL_PROGRESSIVE_WAVEFORM_SAMPLE_BUDGET }
    )

    this.requestRemoteWaveformUpdate(remoteState)
    this.remoteStreamNode.port.postMessage(
      {
        type: 'append-chunk',
        frameCount: chunk.frameCount,
        channelCount: chunk.channels,
        interleavedData: interleaved
      },
      [interleaved.buffer]
    )
    this.maybeStartRemotePlayback()
  }

  private handleRemoteStreamChunk(chunk: RemoteStreamChunk): void {
    const remoteState = this.remoteStreamState
    if (!remoteState || chunk.sessionId !== remoteState.sessionId || !this.remoteStreamNode) {
      return
    }

    if (remoteState.sourceType === 'local') {
      this.handleLocalStreamChunk(chunk, remoteState)
      return
    }

    const channelData = this.deinterleaveRemoteChunk(chunk)
    const startFrame = remoteState.bufferedFrames
    remoteState.bufferedFrames = Math.max(remoteState.bufferedFrames, chunk.decodedFrames)
    remoteState.analyzedFrames = remoteState.bufferedFrames
    remoteState.waveform.ingestChunk(channelData, remoteState.startFrame + startFrame)

    if (remoteState.normalization) {
      remoteState.normalization.analyzer.ingest(channelData)
      const playableThresholdFrames = Math.floor(remoteState.sampleRate * REMOTE_STREAM_PLAYABLE_SECONDS)
      if (remoteState.normalization.nextUpdateFrameThreshold === 0 && remoteState.analyzedFrames >= playableThresholdFrames) {
        remoteState.normalization.nextUpdateFrameThreshold = Math.floor(remoteState.sampleRate * REMOTE_NORMALIZATION_UPDATE_SECONDS)
        this.applyRemoteNormalizationIfNeeded(remoteState, { force: true })
      } else if (
        remoteState.normalization.nextUpdateFrameThreshold > 0
        && remoteState.analyzedFrames >= remoteState.normalization.nextUpdateFrameThreshold
      ) {
        remoteState.normalization.nextUpdateFrameThreshold += Math.floor(remoteState.sampleRate * REMOTE_NORMALIZATION_UPDATE_SECONDS)
        this.applyRemoteNormalizationIfNeeded(remoteState)
      }
    }

    this.requestRemoteWaveformUpdate(remoteState)
    this.remoteStreamNode.port.postMessage(
      {
        type: 'append-chunk',
        frameCount: chunk.frameCount,
        channelData
      },
      channelData.map((channel) => channel.buffer)
    )
    this.maybeStartRemotePlayback()
  }

  private handleRemoteStreamEvent(payload: RemoteStreamEvent): void {
    const remoteState = this.remoteStreamState
    if (!remoteState || payload.sessionId !== remoteState.sessionId) return

    if (payload.type === 'complete') {
      remoteState.sourceEnded = true
      if (remoteState.normalization) {
        this.applyRemoteNormalizationIfNeeded(remoteState, { force: true, markComplete: true })
      } else {
        this.normalizationApproximate = false
      }
      this.requestRemoteWaveformUpdate(remoteState, { force: true })
      this.remoteStreamNode?.port.postMessage({
        type: 'set-source-ended',
        ended: true
      })
      this.maybeStartRemotePlayback()
      return
    }

    if (payload.type === 'failed') {
      remoteState.sourceEnded = true
      this.remoteStreamNode?.port.postMessage({
        type: 'set-source-ended',
        ended: true
      })
      const error = new Error(payload.message)
      this.emit('error', error)
      this.resetRemotePlayPromise(error)
      return
    }

    if (payload.type === 'cancelled') {
      this.resetRemotePlayPromise(new Error('Remote stream was cancelled.'))
    }
  }

  async loadProgressiveStream(track: Track, options: RemoteStreamLoadOptions = {}): Promise<RemoteStreamInfo> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Bit-perfect mode requires path-based native loading.')
    }

    const loadOperation = this.beginLoadOperation()
    await this.initContext()
    this.assertCurrentLoadOperation(loadOperation)
    if (!this.context || !this.workletLoaded) {
      throw new Error('Audio worklet could not be initialized for remote streaming.')
    }

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()

    this.stopSource()
    this.clearNextBuffer()
    await this.clearRemoteStreamState(true)
    this.clearParallaxSinkState()
    this.assertCurrentLoadOperation(loadOperation)
    this.audioBuffer = null
    this.currentNormalizationAnalysis = null
    this.currentBufferTrackPath = null
    this.pauseTime = 0
    this.currentReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)
    this.notifyTrackChange()

    const sourceType = track.sourceType ?? 'local'
    const requiresFixedLocalLoudness = sourceType === 'local'
      && this.shouldAnalyzeLoudnessForLoad(this.currentReplayGainDb)
    if (requiresFixedLocalLoudness && !options.loudnessAnalysis) {
      throw new Error('Normalized local progressive playback requires precomputed loudness.')
    }

    let info: RemoteStreamInfo
    try {
      info = await window.electronAPI.startProgressiveStream(
        track.path,
        this.context.sampleRate,
        track.channels ?? null,
        { startTimeSeconds: options.startTimeSeconds ?? 0 }
      )
    } catch (error) {
      if (loadOperation !== this.loadGeneration) {
        throw new SupersededAudioLoadError()
      }
      throw error
    }

    if (loadOperation !== this.loadGeneration) {
      try {
        await window.electronAPI.cancelProgressiveStream(info.sessionId)
      } catch {
        // Ignore cleanup failures for superseded stream sessions.
      }
      throw new SupersededAudioLoadError()
    }

    this.remoteStreamNode = this.createRemoteStreamNode(info.channels)
    const resolvedStartTimeSeconds = Number.isFinite(info.startTimeSeconds)
      ? Math.max(0, Number(info.startTimeSeconds))
      : Math.max(0, Number(options.startTimeSeconds ?? 0))
    const durationSeconds = info.durationSeconds && info.durationSeconds > 0
      ? info.durationSeconds
      : Math.max(track.duration, 0)
    const fixedLoudnessAnalysis = options.loudnessAnalysis && Number.isFinite(options.loudnessAnalysis.loudnessLufs)
      ? {
          loudnessLufs: options.loudnessAnalysis.loudnessLufs,
          peakLinear: options.loudnessAnalysis.peakLinear ?? 0,
          sampleRate: info.sampleRate,
          frameCount: Math.max(1, Math.round(Math.max(durationSeconds, 1) * info.sampleRate))
        }
      : null
    this.currentBufferTrackPath = track.path
    this.currentNormalizationAnalysis = fixedLoudnessAnalysis
    this.remoteStreamState = {
      sessionId: info.sessionId,
      path: track.path,
      sourceType: info.sourceType,
      track,
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationSeconds,
      startFrame: Math.max(0, Math.floor(resolvedStartTimeSeconds * info.sampleRate)),
      bufferedFrames: 0,
      analyzedFrames: 0,
      currentFrame: 0,
      playRequested: false,
      started: false,
      paused: false,
      sourceEnded: false,
      waveform: new ProgressiveWaveformAccumulator(
        durationSeconds > 0 ? durationSeconds : Math.max(track.duration, 1),
        info.sampleRate
      ),
      lastWaveformUpdateAt: 0,
      waveformUpdateTimer: null,
      normalization: sourceType === 'local'
        ? null
        : this._replayGainEnabled && this.currentReplayGainDb != null
        ? null
        : this.createProgressiveNormalizationAccumulator(info.sampleRate)
    }

    this.applyChannelRoutingPreferences(info.channels)
    this.applyAnalysisRoutingPreferences(info.channels)
    this.emit('durationChange', this.remoteStreamState.durationSeconds)

    if (sourceType === 'local') {
      this.normalizationApproximate = false
      this.applyNormalization()
    } else if (this._replayGainEnabled && this.currentReplayGainDb != null) {
      const clampedGainDb = this.clampGainDb(this.currentReplayGainDb)
      this.normalizationApproximate = false
      this.applyGainState({
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      })
    } else if (!this._normalizationEnabled) {
      this.normalizationApproximate = false
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    } else {
      this.normalizationApproximate = true
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'normalization'
      })
    }

    if (info.initialChunk) {
      this.handleRemoteStreamChunk(info.initialChunk)
    }

    this.assertCurrentLoadOperation(loadOperation)
    return info
  }

  async loadRemoteStream(track: Track, options: RemoteStreamLoadOptions = {}): Promise<RemoteStreamInfo> {
    return this.loadProgressiveStream(track, options)
  }

  async loadParallaxSinkStream(stream: ParallaxStreamInfo): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Parallax sink playback is only available in standard mode.')
    }

    const loadOperation = this.beginLoadOperation()
    await this.initContext({ sampleRate: stream.sampleRate, allowSampleRateMismatch: true })
    this.assertCurrentLoadOperation(loadOperation)
    if (!this.context || !this.workletLoaded) {
      throw new Error('Audio worklet could not be initialized for Parallax sink playback.')
    }
    if (this.context.state === 'suspended') {
      await this.context.resume()
      this.assertCurrentLoadOperation(loadOperation)
    }

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()
    this.stopSource()
    this.clearNextBuffer()
    await this.clearRemoteStreamState(true)
    this.clearParallaxSinkState()
    this.assertCurrentLoadOperation(loadOperation)

    this.audioBuffer = null
    this.currentNormalizationAnalysis = null
    this.currentBufferTrackPath = `parallax:${stream.streamId}`
    this.pauseTime = 0
    this.currentReplayGainDb = null
    const streamNormalization = resolveParallaxStreamNormalization(stream)
    const streamNormalizationGainDb = streamNormalization.normalizationMode === 'off'
      ? 0
      : this.clampGainDb(streamNormalization.normalizationGainDb)
    this.parallaxSinkNode = this.createParallaxSinkNode(stream.channels, stream.sampleRate)
    this.parallaxSinkState = {
      streamId: stream.streamId,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      durationSeconds: stream.durationSeconds,
      normalizationGainDb: streamNormalizationGainDb,
      normalizationMode: streamNormalization.normalizationMode,
      currentFrame: 0,
      currentFrameAtWallMs: 0,
      bufferedFrames: 0,
      bufferedEndFrame: 0,
      underruns: 0,
      playbackRatePpm: 0,
      starvedFrames: 0,
      rebuffering: false
    }

    this.applyChannelRoutingPreferences(stream.channels)
    this.applyAnalysisRoutingPreferences(stream.channels)
    this.applyParallaxSinkNormalization()
    this._playbackState = 'paused'
    this.emit('durationChange', stream.durationSeconds)
    this.emit('stateChange', this._playbackState)
    this.notifyTrackChange()
  }

  appendParallaxSinkAudioChunk(chunk: ParallaxAudioChunk): void {
    if (!this.parallaxSinkState || !this.parallaxSinkNode) return
    if (chunk.streamId !== this.parallaxSinkState.streamId) return
    const channelData = this.deinterleaveParallaxChunk(chunk)
    this.parallaxSinkNode.port.postMessage(
      {
        type: 'append-chunk',
        startFrame: chunk.startFrame,
        frameCount: chunk.frameCount,
        channelData
      },
      channelData.map((channel) => channel.buffer)
    )
  }

  clearParallaxSinkAudioChunks(): void {
    if (!this.parallaxSinkState || !this.parallaxSinkNode) return
    this.parallaxSinkState.bufferedFrames = 0
    this.parallaxSinkState.bufferedEndFrame = this.parallaxSinkState.currentFrame
    this.parallaxSinkState.starvedFrames = 0
    this.parallaxSinkState.rebuffering = false
    this.parallaxSinkNode.port.postMessage({ type: 'clear-buffer' })
  }

  applyParallaxTimeline(
    timeline: ParallaxTimelineState,
    options: { startAtContextTime: number; playbackRatePpm?: number }
  ): void {
    if (!this.parallaxSinkState || !this.parallaxSinkNode || !this.context) return
    if (timeline.streamId !== this.parallaxSinkState.streamId) return
    if (timeline.playbackState === 'playing' && this.context.state === 'suspended') {
      void this.context.resume().catch((error) => {
        this.emit('error', error instanceof Error ? error : new Error('Failed to resume Parallax sink AudioContext'))
      })
    }

    const playbackRatePpm = clampParallaxPlaybackRatePpm(options.playbackRatePpm ?? 0)
    const startAtContextTime = Math.max(this.context.currentTime, options.startAtContextTime)
    // pause() fades the shared audible output path to zero. Entering sink mode calls stop(),
    // which clears the old source but intentionally preserves persistent graph state, including
    // that zero gain. The Parallax worklet's separate analysis tap still drives scopes in this
    // state, making the stream look healthy while speakers remain silent. Restore the audible
    // path at the scheduled Parallax onset, matching host-side Parallax playback.
    if (timeline.playbackState === 'playing' && this.fadeGainNode && this.fadeGainNode.gain.value < 0.999) {
      const fade = this.fadeGainNode.gain
      const now = this.context.currentTime
      fade.cancelScheduledValues(now)
      fade.setValueAtTime(fade.value, now)
      fade.setValueAtTime(fade.value, startAtContextTime)
      fade.linearRampToValueAtTime(1, startAtContextTime + PLAYBACK_FADE_MS / 1000)
    }
    this.parallaxSinkState.currentFrame = Math.max(0, Math.floor(timeline.startFrame))
    this.parallaxSinkState.playbackRatePpm = playbackRatePpm
    this.parallaxSinkNode.port.postMessage({
      type: 'set-timeline',
      startFrame: this.parallaxSinkState.currentFrame,
      startAtContextTime,
      playing: timeline.playbackState === 'playing',
      playbackRatePpm
    })

    this._playbackState = timeline.playbackState === 'playing' ? 'playing' : 'paused'
    this.emit('stateChange', this._playbackState)
    if (this._playbackState === 'playing') {
      this.startTimeUpdate()
    } else {
      this.stopTimeUpdate()
    }
  }

  applyParallaxTimelineFromHostClock(
    timeline: ParallaxTimelineState,
    hostMinusSinkOffsetMs: number | null | undefined,
    playbackRatePpm: number = 0
  ): void {
    if (!this.context) return
    // Paused timelines don't carry an emit deadline — `startHostTimeMs` is just "the wall instant
    // the host stopped." There's nothing to align acoustically, so skip auto-comp and the
    // fail-loud guard (which would otherwise warn on every pause) and let the worklet just park
    // the cursor at startFrame and stay paused. Same for any non-playing state.
    if (timeline.playbackState !== 'playing') {
      this.applyParallaxTimeline(timeline, {
        startAtContextTime: this.context.currentTime,
        playbackRatePpm
      })
      return
    }
    // Acoustic-timeline scheduling (see ParallaxTimelineState.startHostTimeMs invariant). We want
    // the sink's *speaker* to emit startFrame at `timeline.startHostTimeMs` (host clock). Mapping:
    //   target sink-wall  = startHostTimeMs − offset
    //   delayMs           = targetSinkWall − sinkNow
    //   mappedStartCtx    = ctx.currentTime + delayMs/1000 − sinkLatency
    // The −sinkLatency makes the worklet *write* startFrame `sinkLatency` seconds earlier in
    // context time, so the DAC emits it at the target wall instant. applyParallaxTimeline clamps
    // `Math.max(ctx.currentTime, …)` for safety; assertParallaxScheduledLead surfaces a loud warn
    // before that clamp if the math went negative (stale anchor, bad offset).
    const offsetMs = Number.isFinite(hostMinusSinkOffsetMs) ? Number(hostMinusSinkOffsetMs) : 0
    const sinkStartWallTimeMs = mapHostTimeToSinkTimeMs(timeline.startHostTimeMs, offsetMs)
    const delaySeconds = (sinkStartWallTimeMs - (performance.timeOrigin + performance.now())) / 1000
    const sinkLatencySec = this.getParallaxEndpointLatencySeconds()
    const mappedStartContextTime = this.context.currentTime + delaySeconds - sinkLatencySec
    const scheduledLeadMs = (mappedStartContextTime - this.context.currentTime) * 1000
    this.assertParallaxScheduledLead('applyParallaxTimelineFromHostClock', scheduledLeadMs, {
      targetAcousticHostTimeMs: timeline.startHostTimeMs,
      localLatencyMs: sinkLatencySec * 1000,
      mappedStartContextTime,
      ctxNow: this.context.currentTime
    })
    this.applyParallaxTimeline(timeline, {
      startAtContextTime: mappedStartContextTime,
      playbackRatePpm
    })
  }

  setParallaxSinkPlaybackRate(playbackRatePpm: number): void {
    if (!this.parallaxSinkNode || !this.parallaxSinkState) return
    const clamped = clampParallaxPlaybackRatePpm(playbackRatePpm)
    this.parallaxSinkState.playbackRatePpm = clamped
    this.parallaxSinkNode.port.postMessage({
      type: 'set-rate',
      playbackRatePpm: clamped
    })
  }

  // Hard re-sync: jump the worklet cursor to a live host frame (the snap in snap-then-slew). Uses
  // the same set-timeline primitive that pause/play relies on, so it re-anchors cleanly. The caller
  // supplies the target frame already mapped to "now + leadSeconds" of host time, where `now +
  // leadSeconds` IS the target acoustic emit instant. Auto-comp subtracts sinkLatency from the
  // scheduled context time so the DAC actually emits the frame at that wall instant; the worklet's
  // set-timeline clamps `startAtSample ≥ currentFrame` if we ended up scheduling into the past.
  resyncParallaxSinkToHostFrame(targetFrame: number, leadSeconds: number): void {
    if (!this.parallaxSinkNode || !this.parallaxSinkState || !this.context) return
    if (this.context.state === 'suspended') {
      void this.context.resume().catch((error) => {
        this.emit('error', error instanceof Error ? error : new Error('Failed to resume Parallax sink AudioContext'))
      })
    }
    const startFrame = Math.max(0, Math.floor(targetFrame))
    const sinkLatencySec = this.getParallaxEndpointLatencySeconds()
    const lead = Math.max(0, leadSeconds)
    const startAtContextTime = this.context.currentTime + lead - sinkLatencySec
    const scheduledLeadMs = (startAtContextTime - this.context.currentTime) * 1000
    this.assertParallaxScheduledLead('resyncParallaxSinkToHostFrame', scheduledLeadMs, {
      localLatencyMs: sinkLatencySec * 1000,
      mappedStartContextTime: startAtContextTime,
      ctxNow: this.context.currentTime
    })
    this.parallaxSinkState.currentFrame = startFrame
    this.parallaxSinkState.playbackRatePpm = 0
    this.parallaxSinkNode.port.postMessage({
      type: 'set-timeline',
      startFrame,
      startAtContextTime,
      playing: true,
      playbackRatePpm: 0
    })
  }

  stopParallaxSinkPlayback(): void {
    if (!this.parallaxSinkState && !this.parallaxSinkNode) return
    this.parallaxSinkNode?.port.postMessage({ type: 'clear' })
    this.clearParallaxSinkState()
    this.currentBufferTrackPath = null
    this.pauseTime = 0
    this._playbackState = 'stopped'
    this.emit('stateChange', this._playbackState)
    this.emit('timeUpdate', 0)
    this.notifyTrackChange()
  }

  // ── §21 Gapless sink handoff (sink side) ────────────────────────────────────
  // A staged second worklet node pre-buffers the upcoming track and is scheduled (via the worklet's
  // set-timeline `startAtContextTime`) to begin emitting exactly at the boundary, while the current
  // node runs out of buffered audio. `promoteParallaxNextSink` then swaps it into the active slot.

  getStagedParallaxSinkStreamId(): string | null {
    return this.parallaxNextSinkState?.streamId ?? null
  }

  // Pre-load the next stream WITHOUT disturbing the currently-playing sink node. Created via the
  // normal factory (auto-connects to routing + analysis tap; its onmessage stays inert until promote).
  loadParallaxNextSinkStream(stream: ParallaxStreamInfo): void {
    if (this.playbackOutputMode === 'bitperfect') return
    if (!this.context || !this.workletLoaded) return
    if (!this.parallaxSinkState) return // nothing playing to hand off from
    if (this.parallaxNextSinkState?.streamId === stream.streamId) return // already staged
    this.clearParallaxNextSink()

    const streamNormalization = resolveParallaxStreamNormalization(stream)
    const streamNormalizationGainDb = streamNormalization.normalizationMode === 'off'
      ? 0
      : this.clampGainDb(streamNormalization.normalizationGainDb)
    this.parallaxNextSinkNode = this.createParallaxSinkNode(stream.channels, stream.sampleRate)
    this.parallaxNextSinkState = {
      streamId: stream.streamId,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      durationSeconds: stream.durationSeconds,
      normalizationGainDb: streamNormalizationGainDb,
      normalizationMode: streamNormalization.normalizationMode,
      currentFrame: Math.max(0, Math.floor(0)),
      currentFrameAtWallMs: 0,
      bufferedFrames: 0,
      bufferedEndFrame: 0,
      underruns: 0,
      playbackRatePpm: 0,
      starvedFrames: 0,
      rebuffering: false
    }
  }

  appendParallaxNextSinkAudioChunk(chunk: ParallaxAudioChunk): void {
    if (!this.parallaxNextSinkState || !this.parallaxNextSinkNode) return
    if (chunk.streamId !== this.parallaxNextSinkState.streamId) return
    const channelData = this.deinterleaveParallaxChunk(chunk)
    this.parallaxNextSinkNode.port.postMessage(
      {
        type: 'append-chunk',
        startFrame: chunk.startFrame,
        frameCount: chunk.frameCount,
        channelData
      },
      channelData.map((channel) => channel.buffer)
    )
  }

  // Schedule the staged node to begin emitting `timeline.startFrame` at the boundary
  // (`timeline.startHostTimeMs`, host clock). Same acoustic mapping as applyParallaxTimelineFromHostClock
  // but targets the staged node and never touches _playbackState (the current stream is still live).
  scheduleParallaxNextSinkStart(
    timeline: ParallaxTimelineState,
    hostMinusSinkOffsetMs: number | null | undefined,
    playbackRatePpm: number = 0
  ): void {
    if (!this.parallaxNextSinkState || !this.parallaxNextSinkNode || !this.context) return
    if (timeline.streamId !== this.parallaxNextSinkState.streamId) return
    if (timeline.playbackState !== 'playing') return
    const offsetMs = Number.isFinite(hostMinusSinkOffsetMs) ? Number(hostMinusSinkOffsetMs) : 0
    const sinkStartWallTimeMs = mapHostTimeToSinkTimeMs(timeline.startHostTimeMs, offsetMs)
    const delaySeconds = (sinkStartWallTimeMs - (performance.timeOrigin + performance.now())) / 1000
    const sinkLatencySec = this.getParallaxEndpointLatencySeconds()
    const mappedStartContextTime = this.context.currentTime + delaySeconds - sinkLatencySec
    const startFrame = Math.max(0, Math.floor(timeline.startFrame))
    const rate = clampParallaxPlaybackRatePpm(playbackRatePpm)
    this.parallaxNextSinkState.currentFrame = startFrame
    this.parallaxNextSinkState.playbackRatePpm = rate
    this.parallaxNextSinkNode.port.postMessage({
      type: 'set-timeline',
      startFrame,
      startAtContextTime: Math.max(this.context.currentTime, mappedStartContextTime),
      playing: true,
      playbackRatePpm: rate
    })
  }

  // Boundary crossed — swap the staged node into the active slot. The acoustic crossover already
  // happened via the scheduled start; this is the bookkeeping swap + master-normalization switch.
  promoteParallaxNextSink(): boolean {
    if (!this.parallaxNextSinkNode || !this.parallaxNextSinkState) return false
    // Tear down the outgoing (now-silent) current node, then promote the staged one.
    this.disconnectParallaxSinkNode()
    this.parallaxSinkNode = this.parallaxNextSinkNode
    this.parallaxSinkState = this.parallaxNextSinkState
    this.parallaxNextSinkNode = null
    this.parallaxNextSinkState = null
    this.currentBufferTrackPath = `parallax:${this.parallaxSinkState.streamId}`
    // Shared master normalization gain now follows the promoted track (per-track gain can't apply to
    // two concurrent streams — see applyParallaxSinkNormalization).
    this.applyParallaxSinkNormalization()
    this._playbackState = 'playing'
    this.emit('durationChange', this.parallaxSinkState.durationSeconds)
    this.emit('stateChange', this._playbackState)
    this.notifyTrackChange()
    this.startTimeUpdate()
    return true
  }

  clearParallaxNextSink(): void {
    if (this.parallaxNextSinkNode) {
      this.parallaxNextSinkNode.port.onmessage = null
      try { this.parallaxNextSinkNode.port.postMessage({ type: 'clear' }) } catch { /* ignore */ }
      this.disconnectSourceRouting(this.parallaxNextSinkNode)
      try { this.parallaxNextSinkNode.disconnect() } catch { /* ignore */ }
      this.parallaxNextSinkNode = null
    }
    this.parallaxNextSinkState = null
  }

  getParallaxSinkSnapshot(): {
    streamId: string | null
    currentFrame: number
    currentFrameAtWallMs: number
    bufferedFrames: number
    bufferedEndFrame: number
    underruns: number
    playbackRatePpm: number
    starvedFrames: number
    rebuffering: boolean
  } {
    return {
      streamId: this.parallaxSinkState?.streamId ?? null,
      currentFrame: this.parallaxSinkState?.currentFrame ?? 0,
      currentFrameAtWallMs: this.parallaxSinkState?.currentFrameAtWallMs ?? 0,
      bufferedFrames: this.parallaxSinkState?.bufferedFrames ?? 0,
      bufferedEndFrame: this.parallaxSinkState?.bufferedEndFrame ?? 0,
      underruns: this.parallaxSinkState?.underruns ?? 0,
      playbackRatePpm: this.parallaxSinkState?.playbackRatePpm ?? 0,
      starvedFrames: this.parallaxSinkState?.starvedFrames ?? 0,
      rebuffering: this.parallaxSinkState?.rebuffering ?? false
    }
  }

  // Phase 0 diagnostics: push one (currentTime - getOutputTimestamp().contextTime) sample. Cheap;
  // safe to call from the high-rate sink position handler and the 1 Hz telemetry/host tick.
  private sampleParallaxTimestampLatency(): void {
    const ctx = this.context
    if (!ctx || ctx.state !== 'running') return
    const snapshot = this.getContextClockSnapshot(ctx)
    const latencyMs = (ctx.currentTime - snapshot.contextTime) * 1000
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return
    const samples = this.parallaxTimestampLatencySamples
    samples.push(latencyMs)
    if (samples.length > this.parallaxTimestampLatencyWindow) {
      samples.splice(0, samples.length - this.parallaxTimestampLatencyWindow)
    }
  }

  private medianParallaxTimestampLatencyMs(): number | null {
    const samples = this.parallaxTimestampLatencySamples
    if (samples.length === 0) return null
    const sorted = [...samples].sort((left, right) => left - right)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }

  // Phase 0 diagnostics: the three output-latency signals for this device's AudioContext.
  getOutputLatencyMetrics(): ParallaxOutputLatencyMetrics {
    this.sampleParallaxTimestampLatency()
    const ctx = this.context
    return {
      outputLatencyMs: ctx
        ? this.normalizeReportedLatencyMs((ctx as AudioContext & { outputLatency?: number }).outputLatency)
        : null,
      baseLatencyMs: ctx
        ? this.normalizeReportedLatencyMs((ctx as AudioContext & { baseLatency?: number }).baseLatency)
        : null,
      timestampLatencyMs: this.medianParallaxTimestampLatencyMs()
    }
  }

  async playCurrentBufferOnParallaxTimeline(timeline: ParallaxTimelineState): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Parallax host playback is only available in standard mode.')
    }
    await this.initContext()
    if (!this.audioBuffer || !this.context) return
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }

    this.stopSource()
    this.clearPauseFadeTimer()
    this.cancelScheduledNext()
    this.clearParallaxSinkState()

    // Acoustic-timeline scheduling on the host endpoint. The host is the timeline owner and its
    // wall clock IS the host clock, so target sink-wall = target host-wall = startHostTimeMs.
    // Subtract our own output latency so the host's *speaker* — not the DAC write — emits at the
    // target wall instant. Symmetric with the sink (each endpoint compensates its own latency); the
    // per-device latency difference cancels and both speakers emit startFrame at the same wall
    // instant. We clamp Math.max(ctx.currentTime, …) here because sourceNode.start with a past
    // time can throw; assertParallaxScheduledLead surfaces the negative-lead case before the clamp.
    const offset = Math.max(0, Math.min(this.audioBuffer.duration, timeline.startFrame / this.audioBuffer.sampleRate))
    const startDelaySeconds = (timeline.startHostTimeMs - (performance.timeOrigin + performance.now())) / 1000
    const hostLatencySec = this.getParallaxEndpointLatencySeconds()
    const mappedStartContextTime = this.context.currentTime + startDelaySeconds - hostLatencySec
    const scheduledLeadMs = (mappedStartContextTime - this.context.currentTime) * 1000
    this.assertParallaxScheduledLead('playCurrentBufferOnParallaxTimeline', scheduledLeadMs, {
      targetAcousticHostTimeMs: timeline.startHostTimeMs,
      localLatencyMs: hostLatencySec * 1000,
      mappedStartContextTime,
      ctxNow: this.context.currentTime
    })
    const startAtContextTime = Math.max(this.context.currentTime, mappedStartContextTime)

    this.sourceNode = this.context.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.connectSourceWithRouting(this.sourceNode, this.audioBuffer.numberOfChannels)
    this.connectSourceToAnalysisTap(this.sourceNode, this.audioBuffer.numberOfChannels)
    this.sourceNode.onended = () => {
      if (this._playbackState === 'playing') {
        this.performGaplessTransition()
      }
    }
    this.startTime = startAtContextTime - offset
    this.pauseTime = offset
    // A pause fade leaves fadeGainNode at 0 and only play() restores it, which this parallax
    // path bypasses — fade back in, anchored at the scheduled start so the ramp tracks the
    // source onset. When the gain is already at unity (seek while playing), leave the schedule
    // untouched so the skip-declick dip from stopSource() above is not cancelled mid-dip.
    if (this.fadeGainNode && this.fadeGainNode.gain.value < 0.999) {
      const fade = this.fadeGainNode.gain
      fade.cancelScheduledValues(this.context.currentTime)
      fade.setValueAtTime(0, startAtContextTime)
      fade.linearRampToValueAtTime(1, startAtContextTime + PLAYBACK_FADE_MS / 1000)
    }
    this.sourceNode.start(startAtContextTime, offset)
    this._playbackState = 'playing'
    this.emit('stateChange', this._playbackState)
    this.startTimeUpdate()
  }

  async publishCurrentBufferToParallax(streamId: string, timeline?: ParallaxTimelineState): Promise<void> {
    const buffer = this.audioBuffer
    if (!buffer) {
      throw new Error('No decoded local track is available for Parallax streaming.')
    }
    const channels = Math.max(1, Math.min(8, buffer.numberOfChannels))
    const totalFrames = buffer.length
    const publishGeneration = ++this.parallaxHostPublishGeneration
    const initialFrame = timeline
      ? Math.floor(Math.max(0, timeline.startFrame) / PARALLAX_AUDIO_CHUNK_FRAMES) * PARALLAX_AUDIO_CHUNK_FRAMES
      : 0

    for (let startFrame = initialFrame; startFrame < totalFrames; startFrame += PARALLAX_AUDIO_CHUNK_FRAMES) {
      if (publishGeneration !== this.parallaxHostPublishGeneration) return
      if (timeline) {
        const chunkHostTimeMs = timeline.startHostTimeMs + (((startFrame - timeline.startFrame) / buffer.sampleRate) * 1000)
        let delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
        while (delayMs > 0) {
          await this.sleep(Math.min(PARALLAX_HOST_STREAM_SLEEP_SLICE_MS, delayMs))
          if (publishGeneration !== this.parallaxHostPublishGeneration) return
          delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
        }
      }

      const frameCount = Math.min(PARALLAX_AUDIO_CHUNK_FRAMES, totalFrames - startFrame)
      const interleaved = new Float32Array(frameCount * channels)
      for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
        const source = buffer.getChannelData(channelIndex)
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
          interleaved[(frameIndex * channels) + channelIndex] = source[startFrame + frameIndex] ?? 0
        }
      }
      await window.electronAPI.parallax.publishHostAudioChunk({
        streamId,
        sampleRate: buffer.sampleRate,
        channels,
        startFrame,
        frameCount,
        hostTimeMs: timeline
          ? timeline.startHostTimeMs + (((startFrame - timeline.startFrame) / buffer.sampleRate) * 1000)
          : performance.timeOrigin + performance.now(),
        pcmData: interleaved.buffer
      })
    }
  }

  // §21 Gapless sink handoff (host). Stream the pre-buffered NEXT track to sinks ahead of the
  // boundary under its own streamId, paced to a FUTURE-anchored timeline (startHostTimeMs = the
  // boundary). Captures the `nextBuffer` reference so it keeps streaming seamlessly after the gapless
  // swap turns that same buffer into the current `audioBuffer` (main re-routes the streamId from
  // pending → active on promote). Cancellation is per-loop-token so a fresh pre-announce supersedes
  // only the un-promoted loop, never one that already crossed the boundary.
  async publishNextBufferToParallax(streamId: string, timeline: ParallaxTimelineState): Promise<void> {
    const buffer = this.nextBuffer
    if (!buffer) return
    const channels = Math.max(1, Math.min(8, buffer.numberOfChannels))
    const totalFrames = buffer.length
    // Supersede any prior un-promoted pending-next loop (the next track changed).
    if (this.parallaxPendingNextPublishToken) {
      this.parallaxNextPublishTokens.delete(this.parallaxPendingNextPublishToken)
    }
    const token = Symbol('parallax-next-publish')
    this.parallaxPendingNextPublishToken = token
    this.parallaxNextPublishTokens.add(token)
    const initialFrame =
      Math.floor(Math.max(0, timeline.startFrame) / PARALLAX_AUDIO_CHUNK_FRAMES) * PARALLAX_AUDIO_CHUNK_FRAMES
    try {
      for (let startFrame = initialFrame; startFrame < totalFrames; startFrame += PARALLAX_AUDIO_CHUNK_FRAMES) {
        if (!this.parallaxNextPublishTokens.has(token)) return
        const chunkHostTimeMs =
          timeline.startHostTimeMs + (((startFrame - timeline.startFrame) / buffer.sampleRate) * 1000)
        let delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
        while (delayMs > 0) {
          await this.sleep(Math.min(PARALLAX_HOST_STREAM_SLEEP_SLICE_MS, delayMs))
          if (!this.parallaxNextPublishTokens.has(token)) return
          delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
        }

        const frameCount = Math.min(PARALLAX_AUDIO_CHUNK_FRAMES, totalFrames - startFrame)
        const interleaved = new Float32Array(frameCount * channels)
        for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
          const source = buffer.getChannelData(channelIndex)
          for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            interleaved[(frameIndex * channels) + channelIndex] = source[startFrame + frameIndex] ?? 0
          }
        }
        await window.electronAPI.parallax.publishHostAudioChunk({
          streamId,
          sampleRate: buffer.sampleRate,
          channels,
          startFrame,
          frameCount,
          hostTimeMs: chunkHostTimeMs,
          pcmData: interleaved.buffer
        })
      }
    } finally {
      this.parallaxNextPublishTokens.delete(token)
      if (this.parallaxPendingNextPublishToken === token) this.parallaxPendingNextPublishToken = null
    }
  }

  // §21. Withdraw the un-promoted pending-next publish loop (skip/seek/queue edit before boundary).
  cancelParallaxHostNextPublishing(): void {
    if (this.parallaxPendingNextPublishToken) {
      this.parallaxNextPublishTokens.delete(this.parallaxPendingNextPublishToken)
      this.parallaxPendingNextPublishToken = null
    }
  }

  // §21. Boundary crossed — detach the pending-next loop so it continues streaming the (now current)
  // track and a subsequent pre-announce can't cancel it. The loop ends naturally at end-of-buffer.
  promoteParallaxHostNextPublish(): void {
    this.parallaxPendingNextPublishToken = null
  }

  // ── Parallax trim test tone (synced metronome) ──────────────────────────────
  // A pleasant accented metronome (HIGH-low-low-low) generated as one looping bar. It is streamed
  // through the normal host-stream path so every sink plays + trims it in sync, letting the user
  // tune a speaker by ear. Generated buffer is one bar; the publish loop reads it modulo its length
  // so the stream loops seamlessly while the timeline stays linear.

  /** Build the metronome buffer at the context sample rate and stash it. Returns stream specs. */
  async prepareParallaxTestTone(): Promise<{ sampleRate: number; channels: number; totalFrames: number; durationSeconds: number }> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Parallax test tone is only available in standard mode.')
    }
    await this.initContext()
    if (!this.context) throw new Error('Audio context unavailable for Parallax test tone.')
    const sampleRate = this.context.sampleRate
    const beatsPerBar = 4
    const beatSeconds = 0.6 // ~100 BPM
    const barFrames = Math.round(beatsPerBar * beatSeconds * sampleRate)
    const buffer = this.context.createBuffer(1, barFrames, sampleRate)
    const data = buffer.getChannelData(0)
    const accentHz = 1318.51 // E6 downbeat
    const beatHz = 880 // A5 off-beats
    const toneSeconds = 0.09
    const toneFrames = Math.round(toneSeconds * sampleRate)
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const isAccent = beat === 0
      const freq = isAccent ? accentHz : beatHz
      const peak = isAccent ? 0.5 : 0.34
      const beatStart = Math.round(beat * beatSeconds * sampleRate)
      for (let i = 0; i < toneFrames; i++) {
        const t = i / sampleRate
        // Soft attack + exponential decay so it sounds like a pleasant tick, not a hard click.
        const attack = Math.min(1, (i / sampleRate) / 0.004)
        const env = attack * Math.exp(-t * 38)
        data[beatStart + i] = Math.sin(2 * Math.PI * freq * t) * env * peak
      }
    }
    this.testToneBuffer = buffer
    // Report a long virtual duration: the publish loop streams indefinitely (ever-increasing
    // startFrame) by reading the bar buffer modulo its length, so sinks must not bound-reject.
    const totalFrames = Math.round(sampleRate * 3600)
    return { sampleRate, channels: 1, totalFrames, durationSeconds: 3600 }
  }

  /** Schedule the metronome on the host's own output, aligned to the shared acoustic timeline. */
  async playTestToneOnParallaxTimeline(timeline: ParallaxTimelineState): Promise<void> {
    await this.initContext()
    if (!this.testToneBuffer || !this.context) return
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }
    this.stopTestToneSource()
    const startDelaySeconds = (timeline.startHostTimeMs - (performance.timeOrigin + performance.now())) / 1000
    const hostLatencySec = this.getParallaxEndpointLatencySeconds()
    const mappedStartContextTime = this.context.currentTime + startDelaySeconds - hostLatencySec
    const startAtContextTime = Math.max(this.context.currentTime, mappedStartContextTime)
    const source = this.context.createBufferSource()
    source.buffer = this.testToneBuffer
    source.loop = true
    const normalizationBypass = this.context.createGain()
    const currentNormalizationGain = this.getCurrentNormalizationLinearGain()
    normalizationBypass.gain.value = Number.isFinite(currentNormalizationGain) && currentNormalizationGain > 0
      ? 1 / currentNormalizationGain
      : 1
    source.connect(normalizationBypass)
    this.connectSourceWithRouting(normalizationBypass, this.testToneBuffer.numberOfChannels)
    // The trim tone bypasses the normal play()/host-track path, so it must also undo a completed
    // pause fade itself. Without this, the local audible chain can remain at zero while the
    // independent Parallax publisher still sends the tone to sinks.
    if (this.fadeGainNode) {
      const fade = this.fadeGainNode.gain
      const now = this.context.currentTime
      const current = fade.value
      fade.cancelScheduledValues(now)
      fade.setValueAtTime(current, now)
      fade.setValueAtTime(current, startAtContextTime)
      fade.linearRampToValueAtTime(1, startAtContextTime + PLAYBACK_FADE_MS / 1000)
    }
    source.start(startAtContextTime, 0)
    this.testToneSourceNode = source
    this.testToneNormalizationBypassNode = normalizationBypass
  }

  /** Stream the metronome to sinks indefinitely (looping the bar) until stopped. */
  async publishTestToneToParallax(streamId: string, timeline: ParallaxTimelineState): Promise<void> {
    const buffer = this.testToneBuffer
    if (!buffer) return
    const generation = ++this.testTonePublishGeneration
    const sampleRate = buffer.sampleRate
    const totalLen = buffer.length
    const source = buffer.getChannelData(0)
    let virtualFrame = Math.floor(Math.max(0, timeline.startFrame) / PARALLAX_AUDIO_CHUNK_FRAMES) * PARALLAX_AUDIO_CHUNK_FRAMES
    while (generation === this.testTonePublishGeneration) {
      const chunkHostTimeMs = timeline.startHostTimeMs + (((virtualFrame - timeline.startFrame) / sampleRate) * 1000)
      let delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
      while (delayMs > 0) {
        await this.sleep(Math.min(PARALLAX_HOST_STREAM_SLEEP_SLICE_MS, delayMs))
        if (generation !== this.testTonePublishGeneration) return
        delayMs = (chunkHostTimeMs - PARALLAX_HOST_STREAM_LOOKAHEAD_MS) - (performance.timeOrigin + performance.now())
      }
      const frameCount = PARALLAX_AUDIO_CHUNK_FRAMES
      const interleaved = new Float32Array(frameCount)
      for (let i = 0; i < frameCount; i++) {
        interleaved[i] = source[(virtualFrame + i) % totalLen] ?? 0
      }
      await window.electronAPI.parallax.publishHostAudioChunk({
        streamId,
        sampleRate,
        channels: 1,
        startFrame: virtualFrame,
        frameCount,
        hostTimeMs: chunkHostTimeMs,
        pcmData: interleaved.buffer
      })
      virtualFrame += frameCount
    }
  }

  private stopTestToneSource(): void {
    if (this.testToneSourceNode) {
      try {
        this.testToneSourceNode.onended = null
        this.testToneSourceNode.stop()
      } catch {
        // already stopped
      }
      try {
        this.testToneSourceNode.disconnect()
      } catch {
        // already disconnected
      }
      this.testToneSourceNode = null
    }
    if (this.testToneNormalizationBypassNode) {
      this.disconnectSourceRouting(this.testToneNormalizationBypassNode)
      try {
        this.testToneNormalizationBypassNode.disconnect()
      } catch {
        // already disconnected
      }
      this.testToneNormalizationBypassNode = null
    }
  }

  /** Halt the publish loop and the host's local metronome. */
  stopParallaxTestTone(): void {
    this.testTonePublishGeneration += 1
    this.stopTestToneSource()
  }

  private deinterleaveParallaxChunk(chunk: ParallaxAudioChunk): Float32Array[] {
    const interleaved = new Float32Array(chunk.pcmData)
    const channels = Math.max(1, Math.min(8, chunk.channels))
    const channelData = Array.from({ length: channels }, () => new Float32Array(chunk.frameCount))
    for (let frameIndex = 0; frameIndex < chunk.frameCount; frameIndex++) {
      for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
        channelData[channelIndex][frameIndex] = interleaved[(frameIndex * channels) + channelIndex] ?? 0
      }
    }
    return channelData
  }

  async setChannelRoutingMap(map: number[] | null): Promise<void> {
    const normalized = map && map.length > 0
      ? map
        .map((value) => {
          if (!Number.isFinite(value)) return -1
          const rounded = Math.trunc(value)
          return rounded >= -1 ? rounded : -1
        })
        .slice(0, this.getMaxDestinationChannelCount())
      : null

    this.manualChannelRoutingMap = normalized

    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    await this.initContext()
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this.multichannelEnabled && this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  async setMultichannelEnabled(enabled: boolean): Promise<void> {
    this.multichannelEnabled = enabled
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    await this.initContext()
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  async setIncludeLfeInDownmix(enabled: boolean): Promise<void> {
    this.includeLfeInDownmix = Boolean(enabled)
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    await this.initContext()
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  async setStereoUpmixMode(mode: StereoUpmixMode): Promise<void> {
    this.stereoUpmixMode = normalizeStereoUpmixMode(mode)
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    await this.initContext()
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  getSpatialStatus(): SpatialStatus {
    return {
      state: this.spatialWorkletState,
      sampleRate: this.context ? Math.round(this.context.sampleRate) : null,
      taps: this.spatialTailTaps,
      message: this.spatialStatusMessage,
    }
  }

  private emitSpatialStatus(): void {
    this.emit('spatialStatusChange', this.getSpatialStatus())
  }

  private handleSpatialWorkletMessage(event: MessageEvent): void {
    const data = event.data ?? {}
    if (data.type === 'ready') {
      this.spatialWorkletState = 'ready'
      this.spatialTailTaps = Number(data.taps) || 0
      const wasmMaxSpeakers = Number(data.maxSpeakers) || 0
      if (wasmMaxSpeakers > 0 && wasmMaxSpeakers < SPATIAL_MAX_SPEAKERS) {
        console.warn(
          `Spatial renderer wasm supports ${wasmMaxSpeakers} speakers but the app expects ` +
            `${SPATIAL_MAX_SPEAKERS}; layouts wider than ${wasmMaxSpeakers} will be truncated. ` +
            'Rebuild via scripts/build/build-spatial-wasm.sh.'
        )
      }
      this.spatialStatusMessage = null
      this.spatialReadyResolver?.()
      this.spatialReadyResolver = null
      this.emitSpatialStatus()
      return
    }
    if (data.type === 'unsupported-samplerate') {
      this.spatialWorkletState = 'unsupported-samplerate'
      this.spatialStatusMessage = `The binaural renderer supports 44.1/48/88.2/96 kHz output; the audio device is running at ${Math.round(Number(data.sampleRate) || 0)} Hz.`
      this.spatialReadyResolver?.()
      this.spatialReadyResolver = null
      this.emitSpatialStatus()
      return
    }
    if (data.type === 'error') {
      this.spatialWorkletState = 'error'
      this.spatialStatusMessage = typeof data.message === 'string' && data.message.length > 0
        ? data.message
        : 'The binaural renderer failed to initialize.'
      this.spatialReadyResolver?.()
      this.spatialReadyResolver = null
      this.emitSpatialStatus()
    }
  }

  /**
   * Loads the spatial worklet module, creates the persistent render node and
   * initializes the WASM renderer. Resolves once the worklet reports a
   * terminal state; the graph is only rewired through the node when the state
   * lands on 'ready' (see isBinauralActive), so failures leave routing
   * untouched.
   */
  private async ensureSpatialWorklet(): Promise<void> {
    if (!this.context) return
    // 'unsupported-samplerate' is terminal for this context (its rate never
    // changes); 'error' allows a retry on the next enable attempt.
    if (
      this.spatialWorkletState === 'ready' ||
      this.spatialWorkletState === 'loading' ||
      this.spatialWorkletState === 'unsupported-samplerate'
    ) {
      return
    }

    this.spatialWorkletState = 'loading'
    this.spatialStatusMessage = null
    this.emitSpatialStatus()

    try {
      if (!this.spatialWorkletModuleLoaded) {
        await this.context.audioWorklet.addModule('./spatial-worklet.js')
        this.spatialWorkletModuleLoaded = true
      }

      if (!this.spatialWorkletNode) {
        const node = new AudioWorkletNode(this.context, 'spatial-renderer-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        })
        node.port.onmessage = (event: MessageEvent) => this.handleSpatialWorkletMessage(event)
        this.spatialWorkletNode = node
      }
      this.syncSpatialNodeConnection()

      const wasmBytes = await window.electronAPI.getSpatialWasmBytes()
      const ready = new Promise<void>((resolve) => {
        this.spatialReadyResolver = resolve
      })
      this.spatialWorkletNode.port.postMessage(
        {
          type: 'init',
          wasmBytes,
          speakers: buildSpatialSpeakerMessage(this.virtualSpeakers),
        },
        [wasmBytes]
      )
      // The worklet always answers init with ready/error/unsupported; the
      // timeout only guards against a wedged audio thread.
      await Promise.race([
        ready,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ])
      if (this.spatialWorkletState === 'loading') {
        this.spatialWorkletState = 'error'
        this.spatialStatusMessage = 'Timed out initializing the binaural renderer.'
        this.spatialReadyResolver = null
        this.emitSpatialStatus()
      }
    } catch (error) {
      this.spatialWorkletState = 'error'
      this.spatialStatusMessage = error instanceof Error ? error.message : 'Failed to load the binaural renderer.'
      this.spatialReadyResolver = null
      this.emitSpatialStatus()
    }
  }

  /** Keeps the persistent spatial node attached only while binaural is on. */
  private syncSpatialNodeConnection(): void {
    if (!this.spatialWorkletNode || !this.normalizationGainNode) return
    const shouldConnect = this.spatialMode === 'binaural' && this.playbackOutputMode === 'standard'
    if (shouldConnect && !this.spatialWorkletConnected) {
      this.spatialWorkletNode.connect(this.normalizationGainNode)
      this.spatialWorkletConnected = true
    } else if (!shouldConnect && this.spatialWorkletConnected) {
      try { this.spatialWorkletNode.disconnect() } catch { /* ignore */ }
      this.spatialWorkletConnected = false
    }
  }

  async setSpatialMode(mode: SpatialMode): Promise<void> {
    this.spatialMode = mode === 'binaural' ? 'binaural' : 'off'
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    await this.initContext()
    if (this.spatialMode === 'binaural') {
      await this.ensureSpatialWorklet()
    }
    this.syncSpatialNodeConnection()
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  /**
   * Updates virtual speaker positions. Same-width updates (drags) only push
   * new angles to the worklet — the renderer fades filters internally, no
   * graph rebuild. Width changes (preset switches) rewire the render bus.
   */
  async setVirtualSpeakers(speakers: VirtualSpeaker[]): Promise<void> {
    const previousCount = this.virtualSpeakers.length
    this.virtualSpeakers = speakers.slice(0, SPATIAL_MAX_SPEAKERS)

    if (this.spatialWorkletNode && this.spatialWorkletState === 'ready') {
      this.spatialWorkletNode.port.postMessage({
        type: 'set-speakers',
        speakers: buildSpatialSpeakerMessage(this.virtualSpeakers),
      })
    }

    if (this.playbackOutputMode === 'bitperfect') return
    if (this.spatialMode !== 'binaural') return
    if (this.virtualSpeakers.length === previousCount) return

    await this.initContext()
    if (this.spatialMode === 'binaural') {
      await this.ensureSpatialWorklet()
    }
    this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)

    if (this.rebuildRemoteStreamRoutingIfActive()) {
      return
    }
    if (this.rebuildParallaxSinkRoutingIfActive()) {
      return
    }

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  private async initContext(options: { sampleRate?: number; allowSampleRateMismatch?: boolean } = {}): Promise<void> {
    if (!this.context) {
      const requestedSampleRate = Number.isFinite(options.sampleRate) && Number(options.sampleRate) > 0
        ? Math.max(8_000, Math.round(Number(options.sampleRate)))
        : null
      this.context = requestedSampleRate
        ? new AudioContext({ sampleRate: requestedSampleRate })
        : new AudioContext()

      // Create persistent nodes
      this.gainNode = this.context.createGain()
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume

      // Fade node (after volume, last stage before destination) for play/pause/skip fades
      this.fadeGainNode = this.context.createGain()
      this.fadeGainNode.gain.value = 1.0

      // Normalization gain node (applied before volume)
      this.normalizationGainNode = this.context.createGain()
      this.normalizationGainNode.gain.value = 1.0
      this.analysisNormalizationGainNode = this.context.createGain()
      this.analysisNormalizationGainNode.gain.value = 1.0
      this.analysisDelayNode = this.context.createDelay(ANALYSIS_DELAY_MAX_SEC)
      this.analysisDelayNode.delayTime.value = this.analysisDelayMs / 1000

      // Preamp node (after metering worklet, before EQ filters)
      this.preampNode = this.context.createGain()
      this.preampNode.gain.value = 1.0

      // Post-EQ analyser node (for EQ panel spectrum overlay)
      this.eqAnalyserNode = this.context.createAnalyser()
      this.eqAnalyserNode.fftSize = 4096
      this.eqAnalyserNode.smoothingTimeConstant = 0.7
      this.eqAnalysisDelayNode = this.context.createDelay(ANALYSIS_DELAY_MAX_SEC)
      this.eqAnalysisDelayNode.delayTime.value = this.analysisDelayMs / 1000
      this.eqDisplayAnalyserNode = this.context.createAnalyser()
      this.eqDisplayAnalyserNode.fftSize = 4096
      this.eqDisplayAnalyserNode.smoothingTimeConstant = 0.7
      this.eqAnalysisTapSinkNode = this.context.createGain()
      this.eqAnalysisTapSinkNode.gain.value = 0

      // Load and create AudioWorklet for real-time analysis
      if (!this.workletLoaded) {
        try {
          await this.context.audioWorklet.addModule('./oscilloscope-worklet.js')
          this.workletLoaded = true
        } catch (err) {
          console.error('Failed to load audio worklet:', err)
        }
      }

      if (this.workletLoaded) {
        this.workletNode = new AudioWorkletNode(this.context, 'oscilloscope-processor')

        // Set up worklet message handler
        this.workletNode.port.onmessage = (event: MessageEvent) => {
          const { channels, left, right } = event.data ?? {}
          if (Array.isArray(channels) && channels.length > 0) {
            this.queueVisualizerSamples(channels)
            return
          }
          if (left && right && left.length > 0) {
            this.queueVisualizerSamples([left, right])
          }
        }
        this.syncStandardVisualizerStreaming()
      }

      if (this.remoteStreamChunkUnsubscribe === null) {
        this.remoteStreamChunkUnsubscribe = window.electronAPI.onProgressiveStreamChunk((chunk) => {
          this.handleRemoteStreamChunk(chunk)
        })
      }

      if (this.remoteStreamEventUnsubscribe === null) {
        this.remoteStreamEventUnsubscribe = window.electronAPI.onProgressiveStreamEvent((payload) => {
          this.handleRemoteStreamEvent(payload)
        })
      }

      if (this.workletNode && this.analysisNormalizationGainNode && this.analysisDelayNode) {
        this.analysisTapSinkNode = this.context.createGain()
        this.analysisTapSinkNode.gain.value = 0
      }

      this.rebuildStandardAnalysisGraphRouting()

      // Keep stereo behavior for stereo sinks. Enable explicit/discrete routing on multichannel sinks.
      this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)
      this.applyAnalysisRoutingPreferences(this.audioBuffer?.numberOfChannels)
    } else if (Number.isFinite(options.sampleRate) && Number(options.sampleRate) > 0) {
      const requestedSampleRate = Math.max(8_000, Math.round(Number(options.sampleRate)))
      if (!options.allowSampleRateMismatch && Math.abs(this.context.sampleRate - requestedSampleRate) > 1) {
        throw new Error(`Parallax sink requires ${requestedSampleRate} Hz, but the active AudioContext is ${Math.round(this.context.sampleRate)} Hz.`)
      }
    }
  }

  private clampGainDb(gainDb: number): number {
    return Math.max(NORMALIZATION_MIN_GAIN_DB, Math.min(NORMALIZATION_MAX_GAIN_DB, gainDb))
  }

  private toLinearGain(gainDb: number): number {
    return dbToLinear(gainDb)
  }

  private normalizeReplayGainCandidate(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  // Loudness analysis is only worth computing when the resolved gain could
  // actually depend on it (normalization on, no ReplayGain tag overriding it).
  private shouldAnalyzeLoudnessForLoad(replayGainDb: number | null): boolean {
    if (!this._normalizationEnabled) return false
    if (this._replayGainEnabled && replayGainDb != null) return false
    return true
  }

  private async resolveLoudnessAnalysisForLoad(
    buffer: AudioBuffer,
    options: AudioLoadDataOptions,
    replayGainDb: number | null
  ): Promise<LoudnessAnalysis | null> {
    if (!this.shouldAnalyzeLoudnessForLoad(replayGainDb)) return null

    if (options.loudnessAnalysis) {
      try {
        const external = await options.loudnessAnalysis
        if (external && Number.isFinite(external.loudnessLufs)) {
          return {
            loudnessLufs: external.loudnessLufs,
            peakLinear: external.peakLinear ?? 0,
            sampleRate: buffer.sampleRate,
            frameCount: buffer.length
          }
        }
      } catch {
        // Fall back to the in-renderer analyzer below.
      }
    }

    const analysis = await analyzeAudioBufferLoudness(buffer)
    if (options.trackPath && Number.isFinite(analysis.loudnessLufs)) {
      void window.electronAPI.storeTrackLoudness(options.trackPath, {
        loudnessLufs: analysis.loudnessLufs,
        peakLinear: Number.isFinite(analysis.peakLinear) ? analysis.peakLinear : null,
        method: 'kweight-ungated'
      }).catch(() => false)
    }
    return analysis
  }

  // Fill in the current track's loudness after the fact when a settings toggle
  // makes normalization need it (e.g. enabling normalization mid-track after
  // the load-time analysis was skipped).
  private ensureCurrentLoudnessAnalysis(): void {
    if (this.playbackOutputMode === 'bitperfect' || this.remoteStreamState) return
    if (!this._normalizationEnabled || this.currentNormalizationAnalysis) return
    if (this._replayGainEnabled && this.currentReplayGainDb != null) return
    const trackPath = this.currentBufferTrackPath
    if (!trackPath || !this.audioBuffer) return
    if (this.pendingCurrentLoudnessTrackPath === trackPath) return

    this.pendingCurrentLoudnessTrackPath = trackPath
    void window.electronAPI.analyzeTrackLoudness(trackPath)
      .catch(() => null)
      .then((result) => {
        if (this.pendingCurrentLoudnessTrackPath === trackPath) {
          this.pendingCurrentLoudnessTrackPath = null
        }
        if (!result || !Number.isFinite(result.loudnessLufs)) return
        if (this.currentBufferTrackPath !== trackPath || !this.audioBuffer) return
        if (this.currentNormalizationAnalysis) return
        this.currentNormalizationAnalysis = {
          loudnessLufs: result.loudnessLufs,
          peakLinear: result.peakLinear ?? 0,
          sampleRate: this.audioBuffer.sampleRate,
          frameCount: this.audioBuffer.length
        }
        this.applyNormalization()
      })
  }

  getLastLoadTimings(): AudioLoadTimings | null {
    return this.lastLoadTimings ? { ...this.lastLoadTimings } : null
  }

  // Whether loading a track with this ReplayGain candidate would need a
  // loudness analysis; lets callers pre-resolve one in parallel with decode.
  needsLoudnessAnalysisForLoad(replayGainDb: number | null | undefined): boolean {
    if (this.playbackOutputMode === 'bitperfect') return false
    return this.shouldAnalyzeLoudnessForLoad(this.normalizeReplayGainCandidate(replayGainDb))
  }

  private computeNormalizationForAnalysis(
    analysis: LoudnessAnalysis,
    options: { log?: boolean } = {}
  ): GainState {
    const normalizationGain = resolveStaticNormalizationGain({
      targetLufs: this._targetLufs,
      loudnessLufs: analysis.loudnessLufs,
      peakLinear: analysis.peakLinear,
      minGainDb: NORMALIZATION_MIN_GAIN_DB,
      maxGainDb: NORMALIZATION_MAX_GAIN_DB,
      peakCeilingLinear: NORMALIZATION_PEAK_CEILING_LINEAR
    })

    if (options.log !== false) {
      const peakNote = normalizationGain.peakLimited ? ', peak-limited' : ''
      console.log(
        `Normalization: ${analysis.loudnessLufs.toFixed(1)} LUFS -> ${this._targetLufs} LUFS ` +
        `(gain: ${normalizationGain.gainDb.toFixed(1)} dB${peakNote})`
      )
    }

    return {
      gainDb: normalizationGain.gainDb,
      linearGain: normalizationGain.linearGain,
      mode: 'normalization'
    }
  }

  private resolveGainStateForAnalysis(analysis: LoudnessAnalysis | null, replayGainDb: number | null): GainState {
    if (!this._normalizationEnabled) {
      return {
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      }
    }

    if (this._replayGainEnabled && replayGainDb != null) {
      const clampedGainDb = this.clampGainDb(replayGainDb)
      return {
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      }
    }

    if (!analysis) {
      return {
        gainDb: 0,
        linearGain: 1,
        mode: 'normalization'
      }
    }

    return this.computeNormalizationForAnalysis(analysis)
  }

  private applyParallaxSinkNormalization(): void {
    const sinkState = this.parallaxSinkState
    if (!sinkState) return

    const gainDb = sinkState.normalizationMode === 'off'
      ? 0
      : this.clampGainDb(sinkState.normalizationGainDb)

    sinkState.normalizationGainDb = gainDb
    this.normalizationApproximate = false
    this.applyGainState({
      gainDb,
      linearGain: this.toLinearGain(gainDb),
      mode: sinkState.normalizationMode
    })
  }

  private applyGainState(gainState: GainState): void {
    this._normalizationGainDb = gainState.gainDb
    this._normalizationMode = gainState.mode
    if (this.normalizationGainNode) {
      this.normalizationGainNode.gain.value = gainState.linearGain
    }
    if (this.analysisNormalizationGainNode) {
      this.analysisNormalizationGainNode.gain.value = gainState.linearGain
    }
  }

  private getCurrentNormalizationLinearGain(): number {
    if (!this._normalizationEnabled && this._normalizationMode === 'off') return 1
    return this.toLinearGain(this._normalizationGainDb)
  }

  private clearNextNormalizationCache(): void {
    this.nextNormalizationGainDb = null
    this.nextNormalizationLinearGain = null
    this.nextNormalizationMode = null
  }

  private updateNextNormalizationCache(): void {
    if (!this.nextBuffer || !this.nextNormalizationAnalysis) {
      this.clearNextNormalizationCache()
      return
    }

    const nextGain = this.resolveGainStateForAnalysis(this.nextNormalizationAnalysis, this.nextReplayGainDb)
    this.nextNormalizationGainDb = nextGain.gainDb
    this.nextNormalizationLinearGain = nextGain.linearGain
    this.nextNormalizationMode = nextGain.mode
  }

  private getPendingNextNormalization(): GainState {
    if (
      this.nextNormalizationGainDb != null
      && this.nextNormalizationLinearGain != null
      && this.nextNormalizationMode != null
    ) {
      return {
        gainDb: this.nextNormalizationGainDb,
        linearGain: this.nextNormalizationLinearGain,
        mode: this.nextNormalizationMode
      }
    }

    return this.resolveGainStateForAnalysis(this.nextNormalizationAnalysis, this.nextReplayGainDb)
  }

  private scheduleNormalizationTransition(targetLinearGain: number, transitionTime: number): void {
    if (!this.context || !this.normalizationGainNode || !this.analysisNormalizationGainNode) return

    const now = this.context.currentTime
    const currentLinearGain = this.getCurrentNormalizationLinearGain()
    const params = [this.normalizationGainNode.gain, this.analysisNormalizationGainNode.gain]

    for (const param of params) {
      param.cancelScheduledValues(now)
      param.setValueAtTime(currentLinearGain, now)
      param.setValueAtTime(targetLinearGain, transitionTime)
    }
  }

  private restoreCurrentNormalizationGainNow(): void {
    if (!this.context || !this.normalizationGainNode || !this.analysisNormalizationGainNode) return

    const now = this.context.currentTime
    const currentLinearGain = this.getCurrentNormalizationLinearGain()
    const params = [this.normalizationGainNode.gain, this.analysisNormalizationGainNode.gain]

    for (const param of params) {
      param.cancelScheduledValues(now)
      param.setValueAtTime(currentLinearGain, now)
    }
  }

  private applyNormalization(): void {
    const normalization = this.resolveGainStateForAnalysis(this.currentNormalizationAnalysis, this.currentReplayGainDb)
    this.applyGainState(normalization)
  }

  // Normalization settings
  get normalizationEnabled(): boolean {
    return this._normalizationEnabled
  }

  set normalizationEnabled(enabled: boolean) {
    this._normalizationEnabled = enabled
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    if (this.remoteStreamState) {
      this.applyRemoteNormalizationIfNeeded(this.remoteStreamState, {
        force: true,
        markComplete: this.remoteStreamState.sourceEnded
      })
      return
    }
    if (this.parallaxSinkState) {
      this.applyParallaxSinkNormalization()
      return
    }
    if (!enabled) {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    } else if (enabled && this.audioBuffer) {
      this.applyNormalization()
      this.ensureCurrentLoudnessAnalysis()
    } else {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    }

    this.updateNextNormalizationCache()
    if (this._playbackState === 'playing' && this.nextBuffer) {
      this.scheduleGaplessTransition()
    }
  }

  get targetLufs(): number {
    return this._targetLufs
  }

  set targetLufs(lufs: number) {
    this._targetLufs = lufs
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    if (this.remoteStreamState) {
      this.applyRemoteNormalizationIfNeeded(this.remoteStreamState, {
        force: true,
        markComplete: this.remoteStreamState.sourceEnded
      })
      return
    }
    if (this.parallaxSinkState) {
      this.applyParallaxSinkNormalization()
      return
    }
    if (this._normalizationEnabled && this.audioBuffer) {
      this.applyNormalization()
      this.ensureCurrentLoudnessAnalysis()
    }

    this.updateNextNormalizationCache()
    if (this._playbackState === 'playing' && this.nextBuffer) {
      this.scheduleGaplessTransition()
    }
  }

  getNormalizationGainDb(): number {
    return this._normalizationGainDb
  }

  getNormalizationMode(): GainApplicationMode {
    return this._normalizationMode
  }

  // §21 Gapless sink handoff. The pre-buffered next track + its normalization, for building the
  // pre-announced next stream's info. Normalization falls back to current if not yet computed.
  getNextAudioBuffer(): AudioBuffer | null {
    return this.nextBuffer
  }

  getNextNormalization(): { gainDb: number; mode: GainApplicationMode } {
    if (this.nextNormalizationGainDb != null && this.nextNormalizationMode != null) {
      return { gainDb: this.nextNormalizationGainDb, mode: this.nextNormalizationMode }
    }
    return { gainDb: this._normalizationGainDb, mode: this._normalizationMode }
  }

  setCurrentReplayGainDb(replayGainDb: number | null): void {
    const normalized = this.normalizeReplayGainCandidate(replayGainDb)
    if (this.currentReplayGainDb === normalized) return

    this.currentReplayGainDb = normalized
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    if (this.remoteStreamState) {
      this.applyRemoteNormalizationIfNeeded(this.remoteStreamState, {
        force: true,
        markComplete: this.remoteStreamState.sourceEnded
      })
      return
    }
    if (this.parallaxSinkState) {
      this.applyParallaxSinkNormalization()
      return
    }

    if (this.audioBuffer) {
      this.applyNormalization()
      this.ensureCurrentLoudnessAnalysis()
    } else if (!this._normalizationEnabled) {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    }

    this.updateNextNormalizationCache()
    if (this._playbackState === 'playing' && this.nextBuffer) {
      this.scheduleGaplessTransition()
    }
  }

  setReplayGainEnabled(enabled: boolean): void {
    const normalized = Boolean(enabled)
    if (this._replayGainEnabled === normalized) return

    this._replayGainEnabled = normalized
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    if (this.remoteStreamState) {
      this.remoteStreamState.normalization = this.remoteStreamState.sourceType === 'local'
        ? null
        : this._replayGainEnabled && this.currentReplayGainDb != null
          ? null
          : this.remoteStreamState.normalization ?? this.createProgressiveNormalizationAccumulator(this.remoteStreamState.sampleRate)
      this.applyRemoteNormalizationIfNeeded(this.remoteStreamState, {
        force: true,
        markComplete: this.remoteStreamState.sourceEnded
      })
      return
    }
    if (this.parallaxSinkState) {
      this.applyParallaxSinkNormalization()
      return
    }

    if (this.audioBuffer) {
      this.applyNormalization()
      this.ensureCurrentLoudnessAnalysis()
    } else if (!this._normalizationEnabled) {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    }

    this.updateNextNormalizationCache()
    if (this._playbackState === 'playing' && this.nextBuffer) {
      this.scheduleGaplessTransition()
    }
  }

  // Event emitter methods
  on(event: string, callback: EventCallback): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)!.add(callback)
    return () => {
      this.off(event, callback)
    }
  }

  off(event: string, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback)
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach(cb => cb(...args))
  }

  // Getters
  get playbackState(): PlaybackState {
    return this._playbackState
  }

  get volume(): number {
    return this._volume
  }

  get isMuted(): boolean {
    return this._isMuted
  }

  get currentTime(): number {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.currentTime ?? 0
    }
    if (this.remoteStreamState) {
      return this.remoteStreamState.sampleRate > 0
        ? (this.remoteStreamState.startFrame + this.remoteStreamState.currentFrame) / this.remoteStreamState.sampleRate
        : 0
    }
    if (this.parallaxSinkState) {
      return this.parallaxSinkState.sampleRate > 0
        ? this.parallaxSinkState.currentFrame / this.parallaxSinkState.sampleRate
        : 0
    }
    if (!this.context || this._playbackState === 'stopped' || this._playbackState === 'loading') return 0
    if (this._playbackState === 'paused') return this.pauseTime
    return this.context.currentTime - this.startTime
  }

  get duration(): number {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.duration ?? 0
    }
    if (this.remoteStreamState) {
      return this.remoteStreamState.durationSeconds
    }
    if (this.parallaxSinkState) {
      return this.parallaxSinkState.durationSeconds
    }
    return this.audioBuffer?.duration ?? 0
  }

  getAudioBuffer(): AudioBuffer | null {
    return this.audioBuffer
  }

  async getBufferMemoryStats(): Promise<AudioBufferMemoryStats> {
    if (this.playbackOutputMode === 'bitperfect') {
      try {
        return await window.nativeAudioAPI.getBufferMemoryStats()
      } catch {
        return { ...EMPTY_AUDIO_BUFFER_MEMORY_STATS }
      }
    }

    const currentBytes = this.getDecodedAudioBufferBytes(this.audioBuffer)
    const nextBytes = this.getDecodedAudioBufferBytes(this.nextBuffer)
    return {
      currentBytes,
      nextBytes,
      totalBytes: currentBytes + nextBytes
    }
  }

  getCurrentTrackChannelCount(): number | null {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.channels ?? null
    }
    if (this.remoteStreamState) {
      return this.remoteStreamState.channels
    }
    if (this.parallaxSinkState) {
      return this.parallaxSinkState.channels
    }
    return this.audioBuffer?.numberOfChannels ?? null
  }

  getRemoteBufferedSeconds(): number {
    if (!this.remoteStreamState || this.remoteStreamState.sampleRate <= 0) return 0
    return (this.remoteStreamState.startFrame + this.remoteStreamState.bufferedFrames) / this.remoteStreamState.sampleRate
  }

  isNormalizationApproximate(): boolean {
    return this.normalizationApproximate
  }

  getDiagnosticsSnapshot(): {
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
    parallaxSinkActive: boolean
    parallaxSinkStreamId: string | null
    parallaxSinkBufferedFrames: number
    parallaxSinkUnderruns: number
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
  } {
    const currentBufferBytes = this.getDecodedAudioBufferBytes(this.audioBuffer)
    const nextBufferBytes = this.getDecodedAudioBufferBytes(this.nextBuffer)
    const activeVisualizerScopes = SCOPE_KINDS.filter((scope) => this.hasVisualizerDemand(scope))
    const activeMiniVisualizerModes: Array<'spectrum' | 'oscilloscope'> = []
    if (this.hasMiniVisualizerDemand('spectrum')) {
      activeMiniVisualizerModes.push('spectrum')
    }
    if (this.hasMiniVisualizerDemand('oscilloscope')) {
      activeMiniVisualizerModes.push('oscilloscope')
    }
    const gaplessTargetDeltaSeconds = this.context && this.scheduledEndTime > 0
      ? Math.max(0, this.scheduledEndTime - this.context.currentTime)
      : null
    const pendingVisualizerChunksTotal =
      this.pendingOscilloscopeSamples.length +
      this.pendingSpectrumSamples.length +
      this.pendingSpectrogramSamples.length +
      this.pendingVectorscopeSamples.length +
      this.pendingVUMeterSamples.length +
      this.pendingLUFSMeterSamples.length +
      this.pendingWaveformSamples.length +
      this.pendingMiniVisualizerChunks.length

    return {
      playbackOutputMode: this.playbackOutputMode,
      bitPerfectActive: this.isBitPerfectActive(),
      hasContext: this.context !== null,
      hasAudioBuffer: this.audioBuffer !== null,
      hasNextBuffer: this.nextBuffer !== null,
      currentBufferTrackPath: this.currentBufferTrackPath,
      nextBufferTrackPath: this.nextBufferTrackPath,
      currentBufferBytes,
      nextBufferBytes,
      totalBufferBytes: currentBufferBytes + nextBufferBytes,
      nativeNextTrackBuffered: this.nativeNextTrackBuffered,
      gaplessScheduled: this.nextSourceNode !== null || this.nativeNextTrackBuffered,
      gaplessTargetDeltaSeconds,
      remoteStreamActive: this.remoteStreamState !== null,
      remoteStreamSessionId: this.remoteStreamState?.sessionId ?? null,
      remoteStreamSourceType: this.remoteStreamState?.sourceType ?? null,
      remoteBufferedSeconds: this.getRemoteBufferedSeconds(),
      remoteBufferedFrames: this.remoteStreamState?.bufferedFrames ?? 0,
      remoteAnalyzedFrames: this.remoteStreamState?.analyzedFrames ?? 0,
      parallaxSinkActive: this.parallaxSinkState !== null,
      parallaxSinkStreamId: this.parallaxSinkState?.streamId ?? null,
      parallaxSinkBufferedFrames: this.parallaxSinkState?.bufferedFrames ?? 0,
      parallaxSinkUnderruns: this.parallaxSinkState?.underruns ?? 0,
      normalizationApproximate: this.normalizationApproximate,
      visualizerConsumerCount: this.visualizerConsumerDemand.size,
      activeVisualizerScopes,
      activeMiniVisualizerModes,
      pendingOscilloscopeChunks: this.pendingOscilloscopeSamples.length,
      pendingSpectrumChunks: this.pendingSpectrumSamples.length,
      pendingSpectrogramChunks: this.pendingSpectrogramSamples.length,
      pendingVectorscopeChunks: this.pendingVectorscopeSamples.length,
      pendingVUMeterChunks: this.pendingVUMeterSamples.length,
      pendingLUFSMeterChunks: this.pendingLUFSMeterSamples.length,
      pendingWaveformChunks: this.pendingWaveformSamples.length,
      pendingMiniVisualizerChunks: this.pendingMiniVisualizerChunks.length,
      pendingVisualizerChunksTotal
    }
  }

  // Get actual sample rate from AudioContext (for native DSP sync)
  getSampleRate(): number {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.sampleRate
        ?? this.nativeCapabilities.activeSampleRate
        ?? 48000
    }
    return this.context?.sampleRate ?? 48000
  }

  // Get post-EQ analyser node for spectrum overlay
  getEQAnalyserNode(): AnalyserNode | null {
    if (this.playbackOutputMode === 'bitperfect' || this.shouldBypassStandardAnalysisGraph()) {
      return null
    }
    return this.eqDisplayAnalyserNode ?? this.eqAnalyserNode
  }

  getOutputMaxChannelCount(): number | null {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeCapabilities.selectedDeviceMaxChannels ?? null
    }
    return this.context?.destination.maxChannelCount ?? null
  }

  async setAnalysisDelayMs(ms: number): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      this.analysisDelayMs = 0
      return
    }
    await this.initContext()
    const safeMs = Number.isFinite(ms) ? ms : 0
    const clampedMs = Math.max(0, Math.min(ANALYSIS_DELAY_MAX_MS, safeMs))
    this.analysisDelayMs = clampedMs

    if (this.context) {
      if (this.analysisDelayNode) {
        this.analysisDelayNode.delayTime.setValueAtTime(clampedMs / 1000, this.context.currentTime)
      }
      if (this.eqAnalysisDelayNode) {
        this.eqAnalysisDelayNode.delayTime.setValueAtTime(clampedMs / 1000, this.context.currentTime)
      }
    }
  }

  async runOutputDelayCalibration(inputDeviceId: string = ''): Promise<OutputDelayCalibrationResult> {
    if (this.playbackOutputMode === 'bitperfect') {
      return {
        ok: false,
        code: 'not-supported',
        message: BIT_PERFECT_UNSUPPORTED_MESSAGE
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return {
        ok: false,
        code: 'not-supported',
        message: 'Microphone calibration is not supported in this browser.'
      }
    }

    await this.initContext()
    if (!this.context) {
      return {
        ok: false,
        code: 'not-supported',
        message: 'Audio context is unavailable for calibration.'
      }
    }
    if (!this.workletLoaded) {
      return {
        ok: false,
        code: 'worklet-unavailable',
        message: 'Audio worklet is unavailable for calibration.'
      }
    }

    if (this.context.state === 'suspended') {
      await this.context.resume()
    }

    const normalizedInputDeviceId = inputDeviceId.trim()
    const selectedInputDeviceId = (
      normalizedInputDeviceId.length > 0 && normalizedInputDeviceId !== 'default'
    )
      ? normalizedInputDeviceId
      : null

    let stream: MediaStream
    try {
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }

      if (selectedInputDeviceId) {
        audioConstraints.deviceId = { exact: selectedInputDeviceId }
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      })
    } catch (error) {
      const code = this.isLikelyPermissionDenied(error) ? 'mic-denied' : 'mic-unavailable'
      return {
        ok: false,
        code,
        message: code === 'mic-denied'
          ? 'Microphone permission was denied for calibration.'
          : 'Microphone is unavailable for calibration.'
      }
    }

    try {
      const audioTrack = stream.getAudioTracks()[0] ?? null
      const trackSettings = audioTrack?.getSettings?.()
      const rawInputLatencySeconds = (
        trackSettings as (MediaTrackSettings & { latency?: number }) | undefined
      )?.latency
      const inputLatencyMs = this.normalizeReportedLatencyMs(rawInputLatencySeconds)
      const outputLatencyMs = this.normalizeReportedLatencyMs(this.context.outputLatency)
      const baseLatencyMs = this.normalizeReportedLatencyMs(this.context.baseLatency)

      const micSource = this.context.createMediaStreamSource(stream)
      const toneSignal = this.createCalibrationToneSignal()
      const successfulPasses: Array<{ roundTripMs: number; confidence: number }> = []
      let lastFailure: OutputDelayCalibrationResult = {
        ok: false,
        code: 'low-confidence',
        message: 'Could not detect a reliable calibration response.'
      }

      for (let passIndex = 0; passIndex < CALIBRATION_PASSES; passIndex++) {
        const passResult = await this.runSingleCalibrationPass(micSource, toneSignal)
        if (passResult.ok) {
          successfulPasses.push({
            roundTripMs: passResult.roundTripMs,
            confidence: passResult.confidence
          })
        } else {
          lastFailure = passResult
          if (passResult.code === 'mic-denied' || passResult.code === 'mic-unavailable') {
            break
          }
        }

        if (passIndex < CALIBRATION_PASSES - 1) {
          await this.sleep(120)
        }
      }

      try {
        micSource.disconnect()
      } catch {
        // Ignore disconnect failures during calibration cleanup.
      }

      if (successfulPasses.length < CALIBRATION_MIN_SUCCESSFUL_PASSES) {
        return lastFailure
      }

      const roundTrips = successfulPasses
        .map((entry) => entry.roundTripMs)
        .sort((a, b) => a - b)
      const medianRoundTrip = roundTrips[Math.floor(roundTrips.length / 2)]
      const averageConfidence = successfulPasses.reduce((sum, entry) => sum + entry.confidence, 0) / successfulPasses.length
      const quantizedRoundTrip = Math.round(medianRoundTrip / 5) * 5
      const minRoundTrip = roundTrips[0]
      const maxRoundTrip = roundTrips[roundTrips.length - 1]
      const roundTripSpreadMs = maxRoundTrip - minRoundTrip
      const nearUpperBound = quantizedRoundTrip >= (CALIBRATION_RTT_MAX_MS - CALIBRATION_EDGE_LOCK_MARGIN_MS)

      if (
        nearUpperBound
        && (
          averageConfidence < CALIBRATION_EDGE_LOCK_MIN_CONFIDENCE
          && roundTripSpreadMs > CALIBRATION_EDGE_LOCK_MAX_SPREAD_MS
        )
      ) {
        return {
          ok: false,
          code: 'low-confidence',
          message: `Calibration locked near max RTT (${quantizedRoundTrip} ms) with weak confidence/spread. Try calibrating again at higher output volume or quieter conditions.`
        }
      }

      return {
        ok: true,
        roundTripMs: Math.max(0, Math.min(CALIBRATION_RTT_MAX_MS, quantizedRoundTrip)),
        confidence: Math.round(averageConfidence * 1000) / 1000,
        sampleRate: this.context.sampleRate,
        inputLatencyMs,
        outputLatencyMs,
        baseLatencyMs
      }
    } catch (error) {
      console.error('Output delay calibration failed:', error)
      return {
        ok: false,
        code: 'unknown',
        message: 'Calibration failed unexpectedly.'
      }
    } finally {
      stream.getTracks().forEach((track) => track.stop())
    }
  }

  /**
   * Differential dual-output BT latency calibration.
   *
   * Plays staggered chirps through reference and BT outputs into a single mic.
   * Mic latency cancels algebraically when comparing per-fire offsets.
   */
  async runDifferentialCalibration(
    btDeviceId: string,
    referenceDeviceId: string = '',
    inputDeviceId: string = ''
  ): Promise<DifferentialCalibrationResult> {
    if (this.playbackOutputMode === 'bitperfect') {
      return {
        ok: false,
        code: 'not-supported',
        message: BIT_PERFECT_UNSUPPORTED_MESSAGE
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return {
        ok: false,
        code: 'not-supported',
        message: 'Microphone calibration is not supported in this browser.'
      }
    }

    let supportProbe: AudioContext | null = null
    try {
      supportProbe = new AudioContext()
      if (!('setSinkId' in supportProbe)) {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Differential calibration requires setSinkId support in this browser.'
        }
      }
    } catch {
      return {
        ok: false,
        code: 'not-supported',
        message: 'Differential calibration is not supported in this environment.'
      }
    } finally {
      if (supportProbe) {
        try {
          await supportProbe.close()
        } catch {
          // Ignore probe cleanup failures.
        }
      }
    }

    const normalizedBtDeviceId = btDeviceId.trim()
    const normalizedReferenceDeviceId = referenceDeviceId.trim()
    const normalizedInputDeviceId = inputDeviceId.trim()

    let stream: MediaStream
    try {
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }

      if (normalizedInputDeviceId.length > 0 && normalizedInputDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: normalizedInputDeviceId }
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      })
    } catch (error) {
      const code = this.isLikelyPermissionDenied(error) ? 'mic-denied' : 'mic-unavailable'
      return {
        ok: false,
        code,
        message: code === 'mic-denied'
          ? 'Microphone permission was denied for differential calibration.'
          : 'Microphone is unavailable for differential calibration.'
      }
    }

    let btContext: AudioContext | null = null
    let refContext: AudioContext | null = null
    let btWarmupSource: AudioBufferSourceNode | null = null

    try {
      btContext = new AudioContext()
      refContext = new AudioContext()

      const setSinkId = (ctx: AudioContext, sinkId: string): Promise<void> => {
        return (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(sinkId)
      }

      try {
        await setSinkId(
          btContext,
          normalizedBtDeviceId.length > 0 && normalizedBtDeviceId !== 'default'
            ? normalizedBtDeviceId
            : ''
        )
      } catch {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Could not route Bluetooth output for differential calibration.'
        }
      }
      const btSinkId = (btContext as AudioContext & { sinkId?: unknown }).sinkId
      if (
        normalizedBtDeviceId.length > 0
        && normalizedBtDeviceId !== 'default'
        && typeof btSinkId === 'string'
        && btSinkId.length > 0
        && btSinkId !== normalizedBtDeviceId
      ) {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Bluetooth output routing did not apply to the selected device.'
        }
      }

      try {
        await setSinkId(
          refContext,
          normalizedReferenceDeviceId.length > 0 && normalizedReferenceDeviceId !== 'default'
            ? normalizedReferenceDeviceId
            : ''
        )
      } catch {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Could not route reference output for differential calibration.'
        }
      }
      const refSinkId = (refContext as AudioContext & { sinkId?: unknown }).sinkId
      if (
        normalizedReferenceDeviceId.length > 0
        && normalizedReferenceDeviceId !== 'default'
        && typeof refSinkId === 'string'
        && refSinkId.length > 0
        && refSinkId !== normalizedReferenceDeviceId
      ) {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Reference output routing did not apply to the selected device.'
        }
      }

      await btContext.resume()
      await refContext.resume()
      if (btContext.state !== 'running' || refContext.state !== 'running') {
        return {
          ok: false,
          code: 'not-supported',
          message: 'Audio outputs are not active for differential calibration.'
        }
      }

      try {
        const warmupBuffer = btContext.createBuffer(
          1,
          Math.max(1, Math.round(btContext.sampleRate * 0.25)),
          btContext.sampleRate
        )
        btWarmupSource = btContext.createBufferSource()
        btWarmupSource.buffer = warmupBuffer
        btWarmupSource.loop = true
        btWarmupSource.connect(btContext.destination)
        btWarmupSource.start()
      } catch (error) {
        console.warn('Failed to start differential Bluetooth warmup audio:', error)
      }

      try {
        await btContext.audioWorklet.addModule('./oscilloscope-worklet.js')
      } catch {
        return {
          ok: false,
          code: 'worklet-unavailable',
          message: 'Audio worklet is unavailable for differential calibration.'
        }
      }

      const captureRate = btContext.sampleRate
      const btTone = this.createCalibrationToneSignalForContext(btContext, {
        startFreqHz: DIFFERENTIAL_START_FREQ_HZ,
        endFreqHz: DIFFERENTIAL_END_FREQ_HZ
      })
      const refTone = this.createCalibrationToneSignalForContext(refContext, {
        startFreqHz: DIFFERENTIAL_START_FREQ_HZ,
        endFreqHz: DIFFERENTIAL_END_FREQ_HZ
      })

      // Preview only on reference output so users can confirm routing before the measurement run.
      const referencePreviewSource = refContext.createBufferSource()
      referencePreviewSource.buffer = refTone.buffer
      const referencePreviewGain = refContext.createGain()
      referencePreviewGain.gain.value = CALIBRATION_OUTPUT_GAIN
      referencePreviewSource.connect(referencePreviewGain)
      referencePreviewGain.connect(refContext.destination)
      referencePreviewSource.start(refContext.currentTime + (DIFFERENTIAL_REFERENCE_PREVIEW_DELAY_MS / 1000))

      await this.sleep(
        DIFFERENTIAL_REFERENCE_PREVIEW_DELAY_MS
        + Math.round(CALIBRATION_CHIRP_DURATION_SEC * 1000)
        + DIFFERENTIAL_REFERENCE_PREVIEW_TAIL_MS
      )

      const captureNode = new AudioWorkletNode(btContext, 'calibration-capture-processor')
      const captureSink = btContext.createGain()
      captureSink.gain.value = 0
      captureSink.connect(btContext.destination)

      const micSource = btContext.createMediaStreamSource(stream)
      micSource.connect(captureNode)
      captureNode.connect(captureSink)

      const captureChunks: Float32Array[] = []
      captureNode.port.onmessage = (event: MessageEvent<{ samples?: Float32Array }>) => {
        const samples = event.data?.samples
        if (!samples || samples.length === 0) return
        captureChunks.push(new Float32Array(samples))
      }

      const minScheduleGuardSec = 0.08
      const headroomSec = DIFFERENTIAL_SCHEDULE_HEADROOM_MS / 1000
      const staggerSec = DIFFERENTIAL_STAGGER_MS / 1000
      const captureStartContextTime = btContext.currentTime

      // Primary schedule path: use each context's own timeline to avoid cross-context drift bugs.
      let refFireAt = refContext.currentTime + headroomSec
      let wiredFireInBtContext = btContext.currentTime + headroomSec
      let btFireAt = btContext.currentTime + headroomSec + staggerSec

      // Optional refinement via getOutputTimestamp mapping. If mapping looks invalid,
      // keep the timeline-local schedule above.
      const btClock = this.getContextClockSnapshot(btContext)
      const refClock = this.getContextClockSnapshot(refContext)
      const scheduleWallNowMs = performance.now()
      const wiredWallFireMs = scheduleWallNowMs + DIFFERENTIAL_SCHEDULE_HEADROOM_MS
      const mappedRefFireAt = refClock.contextTime + ((wiredWallFireMs - refClock.performanceTime) / 1000)
      const mappedWiredFireInBtContext = btClock.contextTime + ((wiredWallFireMs - btClock.performanceTime) / 1000)
      const mappedBtFireAt = mappedWiredFireInBtContext + staggerSec
      const mappedTimesAreUsable = (
        Number.isFinite(mappedRefFireAt)
        && Number.isFinite(mappedWiredFireInBtContext)
        && Number.isFinite(mappedBtFireAt)
        && mappedRefFireAt >= (refContext.currentTime + minScheduleGuardSec)
        && mappedBtFireAt >= (btContext.currentTime + minScheduleGuardSec)
      )
      if (mappedTimesAreUsable) {
        refFireAt = mappedRefFireAt
        wiredFireInBtContext = mappedWiredFireInBtContext
        btFireAt = mappedBtFireAt
      }

      refFireAt = Math.max(refFireAt, refContext.currentTime + minScheduleGuardSec)
      wiredFireInBtContext = Math.max(wiredFireInBtContext, btContext.currentTime + minScheduleGuardSec)
      btFireAt = Math.max(
        btFireAt,
        btContext.currentTime + minScheduleGuardSec + staggerSec,
        wiredFireInBtContext + staggerSec
      )

      const captureLeadInSamples = Math.max(
        0,
        Math.round((wiredFireInBtContext - captureStartContextTime) * captureRate)
      )
      const staggerSamples = Math.max(
        0,
        Math.round((DIFFERENTIAL_STAGGER_MS / 1000) * captureRate)
      )

      const refSource = refContext.createBufferSource()
      refSource.buffer = refTone.buffer
      const refGain = refContext.createGain()
      refGain.gain.value = CALIBRATION_OUTPUT_GAIN
      refSource.connect(refGain)
      refGain.connect(refContext.destination)

      const btSource = btContext.createBufferSource()
      btSource.buffer = btTone.buffer
      const btGain = btContext.createGain()
      btGain.gain.value = Math.min(1, CALIBRATION_OUTPUT_GAIN * DIFFERENTIAL_BT_GAIN_MULTIPLIER)
      btSource.connect(btGain)
      btGain.connect(btContext.destination)

      refSource.start(refFireAt)
      btSource.start(btFireAt)

      const captureDurationMs = (
        DIFFERENTIAL_SCHEDULE_HEADROOM_MS
        + DIFFERENTIAL_STAGGER_MS
        + DIFFERENTIAL_BT_SEARCH_WINDOW_MS
        + 450
      )
      await this.sleep(captureDurationMs)

      const capturedSignal = this.combineFloat32Chunks(captureChunks)
      if (capturedSignal.length === 0) {
        return {
          ok: false,
          code: 'timeout',
          message: 'No microphone signal was captured during differential calibration.'
        }
      }

      const estimate = this.estimateDifferentialDelay(
        capturedSignal,
        captureRate,
        btTone.referenceSequence,
        captureLeadInSamples,
        staggerSamples
      )
      if (!estimate) {
        return {
          ok: false,
          code: 'low-confidence',
          message: 'Could not find both differential chirp arrivals. Ensure both outputs are audible to the mic and retry.'
        }
      }

      const refOutputLatencyMs = (
        (this.normalizeReportedLatencyMs(refContext.outputLatency) ?? 0)
        + (this.normalizeReportedLatencyMs(refContext.baseLatency) ?? 0)
      )
      const knownRefOutputLatencyMs = refOutputLatencyMs > 0
        ? refOutputLatencyMs
        : DIFFERENTIAL_WIRED_FALLBACK_LATENCY_MS

      const btOutputLatencyMs = Math.max(
        0,
        (((estimate.offsetBtSamples - estimate.offsetWiredSamples) / captureRate) * 1000)
          + knownRefOutputLatencyMs
      )

      const impliedMicAndPropagationMs = (
        ((estimate.offsetWiredSamples / captureRate) * 1000)
        - knownRefOutputLatencyMs
      )
      const propagationBiasWarning = impliedMicAndPropagationMs > 60

      return {
        ok: true,
        btOutputLatencyMs,
        refOutputLatencyMs: knownRefOutputLatencyMs,
        propagationBiasWarning,
        confidence: Math.max(0, Math.min(1, estimate.confidence)),
        sampleRate: captureRate
      }
    } catch (error) {
      console.error('Differential output delay calibration failed:', error)
      return {
        ok: false,
        code: 'unknown',
        message: 'Differential calibration failed unexpectedly.'
      }
    } finally {
      if (btWarmupSource) {
        try {
          btWarmupSource.stop()
        } catch {
          // Ignore warmup stop failures.
        }
        try {
          btWarmupSource.disconnect()
        } catch {
          // Ignore warmup disconnect failures.
        }
      }
      stream.getTracks().forEach((track) => track.stop())
      if (btContext) {
        try {
          await btContext.close()
        } catch {
          // Ignore context close failures.
        }
      }
      if (refContext) {
        try {
          await refContext.close()
        } catch {
          // Ignore context close failures.
        }
      }
    }
  }

  private async runSingleCalibrationPass(
    micSource: MediaStreamAudioSourceNode,
    toneSignal: CalibrationToneSignal
  ): Promise<OutputDelayCalibrationPassResult> {
    if (!this.context || !this.workletLoaded) {
      return {
        ok: false,
        code: 'worklet-unavailable',
        message: 'Calibration processor is unavailable.'
      }
    }

    const captureNode = new AudioWorkletNode(this.context, 'calibration-capture-processor')
    const captureSink = this.context.createGain()
    captureSink.gain.value = 0

    const playbackGain = this.context.createGain()
    playbackGain.gain.value = CALIBRATION_OUTPUT_GAIN

    const playbackSource = this.context.createBufferSource()
    playbackSource.buffer = toneSignal.buffer

    const captureChunks: Float32Array[] = []
    captureNode.port.onmessage = (event: MessageEvent<{ samples?: Float32Array }>) => {
      const samples = event.data?.samples
      if (!samples || samples.length === 0) return
      captureChunks.push(new Float32Array(samples))
    }

    try {
      micSource.connect(captureNode)
      captureNode.connect(captureSink)
      captureSink.connect(this.context.destination)

      playbackSource.connect(playbackGain)
      playbackGain.connect(this.context.destination)

      const toneStartAt = this.context.currentTime + 0.05
      playbackSource.start(toneStartAt)

      await this.sleep(CALIBRATION_CAPTURE_WINDOW_SEC * 1000)

      const capturedSignal = this.combineFloat32Chunks(captureChunks)
      if (capturedSignal.length === 0) {
        return {
          ok: false,
          code: 'timeout',
          message: 'No microphone signal was captured during calibration.'
        }
      }

      const estimate = this.estimateDelayFromCapture(
        capturedSignal,
        this.context.sampleRate,
        toneSignal.referenceSequence,
        toneSignal.leadInSamples
      )

      if (!estimate
        || estimate.correlation < CALIBRATION_MIN_CORRELATION
        || estimate.confidence < CALIBRATION_MIN_CONFIDENCE
      ) {
        const correlation = estimate ? Math.round(estimate.correlation * 100) / 100 : null
        const peakRatio = estimate ? Math.round(estimate.peakRatio * 100) / 100 : null
        return {
          ok: false,
          code: 'low-confidence',
          message: `Calibration signal was too noisy (corr ${correlation ?? 'n/a'}, peak ${peakRatio ?? 'n/a'}). Try raising output volume, moving mic closer, and selecting a specific calibration input.`
        }
      }

      return {
        ok: true,
        roundTripMs: estimate.roundTripMs,
        confidence: estimate.confidence
      }
    } finally {
      captureNode.port.onmessage = null
      try {
        micSource.disconnect(captureNode)
      } catch {
        // Ignore cleanup disconnect failures.
      }
      try {
        playbackSource.stop()
      } catch {
        // Ignore stop errors if already stopped.
      }
      try {
        playbackSource.disconnect()
      } catch {
        // Ignore cleanup disconnect failures.
      }
      try {
        playbackGain.disconnect()
      } catch {
        // Ignore cleanup disconnect failures.
      }
      try {
        captureNode.disconnect()
      } catch {
        // Ignore cleanup disconnect failures.
      }
      try {
        captureSink.disconnect()
      } catch {
        // Ignore cleanup disconnect failures.
      }
    }
  }

  private createCalibrationToneSignal(): CalibrationToneSignal {
    if (!this.context) {
      throw new Error('AudioContext not initialized')
    }

    const sampleRate = this.context.sampleRate
    const burst = this.createChirpBurst(sampleRate)
    const burstSamples = burst.length
    const gapSamples = Math.max(0, Math.round(CALIBRATION_GAP_SEC * sampleRate))
    const leadInSamples = Math.max(0, Math.round(CALIBRATION_LEAD_IN_SEC * sampleRate))
    const totalSamples = leadInSamples
      + (burstSamples * CALIBRATION_BURST_COUNT)
      + (gapSamples * Math.max(0, CALIBRATION_BURST_COUNT - 1))

    const sequence = new Float32Array(totalSamples)
    let writeIndex = leadInSamples

    for (let burstIndex = 0; burstIndex < CALIBRATION_BURST_COUNT; burstIndex++) {
      const weight = CALIBRATION_BURST_WEIGHTS[burstIndex] ?? (burstIndex % 2 === 0 ? 1 : -1)
      for (let sampleIndex = 0; sampleIndex < burst.length; sampleIndex++) {
        sequence[writeIndex + sampleIndex] = burst[sampleIndex] * weight
      }
      writeIndex += burstSamples
      if (burstIndex < CALIBRATION_BURST_COUNT - 1) {
        writeIndex += gapSamples
      }
    }

    const buffer = this.context.createBuffer(1, totalSamples, sampleRate)
    buffer.copyToChannel(sequence, 0)

    return {
      buffer,
      referenceSequence: sequence,
      leadInSamples
    }
  }

  private createCalibrationToneSignalForContext(
    ctx: AudioContext,
    options: { startFreqHz?: number; endFreqHz?: number } = {}
  ): CalibrationToneSignal {
    const sampleRate = ctx.sampleRate
    const burst = this.createChirpBurst(
      sampleRate,
      options.startFreqHz ?? CALIBRATION_START_FREQ_HZ,
      options.endFreqHz ?? CALIBRATION_END_FREQ_HZ
    )
    const burstSamples = burst.length
    const gapSamples = Math.max(0, Math.round(CALIBRATION_GAP_SEC * sampleRate))
    const leadInSamples = Math.max(0, Math.round(CALIBRATION_LEAD_IN_SEC * sampleRate))
    const totalSamples = leadInSamples
      + (burstSamples * CALIBRATION_BURST_COUNT)
      + (gapSamples * Math.max(0, CALIBRATION_BURST_COUNT - 1))

    const sequence = new Float32Array(totalSamples)
    let writeIndex = leadInSamples

    for (let burstIndex = 0; burstIndex < CALIBRATION_BURST_COUNT; burstIndex++) {
      const weight = CALIBRATION_BURST_WEIGHTS[burstIndex] ?? (burstIndex % 2 === 0 ? 1 : -1)
      for (let sampleIndex = 0; sampleIndex < burst.length; sampleIndex++) {
        sequence[writeIndex + sampleIndex] = burst[sampleIndex] * weight
      }
      writeIndex += burstSamples
      if (burstIndex < CALIBRATION_BURST_COUNT - 1) {
        writeIndex += gapSamples
      }
    }

    const buffer = ctx.createBuffer(1, totalSamples, sampleRate)
    buffer.copyToChannel(sequence, 0)
    return {
      buffer,
      referenceSequence: sequence,
      leadInSamples
    }
  }

  private createChirpBurst(
    sampleRate: number,
    startFreqHz: number = CALIBRATION_START_FREQ_HZ,
    endFreqHz: number = CALIBRATION_END_FREQ_HZ
  ): Float32Array {
    const burstSamples = Math.max(256, Math.round(CALIBRATION_CHIRP_DURATION_SEC * sampleRate))
    const chirp = new Float32Array(burstSamples)
    const safeStartFreqHz = Math.max(80, startFreqHz)
    const safeEndFreqHz = Math.max(safeStartFreqHz + 10, endFreqHz)
    const frequencyRatio = safeEndFreqHz / safeStartFreqHz
    let phase = 0

    for (let i = 0; i < burstSamples; i++) {
      const t = burstSamples > 1 ? i / (burstSamples - 1) : 0
      const frequency = safeStartFreqHz * Math.pow(frequencyRatio, t)
      phase += (2 * Math.PI * frequency) / sampleRate
      const window = 0.5 - (0.5 * Math.cos(2 * Math.PI * t))
      chirp[i] = Math.sin(phase) * window
    }

    return chirp
  }

  private estimateDelayFromCapture(
    capturedSignal: Float32Array,
    sampleRate: number,
    referenceSequence: Float32Array,
    leadInSamples: number
  ): { roundTripMs: number; correlation: number; peakRatio: number; confidence: number } | null {
    const processedCapture = this.preprocessCalibrationSignal(capturedSignal, sampleRate)
    const processedReference = this.preprocessCalibrationSignal(referenceSequence, sampleRate)
    const reducedCapture = this.downsampleForCorrelation(processedCapture, CALIBRATION_DOWNSAMPLE_FACTOR)
    const reducedReference = this.downsampleForCorrelation(processedReference, CALIBRATION_DOWNSAMPLE_FACTOR)
    if (reducedCapture.length <= reducedReference.length || reducedReference.length < 16) {
      return null
    }

    const reducedRate = sampleRate / CALIBRATION_DOWNSAMPLE_FACTOR
    const leadInReduced = Math.max(0, Math.floor(leadInSamples / CALIBRATION_DOWNSAMPLE_FACTOR))
    const maxDelaySamples = Math.floor((CALIBRATION_RTT_MAX_MS / 1000) * reducedRate)
    const preRollSamples = Math.floor(CALIBRATION_PRE_ROLL_SEC * reducedRate)
    const tailSamples = Math.floor(CALIBRATION_SEARCH_TAIL_SEC * reducedRate)
    const peakSeparationSamples = Math.max(1, Math.floor(CALIBRATION_PEAK_SEPARATION_SEC * reducedRate))

    const searchStart = Math.max(0, leadInReduced - preRollSamples)
    const maxSearchIndex = reducedCapture.length - reducedReference.length
    const searchEnd = Math.min(maxSearchIndex, leadInReduced + maxDelaySamples + tailSamples)
    if (searchEnd <= searchStart) {
      return null
    }

    let referenceEnergy = 0
    for (let i = 0; i < reducedReference.length; i++) {
      const value = reducedReference[i]
      referenceEnergy += value * value
    }
    if (referenceEnergy <= 1e-12) {
      return null
    }

    const searchLength = searchEnd - searchStart + 1
    const correlations = new Float32Array(searchLength)
    const segmentEnergies = new Float32Array(searchLength)
    let bestCorrelation = Number.NEGATIVE_INFINITY
    let bestIndex = -1
    let maxSegmentEnergy = 0

    for (let startIndex = searchStart; startIndex <= searchEnd; startIndex++) {
      let dot = 0
      let segmentEnergy = 0
      for (let i = 0; i < reducedReference.length; i++) {
        const captured = reducedCapture[startIndex + i]
        const reference = reducedReference[i]
        dot += captured * reference
        segmentEnergy += captured * captured
      }

      const correlationIndex = startIndex - searchStart
      segmentEnergies[correlationIndex] = segmentEnergy
      if (segmentEnergy > maxSegmentEnergy) {
        maxSegmentEnergy = segmentEnergy
      }
      if (segmentEnergy <= 1e-12) {
        correlations[correlationIndex] = Number.NEGATIVE_INFINITY
        continue
      }
      const correlation = dot / Math.sqrt(segmentEnergy * referenceEnergy)
      correlations[correlationIndex] = correlation
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestIndex = startIndex
      }
    }

    if (!Number.isFinite(bestCorrelation) || bestIndex < 0) {
      return null
    }
    const globalBestCorrelation = bestCorrelation

    const directPathEnergyThreshold = maxSegmentEnergy * CALIBRATION_MIN_RELATIVE_SEGMENT_ENERGY
    const bestHighEnergy = this.findBestHighEnergyCorrelationIndex(
      correlations,
      segmentEnergies,
      searchStart,
      directPathEnergyThreshold
    )
    if (bestHighEnergy) {
      bestIndex = bestHighEnergy.index
      bestCorrelation = bestHighEnergy.correlation
    }

    // Prefer the earliest strong candidate near the best-correlation solution.
    const directPathCorrelationThreshold = Math.max(
      CALIBRATION_MIN_CORRELATION,
      bestCorrelation * CALIBRATION_DIRECT_PATH_RELATIVE_THRESHOLD
    )
    const selectedPeak = this.selectDirectPathCandidate(
      correlations,
      segmentEnergies,
      searchStart,
      directPathCorrelationThreshold,
      directPathEnergyThreshold,
      peakSeparationSamples
    )
    let selectedIndex = selectedPeak?.index ?? bestIndex
    let selectedCorrelation = selectedPeak?.correlation ?? bestCorrelation
    const aliasAdjustedPeak = this.resolveBurstPeriodAliasCandidate(
      correlations,
      segmentEnergies,
      searchStart,
      selectedIndex,
      reducedRate,
      peakSeparationSamples
    )
    if (aliasAdjustedPeak) {
      selectedIndex = aliasAdjustedPeak.index
      selectedCorrelation = aliasAdjustedPeak.correlation
    }

    let secondBestCorrelation = Number.NEGATIVE_INFINITY
    for (let i = 0; i < correlations.length; i++) {
      const startIndex = searchStart + i
      if (Math.abs(startIndex - selectedIndex) <= peakSeparationSamples) {
        continue
      }

      const correlation = correlations[i]
      if (correlation > secondBestCorrelation) {
        secondBestCorrelation = correlation
      }
    }

    const offsetReducedSamples = selectedIndex - leadInReduced
    const roundTripSamples = offsetReducedSamples * CALIBRATION_DOWNSAMPLE_FACTOR
    const estimatedRoundTripMs = (roundTripSamples / sampleRate) * 1000
    if (!Number.isFinite(estimatedRoundTripMs) || estimatedRoundTripMs < 0) {
      return null
    }
    if (estimatedRoundTripMs > (CALIBRATION_RTT_MAX_MS + CALIBRATION_ROUNDTRIP_OVERSHOOT_TOLERANCE_MS)) {
      return null
    }
    const roundTripMs = Math.max(0, Math.min(CALIBRATION_RTT_MAX_MS, estimatedRoundTripMs))

    const secondPeakFloor = Number.isFinite(secondBestCorrelation)
      ? Math.max(0.01, secondBestCorrelation)
      : Math.max(0.01, selectedCorrelation * 0.85)
    const peakRatio = selectedCorrelation / secondPeakFloor
    const selectedVsGlobalPeak = selectedCorrelation / Math.max(0.01, globalBestCorrelation)
    const normalizedCorrelation = Math.max(0, Math.min(1, selectedCorrelation))
    const normalizedSelectedVsGlobalPeak = Math.max(0, Math.min(1, selectedVsGlobalPeak))
    const normalizedPeakRatio = Math.max(0, Math.min(1, (peakRatio - CALIBRATION_MIN_PEAK_RATIO) / (1.35 - CALIBRATION_MIN_PEAK_RATIO)))
    const prominence = Number.isFinite(secondBestCorrelation)
      ? Math.max(0, selectedCorrelation - secondBestCorrelation)
      : selectedCorrelation
    const normalizedProminence = Math.max(0, Math.min(1, prominence / 0.45))
    let confidence = Math.max(0, Math.min(1, (
      (normalizedCorrelation * 0.45)
      + (normalizedSelectedVsGlobalPeak * 0.35)
      + (normalizedPeakRatio * 0.12)
      + (normalizedProminence * 0.08)
    )))
    if (estimatedRoundTripMs > CALIBRATION_RTT_MAX_MS) {
      confidence *= 0.7
    }

    return {
      roundTripMs,
      correlation: selectedCorrelation,
      peakRatio,
      confidence
    }
  }

  private estimateDifferentialDelay(
    capturedSignal: Float32Array,
    sampleRate: number,
    referenceSequence: Float32Array,
    captureLeadInSamples: number,
    staggerSamples: number
  ): { offsetWiredSamples: number; offsetBtSamples: number; confidence: number } | null {
    const processedCapture = this.preprocessCalibrationSignal(capturedSignal, sampleRate)
    const processedReference = this.preprocessCalibrationSignal(referenceSequence, sampleRate)
    const reducedCapture = this.downsampleForCorrelation(processedCapture, CALIBRATION_DOWNSAMPLE_FACTOR)
    const reducedReference = this.downsampleForCorrelation(processedReference, CALIBRATION_DOWNSAMPLE_FACTOR)

    if (reducedCapture.length <= reducedReference.length || reducedReference.length < 16) {
      return null
    }

    const reducedRate = sampleRate / CALIBRATION_DOWNSAMPLE_FACTOR
    const templateLength = reducedReference.length
    let referenceEnergy = 0
    for (let i = 0; i < templateLength; i++) {
      const value = reducedReference[i]
      referenceEnergy += value * value
    }
    if (referenceEnergy <= 1e-12) {
      return null
    }

    const leadInReduced = Math.max(0, Math.floor(captureLeadInSamples / CALIBRATION_DOWNSAMPLE_FACTOR))
    const staggerReduced = Math.max(0, Math.floor(staggerSamples / CALIBRATION_DOWNSAMPLE_FACTOR))
    const preRollReduced = Math.max(0, Math.floor((DIFFERENTIAL_SEARCH_PRE_ROLL_MS / 1000) * reducedRate))
    const minBtReduced = Math.max(1, Math.floor((DIFFERENTIAL_MIN_BT_LATENCY_MS / 1000) * reducedRate))
    const wiredWindowReduced = Math.max(1, Math.floor((DIFFERENTIAL_WIRED_SEARCH_WINDOW_MS / 1000) * reducedRate))
    const btWindowReduced = Math.max(1, Math.floor((DIFFERENTIAL_BT_SEARCH_WINDOW_MS / 1000) * reducedRate))

    const maxSearchIndex = reducedCapture.length - templateLength
    if (maxSearchIndex <= 0) {
      return null
    }

    const wiredSearchStart = Math.max(0, Math.min(maxSearchIndex, leadInReduced - preRollReduced))
    const wiredSearchEnd = Math.max(0, Math.min(maxSearchIndex, leadInReduced + wiredWindowReduced))
    const btSearchStart = Math.max(
      0,
      Math.min(maxSearchIndex, leadInReduced + staggerReduced + minBtReduced - preRollReduced)
    )
    const btSearchEnd = Math.max(0, Math.min(maxSearchIndex, leadInReduced + staggerReduced + btWindowReduced))

    if (wiredSearchEnd <= wiredSearchStart || btSearchEnd <= btSearchStart) {
      return null
    }

    const findBestPeak = (
      searchStart: number,
      searchEnd: number
    ): { index: number; correlation: number } | null => {
      let bestCorrelation = Number.NEGATIVE_INFINITY
      let bestIndex = -1

      for (let startIndex = searchStart; startIndex <= searchEnd; startIndex++) {
        let dot = 0
        let segmentEnergy = 0
        for (let i = 0; i < templateLength; i++) {
          const captured = reducedCapture[startIndex + i]
          const reference = reducedReference[i]
          dot += captured * reference
          segmentEnergy += captured * captured
        }

        if (segmentEnergy <= 1e-12) continue
        const correlation = dot / Math.sqrt(segmentEnergy * referenceEnergy)
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation
          bestIndex = startIndex
        }
      }

      if (!Number.isFinite(bestCorrelation) || bestIndex < 0 || bestCorrelation < DIFFERENTIAL_MIN_CORRELATION) {
        return null
      }

      return {
        index: bestIndex,
        correlation: bestCorrelation
      }
    }

    const wiredPeak = findBestPeak(wiredSearchStart, wiredSearchEnd)
    const btPeak = findBestPeak(btSearchStart, btSearchEnd)
    if (!wiredPeak || !btPeak) {
      return null
    }

    const offsetWiredSamples = (wiredPeak.index - leadInReduced) * CALIBRATION_DOWNSAMPLE_FACTOR
    const offsetBtSamples = (btPeak.index - leadInReduced - staggerReduced) * CALIBRATION_DOWNSAMPLE_FACTOR
    if (offsetWiredSamples < 0 || offsetBtSamples < 0) {
      return null
    }

    return {
      offsetWiredSamples,
      offsetBtSamples,
      confidence: Math.min(wiredPeak.correlation, btPeak.correlation)
    }
  }

  private findBestHighEnergyCorrelationIndex(
    correlations: Float32Array,
    segmentEnergies: Float32Array,
    searchStart: number,
    minEnergy: number
  ): { index: number; correlation: number } | null {
    let bestIndex = -1
    let bestCorrelation = Number.NEGATIVE_INFINITY

    for (let offset = 0; offset < correlations.length; offset++) {
      if (segmentEnergies[offset] < minEnergy) continue
      const correlation = correlations[offset]
      if (!Number.isFinite(correlation)) continue
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestIndex = searchStart + offset
      }
    }

    if (bestIndex < 0 || !Number.isFinite(bestCorrelation)) {
      return null
    }

    return {
      index: bestIndex,
      correlation: bestCorrelation
    }
  }

  private selectDirectPathCandidate(
    correlations: Float32Array,
    segmentEnergies: Float32Array,
    searchStart: number,
    minCorrelation: number,
    minEnergy: number,
    peakSeparationSamples: number
  ): { index: number; correlation: number } | null {
    const peaks = this.collectCorrelationPeaks(
      correlations,
      searchStart,
      peakSeparationSamples
    )
    if (peaks.length === 0) {
      return null
    }

    let bestPeakCorrelation = Number.NEGATIVE_INFINITY
    for (const peak of peaks) {
      if (peak.correlation > bestPeakCorrelation) {
        bestPeakCorrelation = peak.correlation
      }
    }

    const candidateCorrelationThreshold = Math.max(
      minCorrelation,
      bestPeakCorrelation * CALIBRATION_DIRECT_PATH_RELATIVE_THRESHOLD
    )

    for (const peak of peaks) {
      const offset = peak.index - searchStart
      if (offset < 0 || offset >= segmentEnergies.length) continue
      if (segmentEnergies[offset] < minEnergy) continue
      if (peak.correlation < candidateCorrelationThreshold) continue
      return peak
    }

    return null
  }

  private collectCorrelationPeaks(
    correlations: Float32Array,
    searchStart: number,
    peakSeparationSamples: number
  ): Array<{ index: number; correlation: number }> {
    const localPeaks: Array<{ offset: number; correlation: number }> = []

    for (let offset = 1; offset < (correlations.length - 1); offset++) {
      const correlation = correlations[offset]
      if (!Number.isFinite(correlation)) continue
      if (correlation < CALIBRATION_MIN_CORRELATION_FOR_PEAK_SCAN) continue

      const prev = correlations[offset - 1]
      const next = correlations[offset + 1]
      if (correlation < prev || correlation < next) continue
      localPeaks.push({ offset, correlation })
    }

    if (localPeaks.length === 0) {
      return []
    }

    localPeaks.sort((a, b) => b.correlation - a.correlation)
    const selected: Array<{ offset: number; correlation: number }> = []
    for (const peak of localPeaks) {
      const tooClose = selected.some((chosen) => (
        Math.abs(chosen.offset - peak.offset) <= peakSeparationSamples
      ))
      if (tooClose) continue
      selected.push(peak)
      if (selected.length >= CALIBRATION_MAX_PEAK_CANDIDATES) break
    }

    selected.sort((a, b) => a.offset - b.offset)
    return selected.map((peak) => ({
      index: searchStart + peak.offset,
      correlation: peak.correlation
    }))
  }

  private resolveBurstPeriodAliasCandidate(
    correlations: Float32Array,
    segmentEnergies: Float32Array,
    searchStart: number,
    selectedIndex: number,
    reducedRate: number,
    peakSeparationSamples: number
  ): { index: number; correlation: number } | null {
    if (CALIBRATION_BURST_COUNT <= 1) {
      return null
    }

    const burstPeriodSamples = Math.max(
      1,
      Math.round((CALIBRATION_CHIRP_DURATION_SEC + CALIBRATION_GAP_SEC) * reducedRate)
    )
    const selectedOffset = selectedIndex - searchStart
    if (selectedOffset < 0 || selectedOffset >= correlations.length) {
      return null
    }
    const selectedCorrelation = correlations[selectedOffset]
    const selectedEnergy = segmentEnergies[selectedOffset]
    if (!Number.isFinite(selectedCorrelation) || !Number.isFinite(selectedEnergy)) {
      return null
    }

    const searchRadius = Math.max(1, Math.floor(peakSeparationSamples / 3))
    let best: { index: number; correlation: number } = {
      index: selectedIndex,
      correlation: selectedCorrelation
    }
    let bestEnergy = selectedEnergy

    for (let step = 1; step <= 1; step++) {
      const targetIndex = selectedIndex - (step * burstPeriodSamples)
      if (targetIndex < searchStart) {
        break
      }

      const candidate = this.findStrongestPeakAroundOffset(
        correlations,
        segmentEnergies,
        searchStart,
        targetIndex,
        searchRadius
      )
      if (!candidate) {
        continue
      }

      if (candidate.correlation < (best.correlation * CALIBRATION_PERIOD_ALIAS_CORRELATION_THRESHOLD)) {
        continue
      }
      if (candidate.energy < (bestEnergy * CALIBRATION_PERIOD_ALIAS_ENERGY_THRESHOLD)) {
        continue
      }

      best = {
        index: candidate.index,
        correlation: candidate.correlation
      }
      bestEnergy = candidate.energy
    }

    if (best.index === selectedIndex) {
      return null
    }

    return best
  }

  private findStrongestPeakAroundOffset(
    correlations: Float32Array,
    segmentEnergies: Float32Array,
    searchStart: number,
    targetIndex: number,
    radius: number
  ): { index: number; correlation: number; energy: number } | null {
    const targetOffset = targetIndex - searchStart
    const startOffset = Math.max(1, targetOffset - radius)
    const endOffset = Math.min(correlations.length - 2, targetOffset + radius)
    if (startOffset > endOffset) {
      return null
    }

    let bestCorrelation = Number.NEGATIVE_INFINITY
    let bestOffset = -1
    for (let offset = startOffset; offset <= endOffset; offset++) {
      const correlation = correlations[offset]
      if (!Number.isFinite(correlation)) continue
      if (correlation < CALIBRATION_MIN_CORRELATION_FOR_PEAK_SCAN) continue
      const prev = correlations[offset - 1]
      const next = correlations[offset + 1]
      if (correlation < prev || correlation < next) continue
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestOffset = offset
      }
    }

    if (bestOffset < 0) {
      return null
    }

    return {
      index: searchStart + bestOffset,
      correlation: bestCorrelation,
      energy: segmentEnergies[bestOffset]
    }
  }

  private preprocessCalibrationSignal(
    input: Float32Array,
    sampleRate: number
  ): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0)
    }

    const output = new Float32Array(input.length)
    const highPassCutoff = Math.max(80, Math.min(CALIBRATION_START_FREQ_HZ * 0.65, sampleRate * 0.2))
    const antiAliasCutoff = Math.max(
      highPassCutoff * 1.4,
      Math.min(
        CALIBRATION_END_FREQ_HZ * 1.1,
        (sampleRate / (2 * CALIBRATION_DOWNSAMPLE_FACTOR)) * 0.9
      )
    )
    const hpAlpha = Math.exp((-2 * Math.PI * highPassCutoff) / sampleRate)
    const lpAlpha = 1 - Math.exp((-2 * Math.PI * antiAliasCutoff) / sampleRate)

    let previousInput = 0
    let highPassState = 0
    let lowPassState = 0
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]
      highPassState = sample - previousInput + (hpAlpha * highPassState)
      previousInput = sample
      lowPassState += lpAlpha * (highPassState - lowPassState)
      output[i] = lowPassState
    }

    return output
  }

  private downsampleForCorrelation(input: Float32Array, factor: number): Float32Array {
    if (!Number.isFinite(factor) || factor <= 1) {
      return new Float32Array(input)
    }

    const sampleFactor = Math.max(1, Math.trunc(factor))
    const length = Math.floor(input.length / sampleFactor)
    if (length <= 0) {
      return new Float32Array(0)
    }

    const reduced = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const start = i * sampleFactor
      let sum = 0
      for (let k = 0; k < sampleFactor; k++) {
        sum += input[start + k]
      }
      reduced[i] = sum / sampleFactor
    }
    return reduced
  }

  private combineFloat32Chunks(chunks: Float32Array[]): Float32Array {
    let totalSamples = 0
    for (const chunk of chunks) {
      totalSamples += chunk.length
    }

    if (totalSamples === 0) {
      return new Float32Array(0)
    }

    const combined = new Float32Array(totalSamples)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    return combined
  }

  private isLikelyPermissionDenied(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.name === 'NotAllowedError' || error.name === 'SecurityError'
  }

  private normalizeReportedLatencyMs(seconds: number | undefined): number | null {
    if (!Number.isFinite(seconds)) return null
    const ms = Number(seconds) * 1000
    if (!Number.isFinite(ms) || ms < 0) return null
    return Math.max(0, Math.min(5000, ms))
  }

  // Canonical per-endpoint output-latency estimator used by every Parallax scheduling site (host
  // local playback, sink initial anchor, sink hard re-sync). Single estimator policy: outputLatency
  // + baseLatency. They are *components* of the render→DAC path and sum (baseLatency = destination
  // node to audio subsystem, outputLatency = audio subsystem to device). The alternative —
  // (ctx.currentTime − getOutputTimestamp().contextTime) — measures the same total directly but is
  // jittery without filtering and is kept only as a diagnostic in `getOutputLatencyMetrics()`. Do
  // NOT add the two estimators together; that's the double-count trap.
  //
  // Manual per-endpoint advance trim hooks here (positive = play this endpoint earlier). §14.1.1
  // wires `parallaxSinkAdvanceMs` to the host-pushed per-sink trim; the field defaults to 0 so
  // unset trims behave exactly like before this feature landed.
  private getParallaxEndpointLatencySeconds(): number {
    return this.getParallaxEndpointLatencyMs() / 1000
  }

  // Public canonical estimator — same value the three scheduling sites subtract. Consumers that
  // need this for *consistency with scheduling* (the drift loop's target, host timeline anchors
  // expressed in acoustic time) must use this method rather than re-summing `outputLatency +
  // baseLatency` from `getOutputLatencyMetrics()`. Otherwise the per-sink trim would shift
  // scheduling but not the drift target — the loop would slew to undo the trim.
  getParallaxEndpointLatencyMs(): number {
    const ctx = this.context
    if (!ctx) return 0
    const outMs = this.normalizeReportedLatencyMs((ctx as AudioContext & { outputLatency?: number }).outputLatency)
    const baseMs = this.normalizeReportedLatencyMs((ctx as AudioContext & { baseLatency?: number }).baseLatency)
    const autoMs = (outMs ?? 0) + (baseMs ?? 0)
    return autoMs + this.parallaxSinkAdvanceMs
  }

  // §14.1.1 — host pushes per-sink trim via `sink-trim-update` events. The drift loop and snap
  // target both consume `getParallaxEndpointLatencyMs()` so they see the new value on the next
  // 1 Hz tick; small changes discharge via slew, larger changes may produce one snap.
  setParallaxSinkAdvanceMs(ms: number): void {
    if (!Number.isFinite(ms)) return
    this.parallaxSinkAdvanceMs = ms
  }

  // §14.1.1 — public getter so the sink renderer can echo the currently-applied trim back into the
  // periodic telemetry payload, letting the host UI display the live-effective value (and detect
  // any mismatch between what it pushed and what the sink is actually running).
  getParallaxSinkAdvanceMs(): number {
    return this.parallaxSinkAdvanceMs
  }

  // §14.1.1 / §15.4 fallback path — Chromium's AudioContext.sinkId is the *device id currently
  // assigned via setSinkId*, which returns `''` for the system default route and may be empty
  // during context initialization. The renderer normalizes `''` → `'default'` so the storage key
  // is stable; pre-context returns `''` to let callers know to wait. Codex's constraint (b) says
  // the *primary* identity source is `audioSettingsStore.selectedDeviceId` (user intent), so this
  // is only consulted when settings are unset.
  getOutputDeviceId(): string {
    const ctx = this.context as (AudioContext & { sinkId?: string }) | null
    if (!ctx) return ''
    const raw = (ctx.sinkId ?? '').trim()
    if (!raw) return 'default'
    return raw
  }

  // Fail-loud guard at every Parallax scheduling site. After auto output-latency compensation
  // `mappedStartContextTime` should sit at or after `ctx.currentTime`; if it drops noticeably
  // negative, the acoustic-timeline invariant has been violated (stale anchor, bad clock offset,
  // arithmetic error in the scheduling math). Previously such cases were silently clamped via
  // `Math.max(ctx.currentTime, ...)`, which masked the -2543-frame sentinel that turned up in the
  // CSV. We still clamp at the call site so playback keeps going, but a console.warn surfaces the
  // context so the bug is impossible to miss in the next CSV trace.
  private assertParallaxScheduledLead(
    site: string,
    scheduledLeadMs: number,
    context: {
      targetAcousticHostTimeMs?: number
      localLatencyMs: number
      mappedStartContextTime: number
      ctxNow: number
    }
  ): void {
    if (scheduledLeadMs >= -50) return
    console.warn(
      `[parallax] ${site}: scheduled lead is strongly negative (${scheduledLeadMs.toFixed(2)} ms) — `
        + `acoustic-timeline invariant violated, clamping to ctx.currentTime. context:`,
      {
        scheduledLeadMs,
        ctxNow: context.ctxNow,
        mappedStartContextTime: context.mappedStartContextTime,
        localLatencyMs: context.localLatencyMs,
        targetAcousticHostTimeMs: context.targetAcousticHostTimeMs ?? null
      }
    )
  }

  private getContextClockSnapshot(ctx: AudioContext): { contextTime: number; performanceTime: number } {
    const fallback = {
      contextTime: ctx.currentTime,
      performanceTime: performance.now()
    }

    if (!('getOutputTimestamp' in ctx)) {
      return fallback
    }

    try {
      const timestamp = (
        ctx as AudioContext & {
          getOutputTimestamp: () => { contextTime: number; performanceTime: number }
        }
      ).getOutputTimestamp()

      const contextTime = Number(timestamp.contextTime)
      const performanceTime = Number(timestamp.performanceTime)
      if (!Number.isFinite(contextTime) || !Number.isFinite(performanceTime)) {
        return fallback
      }

      return {
        contextTime,
        performanceTime
      }
    } catch {
      return fallback
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })
  }

  // Audio output device selection
  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      await this.initNativeAudio()
      this.nativeCapabilities = await window.nativeAudioAPI.setOutputDevice(deviceId)
      await this.refreshNativeSnapshot()
      this.notifyTrackChange()
      return
    }

    await this.initContext()
    if (this.context && 'setSinkId' in this.context) {
      await (this.context as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId)
      this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)
      if (this._playbackState === 'playing' && this.audioBuffer) {
        await this.seek(this.currentTime)
      }
    }
  }

  async ensureContextReady(): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      await this.initNativeAudio()
      return
    }
    await this.initContext()
  }

  // Check if audio context is initialized and ready
  isContextReady(): boolean {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeCapabilities.bitPerfectAvailable
    }
    return this.context !== null && this.workletLoaded
  }

  get worklet(): AudioWorkletNode | null {
    if (this.playbackOutputMode === 'bitperfect') {
      return null
    }
    return this.workletNode
  }

  // Latest audio data from worklet (for visualizers)
  getLatestLeftChannel(): Float32Array {
    return this.latestLeftChannel
  }

  getLatestRightChannel(): Float32Array {
    return this.latestRightChannel
  }

  getLatestMonoChannel(): Float32Array {
    return this.latestMonoChannel
  }

  // Flush all pending oscilloscope samples (prevents sample loss from worklet timing)
  flushPendingOscilloscopeSamples(): Float32Array[] {
    const samples = this.pendingOscilloscopeSamples
    this.pendingOscilloscopeSamples = []
    return samples
  }

  // Flush all pending mono chunks for spectrum processing.
  flushPendingSpectrumSamples(): Float32Array[] {
    const samples = this.pendingSpectrumSamples
    this.pendingSpectrumSamples = []
    return samples
  }

  // Flush all pending stereo chunks for mid/side spectrum processing.
  flushPendingSpectrumStereoSamples(): { left: Float32Array; right: Float32Array }[] {
    const samples = this.pendingSpectrumStereoSamples
    this.pendingSpectrumStereoSamples = []
    return samples
  }

  // Flush all pending mono chunks for spectrogram processing.
  flushPendingSpectrogramSamples(): Float32Array[] {
    const samples = this.pendingSpectrogramSamples
    this.pendingSpectrogramSamples = []
    return samples
  }

  // Flush all pending stereo chunks for vectorscope processing.
  flushPendingVectorscopeSamples(): { left: Float32Array; right: Float32Array }[] {
    const samples = this.pendingVectorscopeSamples
    this.pendingVectorscopeSamples = []
    return samples
  }

  // Flush all pending multichannel chunks for VU meter processing.
  flushPendingVUMeterSamples(): MultichannelAudioChunk[] {
    const samples = this.pendingVUMeterSamples
    this.pendingVUMeterSamples = []
    return samples
  }

  // Flush all pending stereo chunks for LUFS meter processing.
  flushPendingLUFSMeterSamples(): { left: Float32Array; right: Float32Array }[] {
    const samples = this.pendingLUFSMeterSamples
    this.pendingLUFSMeterSamples = []
    return samples
  }

  // Flush all pending mono chunks for scrolling waveform processing.
  flushPendingWaveformSamples(): Float32Array[] {
    const samples = this.pendingWaveformSamples
    this.pendingWaveformSamples = []
    return samples
  }

  // Flush all pending stereo chunks for stereo/multiband waveform processing.
  flushPendingWaveformStereoSamples(): { left: Float32Array; right: Float32Array }[] {
    const samples = this.pendingWaveformStereoSamples
    this.pendingWaveformStereoSamples = []
    return samples
  }

  // Flush all pending chunks for mini-player real-time visualizer stream.
  flushPendingMiniVisualizerChunks(): { left: Float32Array; mono: Float32Array }[] {
    const samples = this.pendingMiniVisualizerChunks
    this.pendingMiniVisualizerChunks = []
    return samples
  }

  get hasNextBuffered(): boolean {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeNextTrackBuffered
    }
    return this.nextBuffer !== null
  }

  get nextBufferedTrackPath(): string | null {
    return this.hasNextBuffered ? this.nextBufferTrackPath : null
  }

  // Load audio from ArrayBuffer
  /**
   * Decodes an IAMF (Eclipsa Audio) file via the wasm decode worker into a
   * 12-channel AudioBuffer in STANDARD_LAYOUTS[12] order — from there the
   * existing multichannel routing (and the 7.1.4 binaural path) takes over.
   * The worker does the heavy lifting off this thread; here we only copy
   * planar channels into the buffer.
   */
  private async decodeIamfToAudioBuffer(
    arrayBuffer: ArrayBuffer,
    container: IamfContainerKind
  ): Promise<AudioBuffer> {
    if (!this.context) throw new Error('AudioContext not initialized')
    this.iamfDecoder ??= new IamfDecoderClient()
    const handle = this.iamfDecoder.decode(arrayBuffer, container)
    this.activeIamfDecodes.add(handle)
    try {
      const decoded = await handle.promise
      const buffer = this.context.createBuffer(decoded.channels, decoded.frames, decoded.sampleRate)
      for (let channel = 0; channel < decoded.channels; channel++) {
        buffer.copyToChannel(decoded.channelData[channel] as Float32Array<ArrayBuffer>, channel)
        // Release each planar array right after its copy so peak overhead
        // stays ~1/12 of the decoded size instead of 2x.
        decoded.channelData[channel] = new Float32Array(0)
      }
      return buffer
    } finally {
      this.activeIamfDecodes.delete(handle)
    }
  }

  /** Cancels in-flight IAMF decodes (current load and/or prebuffer). */
  private cancelActiveIamfDecodes(): void {
    for (const handle of this.activeIamfDecodes) {
      handle.cancel()
    }
    this.activeIamfDecodes.clear()
  }

  async loadAudioData(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Bit-perfect mode requires path-based native loading.')
    }
    const loadOperation = this.beginLoadOperation()
    await this.initContext()
    this.assertCurrentLoadOperation(loadOperation)
    if (!this.context) throw new Error('AudioContext not initialized')

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()

    try {
      // Stop any current playback
      this.stopSource()
      this.clearNextBuffer()
      this.cancelActiveIamfDecodes()
      await this.clearRemoteStreamState(true)
      this.clearParallaxSinkState()
      this.assertCurrentLoadOperation(loadOperation)
      // Clear current decoded buffer so failed decode cannot replay stale audio.
      this.audioBuffer = null
      this.currentNormalizationAnalysis = null
      this.currentBufferTrackPath = null
      this.pauseTime = 0
      this.currentReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)

      // Decode audio data. IAMF (Eclipsa) files must branch BEFORE
      // decodeAudioData: Chromium cannot decode them and the ffmpeg fallback
      // (6.0) cannot rescue them either.
      const decodeStart = performance.now()
      const iamfContainer = detectIamfContainer(arrayBuffer)
      const decodedBuffer = iamfContainer
        ? await this.decodeIamfToAudioBuffer(arrayBuffer, iamfContainer)
        : await this.context.decodeAudioData(arrayBuffer)
      const decodeMs = Math.round(performance.now() - decodeStart)
      this.assertCurrentLoadOperation(loadOperation)
      const analysisStart = performance.now()
      const normalizationAnalysis = await this.resolveLoudnessAnalysisForLoad(decodedBuffer, options, this.currentReplayGainDb)
      this.lastLoadTimings = { decodeMs, analysisMs: Math.round(performance.now() - analysisStart) }
      this.assertCurrentLoadOperation(loadOperation)
      this.audioBuffer = decodedBuffer
      this.currentNormalizationAnalysis = normalizationAnalysis
      this.currentBufferTrackPath = options.trackPath ?? null
      this.applyChannelRoutingPreferences(this.audioBuffer.numberOfChannels)

      // Notify visualizers of track change (reset their state for fresh pitch detection)
      this.notifyTrackChange()

      this.applyNormalization()

      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.emit('stateChange', this._playbackState)
      this.emit('durationChange', this.audioBuffer.duration)
      this.emit('bufferReady', this.audioBuffer)
    } catch (err) {
      if (isSupersededAudioLoadError(err) || loadOperation !== this.loadGeneration) {
        throw new SupersededAudioLoadError()
      }
      this.audioBuffer = null
      this.currentNormalizationAnalysis = null
      this.currentBufferTrackPath = null
      this.pauseTime = 0
      this.currentReplayGainDb = null
      this._playbackState = 'stopped'
      this.emit('stateChange', this._playbackState)
      this.emit('durationChange', 0)
      this.emit('error', err instanceof Error ? err : new Error('Failed to decode audio'))
      throw err
    }
  }

  // Pre-buffer the next track for gapless playback
  async preBufferNext(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Bit-perfect mode requires path-based native prebuffering.')
    }
    const prebufferOperation = this.beginPrebufferOperation()
    await this.initContext()
    this.assertCurrentPrebufferOperation(prebufferOperation)
    if (!this.context) throw new Error('AudioContext not initialized')

    try {
      // Clone the ArrayBuffer since decodeAudioData (and the IAMF worker
      // transfer) detaches it
      const clonedBuffer = arrayBuffer.slice(0)
      const iamfContainer = detectIamfContainer(clonedBuffer)
      const decodedBuffer = iamfContainer
        ? await this.decodeIamfToAudioBuffer(clonedBuffer, iamfContainer)
        : await this.context.decodeAudioData(clonedBuffer)
      this.assertCurrentPrebufferOperation(prebufferOperation)
      const nextReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)
      const normalizationAnalysis = await this.resolveLoudnessAnalysisForLoad(decodedBuffer, options, nextReplayGainDb)
      this.assertCurrentPrebufferOperation(prebufferOperation)
      this.nextReplayGainDb = nextReplayGainDb
      this.nextBuffer = decodedBuffer
      this.nextNormalizationAnalysis = normalizationAnalysis
      this.nextBufferTrackPath = options.trackPath ?? null
      this.updateNextNormalizationCache()

      // If currently playing, schedule the gapless transition
      if (this._playbackState === 'playing' && this.audioBuffer) {
        this.scheduleGaplessTransition()
      }
    } catch (err) {
      if (isSupersededAudioLoadError(err) || prebufferOperation !== this.prebufferGeneration) {
        return
      }
      if (err instanceof IamfDecodeCancelledError) {
        // A new load cancelled the prebuffer decode; the load path resets
        // prebuffer state itself.
        return
      }
      console.error('Failed to pre-buffer next track:', err)
      this.nextBuffer = null
      this.nextNormalizationAnalysis = null
      this.nextBufferTrackPath = null
      this.nextReplayGainDb = null
      this.clearNextNormalizationCache()
    }
  }

  // Schedule the next track to start exactly when current ends
  private scheduleGaplessTransition(): void {
    if (!this.context || !this.nextBuffer || !this.audioBuffer) return
    if (this._playbackState !== 'playing') return

    if (this.nextNormalizationLinearGain == null) {
      this.updateNextNormalizationCache()
    }

    // Cancel any existing scheduled next source
    this.cancelScheduledNext()

    // Calculate when current track will end
    const currentPosition = this.currentTime
    const remaining = this.audioBuffer.duration - currentPosition
    this.scheduledEndTime = this.context.currentTime + remaining

    // Create and schedule the next source
    this.nextSourceNode = this.context.createBufferSource()
    this.nextSourceNode.buffer = this.nextBuffer
    this.connectSourceWithRouting(this.nextSourceNode, this.nextBuffer.numberOfChannels)
    this.connectSourceToAnalysisTap(this.nextSourceNode, this.nextBuffer.numberOfChannels)

    // Schedule to start exactly when current track ends
    this.nextSourceNode.start(this.scheduledEndTime)
    if (this.nextNormalizationLinearGain != null) {
      this.scheduleNormalizationTransition(this.nextNormalizationLinearGain, this.scheduledEndTime)
    }

    // Set up ended handler for the NEXT track (not current)
    this.nextSourceNode.onended = () => {
      // This fires when the next track ends (or is stopped)
      if (this._playbackState === 'playing' && !this.isGaplessTransition) {
        this._playbackState = 'stopped'
        this.pauseTime = 0
        this.stopSource()
        this.releaseDecodedBuffers()
        this.emit('stateChange', this._playbackState)
        this.emit('ended')
        this.stopTimeUpdate()
      }
    }
  }

  // Transition to the next track (called when current track actually ends)
  private performGaplessTransition(): void {
    if (!this.nextBuffer || !this.nextSourceNode) {
      this.nextReplayGainDb = null
      this.nextNormalizationAnalysis = null
      this.clearNextNormalizationCache()
      // No next track buffered, emit ended normally
      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.stopSource()
      this.releaseDecodedBuffers()
      this.emit('stateChange', this._playbackState)
      this.emit('ended')
      this.stopTimeUpdate()
      return
    }

    this.isGaplessTransition = true

    const nextBuffer = this.nextBuffer
    const nextSourceNode = this.nextSourceNode
    const nextNormalization = this.getPendingNextNormalization()
    const nextNormalizationAnalysis = this.nextNormalizationAnalysis
    const nextReplayGainDb = this.nextReplayGainDb

    // Swap buffers
    this.audioBuffer = nextBuffer
    this.nextBuffer = null
    this.currentNormalizationAnalysis = nextNormalizationAnalysis
    this.nextNormalizationAnalysis = null
    this.currentBufferTrackPath = this.nextBufferTrackPath
    this.nextBufferTrackPath = null
    this.currentReplayGainDb = nextReplayGainDb
    this.nextReplayGainDb = null

    // Swap source nodes
    if (this.sourceNode) {
      this.sourceNode.onended = null
      this.disconnectSourceRouting(this.sourceNode)
      try {
        this.sourceNode.buffer = null
        this.sourceNode.disconnect()
      } catch { /* ignore */ }
    }
    this.sourceNode = nextSourceNode
    this.nextSourceNode = null

    // Update timing
    this.startTime = this.scheduledEndTime
    this.pauseTime = 0
    this.applyGainState(nextNormalization)
    this.clearNextNormalizationCache()
    this.applyChannelRoutingPreferences(this.audioBuffer.numberOfChannels)

    // Set up ended handler for the new current track
    this.sourceNode.onended = () => {
      if (this._playbackState === 'playing') {
        this.performGaplessTransition()
      }
    }

    this.isGaplessTransition = false

    // Notify visualizers of track change (reset their state for fresh pitch detection)
    this.notifyTrackChange()

    // Emit events for the track change
    this.emit('durationChange', this.audioBuffer.duration)
    this.emit('gaplessTransition')
    this.emit('bufferReady', this.audioBuffer)
  }

  // Promote the already-decoded prebuffered next track to "current" immediately, so a manual
  // "Next" press is gapless instead of cold-loading from disk. Mirrors performGaplessTransition
  // but starts the new source now (rather than at scheduledEndTime). Returns false when the
  // prebuffer is unusable, so the caller can fall back to the cold-load path.
  skipToPreBuffered(): boolean {
    // Bit-perfect/remote backends manage their own next-track promotion elsewhere.
    if (this.playbackOutputMode !== 'standard') return false
    if (this.remoteStreamState) return false
    if (this._playbackState !== 'playing') return false
    if (!this.context || !this.nextBuffer || !this.audioBuffer || !this.sourceNode) return false

    // A lingering pause fade-out timer would tear down the new source after we start it.
    this.clearPauseFadeTimer()
    this.isGaplessTransition = true

    // Snapshot next-track state before cancelScheduledNext / the swap clears it.
    const nextBuffer = this.nextBuffer
    const nextBufferTrackPath = this.nextBufferTrackPath
    const nextReplayGainDb = this.nextReplayGainDb
    const nextNormalizationAnalysis = this.nextNormalizationAnalysis
    const pendingNextNormalization = this.getPendingNextNormalization()
    const oldSource = this.sourceNode

    // Discard the future-scheduled gapless source (if any) and reset its normalization ramp.
    this.cancelScheduledNext()

    // Build and immediately start the new current source from the prebuffered buffer.
    const newSource = this.context.createBufferSource()
    newSource.buffer = nextBuffer
    this.connectSourceWithRouting(newSource, nextBuffer.numberOfChannels)
    this.connectSourceToAnalysisTap(newSource, nextBuffer.numberOfChannels)
    newSource.onended = () => {
      if (this._playbackState === 'playing') {
        this.performGaplessTransition()
      }
    }

    const now = this.context.currentTime
    newSource.start(now, 0)

    // Dip the shared fade node to silence and back; stop the outgoing source at the dip bottom.
    const declickSec = SKIP_DECLICK_MS / 1000
    const stopAt = this.fadeGainNode ? now + declickSec : now
    if (this.fadeGainNode) {
      const fade = this.fadeGainNode.gain
      fade.cancelScheduledValues(now)
      fade.setValueAtTime(fade.value, now)
      fade.linearRampToValueAtTime(0, now + declickSec)
      fade.linearRampToValueAtTime(1, now + declickSec * 2)
    }
    oldSource.onended = () => {
      this.disconnectSourceRouting(oldSource)
      try {
        oldSource.buffer = null
        oldSource.disconnect()
      } catch { /* ignore */ }
    }
    try {
      oldSource.stop(stopAt)
    } catch { /* ignore */ }

    // Swap buffers/bookkeeping (mirrors performGaplessTransition).
    this.audioBuffer = nextBuffer
    this.nextBuffer = null
    this.currentNormalizationAnalysis = nextNormalizationAnalysis
    this.nextNormalizationAnalysis = null
    this.currentBufferTrackPath = nextBufferTrackPath
    this.nextBufferTrackPath = null
    this.currentReplayGainDb = nextReplayGainDb
    this.nextReplayGainDb = null

    this.sourceNode = newSource
    this.nextSourceNode = null

    // The new track starts at "now" from offset 0.
    this.startTime = now
    this.pauseTime = 0
    this.applyGainState(pendingNextNormalization)
    this.clearNextNormalizationCache()
    this.applyChannelRoutingPreferences(this.audioBuffer.numberOfChannels)

    this.isGaplessTransition = false

    // Reset visualizers and notify consumers exactly like the natural transition.
    this.notifyTrackChange()
    this.emit('durationChange', this.audioBuffer.duration)
    this.emit('gaplessTransition')
    this.emit('bufferReady', this.audioBuffer)

    return true
  }

  // Clear pre-buffered next track
  hasDecodedAudioBuffer(): boolean {
    return this.audioBuffer !== null
  }

  clearNextBuffer(): void {
    this.invalidatePrebufferOperations()
    this.nextNormalizationAnalysis = null
    if (this.playbackOutputMode === 'bitperfect') {
      this.nativeNextTrackBuffered = false
      this.nextBufferTrackPath = null
      void window.nativeAudioAPI.clearNextTrack()
      return
    }
    this.cancelScheduledNext()
    this.nextBuffer = null
    this.nextBufferTrackPath = null
    this.nextReplayGainDb = null
    this.clearNextNormalizationCache()
  }

  // Cancel scheduled next track
  private cancelScheduledNext(): void {
    if (this.nextSourceNode) {
      try {
        this.nextSourceNode.onended = null
        this.disconnectSourceRouting(this.nextSourceNode)
        this.nextSourceNode.stop()
        this.nextSourceNode.buffer = null
        this.nextSourceNode.disconnect()
      } catch { /* ignore */ }
      this.nextSourceNode = null
    }
    this.restoreCurrentNormalizationGainNow()
    this.scheduledEndTime = 0
  }

  // Play
  async play(): Promise<void> {
    const playLoadGeneration = this.loadGeneration
    if (this.playbackOutputMode === 'bitperfect') {
      await this.initNativeAudio()
      this.assertCurrentLoadOperation(playLoadGeneration)
      this.nativeSnapshot = await window.nativeAudioAPI.play()
      this.assertCurrentLoadOperation(playLoadGeneration)
      await this.refreshNativeCapabilities()
      this.assertCurrentLoadOperation(playLoadGeneration)
      this._playbackState = this.nativeSnapshot.playbackState as PlaybackState
      this.emit('stateChange', this._playbackState)
      this.syncNativeScopePolling()
      return
    }

    if (this.remoteStreamState) {
      const remoteState = this.remoteStreamState
      if (remoteState.started && !remoteState.paused && this._playbackState === 'playing') {
        return
      }
      remoteState.playRequested = true

      if (remoteState.started && remoteState.paused) {
        remoteState.paused = false
        this.remoteStreamNode?.port.postMessage({
          type: 'set-playing',
          playing: true
        })
        this._playbackState = 'playing'
        this.emit('stateChange', this._playbackState)
        this.startTimeUpdate()
        return
      }

      if (this.remotePlayPromise === null) {
        this.remotePlayPromise = new Promise<void>((resolve, reject) => {
          this.remotePlayResolver = resolve
          this.remotePlayRejecter = reject
        })
      }
      const pendingPlayPromise = this.remotePlayPromise

      this.maybeStartRemotePlayback()
      return pendingPlayPromise ?? Promise.resolve()
    }

    if (!this.audioBuffer || !this.context) return

    // Resume context if suspended (autoplay policy)
    if (this.context.state === 'suspended') {
      await this.context.resume()
      this.assertCurrentLoadOperation(playLoadGeneration)
    }

    // Rapid resume: a pause fade-out is still in flight and the source is still playing.
    // Cancel the teardown and ramp back up instead of restarting — gapless and click-free.
    if (this.pauseFadeTimer != null && this.sourceNode) {
      this.clearPauseFadeTimer()
      this._playbackState = 'playing'
      this.emit('stateChange', this._playbackState)
      this.startTimeUpdate()
      this.rampFadeGain(1, PLAYBACK_FADE_MS)
      if (this.nextBuffer) {
        this.scheduleGaplessTransition()
      }
      return
    }

    // If already playing, do nothing
    if (this._playbackState === 'playing') return

    // A completed pause fade may have left a stale timer reference; clear before a fresh start.
    this.clearPauseFadeTimer()

    // Stop existing source if any
    this.stopSource()

    // Create new source
    this.sourceNode = this.context.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.connectSourceWithRouting(this.sourceNode, this.audioBuffer.numberOfChannels)
    this.connectSourceToAnalysisTap(this.sourceNode, this.audioBuffer.numberOfChannels)

    // Handle track end
    this.sourceNode.onended = () => {
      if (this._playbackState === 'playing') {
        this.performGaplessTransition()
      }
    }

    // Start from pause position, fading in from silence so the start is not abrupt.
    const offset = this.pauseTime
    this.startTime = this.context.currentTime - offset
    if (this.fadeGainNode) {
      const fadeStart = this.context.currentTime
      this.fadeGainNode.gain.cancelScheduledValues(fadeStart)
      this.fadeGainNode.gain.setValueAtTime(0, fadeStart)
      this.fadeGainNode.gain.linearRampToValueAtTime(1, fadeStart + PLAYBACK_FADE_MS / 1000)
    }
    this.sourceNode.start(0, offset)

    this._playbackState = 'playing'
    this.emit('stateChange', this._playbackState)
    this.startTimeUpdate()

    // If we have a next buffer, schedule the gapless transition
    if (this.nextBuffer) {
      this.scheduleGaplessTransition()
    }
  }

  // Ramp the fade node toward `target` over `durationMs`, holding the live value first so a
  // mid-fade reversal (rapid pause/play) stays smooth. No-op for bit-perfect/remote (no fade node).
  private rampFadeGain(target: number, durationMs: number): void {
    if (!this.context || !this.fadeGainNode) return
    const now = this.context.currentTime
    const gain = this.fadeGainNode.gain
    // Read the live (possibly mid-ramp) value, then anchor it explicitly. linearRampToValueAtTime
    // interpolates from the previous event, so a concrete setValueAtTime anchor is required —
    // cancelAndHoldAtTime is not a reliable ramp anchor in Chromium (the ramp jumps to target).
    const current = gain.value
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(current, now)
    gain.linearRampToValueAtTime(target, now + durationMs / 1000)
  }

  private clearPauseFadeTimer(): void {
    if (this.pauseFadeTimer != null) {
      clearTimeout(this.pauseFadeTimer)
      this.pauseFadeTimer = null
    }
  }

  // Pause
  pause(): void {
    if (this.playbackOutputMode === 'bitperfect') {
      void window.nativeAudioAPI.pause().then((snapshot) => {
        this.nativeSnapshot = snapshot
        this._playbackState = snapshot.playbackState as PlaybackState
        this.emit('stateChange', this._playbackState)
        this.syncNativeScopePolling()
      }).catch((error) => {
        this.emit('error', error instanceof Error ? error : new Error('Failed to pause native playback'))
      })
      this.stopNativeScopePolling()
      return
    }

    if (this.remoteStreamState) {
      this.remoteStreamState.playRequested = false
      this.remoteStreamState.paused = this.remoteStreamState.started
      if (!this.remoteStreamState.started) {
        this.resetRemotePlayPromise(new Error('Remote playback was paused before start.'))
      }
      this.remoteStreamNode?.port.postMessage({
        type: 'set-playing',
        playing: false
      })
      this._playbackState = 'paused'
      this.emit('stateChange', this._playbackState)
      this.stopTimeUpdate()
      return
    }

    if (this._playbackState !== 'playing' || !this.context) return

    // Record the pause position now so the seek bar/time stay correct while the audio fades out.
    this.pauseTime = this.context.currentTime - this.startTime
    this.cancelScheduledNext() // Cancel scheduled next track

    this._playbackState = 'paused'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()

    // Fade out, then tear down the source once it is silent. The source keeps playing during the
    // fade so a quick play() can reverse it gaplessly (see play()'s rapid-resume branch).
    this.rampFadeGain(0, PLAYBACK_FADE_MS)
    this.clearPauseFadeTimer()
    this.pauseFadeTimer = setTimeout(() => {
      this.pauseFadeTimer = null
      if (this._playbackState === 'paused') {
        this.stopSource()
      }
    }, PLAYBACK_FADE_MS + FADE_STOP_EPSILON_MS)
  }

  // Toggle play/pause
  async togglePlay(): Promise<void> {
    if (this._playbackState === 'playing') {
      this.pause()
    } else {
      await this.play()
    }
  }

  // Stop
  stop(): void {
    this.invalidateLoadOperations()
    this.clearPauseFadeTimer()
    const stopLoadGeneration = this.loadGeneration
    if (this.playbackOutputMode === 'bitperfect') {
      this.nativeNextTrackBuffered = false
      this.currentBufferTrackPath = null
      this.nextBufferTrackPath = null
      void window.nativeAudioAPI.stop().then((snapshot) => {
        if (stopLoadGeneration !== this.loadGeneration) return
        this.nativeSnapshot = snapshot
        this._playbackState = snapshot.playbackState as PlaybackState
        this.emit('stateChange', this._playbackState)
        this.emit('timeUpdate', 0)
        this.notifyTrackChange()
        this.syncNativeScopePolling()
      }).catch((error) => {
        this.emit('error', error instanceof Error ? error : new Error('Failed to stop native playback'))
      })
      this.stopTimeUpdate()
      this.stopNativeScopePolling()
      return
    }

    if (this.remoteStreamState) {
      this.remoteStreamNode?.port.postMessage({ type: 'clear' })
      void this.clearRemoteStreamState(true)
      this.pauseTime = 0
      this._playbackState = 'stopped'
      this.emit('stateChange', this._playbackState)
      this.emit('timeUpdate', 0)
      this.notifyTrackChange()
      this.stopTimeUpdate()
      return
    }

    if (this.parallaxSinkState) {
      this.stopParallaxSinkPlayback()
      return
    }

    this.stopSource()
    this.cancelScheduledNext()
    this.releaseDecodedBuffers()
    this.pauseTime = 0
    this._playbackState = 'stopped'
    this.emit('stateChange', this._playbackState)
    this.emit('timeUpdate', 0)
    this.stopTimeUpdate()
  }

  // Decoded PCM is large (~10MB/min at 44.1k stereo); once playback has
  // terminally stopped nothing can use it, so drop it instead of letting it
  // sit until the next load. Pause intentionally keeps buffers for instant
  // resume; restart-after-stop goes through the store's full reload path.
  private releaseDecodedBuffers(): void {
    this.audioBuffer = null
    this.currentBufferTrackPath = null
    this.clearNextBuffer()
  }

  // Seek to time in seconds
  async seek(time: number): Promise<void> {
    this.clearPauseFadeTimer()
    if (this.playbackOutputMode === 'bitperfect') {
      await this.seekNativeBitPerfect(time)
      return
    }

    if (this.remoteStreamState) {
      const remoteState = this.remoteStreamState
      const durationSeconds = Math.max(0, remoteState.durationSeconds)
      const clampedAbsoluteTime = Math.max(0, Math.min(time, durationSeconds > 0 ? durationSeconds : time))
      const bufferedStartTime = remoteState.sampleRate > 0 ? remoteState.startFrame / remoteState.sampleRate : 0
      const bufferedEndTime = this.getRemoteBufferedSeconds()
      const canSeekBuffered = clampedAbsoluteTime >= bufferedStartTime && clampedAbsoluteTime <= bufferedEndTime

      if (remoteState.sourceType === 'local' && !canSeekBuffered) {
        const wasPlaying = this._playbackState === 'playing'
        const track = remoteState.track
        const replayGainDb = this.currentReplayGainDb
        const loudnessAnalysis = this.currentNormalizationAnalysis
          ? {
              loudnessLufs: this.currentNormalizationAnalysis.loudnessLufs,
              peakLinear: this.currentNormalizationAnalysis.peakLinear
            }
          : null

        await this.loadProgressiveStream(track, {
          replayGainDb,
          loudnessAnalysis,
          startTimeSeconds: clampedAbsoluteTime
        })

        if (wasPlaying) {
          await this.play()
        } else {
          this._playbackState = 'paused'
          this.emit('stateChange', this._playbackState)
          this.emit('timeUpdate', clampedAbsoluteTime)
        }
        return
      }

      const seekTime = remoteState.sourceType === 'local'
        ? clampedAbsoluteTime - bufferedStartTime
        : Math.max(0, Math.min(time, bufferedEndTime))
      remoteState.currentFrame = Math.max(0, Math.floor(seekTime * remoteState.sampleRate))
      this.remoteStreamNode?.port.postMessage({
        type: 'seek',
        frame: remoteState.currentFrame
      })
      this.emit('timeUpdate', remoteState.sourceType === 'local' ? clampedAbsoluteTime : seekTime)
      return
    }

    if (!this.audioBuffer || !this.context) return

    const wasPlaying = this._playbackState === 'playing'
    const clampedTime = Math.max(0, Math.min(time, this.audioBuffer.duration))

    // Stop current playback
    this.stopSource()
    this.cancelScheduledNext() // Cancel and reschedule after seek
    this.pauseTime = clampedTime

    if (wasPlaying) {
      // Directly create new source and start (bypass play() state check)
      this.sourceNode = this.context.createBufferSource()
      this.sourceNode.buffer = this.audioBuffer
      this.connectSourceWithRouting(this.sourceNode, this.audioBuffer.numberOfChannels)
      this.connectSourceToAnalysisTap(this.sourceNode, this.audioBuffer.numberOfChannels)

      this.sourceNode.onended = () => {
        if (this._playbackState === 'playing') {
          this.performGaplessTransition()
        }
      }

      this.startTime = this.context.currentTime - clampedTime
      this.sourceNode.start(0, clampedTime)

      // Reschedule gapless transition with new timing
      if (this.nextBuffer) {
        this.scheduleGaplessTransition()
      }
    }

    this.emit('timeUpdate', clampedTime)
  }

  private async seekNativeBitPerfect(time: number): Promise<void> {
    this.pendingNativeSeekTime = time
    if (this.nativeSeekPromise) {
      await this.nativeSeekPromise
      return
    }

    if (this.nativeEventUnsubscribe === null) {
      await this.initNativeAudio()
    }

    this.nativeSeekPromise = (async () => {
      try {
        while (this.pendingNativeSeekTime !== null) {
          const nextSeekTime = this.pendingNativeSeekTime
          this.pendingNativeSeekTime = null
          this.nativeSnapshot = await window.nativeAudioAPI.seek(nextSeekTime)
          this._playbackState = this.nativeSnapshot.playbackState as PlaybackState
          this.emit('timeUpdate', this.nativeSnapshot.currentTime)
          this.notifyTrackChange()
        }
      } finally {
        this.nativeSeekPromise = null
      }
    })()

    await this.nativeSeekPromise
  }

  // Set volume (0-1)
  setVolume(value: number): void {
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    this._volume = Math.max(0, Math.min(1, value))
    if (this.gainNode && !this._isMuted) {
      this.gainNode.gain.value = this._volume
    }
  }

  // Toggle mute
  toggleMute(): void {
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    this._isMuted = !this._isMuted
    if (this.gainNode) {
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume
    }
  }

  // Set mute state
  setMuted(muted: boolean): void {
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    this._isMuted = muted
    if (this.gainNode) {
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume
    }
  }

  // --- EQ Methods ---

  /**
   * Rebuild the entire EQ filter chain.
   * Disconnects old chain then reconnects new one in the same synchronous block,
   * so the audio thread only sees the final connected state (no audible gap).
   */
  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void {
    this.requestedEQBands = bands.map((band) => ({ ...band }))
    this.requestedEQPreampDb = preampDb
    this.requestedEQEnabled = enabled

    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    const postEQOutputNode = this.getPostEQOutputNode()
    if (!this.context || !this.preampNode || !postEQOutputNode) return

    // Update preamp
    const linearPreamp = enabled ? Math.pow(10, preampDb / 20) : 1.0
    this.preampNode.gain.setValueAtTime(linearPreamp, this.context.currentTime)

    // Tear down old chain: disconnect preamp outputs and all old filters
    try { this.preampNode.disconnect() } catch { /* ignore */ }
    for (const filter of this.eqFilters) {
      try { filter.disconnect() } catch { /* ignore */ }
    }
    this.eqFilters = []

    // Rebuild chain immediately (same synchronous block)
    // Route: preamp -> [EQ filters] -> post-EQ output node
    if (enabled && bands.length > 0) {
      const newFilters: BiquadFilterNode[] = bands.map((band) => {
        const filter = this.context!.createBiquadFilter()
        filter.type = this._mapBandType(band.type)
        filter.frequency.setValueAtTime(band.frequency, this.context!.currentTime)
        filter.Q.setValueAtTime(band.Q, this.context!.currentTime)
        filter.gain.setValueAtTime(band.gain, this.context!.currentTime)
        return filter
      })

      this.preampNode.connect(newFilters[0])
      for (let i = 0; i < newFilters.length - 1; i++) {
        newFilters[i].connect(newFilters[i + 1])
      }
      newFilters[newFilters.length - 1].connect(postEQOutputNode)
      this.eqFilters = newFilters
    } else {
      // Bypass EQ filters but keep the selected post-EQ route active.
      this.preampNode.connect(postEQOutputNode)
    }
  }

  /**
   * Update a single band's parameters without rebuilding the chain.
   * Efficient for real-time slider dragging.
   */
  updateEQBand(index: number, band: EQBand): void {
    if (index >= 0 && index < this.requestedEQBands.length) {
      this.requestedEQBands[index] = { ...band }
    }

    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    if (index < 0 || index >= this.eqFilters.length || !this.context) return
    const filter = this.eqFilters[index]
    filter.type = this._mapBandType(band.type)
    filter.frequency.setValueAtTime(band.frequency, this.context.currentTime)
    filter.Q.setValueAtTime(band.Q, this.context.currentTime)
    filter.gain.setValueAtTime(band.gain, this.context.currentTime)
  }

  /**
   * Update only the preamp gain without touching filters.
   */
  updatePreamp(dB: number): void {
    this.requestedEQPreampDb = dB
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }
    if (!this.preampNode) return
    const effectiveDb = this.requestedEQEnabled ? dB : 0
    this.preampNode.gain.value = Math.pow(10, effectiveDb / 20)
  }

  private _mapBandType(type: EQBand['type']): BiquadFilterType {
    switch (type) {
      case 'lowshelf': return 'lowshelf'
      case 'highshelf': return 'highshelf'
      case 'peaking': return 'peaking'
      case 'highpass': return 'highpass'
      case 'lowpass': return 'lowpass'
    }
  }

  private _disconnectEQChain(): void {
    // Disconnect preamp from everything (will be reconnected by caller)
    try { this.preampNode?.disconnect() } catch { /* ignore */ }
    // Disconnect all existing filters
    for (const filter of this.eqFilters) {
      try { filter.disconnect() } catch { /* ignore */ }
    }
    this.eqFilters = []
  }

  // Audio analysis is now handled by AudioWorklet -> Native C++
  // Visualizers should listen to worklet.port messages instead

  // Private helpers
  private stopSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null
        this.sourceNode.stop()
        this.sourceNode.buffer = null
        this.disconnectSourceRouting(this.sourceNode)
        this.sourceNode.disconnect()
      } catch {
        // Ignore errors from already stopped source
      }
      this.sourceNode = null
    }
  }

  private startTimeUpdate(): void {
    this.stopTimeUpdate()

    const update = () => {
      this.emit('timeUpdate', this.currentTime)
      this.animationFrame = requestAnimationFrame(update)
    }

    this.animationFrame = requestAnimationFrame(update)
  }

  private stopTimeUpdate(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }
  }

  // Cleanup
  dispose(): void {
    this.stop()
    this.clearNextBuffer()
    void this.clearRemoteStreamState(true)
    this.stopTimeUpdate()
    this.stopNativeScopePolling()
    if (this.lastNativeVisualizerTapDemand !== null) {
      void window.nativeAudioAPI.setVisualizerTapDemand({
        oscilloscope: false,
        spectrum: false,
        vectorscope: false,
        vumeter: false,
      }).catch(() => {
        // Ignore teardown errors.
      })
      this.lastNativeVisualizerTapDemand = null
    }
    if (this.nativeEventUnsubscribe) {
      this.nativeEventUnsubscribe()
      this.nativeEventUnsubscribe = null
    }
    if (this.remoteStreamChunkUnsubscribe) {
      this.remoteStreamChunkUnsubscribe()
      this.remoteStreamChunkUnsubscribe = null
    }
    if (this.remoteStreamEventUnsubscribe) {
      this.remoteStreamEventUnsubscribe()
      this.remoteStreamEventUnsubscribe = null
    }
    this.nativeSnapshot = null
    this.nativeNextTrackBuffered = false

    // Clean up EQ chain
    this._disconnectEQChain()
    if (this.preampNode) {
      try { this.preampNode.disconnect() } catch { /* ignore */ }
      this.preampNode = null
    }
    if (this.eqAnalyserNode) {
      try { this.eqAnalyserNode.disconnect() } catch { /* ignore */ }
      this.eqAnalyserNode = null
    }
    if (this.eqDisplayAnalyserNode) {
      try { this.eqDisplayAnalyserNode.disconnect() } catch { /* ignore */ }
      this.eqDisplayAnalyserNode = null
    }
    if (this.eqAnalysisTapSinkNode) {
      try { this.eqAnalysisTapSinkNode.disconnect() } catch { /* ignore */ }
      this.eqAnalysisTapSinkNode = null
    }
    if (this.eqAnalysisDelayNode) {
      try { this.eqAnalysisDelayNode.disconnect() } catch { /* ignore */ }
      this.eqAnalysisDelayNode = null
    }

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }
    this.disconnectRemoteStreamNode()
    this.disconnectParallaxSinkNode()
    this.parallaxSinkState = null
    if (this.analysisTapSinkNode) {
      try { this.analysisTapSinkNode.disconnect() } catch { /* ignore */ }
      this.analysisTapSinkNode = null
    }
    if (this.analysisDelayNode) {
      try { this.analysisDelayNode.disconnect() } catch { /* ignore */ }
      this.analysisDelayNode = null
    }

    if (this.fadeGainNode) {
      try { this.fadeGainNode.disconnect() } catch { /* ignore */ }
      this.fadeGainNode = null
    }

    if (this.context) {
      this.context.close()
      this.context = null
    }

    this.gainNode = null
    this.normalizationGainNode = null
    this.analysisNormalizationGainNode = null
    this.analysisDelayMs = 0
    this._normalizationGainDb = 0
    this._normalizationMode = 'off'
    this.normalizationApproximate = false
    this._replayGainEnabled = false
    this.currentReplayGainDb = null
    this.nextReplayGainDb = null
    this.clearNextNormalizationCache()
    this.audioBuffer = null
    this.nextBuffer = null
    this.currentNormalizationAnalysis = null
    this.nextNormalizationAnalysis = null
    this.currentBufferTrackPath = null
    this.nextBufferTrackPath = null
    this.remoteStreamState = null
    this.latestLeftChannel = new Float32Array(0)
    this.latestRightChannel = new Float32Array(0)
    this.latestMonoChannel = new Float32Array(0)
    this.pendingOscilloscopeSamples = []
    this.pendingSpectrumSamples = []
    this.pendingSpectrumStereoSamples = []
    this.pendingSpectrogramSamples = []
    this.pendingVectorscopeSamples = []
    this.pendingVUMeterSamples = []
    this.pendingLUFSMeterSamples = []
    this.pendingWaveformSamples = []
    this.pendingWaveformStereoSamples = []
    this.pendingMiniVisualizerChunks = []
    this.eventListeners.clear()
  }
}

// Singleton instance
export const audioEngine = new AudioEngine()
