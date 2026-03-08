import type {
  DifferentialCalibrationResult,
  OutputDelayCalibrationResult
} from './AudioEngine'
import type {
  AudioBackendEngine,
  AudioBackendEventMap,
  AudioBackendEventName,
  AudioLoadDataOptions
} from './AudioBackendEngine'
import type {
  AudioBackendFamily,
  AudioBackendMode,
  EQBand,
  GainApplicationMode,
  PlaybackState
} from '../types/audio'
import type {
  NativeAudioAPI,
  NativeAudioDecodedSamples,
  NativeAudioDevice
} from './native/native-audio'

type EventCallback = (...args: unknown[]) => void

interface GainState {
  gainDb: number
  linearGain: number
  mode: GainApplicationMode
}

const ANALYSIS_DELAY_MAX_MS = 2500
const NORMALIZATION_MIN_GAIN_DB = -18
const NORMALIZATION_MAX_GAIN_DB = 6
const DEFAULT_TARGET_LUFS = -14
const VISUALIZER_CHUNK_SIZE = 128
const POST_EQ_READ_FRAMES = 4096
const POLL_INTERVAL_MS = 20
const TIME_UPDATE_MIN_DELTA_SEC = 1 / 30
const MAX_PENDING_OSCILLOSCOPE_CHUNKS = 20
const MAX_PENDING_SPECTRUM_CHUNKS = 96
const MAX_PENDING_VECTORSCOPE_CHUNKS = 20
const MAX_PENDING_MINI_VISUALIZER_CHUNKS = 160
const MAX_PENDING_POST_EQ_CHUNKS = 96
const MAX_VISUALIZER_READ_FRAMES = MAX_PENDING_OSCILLOSCOPE_CHUNKS * VISUALIZER_CHUNK_SIZE

export class NativeAudioEngine implements AudioBackendEngine {
  private static normalizationContext: AudioContext | null = null

  readonly family: AudioBackendFamily = 'native'
  readonly supportsExclusiveMode = true
  readonly usesNativePlayback = true
  readonly usesAppResampler = false

  private readonly api: NativeAudioAPI
  private eventListeners = new Map<string, Set<EventCallback>>()
  private trackChangeCallbacks = new Set<() => void>()
  private mode: AudioBackendMode = 'native-shared'
  private requestedBitPerfect = false
  private lastFallbackWarning: string | null = null
  private animationFrame: number | null = null
  private manualStopPending = false
  private lastPollAt = 0
  private lastEmittedTime = Number.NaN
  private lastVisualizerPollAt = 0

  private _playbackState: PlaybackState = 'stopped'
  private _volume = 0.7
  private _isMuted = false
  private _currentTime = 0
  private _duration = 0
  private _hasNextBuffered = false
  private _normalizationEnabled = true
  private _replayGainEnabled = false
  private _targetLufs = DEFAULT_TARGET_LUFS
  private _normalizationGainDb = 0
  private _normalizationMode: GainApplicationMode = 'off'

  private currentReplayGainDb: number | null = null
  private nextReplayGainDb: number | null = null
  private nextGainState: GainState | null = null
  private nextBufferData: ArrayBuffer | null = null
  private multichannelEnabled = false
  private channelRoutingMap: number[] | null = null
  private outputDeviceId = ''
  private outputDevices: NativeAudioDevice[] = []
  private currentTrackChannelCount: number | null = null
  private sampleRate = 48000
  private deviceSampleRate: number | null = null

  private requestedEQBands: EQBand[] = []
  private requestedEQPreampDb = 0
  private requestedEQEnabled = false

  private pendingOscilloscopeSamples: Float32Array[] = []
  private pendingSpectrumSamples: Float32Array[] = []
  private pendingVectorscopeSamples: Array<{ left: Float32Array; right: Float32Array }> = []
  private pendingMiniVisualizerChunks: Array<{ left: Float32Array; mono: Float32Array }> = []
  private pendingPostEqSpectrumSamples: Float32Array[] = []

  constructor(api: NativeAudioAPI) {
    this.api = api
  }

  get backendMode(): AudioBackendMode {
    return this.mode
  }

  get decoderLabel(): string {
    return this.mode === 'bit-perfect'
      ? 'miniaudio (exclusive)'
      : 'miniaudio'
  }

