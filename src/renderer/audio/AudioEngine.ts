import { PlaybackState, EQBand, Track } from '../types/audio'
import type {
  NativeAudioCapabilities,
  NativeAudioEvent,
  NativeAudioPlaybackSnapshot,
  NativeAudioTrackMetadata,
  NativeAudioTrackLoadResult,
  NativeAudioVisualizerTapDemand,
  PlaybackOutputMode
} from '../../types/nativeAudio'
import type { ScopeKind } from '../../types/scopePopout'

type EventCallback = (...args: unknown[]) => void

const ANALYSIS_DELAY_MAX_MS = 2500
const ANALYSIS_DELAY_MAX_SEC = ANALYSIS_DELAY_MAX_MS / 1000
const BIT_PERFECT_UNSUPPORTED_MESSAGE = 'Bit-perfect mode bypasses all app DSP and uses exclusive/direct device output.'

const NORMALIZATION_MIN_GAIN_DB = -18
const NORMALIZATION_MAX_GAIN_DB = 6
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

type GainApplicationMode = 'off' | 'normalization' | 'replaygain'

interface GainState {
  gainDb: number
  linearGain: number
  mode: GainApplicationMode
}

export interface VisualizerConsumerDemand {
  spectrum?: boolean
  oscilloscope?: boolean
  vectorscope?: boolean
  spectrogram?: boolean
  vumeter?: boolean
  lufsmeter?: boolean
  waveform?: boolean
  miniSpectrum?: boolean
  miniOscilloscope?: boolean
}

interface AudioLoadDataOptions {
  replayGainDb?: number | null
}

interface PlaybackModeSwitchResult {
  activeMode: PlaybackOutputMode
  capabilities: NativeAudioCapabilities
  message: string | null
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
  private normalizationGainNode: GainNode | null = null
  private analysisNormalizationGainNode: GainNode | null = null
  private analysisDelayNode: DelayNode | null = null
  private analysisTapSinkNode: GainNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private workletLoaded: boolean = false
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
  private pendingSpectrogramSamples: Float32Array[] = []
  private pendingVectorscopeSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingVUMeterSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingLUFSMeterSamples: { left: Float32Array; right: Float32Array }[] = []
  private pendingWaveformSamples: Float32Array[] = []
  private pendingMiniVisualizerChunks: { left: Float32Array; mono: Float32Array }[] = []
  private visualizerConsumerDemand: Map<string, VisualizerConsumerDemand> = new Map()
  private static readonly MAX_PENDING_CHUNKS = 20 // ~2560 samples at 128/chunk
  private static readonly MAX_PENDING_SPECTRUM_CHUNKS = 96 // ~0.25s at 48k/128
  private static readonly MAX_PENDING_VECTORSCOPE_CHUNKS = 20
  private static readonly MAX_PENDING_MINI_VISUALIZER_CHUNKS = 160 // ~0.42s at 48k/128

  private audioBuffer: AudioBuffer | null = null
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
  private manualChannelRoutingMap: number[] | null = null
  private sourceRoutingNodes: WeakMap<AudioBufferSourceNode, {
    splitter: ChannelSplitterNode
    merger: ChannelMergerNode
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
  private nativeModeMessage: string | null = null
  private nativeNextTrackBuffered: boolean = false
  private lastNativeVisualizerTapDemand: NativeAudioVisualizerTapDemand | null = null

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
    this.playbackOutputMode = 'bitperfect'
    this.nativeModeMessage = BIT_PERFECT_UNSUPPORTED_MESSAGE
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
    this.pendingSpectrogramSamples = []
    this.pendingVectorscopeSamples = []
    this.pendingVUMeterSamples = []
    this.pendingLUFSMeterSamples = []
    this.pendingWaveformSamples = []
    this.pendingMiniVisualizerChunks = []
    this.clearLatestVisualizerChannels()
    this.resetBitPerfectVisualizerGain()
    this.bitPerfectOscilloscopeRemainder = new Float32Array(0)
    this.trackChangeCallbacks.forEach(cb => cb())
  }

