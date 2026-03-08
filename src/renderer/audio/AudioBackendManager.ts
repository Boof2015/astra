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
import { NativeAudioEngine } from './NativeAudioEngine'
import { WebAudioBackendAdapter } from './WebAudioBackendAdapter'
import type {
  AudioBackendFamily,
  AudioBackendMode,
  EQBand,
  GainApplicationMode,
  PlaybackState
} from '../types/audio'
import type { NativeAudioDevice } from './native/native-audio'

type EventCallback = (...args: unknown[]) => void

export interface AudioBackendManagerModeChangeEvent {
  requestedMode: AudioBackendMode
  effectiveMode: AudioBackendMode
}

export interface AudioBackendManagerEventMap extends AudioBackendEventMap {
  modeChange: (event: AudioBackendManagerModeChangeEvent) => void
  fallbackWarning: (warning: string) => void
}

type AudioBackendManagerEventName = keyof AudioBackendManagerEventMap

export class AudioBackendManager implements AudioBackendEngine {
  private readonly webEngine = new WebAudioBackendAdapter()
  private readonly nativeEngine = window.nativeAudioAPI
    ? new NativeAudioEngine(window.nativeAudioAPI)
    : null

  private activeEngine: AudioBackendEngine = this.webEngine
  private eventListeners = new Map<string, Set<EventCallback>>()
  private trackChangeCallbacks = new Set<() => void>()
  private activeTrackChangeUnsubscribe: (() => void) | null = null
  private activeEngineForwarders: Array<{ event: AudioBackendEventName; callback: EventCallback }> = []

  private _requestedMode: AudioBackendMode = 'web-audio'
  private _effectiveMode: AudioBackendMode = 'web-audio'
  private _fallbackWarning: string | null = null

  constructor() {
    this.attachEngine(this.activeEngine)
  }

  get engine(): AudioBackendEngine {
    return this.activeEngine
  }

  get requestedMode(): AudioBackendMode {
    return this._requestedMode
  }

  get effectiveMode(): AudioBackendMode {
    return this._effectiveMode
  }

  get isNativeAvailable(): boolean {
    return this.nativeEngine !== null
  }

  get fallbackWarning(): string | null {
    return this._fallbackWarning
  }

  get family(): AudioBackendFamily {
    return this.activeEngine.family
  }

  get backendMode(): AudioBackendMode {
    return this.activeEngine.backendMode
  }

  get decoderLabel(): string {
    return this.activeEngine.decoderLabel
  }

  get supportsExclusiveMode(): boolean {
    return this.activeEngine.supportsExclusiveMode
  }

  get usesNativePlayback(): boolean {
    return this.activeEngine.usesNativePlayback
  }

  get usesAppResampler(): boolean {
    return this.activeEngine.usesAppResampler
  }

  get playbackState(): PlaybackState {
    return this.activeEngine.playbackState
  }

  get volume(): number {
    return this.activeEngine.volume
  }

  get isMuted(): boolean {
    return this.activeEngine.isMuted
  }

  get currentTime(): number {
    return this.activeEngine.currentTime
  }

  get duration(): number {
    return this.activeEngine.duration
  }

  get hasNextBuffered(): boolean {
    return this.activeEngine.hasNextBuffered
  }

  get normalizationEnabled(): boolean {
    return this.activeEngine.normalizationEnabled
  }

  set normalizationEnabled(enabled: boolean) {
    this.activeEngine.normalizationEnabled = enabled
  }

  get targetLufs(): number {
    return this.activeEngine.targetLufs
  }

  set targetLufs(lufs: number) {
    this.activeEngine.targetLufs = lufs
  }

