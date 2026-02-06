import { PlaybackState, EQBand } from '../types/audio'
import workletUrl from './oscilloscope-worklet.ts?url'

type EventCallback = (...args: unknown[]) => void

/**
 * AudioEngine - Core Web Audio API wrapper for audio playback and analysis
 *
 * Supports gapless playback through pre-buffering and sample-accurate scheduling.
 *
 * Audio Graph:
 * Source -> NormalizationGain -> AudioWorklet (analysis tap) -> GainNode (volume) -> Destination
 *                                      |
 *                                      +-> Feeds native C++ visualizers continuously
 */
export class AudioEngine {
  private context: AudioContext | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  private normalizationGainNode: GainNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private workletLoaded: boolean = false

  // EQ nodes
  private preampNode: GainNode | null = null
  private eqFilters: BiquadFilterNode[] = []

  // Latest audio data from worklet (for visualizers)
  private latestLeftChannel: Float32Array = new Float32Array(0)
  private latestRightChannel: Float32Array = new Float32Array(0)
  private latestMonoChannel: Float32Array = new Float32Array(0)

  // Queue for accumulating oscilloscope samples (prevents sample loss)
  private pendingOscilloscopeSamples: Float32Array[] = []
  private pendingSpectrumSamples: Float32Array[] = []
  private pendingVectorscopeSamples: { left: Float32Array; right: Float32Array }[] = []
  private static readonly MAX_PENDING_CHUNKS = 20 // ~2560 samples at 128/chunk
  private static readonly MAX_PENDING_SPECTRUM_CHUNKS = 96 // ~0.25s at 48k/128
  private static readonly MAX_PENDING_VECTORSCOPE_CHUNKS = 20

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

  // Track change callbacks (for visualizer reset)
  private trackChangeCallbacks: (() => void)[] = []

  constructor() {
    // Lazy init AudioContext on first user interaction
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
    this.pendingVectorscopeSamples = []
    this.trackChangeCallbacks.forEach(cb => cb())
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

      // Preamp node (after metering worklet, before EQ filters)
      this.preampNode = this.context.createGain()
      this.preampNode.gain.value = 1.0

      // Load and create AudioWorklet for real-time analysis
      if (!this.workletLoaded) {
        try {
          await this.context.audioWorklet.addModule(workletUrl)
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
            this.latestLeftChannel = left
            this.latestRightChannel = right

            // Queue samples for oscilloscope (prevents sample loss)
            // Memory safety: drop oldest chunks if queue gets too large
            if (this.pendingOscilloscopeSamples.length >= AudioEngine.MAX_PENDING_CHUNKS) {
              this.pendingOscilloscopeSamples = this.pendingOscilloscopeSamples.slice(
                -AudioEngine.MAX_PENDING_CHUNKS / 2
              )
            }
            this.pendingOscilloscopeSamples.push(new Float32Array(left))

            // Compute mono sum (L+R)/2
            const mono = new Float32Array(left.length)
            for (let i = 0; i < left.length; i++) {
              mono[i] = (left[i] + right[i]) / 2
            }
            this.latestMonoChannel = mono

            // Queue mono chunks for spectrum analyzer so it can consume all samples.
            if (this.pendingSpectrumSamples.length >= AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS) {
              this.pendingSpectrumSamples = this.pendingSpectrumSamples.slice(
                -Math.floor(AudioEngine.MAX_PENDING_SPECTRUM_CHUNKS / 2)
              )
            }
            this.pendingSpectrumSamples.push(mono)

            // Queue stereo chunks for vectorscope (prevents sample loss)
            if (this.pendingVectorscopeSamples.length >= AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS) {
              this.pendingVectorscopeSamples = this.pendingVectorscopeSamples.slice(
                -Math.floor(AudioEngine.MAX_PENDING_VECTORSCOPE_CHUNKS / 2)
              )
            }
            this.pendingVectorscopeSamples.push({
              left: new Float32Array(left),
              right: new Float32Array(right)
            })
          }
        }
      }

      // Connect main signal path:
      // normalization -> worklet -> preamp -> [eq filters] -> gain -> destination
      if (this.workletNode) {
        this.normalizationGainNode.connect(this.workletNode)
        this.workletNode.connect(this.preampNode)
      } else {
        // Fallback if worklet failed to load
        this.normalizationGainNode.connect(this.preampNode)
      }
      // Initially preamp connects directly to gain (no EQ bands yet)
      this.preampNode.connect(this.gainNode)
      this.gainNode.connect(this.context.destination)
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

  // Get actual sample rate from AudioContext (for native DSP sync)
  getSampleRate(): number {
    return this.context?.sampleRate ?? 48000
  }

  // Check if audio context is initialized and ready
  isContextReady(): boolean {
    return this.context !== null && this.workletLoaded
  }

  get worklet(): AudioWorkletNode | null {
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

  // Flush all pending stereo chunks for vectorscope processing.
  flushPendingVectorscopeSamples(): { left: Float32Array; right: Float32Array }[] {
    const samples = this.pendingVectorscopeSamples
    this.pendingVectorscopeSamples = []
    return samples
  }

  get hasNextBuffered(): boolean {
    return this.nextBuffer !== null
  }

  // Load audio from ArrayBuffer
  async loadAudioData(arrayBuffer: ArrayBuffer): Promise<void> {
    await this.initContext()
    if (!this.context) throw new Error('AudioContext not initialized')

    this._playbackState = 'loading'
    this.emit('stateChange', this._playbackState)

    try {
      // Stop any current playback
      this.stopSource()
      this.clearNextBuffer()

      // Decode audio data
      this.audioBuffer = await this.context.decodeAudioData(arrayBuffer)

      // Notify visualizers of track change (reset their state for fresh pitch detection)
      this.notifyTrackChange()

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
    await this.initContext()
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
    if (!this.context || !this.nextBuffer || !this.audioBuffer) return
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
    this.nextSourceNode.connect(this.normalizationGainNode!)

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

    // Notify visualizers of track change (reset their state for fresh pitch detection)
    this.notifyTrackChange()

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
    this.sourceNode.connect(this.normalizationGainNode!)

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
      this.sourceNode.connect(this.normalizationGainNode!)

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

  // --- EQ Methods ---

  /**
   * Rebuild the entire EQ filter chain.
   * Disconnects old chain then reconnects new one in the same synchronous block,
   * so the audio thread only sees the final connected state (no audible gap).
   */
  updateEQ(bands: EQBand[], preampDb: number, enabled: boolean): void {
    if (!this.context || !this.preampNode || !this.gainNode) return

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
      newFilters[newFilters.length - 1].connect(this.gainNode)
      this.eqFilters = newFilters
    } else {
      // Bypass: connect preamp directly to gain
      this.preampNode.connect(this.gainNode)
    }
  }

  /**
   * Update a single band's parameters without rebuilding the chain.
   * Efficient for real-time slider dragging.
   */
  updateEQBand(index: number, band: EQBand): void {
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
    if (!this.preampNode) return
    this.preampNode.gain.value = Math.pow(10, dB / 20)
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

    // Clean up EQ chain
    this._disconnectEQChain()
    if (this.preampNode) {
      try { this.preampNode.disconnect() } catch { /* ignore */ }
      this.preampNode = null
    }

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.context) {
      this.context.close()
      this.context = null
    }

    this.gainNode = null
    this.normalizationGainNode = null
    this.audioBuffer = null
    this.eventListeners.clear()
  }
}

// Singleton instance
export const audioEngine = new AudioEngine()
