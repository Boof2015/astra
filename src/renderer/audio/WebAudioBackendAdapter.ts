import {
  audioEngine,
  type DifferentialCalibrationResult,
  type OutputDelayCalibrationResult
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
import type { NativeAudioDevice } from './native/native-audio'

type EventCallback = (...args: unknown[]) => void

export class WebAudioBackendAdapter implements AudioBackendEngine {
  readonly family: AudioBackendFamily = 'web'
  readonly backendMode: AudioBackendMode = 'web-audio'
  readonly decoderLabel = 'Web Audio API'
  readonly supportsExclusiveMode = false
  readonly usesNativePlayback = false
  readonly usesAppResampler = true

  get playbackState(): PlaybackState {
    return audioEngine.playbackState
  }

  get volume(): number {
    return audioEngine.volume
  }

  get isMuted(): boolean {
    return audioEngine.isMuted
  }

  get currentTime(): number {
    return audioEngine.currentTime
  }

  get duration(): number {
    return audioEngine.duration
  }

  get hasNextBuffered(): boolean {
    return audioEngine.hasNextBuffered
  }

  get normalizationEnabled(): boolean {
    return audioEngine.normalizationEnabled
  }

  set normalizationEnabled(enabled: boolean) {
    audioEngine.normalizationEnabled = enabled
  }

  get targetLufs(): number {
    return audioEngine.targetLufs
  }

  set targetLufs(lufs: number) {
    audioEngine.targetLufs = lufs
  }

  on<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void {
    audioEngine.on(event, callback as unknown as EventCallback)
  }

  off<T extends AudioBackendEventName>(event: T, callback: AudioBackendEventMap[T]): void {
    audioEngine.off(event, callback as unknown as EventCallback)
  }

  onTrackChange(callback: () => void): () => void {
    return audioEngine.onTrackChange(callback)
  }

  async loadAudioData(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    await audioEngine.loadAudioData(arrayBuffer, options)
  }

  async preBufferNext(arrayBuffer: ArrayBuffer, options: AudioLoadDataOptions = {}): Promise<void> {
    await audioEngine.preBufferNext(arrayBuffer, options)
  }

  clearNextBuffer(): void {
    audioEngine.clearNextBuffer()
  }

  async play(): Promise<void> {
    await audioEngine.play()
  }

  pause(): void {
    audioEngine.pause()
  }

  async togglePlay(): Promise<void> {
    await audioEngine.togglePlay()
  }

  stop(): void {
    audioEngine.stop()
  }

  async seek(time: number): Promise<void> {
    await audioEngine.seek(time)
  }

  setVolume(value: number): void {
    audioEngine.setVolume(value)
  }

  toggleMute(): void {
    audioEngine.toggleMute()
  }

  setMuted(muted: boolean): void {
    audioEngine.setMuted(muted)
  }

  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void {
    audioEngine.updateEQ(bands, preampDb, enabled)
  }

  updateEQBand(index: number, band: EQBand): void {
    audioEngine.updateEQBand(index, band)
  }

  updatePreamp(dB: number): void {
    audioEngine.updatePreamp(dB)
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await audioEngine.setOutputDevice(deviceId)
  }

  async enumerateOutputDevices(): Promise<NativeAudioDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => {
        const isDefaultAlias = device.deviceId === 'default' || device.deviceId === ''
        const fallbackLabel = isDefaultAlias
          ? 'System Default Device'
          : `Speaker (${device.deviceId.slice(0, 8)}...)`
        return {
          deviceId: device.deviceId,
          label: device.label || fallbackLabel,
          groupId: device.groupId || '',
          isDefaultAlias,
          maxChannels: 2,
          supportsExclusive: false,
        }
      })
  }

  async ensureContextReady(): Promise<void> {
    await audioEngine.ensureContextReady()
  }

  isContextReady(): boolean {
    return audioEngine.isContextReady()
  }

  getCurrentTrackChannelCount(): number | null {
    return audioEngine.getCurrentTrackChannelCount()
  }

  getSampleRate(): number {
    return audioEngine.getSampleRate()
  }

  getDeviceSampleRate(): number | null {
    return audioEngine.getSampleRate()
  }

  getEQAnalyserNode(): AnalyserNode | null {
    return audioEngine.getEQAnalyserNode()
  }

  getOutputMaxChannelCount(): number | null {
    return audioEngine.getOutputMaxChannelCount()
  }

  getNormalizationGainDb(): number {
    return audioEngine.getNormalizationGainDb()
  }

  getNormalizationMode(): GainApplicationMode {
    return audioEngine.getNormalizationMode()
  }

  setCurrentReplayGainDb(replayGainDb: number | null): void {
    audioEngine.setCurrentReplayGainDb(replayGainDb)
  }

  setReplayGainEnabled(enabled: boolean): void {
    audioEngine.setReplayGainEnabled(enabled)
  }

  async setAnalysisDelayMs(ms: number): Promise<void> {
    await audioEngine.setAnalysisDelayMs(ms)
  }

  async setMultichannelEnabled(enabled: boolean): Promise<void> {
    await audioEngine.setMultichannelEnabled(enabled)
  }

  async setChannelRoutingMap(map: number[] | null): Promise<void> {
    await audioEngine.setChannelRoutingMap(map)
  }

  async runOutputDelayCalibration(inputDeviceId?: string): Promise<OutputDelayCalibrationResult> {
    return await audioEngine.runOutputDelayCalibration(inputDeviceId)
  }

  async runDifferentialCalibration(
    btOutputDeviceId: string,
    referenceOutputDeviceId: string,
    inputDeviceId?: string
  ): Promise<DifferentialCalibrationResult> {
    return await audioEngine.runDifferentialCalibration(
      btOutputDeviceId,
      referenceOutputDeviceId,
      inputDeviceId
    )
  }

  flushPendingOscilloscopeSamples(): Float32Array[] {
    return audioEngine.flushPendingOscilloscopeSamples()
  }

  flushPendingSpectrumSamples(): Float32Array[] {
    return audioEngine.flushPendingSpectrumSamples()
  }

  flushPendingVectorscopeSamples(): Array<{ left: Float32Array; right: Float32Array }> {
    return audioEngine.flushPendingVectorscopeSamples()
  }

  flushPendingMiniVisualizerChunks(): Array<{ left: Float32Array; mono: Float32Array }> {
    return audioEngine.flushPendingMiniVisualizerChunks()
  }

  flushPendingPostEqSpectrumSamples(): Float32Array[] {
    return []
  }

  getOutputDeviceId(): string {
    return ''
  }

  isExclusiveModeActive(): boolean {
    return false
  }
}
