import type { ParallaxAudioChunk } from '../../src/types/parallax'
import { clampParallaxPlaybackRatePpm } from '../../src/types/parallax'
import type { OutputBackend } from './output/types'

// Headless port of the `ParallaxSinkProcessor` AudioWorklet (oscilloscope-worklet.js). The
// algorithm is unchanged — start-frame-sorted chunk list, fractional cursor with linear
// interpolation, one playback-rate mechanism doing both sample-rate conversion and the ±1000 ppm
// drift slew, gap-skip vs. starvation distinction, self-pause into rebuffering — only the clock
// domain moves: Web Audio context samples become "output frames written to the backend since
// open" (`OutputBackend.framesWritten()`), and `startAtContextTime` becomes `startAtOutputFrame`.
//
// Emission-time invariant the session's drift math depends on: a position stamp records the wall
// time a cursor frame was WRITTEN plus the backend queue depth at that same instant
// (`latencyMsAtStamp`), so `emission_wall(currentFrame) = currentFrameAtWallMs + latencyMsAtStamp`
// — the exact analogue of the renderer's write-cursor + AudioContext output latency pair that
// `computeRateCorrectionPpm` was built around.

interface PlayoutChunk {
  startFrame: number
  frameCount: number
  channels: Float32Array[]
}

export interface PlayoutStreamParams {
  streamId: string
  sourceSampleRate: number
  channels: number
  /** Resolved gain (0 when normalization mode is off) — the sink applies this, per protocol. */
  normalizationGainDb: number
}

export interface PlayoutSnapshot {
  streamId: string | null
  currentFrame: number
  currentFrameAtWallMs: number
  /** Backend queue depth (ms) captured at the same instant as currentFrameAtWallMs. */
  latencyMsAtStamp: number
  bufferedFrames: number
  bufferedEndFrame: number
  underruns: number
  playbackRatePpm: number
  starvedFrames: number
  rebuffering: boolean
  playing: boolean
}

export interface PlayoutTimeline {
  startFrame: number
  /** Output-frame index (backend framesWritten domain) at which startFrame begins emitting. */
  startAtOutputFrame: number
  playing: boolean
  playbackRatePpm: number
}

function dbToLinear(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 1
}

export class SinkPlayoutEngine {
  private readonly deviceSampleRate: number
  private readonly deviceChannels: number
  private readonly maxRetainedChunks = 512
  // ~250 ms of continuous starvation before self-pausing into rebuffering. Keep in sync with
  // PARALLAX_STARVE_TRIGGER_MS (mirrors the worklet's starveTriggerFrames).
  private readonly starveTriggerFrames: number

  private chunks: PlayoutChunk[] = []
  private streamId: string | null = null
  private sourceSampleRate = 48000
  private basePlaybackRate = 1
  private playbackRate = 1
  private playbackRatePpm = 0
  private currentFrameFloat = 0
  private playing = false
  private startAtOutputFrame = 0
  private starvedFrames = 0
  private rebuffering = false
  private underrunCount = 0
  private lastUnderrunReportFrame = -1
  private volumeLinear = 1
  private normalizationLinear = 1
  private stampWallMs = 0
  private stampLatencyMs = 0

  constructor(deviceSampleRate: number, deviceChannels: number) {
    this.deviceSampleRate = deviceSampleRate
    this.deviceChannels = Math.max(1, deviceChannels)
    this.starveTriggerFrames = Math.max(1, Math.floor(0.25 * deviceSampleRate))
  }

  configureStream(params: PlayoutStreamParams): void {
    this.resetPlayback()
    this.chunks = []
    this.streamId = params.streamId
    this.sourceSampleRate = params.sourceSampleRate > 0 ? params.sourceSampleRate : this.deviceSampleRate
    this.basePlaybackRate = this.sourceSampleRate / this.deviceSampleRate
    this.playbackRate = this.basePlaybackRate
    this.normalizationLinear = dbToLinear(params.normalizationGainDb)
    this.stampWallMs = 0
    this.stampLatencyMs = 0
  }

  clearStream(): void {
    this.resetPlayback()
    this.chunks = []
    this.streamId = null
    this.stampWallMs = 0
    this.stampLatencyMs = 0
  }

  private resetPlayback(): void {
    this.currentFrameFloat = 0
    this.playing = false
    this.playbackRate = this.basePlaybackRate || 1
    this.playbackRatePpm = 0
    this.startAtOutputFrame = 0
    this.starvedFrames = 0
    this.rebuffering = false
    this.underrunCount = 0
    this.lastUnderrunReportFrame = -1
  }