  setVisualizerConsumerDemand(consumerId: string, demand: VisualizerConsumerDemand): void {
    const nextDemand: VisualizerConsumerDemand = {
      spectrum: Boolean(demand.spectrum),
      oscilloscope: Boolean(demand.oscilloscope),
      vectorscope: Boolean(demand.vectorscope),
      spectrogram: Boolean(demand.spectrogram),
      vumeter: Boolean(demand.vumeter),
      lufsmeter: Boolean(demand.lufsmeter),
      waveform: Boolean(demand.waveform),
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

  private hasVisualizerDemand(scope: ScopeKind): boolean {
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

  private syncStandardVisualizerStreaming(): void {
    if (!this.workletNode) return
    this.workletNode.port.postMessage({
      type: 'set-visualizer-streaming-enabled',
      enabled: this.playbackOutputMode === 'standard' && this.hasAnyVisualizerDemand()
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
        || this.hasVisualizerDemand('vumeter')
        || this.hasVisualizerDemand('lufsmeter')
        || this.hasVisualizerDemand('waveform')
      ),
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
        }

    if (
      this.lastNativeVisualizerTapDemand
      && this.lastNativeVisualizerTapDemand.oscilloscope === demand.oscilloscope
      && this.lastNativeVisualizerTapDemand.spectrum === demand.spectrum
      && this.lastNativeVisualizerTapDemand.vectorscope === demand.vectorscope
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
    if (!this.hasMiniVisualizerDemand('spectrum') && !this.hasMiniVisualizerDemand('oscilloscope')) {
      this.pendingMiniVisualizerChunks = []
    }
    if (!this.hasAnyVisualizerDemand()) {
      this.clearLatestVisualizerChannels()
      this.discardNativeScopeChunks()
    }
  }

  private queueVisualizerSamples(left: Float32Array, right: Float32Array): void {
    if (!left || !right || left.length === 0 || right.length === 0) return
    if (!this.hasAnyVisualizerDemand()) {
      this.clearLatestVisualizerChannels()
      return
    }

    const normalizedSamples = this.normalizeBitPerfectVisualizerSamples(left, right)
    const normalizedLeft = normalizedSamples?.left ?? left
    const normalizedRight = normalizedSamples?.right ?? right

    this.latestLeftChannel = normalizedLeft
    this.latestRightChannel = normalizedRight

    const oscilloscopeDemand = this.hasVisualizerDemand('oscilloscope')
    const spectrumDemand = this.hasVisualizerDemand('spectrum')
    const spectrogramDemand = this.hasVisualizerDemand('spectrogram')
    const vectorscopeDemand = this.hasVisualizerDemand('vectorscope')
    const vuMeterDemand = this.hasVisualizerDemand('vumeter')
    const lufsMeterDemand = this.hasVisualizerDemand('lufsmeter')
    const waveformDemand = this.hasVisualizerDemand('waveform')
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
      const leftChunk = new Float32Array(normalizedLeft)
      this.enqueueOscilloscopeSamples(leftChunk)
    }

    if (spectrumDemand && mono) {
      if (this.pendingSpectrumSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingSpectrumSamples = this.pendingSpectrumSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingSpectrumSamples.push(mono)
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
        left: miniOscilloscopeDemand ? new Float32Array(normalizedLeft) : new Float32Array(0),
        mono: miniSpectrumDemand && mono ? mono : new Float32Array(0),
      })
    }

    if (vectorscopeDemand) {
      if (this.pendingVectorscopeSamples.length >= AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS) {
        this.pendingVectorscopeSamples = this.pendingVectorscopeSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS / 2)
        )
      }
      this.pendingVectorscopeSamples.push({
        left: new Float32Array(normalizedLeft),
        right: new Float32Array(normalizedRight)
      })
    }

    if (vuMeterDemand) {
      if (this.pendingVUMeterSamples.length >= AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS) {
        this.pendingVUMeterSamples = this.pendingVUMeterSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS / 2)
        )
      }
      this.pendingVUMeterSamples.push({
        left: new Float32Array(normalizedLeft),
        right: new Float32Array(normalizedRight)
      })
    }

    if (lufsMeterDemand) {
      if (this.pendingLUFSMeterSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingLUFSMeterSamples = this.pendingLUFSMeterSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingLUFSMeterSamples.push({
        left: new Float32Array(normalizedLeft),
        right: new Float32Array(normalizedRight)
      })
    }

    if (waveformDemand) {
      if (this.pendingWaveformSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingWaveformSamples = this.pendingWaveformSamples.slice(
          -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
        )
      }
      this.pendingWaveformSamples.push(new Float32Array(normalizedLeft))
    }
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

  private normalizeBitPerfectVisualizerSamples(
    left: Float32Array,
    right: Float32Array
  ): { left: Float32Array; right: Float32Array } | null {
    if (this.playbackOutputMode !== 'bitperfect' || (!this._normalizationEnabled && !this._replayGainEnabled)) {
      return null
    }

    const desiredGain = this.resolveBitPerfectVisualizerGain(left, right)
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

    const normalizedLeft = new Float32Array(left.length)
    const normalizedRight = new Float32Array(right.length)
    for (let i = 0; i < left.length; i++) {
      normalizedLeft[i] = Math.max(-1, Math.min(1, left[i] * appliedGain))
    }
    for (let i = 0; i < right.length; i++) {
      normalizedRight[i] = Math.max(-1, Math.min(1, right[i] * appliedGain))
    }

    return {
      left: normalizedLeft,
      right: normalizedRight
    }
  }

  private smoothBitPerfectVisualizerGain(desiredGain: number): number {
    const smoothing = desiredGain > this.bitPerfectVisualizerGain
      ? BIT_PERFECT_VISUALIZER_GAIN_RISE_SMOOTHING
      : BIT_PERFECT_VISUALIZER_GAIN_FALL_SMOOTHING

    return this.bitPerfectVisualizerGain + ((desiredGain - this.bitPerfectVisualizerGain) * smoothing)
  }

  private resolveBitPerfectVisualizerGain(left: Float32Array, right: Float32Array): number {
    if (!this._normalizationEnabled) {
      return 1
    }

    let desiredGainDb: number
    if (this._replayGainEnabled && this.currentReplayGainDb != null) {
      desiredGainDb = this.currentReplayGainDb
    } else {
      const chunkLoudnessDb = this.calculateChunkLoudness(left, right)
      if (chunkLoudnessDb == null) {
        return this.bitPerfectVisualizerGainInitialized ? this.bitPerfectVisualizerGain : 1
      }
      desiredGainDb = this._targetLufs - chunkLoudnessDb
    }

    const clampedGain = this.toLinearGain(this.clampGainDb(desiredGainDb))
    const peak = this.getChunkPeak(left, right)
    if (!Number.isFinite(peak) || peak <= 0) {
      return clampedGain
    }

    return Math.min(clampedGain, BIT_PERFECT_VISUALIZER_TARGET_PEAK / peak)
  }

  private calculateChunkLoudness(left: Float32Array, right: Float32Array): number | null {
    const sampleCount = Math.min(left.length, right.length)
    if (sampleCount === 0) return null

    let sumSquares = 0
    for (let i = 0; i < sampleCount; i++) {
      const leftSample = left[i]
      const rightSample = right[i]
      sumSquares += (leftSample * leftSample) + (rightSample * rightSample)
    }

    const rms = Math.sqrt(sumSquares / (sampleCount * 2))
    if (!Number.isFinite(rms) || rms < BIT_PERFECT_VISUALIZER_SILENCE_RMS) {
      return null
    }

    return 20 * Math.log10(rms + 1e-10)
  }

  private getChunkPeak(left: Float32Array, right: Float32Array): number {
    const sampleCount = Math.min(left.length, right.length)
    let peak = 0

    for (let i = 0; i < sampleCount; i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
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
        void this.refreshNativeSnapshot()
        this.notifyTrackChange()
        this.emit('gaplessTransition')
        break
      case 'ended':
        this.nativeNextTrackBuffered = false
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

    if (stereoChunks.length > 0) {
      for (const chunk of stereoChunks) {
        this.queueVisualizerSamples(chunk.left, chunk.right)
      }
    } else if (leftChunks.length > 0 || monoChunks.length > 0) {
      const mono = monoChunks[monoChunks.length - 1] ?? new Float32Array(0)
      const left = leftChunks[leftChunks.length - 1] ?? mono
      const right = mono.length === left.length && mono.length > 0
        ? mono
        : left
      if (left.length > 0) {
        this.queueVisualizerSamples(left, right)
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

  async loadTrackFromPath(track: Track): Promise<NativeAudioTrackLoadResult> {
    await this.initNativeAudio()
    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)
    if (this.nativeSnapshot?.playbackState === 'playing' || this.nativeSnapshot?.playbackState === 'paused') {
      try {
        await window.nativeAudioAPI.stop()
      } catch {
        // Ignore stop failures here; the next load attempt will surface a hard error if the backend is unhealthy.
      }
    }
    this.clearNextBuffer()
    this.audioBuffer = null
    this.nativeNextTrackBuffered = false
    const result = await window.nativeAudioAPI.loadTrack(track.path, this.buildNativeTrackMetadata(track))
    await this.refreshNativeCapabilities()
    await this.refreshNativeSnapshot()
    this.notifyTrackChange()
    this._playbackState = 'stopped'
    this.emit('stateChange', this._playbackState)
    this.emit('durationChange', result.duration)
    return result
  }

  async preBufferNextTrackFromPath(track: Track): Promise<NativeAudioTrackLoadResult> {
    await this.initNativeAudio()
    const result = await window.nativeAudioAPI.preloadNextTrack(track.path, this.buildNativeTrackMetadata(track))
    this.nativeNextTrackBuffered = true
    return result
  }

  private getMaxDestinationChannelCount(): number {
    return Math.max(1, Math.min(32, this.context?.destination.maxChannelCount ?? 2))
  }

  private getRoutingOutputChannelCount(sourceChannels?: number): number {
    const maxChannels = this.getMaxDestinationChannelCount()
    if (!this.multichannelEnabled) {
      return Math.max(1, Math.min(maxChannels, 2))
    }

    const manualMapChannelCount = this.manualChannelRoutingMap?.length ?? 0

    if (manualMapChannelCount > 0) {
      return Math.max(1, Math.min(maxChannels, manualMapChannelCount))
    }

    const preferred = sourceChannels && sourceChannels > 0
      ? sourceChannels
      : this.audioBuffer?.numberOfChannels ?? 2

    return Math.max(1, Math.min(maxChannels, preferred))
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
    const useDiscreteRouting = routingChannels > 2
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
      this.applyNodeRoutingMode(node, routingChannels, mode, interpretation)
    }
  }

  private getEffectiveChannelMap(sourceChannels: number, outputChannels: number): Array<number | null> {
    return Array.from({ length: outputChannels }, (_, outputIndex) => {
      const manualSourceIndex = this.manualChannelRoutingMap?.[outputIndex]
      if (typeof manualSourceIndex === 'number' && Number.isInteger(manualSourceIndex)) {
        if (manualSourceIndex === -1) return null
        if (manualSourceIndex >= 0 && manualSourceIndex < sourceChannels) return manualSourceIndex
      }

      return outputIndex < sourceChannels ? outputIndex : null
    })
  }

  private connectSourceWithRouting(sourceNode: AudioBufferSourceNode, sourceChannels: number): void {
    if (!this.context || !this.normalizationGainNode) return

    this.applyChannelRoutingPreferences(sourceChannels)

    const outputChannels = this.getRoutingOutputChannelCount(sourceChannels)
    const shouldUseRoutingMatrix = Boolean(
      this.multichannelEnabled &&
      this.manualChannelRoutingMap &&
      this.manualChannelRoutingMap.length > 0
    )

    if (!shouldUseRoutingMatrix) {
      sourceNode.connect(this.normalizationGainNode)
      return
    }

    const splitter = this.context.createChannelSplitter(Math.max(1, sourceChannels))
    const merger = this.context.createChannelMerger(Math.max(1, outputChannels))
    this.applyNodeRoutingMode(splitter, sourceChannels, 'explicit', 'discrete')
    this.applyNodeRoutingMode(
      merger,
      outputChannels,
      outputChannels > 2 ? 'explicit' : 'max',
      outputChannels > 2 ? 'discrete' : 'speakers'
    )

    sourceNode.connect(splitter)

    const channelMap = this.getEffectiveChannelMap(sourceChannels, outputChannels)
    for (let outputIndex = 0; outputIndex < outputChannels; outputIndex++) {
      const sourceIndex = channelMap[outputIndex]
      if (sourceIndex === null) continue
      splitter.connect(merger, sourceIndex, outputIndex)
    }

    merger.connect(this.normalizationGainNode)
    this.sourceRoutingNodes.set(sourceNode, { splitter, merger })
  }

  private connectSourceToAnalysisTap(sourceNode: AudioBufferSourceNode, sourceChannels: number): void {
    if (!this.analysisNormalizationGainNode) return

    this.applyNodeRoutingMode(
      this.analysisNormalizationGainNode,
      Math.max(1, sourceChannels),
      sourceChannels > 2 ? 'explicit' : 'max',
      sourceChannels > 2 ? 'discrete' : 'speakers'
    )

    sourceNode.connect(this.analysisNormalizationGainNode)
  }

  private disconnectSourceRouting(sourceNode: AudioBufferSourceNode | null): void {
    if (!sourceNode) return

    const routingNodes = this.sourceRoutingNodes.get(sourceNode)
    if (!routingNodes) return

    try { routingNodes.splitter.disconnect() } catch { /* ignore */ }
    try { routingNodes.merger.disconnect() } catch { /* ignore */ }
    this.sourceRoutingNodes.delete(sourceNode)
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

    if (this._playbackState === 'playing' && this.audioBuffer) {
      await this.seek(this.currentTime)
    }
  }

  private async initContext(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext()

      // Create persistent nodes
      this.gainNode = this.context.createGain()
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume

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
          const { left, right } = event.data
          if (left && right && left.length > 0) {
            this.queueVisualizerSamples(left, right)
          }
        }
        this.syncStandardVisualizerStreaming()
      }

      // Connect main signal path:
      // playback: normalization -> preamp -> [eq filters] -> gain -> destination
      this.normalizationGainNode.connect(this.preampNode)
      // Initially preamp connects through analyser to gain (no EQ bands yet)
      this.preampNode.connect(this.eqAnalyserNode)
      this.eqAnalyserNode.connect(this.gainNode)
      this.gainNode.connect(this.context.destination)

      // delayed EQ analyser tap for EQ/fullscreen visuals
      if (this.eqAnalysisDelayNode && this.eqDisplayAnalyserNode && this.eqAnalysisTapSinkNode) {
        this.eqAnalyserNode.connect(this.eqAnalysisDelayNode)
        this.eqAnalysisDelayNode.connect(this.eqDisplayAnalyserNode)
        this.eqDisplayAnalyserNode.connect(this.eqAnalysisTapSinkNode)
        this.eqAnalysisTapSinkNode.connect(this.context.destination)
      }

      // analysis: normalization tap -> worklet -> silent sink so the worklet stays pulled.
      if (this.workletNode && this.analysisNormalizationGainNode && this.analysisDelayNode) {
        this.analysisTapSinkNode = this.context.createGain()
        this.analysisTapSinkNode.gain.value = 0
        this.analysisNormalizationGainNode.connect(this.analysisDelayNode)
        this.analysisDelayNode.connect(this.workletNode)
        this.workletNode.connect(this.analysisTapSinkNode)
        this.analysisTapSinkNode.connect(this.context.destination)
      }

      // Apply the latest requested EQ state now that the EQ nodes exist.
      this.updateEQ(this.requestedEQBands, this.requestedEQPreampDb, this.requestedEQEnabled)

      // Keep stereo behavior for stereo sinks. Enable explicit/discrete routing on multichannel sinks.
      this.applyChannelRoutingPreferences(this.audioBuffer?.numberOfChannels)
    }
  }

  /**
   * Calculate approximate loudness of an audio buffer in dB
   * Uses RMS (root mean square) measurement
   */
  private calculateLoudness(buffer: AudioBuffer): number {
    const channels = buffer.numberOfChannels
    const length = buffer.length
    let sumSquares = 0

    // Sum squares across all channels
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        sumSquares += data[i] * data[i]
      }
    }

    // Calculate RMS and convert to dB
    const rms = Math.sqrt(sumSquares / (length * channels))
    const dB = 20 * Math.log10(rms + 1e-10)

    return dB
  }

  private clampGainDb(gainDb: number): number {
    return Math.max(NORMALIZATION_MIN_GAIN_DB, Math.min(NORMALIZATION_MAX_GAIN_DB, gainDb))
  }

  private toLinearGain(gainDb: number): number {
    return Math.pow(10, gainDb / 20)
  }

  private normalizeReplayGainCandidate(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private computeNormalizationForBuffer(buffer: AudioBuffer): GainState {
    const currentDb = this.calculateLoudness(buffer)
    const gainDb = this._targetLufs - currentDb
    const clampedGainDb = this.clampGainDb(gainDb)
    const linearGain = this.toLinearGain(clampedGainDb)

    console.log(`Normalization: ${currentDb.toFixed(1)} dB -> ${this._targetLufs} dB (gain: ${clampedGainDb.toFixed(1)} dB)`)

    return {
      gainDb: clampedGainDb,
      linearGain,
      mode: 'normalization'
    }
  }

  private resolveGainStateForBuffer(buffer: AudioBuffer, replayGainDb: number | null): GainState {
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

    return this.computeNormalizationForBuffer(buffer)
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
    if (!this.nextBuffer) {
      this.clearNextNormalizationCache()
      return
    }

    const nextGain = this.resolveGainStateForBuffer(this.nextBuffer, this.nextReplayGainDb)
    this.nextNormalizationGainDb = nextGain.gainDb
    this.nextNormalizationLinearGain = nextGain.linearGain
    this.nextNormalizationMode = nextGain.mode
  }

  private getPendingNextNormalization(buffer: AudioBuffer): GainState {
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

    return this.resolveGainStateForBuffer(buffer, this.nextReplayGainDb)
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

  private applyNormalization(buffer: AudioBuffer): void {
    const normalization = this.resolveGainStateForBuffer(buffer, this.currentReplayGainDb)
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
    if (!enabled) {
      this.applyGainState({
        gainDb: 0,
        linearGain: 1,
        mode: 'off'
      })
    } else if (enabled && this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
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
    if (this._normalizationEnabled && this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
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

  setCurrentReplayGainDb(replayGainDb: number | null): void {
    const normalized = this.normalizeReplayGainCandidate(replayGainDb)
    if (this.currentReplayGainDb === normalized) return

    this.currentReplayGainDb = normalized
    if (this.playbackOutputMode === 'bitperfect') {
      return
    }

    if (this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
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

    if (this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
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
    if (!this.context || this._playbackState === 'stopped') return 0
    if (this._playbackState === 'paused') return this.pauseTime
    return this.context.currentTime - this.startTime
  }

  get duration(): number {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.duration ?? 0
    }
    return this.audioBuffer?.duration ?? 0
  }

  getAudioBuffer(): AudioBuffer | null {
    return this.audioBuffer
  }

  getCurrentTrackChannelCount(): number | null {
    if (this.playbackOutputMode === 'bitperfect') {
      return this.nativeSnapshot?.channels ?? null
    }
    return this.audioBuffer?.numberOfChannels ?? null
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
    if (this.playbackOutputMode === 'bitperfect') {
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

  // Flush all pending stereo chunks for VU meter processing.
  flushPendingVUMeterSamples(): { left: Float32Array; right: Float32Array }[] {
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

  // Load audio from ArrayBuffer
  async loadAudioData(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      throw new Error('Bit-perfect mode requires path-based native loading.')
    }
    await this.initContext()
    if (!this.context) throw new Error('AudioContext not initialized')

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)

    try {
      // Stop any current playback
      this.stopSource()
      this.clearNextBuffer()
      // Clear current decoded buffer so failed decode cannot replay stale audio.
      this.audioBuffer = null
      this.pauseTime = 0
      this.currentReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)

      // Decode audio data
      this.audioBuffer = await this.context.decodeAudioData(arrayBuffer)
      this.applyChannelRoutingPreferences(this.audioBuffer.numberOfChannels)

      // Notify visualizers of track change (reset their state for fresh pitch detection)
      this.notifyTrackChange()

      this.applyNormalization(this.audioBuffer)

      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.emit('stateChange', this._playbackState)
      this.emit('durationChange', this.audioBuffer.duration)
      this.emit('bufferReady', this.audioBuffer)
    } catch (err) {
      this.audioBuffer = null
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
    await this.initContext()
    if (!this.context) throw new Error('AudioContext not initialized')

    try {
      // Clone the ArrayBuffer since decodeAudioData detaches it
      const clonedBuffer = arrayBuffer.slice(0)
      this.nextReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)
      this.nextBuffer = await this.context.decodeAudioData(clonedBuffer)
      this.updateNextNormalizationCache()

      // If currently playing, schedule the gapless transition
      if (this._playbackState === 'playing' && this.audioBuffer) {
        this.scheduleGaplessTransition()
      }
    } catch (err) {
      console.error('Failed to pre-buffer next track:', err)
      this.nextBuffer = null
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
      this.clearNextNormalizationCache()
      // No next track buffered, emit ended normally
      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.emit('stateChange', this._playbackState)
      this.emit('ended')
      this.stopTimeUpdate()
      return
    }

    this.isGaplessTransition = true

    const nextBuffer = this.nextBuffer
    const nextSourceNode = this.nextSourceNode
    const nextNormalization = this.getPendingNextNormalization(nextBuffer)
    const nextReplayGainDb = this.nextReplayGainDb

    // Swap buffers
    this.audioBuffer = nextBuffer
    this.nextBuffer = null
    this.currentReplayGainDb = nextReplayGainDb
    this.nextReplayGainDb = null

    // Swap source nodes
    if (this.sourceNode) {
      this.sourceNode.onended = null
      this.disconnectSourceRouting(this.sourceNode)
      try {
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

  // Clear pre-buffered next track
  clearNextBuffer(): void {
    if (this.playbackOutputMode === 'bitperfect') {
      this.nativeNextTrackBuffered = false
      void window.nativeAudioAPI.clearNextTrack()
      return
    }
    this.cancelScheduledNext()
    this.nextBuffer = null
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
        this.nextSourceNode.disconnect()
      } catch { /* ignore */ }
      this.nextSourceNode = null
    }
    this.restoreCurrentNormalizationGainNow()
    this.scheduledEndTime = 0
  }

  // Play
  async play(): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      await this.initNativeAudio()
      this.nativeSnapshot = await window.nativeAudioAPI.play()
      this._playbackState = this.nativeSnapshot.playbackState as PlaybackState
      this.emit('stateChange', this._playbackState)
      this.syncNativeScopePolling()
      return
    }

    if (!this.audioBuffer || !this.context) return

    // Resume context if suspended (autoplay policy)
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }

    // If already playing, do nothing
    if (this._playbackState === 'playing') return

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

    // Start from pause position
    const offset = this.pauseTime
    this.startTime = this.context.currentTime - offset
    this.sourceNode.start(0, offset)

    this._playbackState = 'playing'
    this.emit('stateChange', this._playbackState)
    this.startTimeUpdate()

    // If we have a next buffer, schedule the gapless transition
    if (this.nextBuffer) {
      this.scheduleGaplessTransition()
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

    if (this._playbackState !== 'playing' || !this.context) return

    this.pauseTime = this.context.currentTime - this.startTime
    this.stopSource()
    this.cancelScheduledNext() // Cancel scheduled next track

    this._playbackState = 'paused'
    this.emit('stateChange', this._playbackState)
    this.stopTimeUpdate()
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
    if (this.playbackOutputMode === 'bitperfect') {
      this.nativeNextTrackBuffered = false
      void window.nativeAudioAPI.stop().then((snapshot) => {
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

    this.stopSource()
    this.cancelScheduledNext()
    this.pauseTime = 0
    this._playbackState = 'stopped'
    this.emit('stateChange', this._playbackState)
    this.emit('timeUpdate', 0)
    this.stopTimeUpdate()
  }

  // Seek to time in seconds
  async seek(time: number): Promise<void> {
    if (this.playbackOutputMode === 'bitperfect') {
      await this.initNativeAudio()
      this.nativeSnapshot = await window.nativeAudioAPI.seek(time)
      this._playbackState = this.nativeSnapshot.playbackState as PlaybackState
      this.emit('timeUpdate', this.nativeSnapshot.currentTime)
      this.notifyTrackChange()
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

    if (!this.context || !this.preampNode || !this.eqAnalyserNode) return

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
    // Route: preamp -> [EQ filters] -> eqAnalyserNode (-> gainNode already connected)
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
      newFilters[newFilters.length - 1].connect(this.eqAnalyserNode)
      this.eqFilters = newFilters
    } else {
      // Bypass: connect preamp directly to analyser
      this.preampNode.connect(this.eqAnalyserNode)
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
    this.stopTimeUpdate()
    this.stopNativeScopePolling()
    if (this.lastNativeVisualizerTapDemand !== null) {
      void window.nativeAudioAPI.setVisualizerTapDemand({
        oscilloscope: false,
        spectrum: false,
        vectorscope: false,
      }).catch(() => {
        // Ignore teardown errors.
      })
      this.lastNativeVisualizerTapDemand = null
    }
    if (this.nativeEventUnsubscribe) {
      this.nativeEventUnsubscribe()
      this.nativeEventUnsubscribe = null
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
    if (this.analysisTapSinkNode) {
      try { this.analysisTapSinkNode.disconnect() } catch { /* ignore */ }
      this.analysisTapSinkNode = null
    }
    if (this.analysisDelayNode) {
      try { this.analysisDelayNode.disconnect() } catch { /* ignore */ }
      this.analysisDelayNode = null
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
    this._replayGainEnabled = false
    this.currentReplayGainDb = null
    this.nextReplayGainDb = null
    this.clearNextNormalizationCache()
    this.audioBuffer = null
    this.latestLeftChannel = new Float32Array(0)
    this.latestRightChannel = new Float32Array(0)
    this.latestMonoChannel = new Float32Array(0)
    this.pendingOscilloscopeSamples = []
    this.pendingSpectrumSamples = []
    this.pendingSpectrogramSamples = []
    this.pendingVectorscopeSamples = []
    this.pendingVUMeterSamples = []
    this.pendingLUFSMeterSamples = []
    this.pendingWaveformSamples = []
    this.pendingMiniVisualizerChunks = []
    this.eventListeners.clear()
  }
}

// Singleton instance
export const audioEngine = new AudioEngine()
