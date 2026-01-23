import { PlaybackState } from '../types/audio'

type EventCallback = (...args: unknown[]) => void

/**
 * AudioEngine - Core Web Audio API wrapper for audio playback and analysis
 *
 * Supports gapless playback through pre-buffering and sample-accurate scheduling.
 *
 * Audio Graph:
 * Source -> AnalyserNode (pre) -> GainNode (volume) -> Destination
 *                |
 *                +-> ChannelSplitter -> AnalyserL / AnalyserR (for stereo visualization)
 */
export class AudioEngine {
  private context: AudioContext | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  private normalizationGainNode: GainNode | null = null
  private analyserNode: AnalyserNode | null = null

  // Stereo analysis nodes
  private channelSplitter: ChannelSplitterNode | null = null
  private analyserLeft: AnalyserNode | null = null
  private analyserRight: AnalyserNode | null = null

  private audioBuffer: AudioBuffer | null = null
  private startTime: number = 0
  private pauseTime: number = 0
  private _playbackState: PlaybackState = 'stopped'
  private _volume: number = 0.7
  private _isMuted: boolean = false
  private _normalizationEnabled: boolean = true
  private _targetLufs: number = -14 // Target loudness in dB RMS

  // Gapless playback support
  private nextBuffer: AudioBuffer | null = null
  private nextSourceNode: AudioBufferSourceNode | null = null
  private scheduledEndTime: number = 0
  private isGaplessTransition: boolean = false

  private animationFrame: number | null = null
  private eventListeners: Map<string, Set<EventCallback>> = new Map()

  constructor() {
    // Lazy init AudioContext on first user interaction
  }