  getStreamId(): string | null {
    return this.streamId
  }

  setVolumePercent(volumePercent: number): void {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(volumePercent) ? volumePercent : 100))
    this.volumeLinear = clamped / 100
  }

  private gain(): number {
    return this.volumeLinear * this.normalizationLinear
  }

  appendChunk(chunk: ParallaxAudioChunk): void {
    if (this.streamId === null || chunk.streamId !== this.streamId) return
    if (chunk.frameCount <= 0 || !Number.isFinite(chunk.startFrame)) return
    const interleaved = new Float32Array(chunk.pcmData)
    const channels: Float32Array[] = []
    for (let channel = 0; channel < chunk.channels; channel += 1) {
      const data = new Float32Array(chunk.frameCount)
      for (let frame = 0; frame < chunk.frameCount; frame += 1) {
        data[frame] = interleaved[frame * chunk.channels + channel]
      }
      channels.push(data)
    }
    this.chunks.push({
      startFrame: Math.max(0, Math.floor(chunk.startFrame)),
      frameCount: Math.floor(chunk.frameCount),
      channels
    })
    this.chunks.sort((left, right) => left.startFrame - right.startFrame)
    if (this.chunks.length > this.maxRetainedChunks) {
      this.chunks.splice(0, this.chunks.length - this.maxRetainedChunks)
    }
  }

  clearChunks(): void {
    this.chunks = []
    this.starvedFrames = 0
    this.rebuffering = false
  }

  setTimeline(timeline: PlayoutTimeline, currentOutputFrame: number): void {
    const startFrame = Number.isFinite(timeline.startFrame)
      ? Math.max(0, Math.floor(timeline.startFrame))
      : Math.max(0, Math.floor(this.currentFrameFloat))
    this.currentFrameFloat = startFrame
    // Never schedule before the write head — frames up to framesWritten are already committed.
    this.startAtOutputFrame = Math.max(currentOutputFrame, Math.floor(timeline.startAtOutputFrame))
    this.setRatePpm(timeline.playbackRatePpm)
    this.playing = Boolean(timeline.playing)
    // A fresh timeline is a clean (re-)anchor — leave any rebuffering state behind.
    this.starvedFrames = 0
    this.rebuffering = false
  }

  setRatePpm(playbackRatePpm: number): void {
    const ppm = clampParallaxPlaybackRatePpm(playbackRatePpm)
    this.playbackRatePpm = ppm
    this.playbackRate = (this.basePlaybackRate || 1) * (1 + ppm / 1_000_000)
  }

  private findChunk(frame: number): PlayoutChunk | null {
    for (const chunk of this.chunks) {
      if (frame < chunk.startFrame) return null
      if (frame < chunk.startFrame + chunk.frameCount) return chunk
    }
    return null
  }

  private findNextChunk(frame: number): PlayoutChunk | null {
    for (const chunk of this.chunks) {
      if (chunk.startFrame + chunk.frameCount <= frame) continue
      if (chunk.startFrame >= frame) return chunk
    }
    return null
  }

  private sampleAt(channel: number, frame: number): number | null {
    const chunk = this.findChunk(frame)
    if (!chunk) return null
    const offset = frame - chunk.startFrame
    const sourceChannel = chunk.channels[channel] ?? chunk.channels[0]
    if (!sourceChannel || offset < 0 || offset >= sourceChannel.length) return null
    return sourceChannel[offset] || 0
  }

  private readInterpolated(channel: number, frameFloat: number): number | null {
    const frame = Math.floor(frameFloat)
    const frac = frameFloat - frame
    const current = this.sampleAt(channel, frame)
    if (current === null) return null
    if (frac <= 0.000001) return current
    const next = this.sampleAt(channel, frame + 1)
    if (next === null) return current
    return current + (next - current) * frac
  }

  private reportUnderrun(frame: number): void {
    this.underrunCount += 1
    if (this.lastUnderrunReportFrame >= 0 && frame - this.lastUnderrunReportFrame < this.sourceSampleRate / 4) return
    this.lastUnderrunReportFrame = frame
  }

  /**
   * Render `frames` interleaved device frames into `out`, starting at output frame
   * `blockStartOutputFrame` (the backend's framesWritten before this block is pushed). Always
   * fills the full block — silence while paused/rebuffering/pre-roll — so the device stays fed.
   * Returns how many output frames advanced the cursor (0 while paused/pre-roll/starved), which
   * the driver uses to decide whether a position stamp for this engine would be truthful.
   */
  render(out: Float32Array, frames: number, blockStartOutputFrame: number): number {
    const channelCount = this.deviceChannels
    out.fill(0, 0, frames * channelCount)
    if (!this.playing || this.streamId === null) return 0

    let voicedFrames = 0
    const gain = this.gain()
    for (let outputFrame = 0; outputFrame < frames; outputFrame += 1) {
      if (blockStartOutputFrame + outputFrame < this.startAtOutputFrame) {
        continue
      }

      const sourceFrame = Math.max(0, Math.floor(this.currentFrameFloat))
      let anyMissing = false
      let anyReadable = false
      const base = outputFrame * channelCount
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = this.readInterpolated(channel, this.currentFrameFloat)
        if (sample === null) {
          anyMissing = true
          out[base + channel] = 0
        } else {
          anyReadable = true
          out[base + channel] = sample * gain
        }
      }

      if (anyMissing) {
        this.reportUnderrun(sourceFrame)
      }

      if (!anyReadable) {
        const nextChunk = this.findNextChunk(sourceFrame)
        if (nextChunk && nextChunk.startFrame > sourceFrame) {
          // Data exists ahead (a gap, not a drained buffer): skip to it, not a starvation.
          this.currentFrameFloat = nextChunk.startFrame
          this.starvedFrames = 0
        } else {
          // Nothing buffered ahead: the cursor is frozen and we are truly starved.
          this.starvedFrames += 1
        }
        continue
      }

      this.starvedFrames = 0
      this.currentFrameFloat += this.playbackRate
      voicedFrames += 1
    }

    // Sustained starvation while connected: self-pause into rebuffering instead of free-running
    // the cursor into empty data. The session re-anchors to the live host frame once the buffer
    // refills (rebuffer_snap path).
    if (this.playing && !this.rebuffering && this.starvedFrames >= this.starveTriggerFrames) {
      this.rebuffering = true
      this.playing = false
    }
    return voicedFrames
  }

  /** Called by the driver right after a block lands in the backend, with matching queue depth. */
  stampPosition(wallMs: number, latencyMs: number): void {
    this.stampWallMs = wallMs
    this.stampLatencyMs = Math.max(0, latencyMs)
    this.pruneOldChunks()
  }

  private pruneOldChunks(): void {
    const retainAfterFrame = Math.max(0, Math.floor(this.currentFrameFloat) - this.sourceSampleRate)
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0]
      if (chunk.startFrame + chunk.frameCount >= retainAfterFrame) break
      this.chunks.shift()
    }
  }

  getSnapshot(): PlayoutSnapshot {
    const frame = Math.max(0, Math.floor(this.currentFrameFloat))
    let bufferedEndFrame = 0
    for (const chunk of this.chunks) {
      const end = chunk.startFrame + chunk.frameCount
      if (end > bufferedEndFrame) bufferedEndFrame = end
    }
    return {
      streamId: this.streamId,
      currentFrame: frame,
      currentFrameAtWallMs: this.stampWallMs,
      latencyMsAtStamp: this.stampLatencyMs,
      bufferedFrames: Math.max(0, bufferedEndFrame - frame),
      bufferedEndFrame,
      underruns: this.underrunCount,
      playbackRatePpm: this.playbackRatePpm,
      starvedFrames: this.starvedFrames,
      rebuffering: this.rebuffering,
      playing: this.playing
    }
  }
}

