// Output backend contract for the headless Parallax receiver.
//
// The playout driver renders source audio into interleaved Float32 blocks and pushes them here.
// The backend owns the device: it reports how much pushed audio has not yet left the DAC
// (`bufferedFrames`), which is the daemon's substitute for the renderer's
// `AudioContext.outputLatency + baseLatency` — the write→emit delay every scheduling and drift
// computation depends on. ALSA implements this via snd_pcm_delay; NullOutput simulates it from
// the wall clock so the full daemon can run on non-Linux dev machines.

export interface OutputBackend {
  /** Stable identifier used as the trim key (`outputDeviceId`) and in telemetry. */
  readonly deviceId: string
  /** Human-readable label reported to the host (`outputDeviceLabel`). */
  readonly deviceLabel: string
  /** Actual negotiated device sample rate (the playout engine resamples source → this). */
  readonly sampleRate: number
  readonly channels: number
  /**
   * Push interleaved Float32 frames. Returns the number of frames accepted; the caller retries
   * the remainder on the next driver tick. Never blocks.
   */
  write(interleaved: Float32Array, frames: number): number
  /** Total frames accepted via write() since open. The playout "context time" cursor. */
  framesWritten(): number
  /** Frames written but not yet emitted at the DAC (device queue depth). */
  bufferedFrames(): number
  /** Device-side underrun count since open (xruns for ALSA). */
  underruns(): number
  close(): void
}