  get playbackState(): PlaybackState {
    return this._playbackState
  }

  get volume(): number {
    return this._volume
  }

  get isMuted(): boolean {
    return this.mode === 'bit-perfect' ? false : this._isMuted
  }

  get currentTime(): number {
    return this._currentTime
  }

  get duration(): number {
    return this._duration
  }

  get hasNextBuffered(): boolean {
    return this._hasNextBuffered
  }

  get normalizationEnabled(): boolean {
    return this._normalizationEnabled
  }

  set normalizationEnabled(enabled: boolean) {
    this._normalizationEnabled = Boolean(enabled)
    void this.recomputeCurrentGainState()
    void this.recomputeNextGainState()
  }

  get targetLufs(): number {
    return this._targetLufs
  }

  set targetLufs(lufs: number) {
    if (!Number.isFinite(lufs)) return
    this._targetLufs = lufs
    void this.recomputeCurrentGainState()
    void this.recomputeNextGainState()
  }

  async configureMode(mode: Extract<AudioBackendMode, 'native-shared' | 'bit-perfect'>): Promise<AudioBackendMode> {
    this.requestedBitPerfect = mode === 'bit-perfect'
    this.mode = mode
    this.lastFallbackWarning = null
    this.applyModeConfiguration()
    return this.mode
  }

  takePendingFallbackWarning(): string | null {
    const warning = this.lastFallbackWarning
    this.lastFallbackWarning = null
    return warning
  }