  private initContext(): void {
    if (!this.context) {
      this.context = new AudioContext()

      // Create persistent nodes
      this.gainNode = this.context.createGain()
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume

      // Normalization gain node (applied before volume)
      this.normalizationGainNode = this.context.createGain()
      this.normalizationGainNode.gain.value = 1.0

      this.analyserNode = this.context.createAnalyser()
      this.analyserNode.fftSize = 2048
      this.analyserNode.smoothingTimeConstant = 0.8

      // Create stereo channel splitter and analysers for vectorscope
      this.channelSplitter = this.context.createChannelSplitter(2)
      this.analyserLeft = this.context.createAnalyser()
      this.analyserRight = this.context.createAnalyser()
      this.analyserLeft.fftSize = 2048
      this.analyserRight.fftSize = 2048
      this.analyserLeft.smoothingTimeConstant = 0
      this.analyserRight.smoothingTimeConstant = 0

      // Connect: analyser -> normalization -> gain -> destination
      this.analyserNode.connect(this.normalizationGainNode)
      this.normalizationGainNode.connect(this.gainNode)
      this.gainNode.connect(this.context.destination)

      // Connect stereo splitter (from main analyser output)
      this.analyserNode.connect(this.channelSplitter)
      this.channelSplitter.connect(this.analyserLeft, 0)
      this.channelSplitter.connect(this.analyserRight, 1)
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

  /**
   * Apply normalization gain based on buffer loudness
   */
  private applyNormalization(buffer: AudioBuffer): void {
    if (!this.normalizationGainNode) return

    const currentDb = this.calculateLoudness(buffer)
    const gainDb = this._targetLufs - currentDb

    // Clamp gain to prevent extreme values
    // Allow up to +6dB boost and -18dB cut
    const clampedGainDb = Math.max(-18, Math.min(6, gainDb))

    // Convert dB to linear gain
    const linearGain = Math.pow(10, clampedGainDb / 20)

    console.log(`Normalization: ${currentDb.toFixed(1)} dB -> ${this._targetLufs} dB (gain: ${clampedGainDb.toFixed(1)} dB)`)

    this.normalizationGainNode.gain.value = linearGain
  }

  // Normalization settings
  get normalizationEnabled(): boolean {
    return this._normalizationEnabled
  }

  set normalizationEnabled(enabled: boolean) {
    this._normalizationEnabled = enabled
    if (!enabled && this.normalizationGainNode) {
      this.normalizationGainNode.gain.value = 1.0
    } else if (enabled && this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
    }
  }

  get targetLufs(): number {
    return this._targetLufs
  }

  set targetLufs(lufs: number) {
    this._targetLufs = lufs
    if (this._normalizationEnabled && this.audioBuffer) {
      this.applyNormalization(this.audioBuffer)
    }
  }

  // Event emitter methods
  on(event: string, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)!.add(callback)
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
    if (!this.context || this._playbackState === 'stopped') return 0
    if (this._playbackState === 'paused') return this.pauseTime
    return this.context.currentTime - this.startTime
  }

  get duration(): number {
    return this.audioBuffer?.duration ?? 0
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  get analyserL(): AnalyserNode | null {
    return this.analyserLeft
  }

  get analyserR(): AnalyserNode | null {
    return this.analyserRight
  }

  get hasNextBuffered(): boolean {
    return this.nextBuffer !== null
  }

  // Load audio from ArrayBuffer
  async loadAudioData(arrayBuffer: ArrayBuffer): Promise<void> {
    this.initContext()
    if (!this.context) throw new Error('AudioContext not initialized')

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)

    try {
      // Stop any current playback
      this.stopSource()
      this.clearNextBuffer()

      // Decode audio data
      this.audioBuffer = await this.context.decodeAudioData(arrayBuffer)

      // Apply normalization if enabled
      if (this._normalizationEnabled) {
        this.applyNormalization(this.audioBuffer)
      } else {
        this.normalizationGainNode!.gain.value = 1.0
      }

      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.emit('stateChange', this._playbackState)
      this.emit('durationChange', this.audioBuffer.duration)
    } catch (err) {
      this._playbackState = 'stopped'
      this.emit('stateChange', this._playbackState)
      this.emit('error', err instanceof Error ? err : new Error('Failed to decode audio'))
      throw err
    }
  }

  // Pre-buffer the next track for gapless playback
  async preBufferNext(arrayBuffer: ArrayBuffer): Promise<void> {
    this.initContext()
    if (!this.context) throw new Error('AudioContext not initialized')

    try {
      // Clone the ArrayBuffer since decodeAudioData detaches it
      const clonedBuffer = arrayBuffer.slice(0)
      this.nextBuffer = await this.context.decodeAudioData(clonedBuffer)

      // If currently playing, schedule the gapless transition
      if (this._playbackState === 'playing' && this.audioBuffer) {
        this.scheduleGaplessTransition()
      }
    } catch (err) {
      console.error('Failed to pre-buffer next track:', err)
      this.nextBuffer = null
    }
  }

  // Schedule the next track to start exactly when current ends
  private scheduleGaplessTransition(): void {
    if (!this.context || !this.nextBuffer || !this.analyserNode || !this.audioBuffer) return
    if (this._playbackState !== 'playing') return

    // Cancel any existing scheduled next source
    this.cancelScheduledNext()

    // Calculate when current track will end
    const currentPosition = this.currentTime
    const remaining = this.audioBuffer.duration - currentPosition
    this.scheduledEndTime = this.context.currentTime + remaining

    // Create and schedule the next source
    this.nextSourceNode = this.context.createBufferSource()
    this.nextSourceNode.buffer = this.nextBuffer
    this.nextSourceNode.connect(this.analyserNode)

    // Schedule to start exactly when current track ends
    this.nextSourceNode.start(this.scheduledEndTime)

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
      // No next track buffered, emit ended normally
      this._playbackState = 'stopped'
      this.pauseTime = 0
      this.emit('stateChange', this._playbackState)
      this.emit('ended')
      this.stopTimeUpdate()
      return
    }

    this.isGaplessTransition = true

    // Swap buffers
    this.audioBuffer = this.nextBuffer
    this.nextBuffer = null

    // Swap source nodes
    if (this.sourceNode) {
      this.sourceNode.onended = null
      try {
        this.sourceNode.disconnect()
      } catch { /* ignore */ }
    }
    this.sourceNode = this.nextSourceNode
    this.nextSourceNode = null

    // Update timing
    this.startTime = this.scheduledEndTime
    this.pauseTime = 0

    // Set up ended handler for the new current track
    this.sourceNode.onended = () => {
      if (this._playbackState === 'playing') {
        this.performGaplessTransition()
      }
    }

    this.isGaplessTransition = false

    // Emit events for the track change
    this.emit('durationChange', this.audioBuffer.duration)
    this.emit('gaplessTransition')
  }