// ── Write-ahead driver ─────────────────────────────────────────────────────────
// Replaces Web Audio's pull model: every tick, top the backend queue back up to the target depth
// with freshly rendered audio. The queue depth doubles as the emission latency the drift math
// consumes, and `outputFrameForWallTime` provides the scheduling map that replaced
// `AudioContext.currentTime` arithmetic in the renderer's three scheduling sites.

export interface PlayoutDriverOptions {
  backend: OutputBackend
  engine: SinkPlayoutEngine
  targetBufferMs?: number
  tickMs?: number
  nowMs?: () => number
}

export class PlayoutDriver {
  private readonly backend: OutputBackend
  private engine: SinkPlayoutEngine
  // §21 staged next-stream engine. It renders into every block ALONGSIDE the active engine and
  // the two are summed — the exact analogue of the app's dual worklet nodes both feeding the
  // audio graph. No explicit boundary split is needed: the staged engine emits silence before
  // its scheduled startAtOutputFrame, and the retiring engine runs out of chunks at the old
  // stream's end, so the audible switch is sample-aligned at the pre-scheduled boundary frame
  // regardless of when the promote bookkeeping event arrives.
  private staged: SinkPlayoutEngine | null = null
  private stagedScratch: Float32Array | null = null
  private readonly targetBufferFrames: number
  private readonly tickMs: number
  private readonly nowMs: () => number
  private readonly scratch: Float32Array
  private readonly blockFrames = 2048
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: PlayoutDriverOptions) {
    this.backend = options.backend
    this.engine = options.engine
    this.tickMs = options.tickMs ?? 20
    this.nowMs = options.nowMs ?? (() => performance.timeOrigin + performance.now())
    const targetMs = options.targetBufferMs ?? 120
    this.targetBufferFrames = Math.max(1, Math.round((targetMs / 1000) * this.backend.sampleRate))
    this.scratch = new Float32Array(this.blockFrames * this.backend.channels)
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), this.tickMs)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** The engine currently bound to the live stream (changes on promoteStagedEngine). */
  activeEngine(): SinkPlayoutEngine {
    return this.engine
  }

  stagedEngine(): SinkPlayoutEngine | null {
    return this.staged
  }

  /** Stage (or clear) the §21 next-stream engine; its startAtOutputFrame gates when it sounds. */
  setStagedEngine(engine: SinkPlayoutEngine | null): void {
    this.staged = engine
  }

  /**
   * §21 promote bookkeeping: the staged engine becomes the active one. The audible crossover
   * already happened at the staged engine's scheduled start frame — this only retargets which
   * engine future stamps, snapshots, and timeline updates address. Returns the retired engine.
   */
  promoteStagedEngine(): SinkPlayoutEngine | null {
    if (!this.staged) return null
    const retired = this.engine
    this.engine = this.staged
    this.staged = null
    return retired
  }

  /**
   * Output frame (framesWritten domain) whose DAC emission lands at `wallMs`. The consumption
   * head is `framesWritten − bufferedFrames`; emission of frame W happens (W − head)/rate after
   * now. This is the scheduling primitive for timeline anchors and hard resyncs.
   */
  outputFrameForWallTime(wallMs: number): number {
    const head = this.backend.framesWritten() - this.backend.bufferedFrames()
    return Math.round(head + ((wallMs - this.nowMs()) / 1000) * this.backend.sampleRate)
  }

  currentOutputFrame(): number {
    return this.backend.framesWritten()
  }

  /** Current write→emission queue depth in ms — the daemon's output latency. */
  currentLatencyMs(): number {
    return (this.backend.bufferedFrames() / this.backend.sampleRate) * 1000
  }

  tick(): void {
    let guard = 0
    let wroteFrames = 0
    let stagedVoicedFrames = 0
    while (guard < 16) {
      guard += 1
      const buffered = this.backend.bufferedFrames()
      const deficit = this.targetBufferFrames - buffered
      if (deficit <= 0) break
      const frames = Math.min(this.blockFrames, deficit)
      const blockStartOutputFrame = this.backend.framesWritten()
      this.engine.render(this.scratch, frames, blockStartOutputFrame)
      const staged = this.staged
      if (staged) {
        const stagedOut = this.stagedScratch
          ?? (this.stagedScratch = new Float32Array(this.blockFrames * this.backend.channels))
        stagedVoicedFrames += staged.render(stagedOut, frames, blockStartOutputFrame)
        const samples = frames * this.backend.channels
        for (let index = 0; index < samples; index += 1) {
          this.scratch[index] += stagedOut[index]
        }
      }
      const accepted = this.backend.write(this.scratch, frames)
      wroteFrames += accepted
      if (accepted < frames) {
        // Device queue unexpectedly full — rendered-but-unwritten frames are dropped. Should not
        // happen while target depth < device buffer capacity.
        break
      }
    }
    // Stamp only when this tick actually pushed audio: on a tick where the device's queue report
    // was stale (period granularity), both the cursor and the reported delay are frozen — a
    // stamp taken then would feed the drift loop phantom lag. A slightly aged stamp is harmless
    // by design (drift is computed at the stamp instant, not "now").
    if (wroteFrames > 0) {
      const wallMs = this.nowMs()
      const latencyMs = this.currentLatencyMs()
      this.engine.stampPosition(wallMs, latencyMs)
      // The staged engine gets a stamp only once it has voiced frames (its cursor moved): a
      // stamp taken during its pre-roll would claim "startFrame emitted around now" while the
      // real emission is still ahead at the boundary — phantom drift for the first post-promote
      // telemetry tick.
      if (this.staged && stagedVoicedFrames > 0) {
        this.staged.stampPosition(wallMs, latencyMs)
      }
    }
  }
}