  on<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void
  on<T extends AudioBackendManagerEventName>(event: T, callback: AudioBackendManagerEventMap[T]): void
  on(event: string, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)?.add(callback)
  }

  off<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void
  off<T extends AudioBackendManagerEventName>(event: T, callback: AudioBackendManagerEventMap[T]): void
  off(event: string, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback)
  }

  onTrackChange(callback: () => void): () => void {
    this.trackChangeCallbacks.add(callback)
    return () => {
      this.trackChangeCallbacks.delete(callback)
    }
  }

  async switchTo(mode: AudioBackendMode): Promise<AudioBackendMode> {
    this._requestedMode = mode
    this._fallbackWarning = null

    if (mode === 'web-audio' || !this.nativeEngine) {
      if (mode !== 'web-audio' && !this.nativeEngine) {
        this._fallbackWarning = 'Native audio backend is unavailable. Astra stayed on Web Audio.'
        this.emit('fallbackWarning', this._fallbackWarning)
      }
      this.activeEngine.stop()
      this.swapActiveEngine(this.webEngine)
      this._effectiveMode = 'web-audio'
      this.emit('modeChange', {
        requestedMode: this._requestedMode,
        effectiveMode: this._effectiveMode
      })
      return this._effectiveMode
    }

    this.activeEngine.stop()
    this.swapActiveEngine(this.nativeEngine)
    this._effectiveMode = await this.nativeEngine.configureMode(
      mode === 'bit-perfect' ? 'bit-perfect' : 'native-shared'
    )
    this.consumeNativeFallbackState()
    this.emit('modeChange', {
      requestedMode: this._requestedMode,
      effectiveMode: this._effectiveMode
    })
    return this._effectiveMode
  }

  async loadAudioData(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    await this.activeEngine.loadAudioData(arrayBuffer, options)
    this.consumeNativeFallbackState()
  }

  async preBufferNext(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    await this.activeEngine.preBufferNext(arrayBuffer, options)
  }

  clearNextBuffer(): void {
    this.activeEngine.clearNextBuffer()
  }

  async play(): Promise<void> {
    await this.activeEngine.play()
    this.consumeNativeFallbackState()
  }

  pause(): void {
    this.activeEngine.pause()
  }

  async togglePlay(): Promise<void> {
    await this.activeEngine.togglePlay()
    this.consumeNativeFallbackState()
  }

  stop(): void {
    this.activeEngine.stop()
  }

  async seek(time: number): Promise<void> {
    await this.activeEngine.seek(time)
  }

  setVolume(value: number): void {
    this.activeEngine.setVolume(value)
  }

  toggleMute(): void {
    this.activeEngine.toggleMute()
  }

  setMuted(muted: boolean): void {
    this.activeEngine.setMuted(muted)
  }

  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void {
    this.activeEngine.updateEQ(bands, preampDb, enabled)
  }

  updateEQBand(index: number, band: EQBand): void {
    this.activeEngine.updateEQBand(index, band)
  }

  updatePreamp(dB: number): void {
    this.activeEngine.updatePreamp(dB)
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.activeEngine.setOutputDevice(deviceId)
  }

  async enumerateOutputDevices(): Promise<NativeAudioDevice[]> {
    return await this.activeEngine.enumerateOutputDevices()
  }

  async ensureContextReady(): Promise<void> {
    await this.activeEngine.ensureContextReady()
  }

  isContextReady(): boolean {
    return this.activeEngine.isContextReady()
  }

  getCurrentTrackChannelCount(): number | null {
    return this.activeEngine.getCurrentTrackChannelCount()
  }

  getSampleRate(): number {
    return this.activeEngine.getSampleRate()
  }

  getDeviceSampleRate(): number | null {
    return this.activeEngine.getDeviceSampleRate()
  }

  getEQAnalyserNode(): AnalyserNode | null {
    return this.activeEngine.getEQAnalyserNode()
  }

  getOutputMaxChannelCount(): number | null {
    return this.activeEngine.getOutputMaxChannelCount()
  }

  getNormalizationGainDb(): number {
    return this.activeEngine.getNormalizationGainDb()
  }

  getNormalizationMode(): GainApplicationMode {
    return this.activeEngine.getNormalizationMode()
  }

  setCurrentReplayGainDb(replayGainDb: number | null): void {
    this.activeEngine.setCurrentReplayGainDb(replayGainDb)
  }

  setReplayGainEnabled(enabled: boolean): void {
    this.activeEngine.setReplayGainEnabled(enabled)
  }

  async setAnalysisDelayMs(ms: number): Promise<void> {
    await this.activeEngine.setAnalysisDelayMs(ms)
  }

  async setMultichannelEnabled(enabled: boolean): Promise<void> {
    await this.activeEngine.setMultichannelEnabled(enabled)
  }

  async setChannelRoutingMap(map: number[] | null): Promise<void> {
    await this.activeEngine.setChannelRoutingMap(map)
  }

  async runOutputDelayCalibration(inputDeviceId?: string): Promise<OutputDelayCalibrationResult> {
    return await this.activeEngine.runOutputDelayCalibration(inputDeviceId)
  }

  async runDifferentialCalibration(
    btOutputDeviceId: string,
    referenceOutputDeviceId: string,
    inputDeviceId?: string
  ): Promise<DifferentialCalibrationResult> {
    return await this.activeEngine.runDifferentialCalibration(
      btOutputDeviceId,
      referenceOutputDeviceId,
      inputDeviceId
    )
  }

  flushPendingOscilloscopeSamples(): Float32Array[] {
    return this.activeEngine.flushPendingOscilloscopeSamples()
  }

  flushPendingSpectrumSamples(): Float32Array[] {
    return this.activeEngine.flushPendingSpectrumSamples()
  }

  flushPendingVectorscopeSamples(): Array<{ left: Float32Array; right: Float32Array }> {
    return this.activeEngine.flushPendingVectorscopeSamples()
  }

  flushPendingMiniVisualizerChunks(): Array<{ left: Float32Array; mono: Float32Array }> {
    return this.activeEngine.flushPendingMiniVisualizerChunks()
  }

  flushPendingPostEqSpectrumSamples(): Float32Array[] {
    return this.activeEngine.flushPendingPostEqSpectrumSamples()
  }

  getOutputDeviceId(): string {
    return this.activeEngine.getOutputDeviceId()
  }

  isExclusiveModeActive(): boolean {
    return this.activeEngine.isExclusiveModeActive()
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach((callback) => callback(...args))
  }

  private swapActiveEngine(engine: AudioBackendEngine): void {
    if (this.activeEngine === engine) return
    this.detachEngine()
    this.activeEngine = engine
    this.attachEngine(engine)
  }

  private attachEngine(engine: AudioBackendEngine): void {
    const events: AudioBackendEventName[] = [
      'stateChange',
      'timeUpdate',
      'durationChange',
      'bufferReady',
      'gaplessTransition',
      'ended',
      'error',
    ]

    this.activeEngineForwarders = events.map((event) => {
      const callback = (...args: unknown[]) => {
        this.emit(event, ...args)
      }
      engine.on(event, callback as never)
      return { event, callback }
    })

    this.activeTrackChangeUnsubscribe = engine.onTrackChange(() => {
      this.trackChangeCallbacks.forEach((callback) => callback())
    })
  }

  private detachEngine(): void {
    for (const { event, callback } of this.activeEngineForwarders) {
      this.activeEngine.off(event, callback as never)
    }
    this.activeEngineForwarders = []
    this.activeTrackChangeUnsubscribe?.()
    this.activeTrackChangeUnsubscribe = null
  }

  private consumeNativeFallbackState(): void {
    if (!this.nativeEngine || this.activeEngine !== this.nativeEngine) {
      this._effectiveMode = 'web-audio'
      return
    }

    const warning = this.nativeEngine.takePendingFallbackWarning()
    this._effectiveMode = this.nativeEngine.backendMode
    if (warning) {
      this._fallbackWarning = warning
      this.emit('fallbackWarning', warning)
      this.emit('modeChange', {
        requestedMode: this._requestedMode,
        effectiveMode: this._effectiveMode
      })
    }
  }
}

export const backendManager = new AudioBackendManager()