  // Clear pre-buffered next track
  clearNextBuffer(): void {
    this.cancelScheduledNext()
    this.nextBuffer = null
  }

  // Cancel scheduled next track
  private cancelScheduledNext(): void {
    if (this.nextSourceNode) {
      try {
        this.nextSourceNode.onended = null
        this.nextSourceNode.stop()
        this.nextSourceNode.disconnect()
      } catch { /* ignore */ }
      this.nextSourceNode = null
    }
    this.scheduledEndTime = 0
  }

  // Play
  async play(): Promise<void> {
    if (!this.audioBuffer || !this.context || !this.analyserNode) return

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
    this.sourceNode.connect(this.analyserNode)

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
    if (!this.audioBuffer || !this.context || !this.analyserNode) return

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
      this.sourceNode.connect(this.analyserNode)

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
    this._volume = Math.max(0, Math.min(1, value))
    if (this.gainNode && !this._isMuted) {
      this.gainNode.gain.value = this._volume
    }
  }

  // Toggle mute
  toggleMute(): void {
    this._isMuted = !this._isMuted
    if (this.gainNode) {
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume
    }
  }

  // Set mute state
  setMuted(muted: boolean): void {
    this._isMuted = muted
    if (this.gainNode) {
      this.gainNode.gain.value = this._isMuted ? 0 : this._volume
    }
  }

  // Get frequency data for visualizers
  getFrequencyData(): Uint8Array {
    if (!this.analyserNode) return new Uint8Array(0)
    const data = new Uint8Array(this.analyserNode.frequencyBinCount)
    this.analyserNode.getByteFrequencyData(data)
    return data
  }

  // Get time domain data for oscilloscope
  getTimeDomainData(): Uint8Array {
    if (!this.analyserNode) return new Uint8Array(0)
    const data = new Uint8Array(this.analyserNode.fftSize)
    this.analyserNode.getByteTimeDomainData(data)
    return data
  }

  // Get float time domain data (higher precision)
  getFloatTimeDomainData(): Float32Array {
    if (!this.analyserNode) return new Float32Array(0)
    const data = new Float32Array(this.analyserNode.fftSize)
    this.analyserNode.getFloatTimeDomainData(data)
    return data
  }

  // Get stereo float time domain data for vectorscope
  getStereoTimeDomainData(): { left: Float32Array; right: Float32Array } {
    if (!this.analyserLeft || !this.analyserRight) {
      return { left: new Float32Array(0), right: new Float32Array(0) }
    }
    const left = new Float32Array(this.analyserLeft.fftSize)
    const right = new Float32Array(this.analyserRight.fftSize)
    this.analyserLeft.getFloatTimeDomainData(left)
    this.analyserRight.getFloatTimeDomainData(right)
    return { left, right }
  }

  // Get float frequency data (higher precision, in dB)
  getFloatFrequencyData(): Float32Array {
    if (!this.analyserNode) return new Float32Array(0)
    const data = new Float32Array(this.analyserNode.frequencyBinCount)
    this.analyserNode.getFloatFrequencyData(data)
    return data
  }

  // Set FFT size for analyser
  setFFTSize(size: 1024 | 2048 | 4096 | 8192 | 16384): void {
    if (this.analyserNode) {
      this.analyserNode.fftSize = size
    }
  }

  // Private helpers
  private stopSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null
        this.sourceNode.stop()
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

    if (this.context) {
      this.context.close()
      this.context = null
    }

    this.gainNode = null
    this.analyserNode = null
    this.channelSplitter = null
    this.analyserLeft = null
    this.analyserRight = null
    this.audioBuffer = null
    this.eventListeners.clear()
  }
}

// Singleton instance
export const audioEngine = new AudioEngine()