  on<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)?.add(callback as unknown as EventCallback)
  }

  off<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void {
    this.eventListeners.get(event)?.delete(callback as unknown as EventCallback)
  }

  onTrackChange(callback: () => void): () => void {
    this.trackChangeCallbacks.add(callback)
    return () => {
      this.trackChangeCallbacks.delete(callback)
    }
  }

  async loadAudioData(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    this.manualStopPending = true
    this.api.stop()
    this.api.clearNextBuffer()
    this.clearPendingVisualData()
    this.currentReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)
    this.nextReplayGainDb = null
    this.nextGainState = null
    this.nextBufferData = null
    this._hasNextBuffered = false
    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)

    try {
      const ok = this.api.loadFromBuffer(arrayBuffer)
      if (!ok) {
        throw new Error('Failed to decode audio data')
      }

      this.syncStaticStateFromCurrentDecode()
      await this.recomputeCurrentGainState()
      this._playbackState = 'stopped'
      this._currentTime = 0
      this.lastEmittedTime = Number.NaN
      this.emitTrackChange()
      this.emit('stateChange', this._playbackState)
      this.emitTimeUpdate(true)
      this.emit('durationChange', this._duration)
      this.emit('bufferReady', null)
      this.startPolling()
    } catch (error) {
      this._playbackState = 'stopped'
      this._currentTime = 0
      this._duration = 0
      this.currentTrackChannelCount = null
      this.emit('stateChange', this._playbackState)
      this.emit('durationChange', 0)
      this.emit('error', error instanceof Error ? error : new Error('Failed to decode audio data'))
      throw error
    }
  }

  async preBufferNext(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    const ok = this.api.preBufferFromBuffer(arrayBuffer)
    if (!ok) {
      throw new Error('Failed to pre-buffer audio data')
    }

    this.nextReplayGainDb = this.normalizeReplayGainCandidate(options.replayGainDb)
    this.nextBufferData = arrayBuffer.slice(0)
    this._hasNextBuffered = true
    await this.recomputeNextGainState()
  }

  clearNextBuffer(): void {
    this.api.clearNextBuffer()
    this.nextReplayGainDb = null
    this.nextGainState = null
    this.nextBufferData = null
    this._hasNextBuffered = false
  }

  async play(): Promise<void> {
    this.manualStopPending = false
    this.applyModeConfiguration()
    const ok = this.api.play()
    if (!ok) {
      return
    }

    if (this.requestedBitPerfect && !this.api.isExclusiveModeActive()) {
      this.handleBitPerfectFallback()
    }

    this.syncStateFromApi()
    this.startPolling()
  }

  pause(): void {
    this.api.pause()
    this.syncStateFromApi()
  }

  async togglePlay(): Promise<void> {
    if (this._playbackState === 'playing') {
      this.pause()
      return
    }
    await this.play()
  }

  stop(): void {
    this.manualStopPending = true
    this.api.stop()
    this.syncStateFromApi()
    this._currentTime = 0
    this.lastEmittedTime = Number.NaN
    this.emitTimeUpdate(true)
  }

  async seek(time: number): Promise<void> {
    this.api.seek(time)
    this.syncStateFromApi()
    this.emitTimeUpdate(true)
  }

  setVolume(value: number): void {
    const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.7))
    this._volume = normalized
    if (this.mode === 'bit-perfect') return
    this.api.setVolume(normalized)
  }

  toggleMute(): void {
    if (this.mode === 'bit-perfect') return
    this._isMuted = !this._isMuted
    this.api.setMuted(this._isMuted)
  }

  setMuted(muted: boolean): void {
    if (this.mode === 'bit-perfect') return
    this._isMuted = Boolean(muted)
    this.api.setMuted(this._isMuted)
  }

  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void {
    this.requestedEQBands = bands.map((band) => ({ ...band }))
    this.requestedEQPreampDb = preampDb
    this.requestedEQEnabled = enabled
    this.applyModeConfiguration()
  }

  updateEQBand(index: number, band: EQBand): void {
    if (index < 0 || index >= this.requestedEQBands.length) return
    this.requestedEQBands[index] = { ...band }
    this.applyModeConfiguration()
  }

  updatePreamp(dB: number): void {
    this.requestedEQPreampDb = dB
    this.applyModeConfiguration()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId.trim()
    if (!this.api.selectDevice(this.outputDeviceId)) {
      throw new Error('Failed to select native output device')
    }
    this.outputDevices = this.api.enumerateDevices()
    this.syncStaticStateFromCurrentDecode()
  }

  async enumerateOutputDevices(): Promise<NativeAudioDevice[]> {
    this.outputDevices = this.api.enumerateDevices()
    return this.outputDevices.map((device) => ({ ...device }))
  }

  async ensureContextReady(): Promise<void> {
    return
  }

  isContextReady(): boolean {
    return true
  }

  getCurrentTrackChannelCount(): number | null {
    return this.currentTrackChannelCount
  }

  getSampleRate(): number {
    return this.sampleRate
  }

  getDeviceSampleRate(): number | null {
    return this.deviceSampleRate
  }

  getEQAnalyserNode(): AnalyserNode | null {
    return null
  }

  getOutputMaxChannelCount(): number | null {
    const maxChannels = this.api.getOutputMaxChannelCount()
    return Number.isFinite(maxChannels) && maxChannels > 0 ? maxChannels : null
  }

  getNormalizationGainDb(): number {
    return this._normalizationGainDb
  }

  getNormalizationMode(): GainApplicationMode {
    return this.mode === 'bit-perfect' ? 'off' : this._normalizationMode
  }

  setCurrentReplayGainDb(replayGainDb: number | null): void {
    this.currentReplayGainDb = this.normalizeReplayGainCandidate(replayGainDb)
    void this.recomputeCurrentGainState()
  }

  setReplayGainEnabled(enabled: boolean): void {
    this._replayGainEnabled = Boolean(enabled)
    void this.recomputeCurrentGainState()
    void this.recomputeNextGainState()
  }

  async setAnalysisDelayMs(ms: number): Promise<void> {
    const normalized = Number.isFinite(ms) ? Math.max(0, Math.min(ANALYSIS_DELAY_MAX_MS, ms)) : 0
    this.api.setAnalysisDelayMs(normalized)
  }

  async setMultichannelEnabled(enabled: boolean): Promise<void> {
    this.multichannelEnabled = Boolean(enabled)
    if (this.mode === 'bit-perfect') {
      this.api.setMultichannelEnabled(false)
      return
    }
    this.api.setMultichannelEnabled(this.multichannelEnabled)
  }

  async setChannelRoutingMap(map: number[] | null): Promise<void> {
    this.channelRoutingMap = map ? map.map((value) => Math.trunc(value)) : null
    if (this.mode === 'bit-perfect') {
      this.api.setChannelRoutingMap(null)
      return
    }
    this.api.setChannelRoutingMap(this.channelRoutingMap)
  }

  async runOutputDelayCalibration(): Promise<OutputDelayCalibrationResult> {
    return {
      ok: false,
      code: 'not-supported',
      message: 'Delay calibration requires the Web Audio backend.'
    }
  }

  async runDifferentialCalibration(): Promise<DifferentialCalibrationResult> {
    return {
      ok: false,
      code: 'not-supported',
      message: 'Differential calibration requires the Web Audio backend.'
    }
  }

  flushPendingOscilloscopeSamples(): Float32Array[] {
    const samples = this.pendingOscilloscopeSamples
    this.pendingOscilloscopeSamples = []
    return samples
  }

  flushPendingSpectrumSamples(): Float32Array[] {
    const samples = this.pendingSpectrumSamples
    this.pendingSpectrumSamples = []
    return samples
  }

  flushPendingVectorscopeSamples(): Array<{ left: Float32Array; right: Float32Array }> {
    const samples = this.pendingVectorscopeSamples
    this.pendingVectorscopeSamples = []
    return samples
  }

  flushPendingMiniVisualizerChunks(): Array<{ left: Float32Array; mono: Float32Array }> {
    const samples = this.pendingMiniVisualizerChunks
    this.pendingMiniVisualizerChunks = []
    return samples
  }

  flushPendingPostEqSpectrumSamples(): Float32Array[] {
    const samples = this.pendingPostEqSpectrumSamples
    this.pendingPostEqSpectrumSamples = []
    return samples
  }

  getOutputDeviceId(): string {
    return this.outputDeviceId
  }

  isExclusiveModeActive(): boolean {
    return this.api.isExclusiveModeActive()
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach((callback) => callback(...args))
  }

  private emitTrackChange(): void {
    this.clearPendingVisualData()
    this.trackChangeCallbacks.forEach((callback) => callback())
  }

  private startPolling(): void {
    if (this.animationFrame !== null) return

    const tick = (timestamp: number) => {
      this.animationFrame = null
      this.poll(timestamp)

      if (this._playbackState !== 'stopped' || this._hasNextBuffered) {
        this.animationFrame = requestAnimationFrame(tick)
      }
    }

    this.animationFrame = requestAnimationFrame(tick)
  }

  private poll(timestamp: number): void {
    if ((timestamp - this.lastPollAt) >= POLL_INTERVAL_MS) {
      this.lastPollAt = timestamp

      const didTransition = this.api.didGaplessTransition()
      if (didTransition) {
        this.handleGaplessTransition()
      }

      this.syncStateFromApi()
    }

    this.pollVisualizerData(timestamp)
    this.pollPostEqSpectrumData()
  }

  private syncStateFromApi(): void {
    const nextState = this.api.getState()
    const nextDuration = this.api.getDuration()
    const nextTime = this.api.getPosition()
    const prevState = this._playbackState
    const prevDuration = this._duration
    const nextDeviceSampleRate = this.nullIfZero(this.api.getDeviceSampleRate())

    this._playbackState = nextState
    this._duration = Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0
    this._currentTime = Number.isFinite(nextTime)
      ? Math.max(0, Math.min(this._duration || Number.POSITIVE_INFINITY, nextTime))
      : 0
    this.deviceSampleRate = nextDeviceSampleRate ?? this.deviceSampleRate

    if (prevDuration !== this._duration) {
      this.emit('durationChange', this._duration)
    }

    if (prevState !== this._playbackState) {
      this.emit('stateChange', this._playbackState)
      if (prevState === 'playing' && this._playbackState === 'stopped') {
        if (this.manualStopPending) {
          this.manualStopPending = false
        } else {
          this.emit('ended')
        }
      }
    }

    this.emitTimeUpdate(prevState !== this._playbackState)
  }

  private syncStaticStateFromCurrentDecode(): void {
    const decoded = this.api.getDecodedSamples()
    const nextDeviceSampleRate = this.nullIfZero(this.api.getDeviceSampleRate())
    this.currentTrackChannelCount = decoded?.channels ?? this.nullIfZero(this.api.getCurrentTrackChannelCount())
    this.sampleRate = decoded?.sampleRate || this.api.getSampleRate() || 48000
    this.deviceSampleRate = nextDeviceSampleRate ?? this.deviceSampleRate ?? this.sampleRate
    this._duration = this.api.getDuration()
  }

  private pollVisualizerData(timestamp: number): void {
    const canQueueOscilloscope = this.pendingOscilloscopeSamples.length < MAX_PENDING_OSCILLOSCOPE_CHUNKS
    const canQueueSpectrum = this.pendingSpectrumSamples.length < MAX_PENDING_SPECTRUM_CHUNKS
    const canQueueVectorscope = this.pendingVectorscopeSamples.length < MAX_PENDING_VECTORSCOPE_CHUNKS
    const canQueueMini = this.pendingMiniVisualizerChunks.length < MAX_PENDING_MINI_VISUALIZER_CHUNKS

    if (!canQueueOscilloscope && !canQueueSpectrum && !canQueueVectorscope && !canQueueMini) {
      return
    }

    const { mono, left, right, count } = this.api.readVisualizerSamples(
      this.getVisualizerReadFrames(timestamp)
    )
    if (!count || count <= 0) return

    const monoFrames = mono.subarray(0, count)
    const leftFrames = left.subarray(0, count)
    const rightFrames = right.subarray(0, count)

    for (let start = 0; start < count; start += VISUALIZER_CHUNK_SIZE) {
      const end = Math.min(start + VISUALIZER_CHUNK_SIZE, count)
      const monoChunk = monoFrames.subarray(start, end)
      const leftChunk = leftFrames.subarray(start, end)
      const rightChunk = rightFrames.subarray(start, end)

      if (canQueueOscilloscope && this.pendingOscilloscopeSamples.length < MAX_PENDING_OSCILLOSCOPE_CHUNKS) {
        this.pendingOscilloscopeSamples.push(leftChunk)
      }
      if (canQueueSpectrum && this.pendingSpectrumSamples.length < MAX_PENDING_SPECTRUM_CHUNKS) {
        this.pendingSpectrumSamples.push(monoChunk)
      }
      if (canQueueVectorscope && this.pendingVectorscopeSamples.length < MAX_PENDING_VECTORSCOPE_CHUNKS) {
        this.pendingVectorscopeSamples.push({ left: leftChunk, right: rightChunk })
      }
      if (canQueueMini && this.pendingMiniVisualizerChunks.length < MAX_PENDING_MINI_VISUALIZER_CHUNKS) {
        this.pendingMiniVisualizerChunks.push({ left: leftChunk, mono: monoChunk })
      }
    }

    this.trimChunkQueues()
  }

  private pollPostEqSpectrumData(): void {
    if (this.pendingPostEqSpectrumSamples.length >= MAX_PENDING_POST_EQ_CHUNKS) {
      return
    }

    const { mono, count } = this.api.readPostEqSpectrumSamples(POST_EQ_READ_FRAMES)
    if (!count || count <= 0) return

    const monoFrames = mono.subarray(0, count)
    for (let start = 0; start < count; start += VISUALIZER_CHUNK_SIZE) {
      const end = Math.min(start + VISUALIZER_CHUNK_SIZE, count)
      this.pendingPostEqSpectrumSamples.push(monoFrames.subarray(start, end))
      if (this.pendingPostEqSpectrumSamples.length >= MAX_PENDING_POST_EQ_CHUNKS) {
        break
      }
    }

    if (this.pendingPostEqSpectrumSamples.length > MAX_PENDING_POST_EQ_CHUNKS) {
      this.pendingPostEqSpectrumSamples.splice(
        0,
        this.pendingPostEqSpectrumSamples.length - MAX_PENDING_POST_EQ_CHUNKS
      )
    }
  }

  private clearPendingVisualData(): void {
    this.pendingOscilloscopeSamples = []
    this.pendingSpectrumSamples = []
    this.pendingVectorscopeSamples = []
    this.pendingMiniVisualizerChunks = []
    this.pendingPostEqSpectrumSamples = []
    this.lastVisualizerPollAt = 0
  }

  private trimChunkQueues(): void {
    if (this.pendingOscilloscopeSamples.length > MAX_PENDING_OSCILLOSCOPE_CHUNKS) {
      this.pendingOscilloscopeSamples.splice(0, this.pendingOscilloscopeSamples.length - MAX_PENDING_OSCILLOSCOPE_CHUNKS)
    }
    if (this.pendingSpectrumSamples.length > MAX_PENDING_SPECTRUM_CHUNKS) {
      this.pendingSpectrumSamples.splice(0, this.pendingSpectrumSamples.length - MAX_PENDING_SPECTRUM_CHUNKS)
    }
    if (this.pendingVectorscopeSamples.length > MAX_PENDING_VECTORSCOPE_CHUNKS) {
      this.pendingVectorscopeSamples.splice(0, this.pendingVectorscopeSamples.length - MAX_PENDING_VECTORSCOPE_CHUNKS)
    }
    if (this.pendingMiniVisualizerChunks.length > MAX_PENDING_MINI_VISUALIZER_CHUNKS) {
      this.pendingMiniVisualizerChunks.splice(0, this.pendingMiniVisualizerChunks.length - MAX_PENDING_MINI_VISUALIZER_CHUNKS)
    }
  }

  private handleGaplessTransition(): void {
    this.syncStaticStateFromCurrentDecode()
    this.currentReplayGainDb = this.nextReplayGainDb
    this.nextReplayGainDb = null
    this.nextBufferData = null
    this._hasNextBuffered = false

    if (this.nextGainState) {
      this.applyGainState(this.nextGainState)
    } else {
      void this.recomputeCurrentGainState()
    }

    this.nextGainState = null
    this.emitTrackChange()
    this.lastEmittedTime = Number.NaN
    this.emitTimeUpdate(true)
    this.emit('durationChange', this._duration)
    this.emit('bufferReady', null)
    this.emit('gaplessTransition')
  }

  private handleBitPerfectFallback(): void {
    this.api.pause()
    this.mode = 'native-shared'
    this.requestedBitPerfect = false
    this.lastFallbackWarning = 'Bit-perfect exclusive mode was unavailable. Astra fell back to Native shared mode.'
    this.applyModeConfiguration()
    this.api.play()
  }

  private applyModeConfiguration(): void {
    const bitPerfect = this.mode === 'bit-perfect'
    this.api.setExclusiveMode(bitPerfect)
    this.api.setDspEnabled(!bitPerfect)
    this.api.setMuted(bitPerfect ? false : this._isMuted)
    this.api.setVolume(bitPerfect ? 1 : this._volume)
    this.api.setMultichannelEnabled(bitPerfect ? false : this.multichannelEnabled)
    this.api.setChannelRoutingMap(bitPerfect ? null : this.channelRoutingMap)
    this.api.updateEQ(
      this.requestedEQBands,
      this.requestedEQPreampDb,
      bitPerfect ? false : this.requestedEQEnabled
    )

    if (bitPerfect) {
      this.api.setNormalizationGain(1)
      this._normalizationGainDb = 0
      this._normalizationMode = 'off'
      return
    }

    const currentLinearGain = this.toLinearGain(this._normalizationGainDb)
    this.api.setNormalizationGain(currentLinearGain)
  }

  private async recomputeCurrentGainState(): Promise<void> {
    if (this.mode === 'bit-perfect') {
      this.applyGainState({ gainDb: 0, linearGain: 1, mode: 'off' })
      return
    }

    const decoded = this.api.getDecodedSamples()
    if (!decoded) {
      this.applyGainState({ gainDb: 0, linearGain: 1, mode: 'off' })
      return
    }

    const gainState = this.resolveGainStateForDecoded(decoded, this.currentReplayGainDb)
    this.applyGainState(gainState)
  }

  private async recomputeNextGainState(): Promise<void> {
    if (!this.nextBufferData) {
      this.nextGainState = null
      return
    }

    if (this.mode === 'bit-perfect') {
      this.nextGainState = { gainDb: 0, linearGain: 1, mode: 'off' }
      return
    }

    if (!this._normalizationEnabled) {
      this.nextGainState = { gainDb: 0, linearGain: 1, mode: 'off' }
      return
    }

    if (this._replayGainEnabled && this.nextReplayGainDb != null) {
      const clampedGainDb = this.clampGainDb(this.nextReplayGainDb)
      this.nextGainState = {
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      }
      return
    }

    try {
      const analysisBuffer = await this.decodeAudioDataForNormalization(this.nextBufferData)
      this.nextGainState = this.resolveGainStateForAudioBuffer(analysisBuffer, this.nextReplayGainDb)
    } catch {
      this.nextGainState = {
        gainDb: this._normalizationGainDb,
        linearGain: this.toLinearGain(this._normalizationGainDb),
        mode: this._normalizationMode
      }
    }
  }

  private applyGainState(gainState: GainState): void {
    this._normalizationGainDb = gainState.gainDb
    this._normalizationMode = gainState.mode
    if (this.mode === 'bit-perfect') {
      this.api.setNormalizationGain(1)
      return
    }
    this.api.setNormalizationGain(gainState.linearGain)
  }

  private resolveGainStateForDecoded(
    decoded: NativeAudioDecodedSamples,
    replayGainDb: number | null
  ): GainState {
    if (!this._normalizationEnabled) {
      return { gainDb: 0, linearGain: 1, mode: 'off' }
    }

    if (this._replayGainEnabled && replayGainDb != null) {
      const clampedGainDb = this.clampGainDb(replayGainDb)
      return {
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      }
    }

    const currentDb = this.calculateLoudnessFromSamples(decoded.samples, decoded.channels)
    const gainDb = this.clampGainDb(this._targetLufs - currentDb)
    return {
      gainDb,
      linearGain: this.toLinearGain(gainDb),
      mode: 'normalization'
    }
  }

  private resolveGainStateForAudioBuffer(buffer: AudioBuffer, replayGainDb: number | null): GainState {
    if (!this._normalizationEnabled) {
      return { gainDb: 0, linearGain: 1, mode: 'off' }
    }

    if (this._replayGainEnabled && replayGainDb != null) {
      const clampedGainDb = this.clampGainDb(replayGainDb)
      return {
        gainDb: clampedGainDb,
        linearGain: this.toLinearGain(clampedGainDb),
        mode: 'replaygain'
      }
    }

    const currentDb = this.calculateLoudnessFromAudioBuffer(buffer)
    const gainDb = this.clampGainDb(this._targetLufs - currentDb)
    return {
      gainDb,
      linearGain: this.toLinearGain(gainDb),
      mode: 'normalization'
    }
  }

  private calculateLoudnessFromSamples(samples: Float32Array, channels: number): number {
    if (channels <= 0 || samples.length === 0) return 0
    let sumSquares = 0
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] ?? 0
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / samples.length)
    return 20 * Math.log10(rms + 1e-10)
  }

  private calculateLoudnessFromAudioBuffer(buffer: AudioBuffer): number {
    let sumSquares = 0
    const channels = buffer.numberOfChannels
    const length = buffer.length

    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel)
      for (let i = 0; i < length; i++) {
        const sample = data[i] ?? 0
        sumSquares += sample * sample
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, channels * length))
    return 20 * Math.log10(rms + 1e-10)
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

  private nullIfZero(value: number): number | null {
    return Number.isFinite(value) && value > 0 ? value : null
  }

  private emitTimeUpdate(force = false): void {
    if (
      !force
      && Number.isFinite(this.lastEmittedTime)
      && Math.abs(this._currentTime - this.lastEmittedTime) < TIME_UPDATE_MIN_DELTA_SEC
    ) {
      return
    }

    this.lastEmittedTime = this._currentTime
    this.emit('timeUpdate', this._currentTime)
  }

  private getVisualizerReadFrames(timestamp: number): number {
    const sampleRate = Math.max(1, this.deviceSampleRate ?? this.sampleRate ?? 48000)
    const elapsedMs = this.lastVisualizerPollAt > 0
      ? Math.max(1, Math.min(100, timestamp - this.lastVisualizerPollAt))
      : (1000 / 60)
    this.lastVisualizerPollAt = timestamp

    const estimatedFrames = Math.ceil((sampleRate * elapsedMs) / 1000) + VISUALIZER_CHUNK_SIZE
    const chunkAlignedFrames = Math.ceil(estimatedFrames / VISUALIZER_CHUNK_SIZE) * VISUALIZER_CHUNK_SIZE
    return Math.max(VISUALIZER_CHUNK_SIZE, Math.min(MAX_VISUALIZER_READ_FRAMES, chunkAlignedFrames))
  }

  private async decodeAudioDataForNormalization(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const context = NativeAudioEngine.normalizationContext
      ?? new AudioContext()
    NativeAudioEngine.normalizationContext = context
    return await context.decodeAudioData(arrayBuffer.slice(0))
  }
}
