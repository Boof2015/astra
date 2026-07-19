import { performance } from 'perf_hooks'
import type {
  ParallaxAudioChunk,
  ParallaxSinkTelemetry,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../../src/types/parallax'
import {
  clampParallaxPlaybackRatePpm,
  decideParallaxSinkCorrection,
  fitHostEmitAnchorLine,
  hostEmitAnchorSlopeToPpm,
  mapHostTimeToSinkTimeMs,
  resolveParallaxStreamNormalization,
  PARALLAX_HARD_SYNC_MS,
  PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM,
  PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES,
  PARALLAX_HOST_EMIT_ANCHOR_STALE_MS,
  PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES,
  PARALLAX_HOST_EMIT_ANCHOR_WINDOW_MS,
  PARALLAX_PREDICTOR_TRUST_TICKS,
  PARALLAX_REBUFFER_MARGIN_MS,
  PARALLAX_RESYNC_GUARD_MS,
  PARALLAX_RESYNC_LEAD_MS,
  PARALLAX_RESYNC_MIN_INTERVAL_MS,
  PARALLAX_SNAP_CONFIRM_TICKS
} from '../../src/types/parallax'
import type { OutputBackend } from './output/types'
import { PlayoutDriver, SinkPlayoutEngine } from './playout'
import type { ParallaxSinkClient, SinkClientStatus } from './sinkClient'

// The sink-side control loop, ported from the renderer's parallaxStore (drift/telemetry tick,
// host-emit-anchor predictor with the §17.2(c) fail-closed trust latch, snap-then-slew policy)
// and AudioEngine's three scheduling sites (initial anchor, timeline updates, hard resync). The
// Zustand/IPC shell is gone — this class talks directly to the ParallaxSinkClient and the
// SinkPlayoutEngine/PlayoutDriver pair. All decision math comes verbatim from types/parallax.ts.
//
// Clock-domain note: the renderer schedules against AudioContext time and subtracts
// `outputLatency + baseLatency`; here `PlayoutDriver.outputFrameForWallTime()` maps a wall-clock
// emission instant directly onto the backend's write-frame axis (consumption head +
// snd_pcm_delay), so no separate latency subtraction is needed when scheduling. The drift
// formula's `sinkLatencyMs` is the queue depth captured with each position stamp plus the
// host-pushed trim — the same "latency the schedule actually used" contract the app maintains via
// getParallaxEndpointLatencyMs().

const PARALLAX_USE_HOST_PREDICTOR = process.env.PARALLAX_DISABLE_HOST_PREDICTOR !== '1'

interface HostEmitAnchorSample {
  hostWallTimeMs: number
  sourceFrameAtHostOutput: number
  sequence: number
}

interface RateCorrection {
  driftFrames: number
  playbackRatePpm: number
  loopSource: 'predictor' | 'phase1' | 'hold'
}

export interface SinkSessionDiagnostics {
  driftMs: number | null
  phase2DriftMs: number | null
  loopSource: 'predictor' | 'phase1' | 'hold' | null
  appliedPpm: number
  bufferedMs: number
  latencyMs: number
  anchors: number
  predictorTrusted: boolean
  hardSyncCount: number
  underruns: number
  rebuffering: boolean
  lastSyncEvent: string | null
  /** §21: title (or streamId) of the pre-announced next stream while its engine is staged. */
  stagedNextTitle: string | null
}

export interface SinkSessionInfo {
  assignedSinkName: string | null
  appliedAdvanceMs: number
  streamTitle: string | null
  streamArtist: string | null
  streamAlbum: string | null
  playbackState: string
  // Track position for the /display progress bar, interpolated SERVER-side at read time (the
  // ZoneDisplay recipe: frame cursor + wall delta × rate). The viewing browser only ticks it
  // forward between polls, so a laptop's clock skew against the Pi never shows up.
  position: { elapsedSeconds: number; durationSeconds: number | null; advancing: boolean } | null
  diagnostics: SinkSessionDiagnostics
}

function localNowMs(): number {
  return performance.timeOrigin + performance.now()
}

export class SinkSession {
  private readonly backend: OutputBackend
  private readonly driver: PlayoutDriver
  private client: ParallaxSinkClient | null = null
  private ownSinkId: string | null = null

  private latestTimeline: ParallaxTimelineState | null = null
  private pendingSinkEvents: ParallaxTimelineEvent[] = []
  private pendingAudioChunks: ParallaxAudioChunk[] = []
  private activeStream: ParallaxStreamInfo | null = null
  // §21: the pre-announced next stream whose engine is staged in the driver. The engine itself
  // lives only in the driver (stagedEngine()/promoteStagedEngine()) so the swap has one owner.
  private stagedStream: ParallaxStreamInfo | null = null
  private stagedTimeline: ParallaxTimelineState | null = null
  private volumePercent = 100
  private advanceMs = 0
  private assignedSinkName: string | null = null

  private hostEmitAnchors: HostEmitAnchorSample[] = []
  private hostEmitAnchorStreamId: string | null = null
  private hostEmitLastSequence: number | null = null
  private hostEmitLastWallMs: number | null = null
  private hostEmitRawPairwisePpm: number | null = null
  private hostEmitPredictor: { slopeFramesPerMs: number; intercept: number } | null = null
  private predictorSnapTrusted = false
  private predictorTrustTickCount = 0
  private snapPendingTicks = 0
  private lastHardSyncAtMs = 0
  private hardSyncCount = 0

  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastDiagnostics: SinkSessionDiagnostics = {
    driftMs: null,
    phase2DriftMs: null,
    loopSource: null,
    appliedPpm: 0,
    bufferedMs: 0,
    latencyMs: 0,
    anchors: 0,
    predictorTrusted: false,
    hardSyncCount: 0,
    underruns: 0,
    rebuffering: false,
    lastSyncEvent: null,
    stagedNextTitle: null
  }

  constructor(backend: OutputBackend) {
    this.backend = backend
    this.driver = new PlayoutDriver({
      backend,
      engine: new SinkPlayoutEngine(backend.sampleRate, backend.channels)
    })
  }

  // The engine bound to the live stream. Always dereferenced through the driver so a §21 promote
  // (which swaps the staged engine into the active slot) can never leave the session holding the
  // retired engine.
  private get engine(): SinkPlayoutEngine {
    return this.driver.activeEngine()
  }

  attachClient(client: ParallaxSinkClient, ownSinkId: string): void {
    this.client = client
    this.ownSinkId = ownSinkId
  }

  setVolumePercent(volumePercent: number): void {
    this.volumePercent = volumePercent
    this.engine.setVolumePercent(volumePercent)
    this.driver.stagedEngine()?.setVolumePercent(volumePercent)
  }

  start(): void {
    this.driver.start()
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.telemetryTick(), 1000)
      this.tickTimer.unref?.()
    }
  }

  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.driver.stop()
    this.engine.clearStream()
    this.driver.setStagedEngine(null)
    this.stagedStream = null
    this.stagedTimeline = null
    this.latestTimeline = null
    this.pendingSinkEvents = []
    this.pendingAudioChunks = []
    this.activeStream = null
    this.resetHostEmitAnchors()
    this.hardSyncCount = 0
  }

  getInfo(): SinkSessionInfo {
    return {
      assignedSinkName: this.assignedSinkName,
      appliedAdvanceMs: this.advanceMs,
      streamTitle: this.activeStream?.title ?? null,
      streamArtist: this.activeStream?.artist ?? null,
      streamAlbum: this.activeStream?.album || null,
      playbackState: this.latestTimeline?.playbackState ?? 'stopped',
      position: this.currentPosition(),
      diagnostics: this.lastDiagnostics
    }
  }

  // ZoneDisplay's position recipe against the daemon's playout snapshot: interpolate the frame
  // cursor forward off the wall clock while playing, freeze on pause/rebuffer.
  private currentPosition(): SinkSessionInfo['position'] {
    const stream = this.activeStream
    if (!stream || stream.sampleRate <= 0) return null
    const snapshot = this.engine.getSnapshot()
    if (snapshot.streamId !== stream.streamId) return null
    const advancing = this.latestTimeline?.playbackState === 'playing' && !snapshot.rebuffering
    let frame = snapshot.currentFrame
    if (advancing && snapshot.currentFrameAtWallMs > 0) {
      const deltaMs = localNowMs() - snapshot.currentFrameAtWallMs
      frame += (deltaMs / 1000) * stream.sampleRate * (1 + snapshot.playbackRatePpm / 1e6)
    }
    const durationSeconds = stream.durationSeconds > 0 ? stream.durationSeconds : null
    const raw = frame / stream.sampleRate
    const elapsedSeconds = Math.max(0, durationSeconds !== null ? Math.min(raw, durationSeconds) : raw)
    return { elapsedSeconds, durationSeconds, advancing }
  }

  // ── Client callbacks ─────────────────────────────────────────────────────────

  handleStatus(status: SinkClientStatus): void {
    // Release deferred events once clock priming produced a usable offset (parallaxStore's
    // pendingSinkEvent mechanism, widened to a queue so a deferred stream-start and the
    // next-stream-start that may follow it replay in order).
    if (this.pendingSinkEvents.length > 0 && status.clockOffsetMs !== null) {
      const deferred = this.pendingSinkEvents
      this.pendingSinkEvents = []
      for (const event of deferred) this.handleEvent(event)
    }
    if (!status.connected) {
      this.engine.clearStream()
      this.discardStagedEngine('disconnected')
      this.latestTimeline = null
      this.pendingSinkEvents = []
      this.pendingAudioChunks = []
      this.activeStream = null
      this.resetHostEmitAnchors()
    }
  }

  handleAudioChunk(chunk: ParallaxAudioChunk): void {
    if (this.engine.getStreamId() === chunk.streamId) {
      this.engine.appendChunk(chunk)
      this.applyChunkTimelineIfNeeded(chunk)
      return
    }
    // §21: pre-fetched next-stream chunks flow to the staged engine.
    const staged = this.driver.stagedEngine()
    if (staged && staged.getStreamId() === chunk.streamId) {
      staged.appendChunk(chunk)
      return
    }
    // Early chunk — buffer until its stream-start configures the engine.
    this.pendingAudioChunks = [...this.pendingAudioChunks, chunk].slice(-256)
  }

  handleEvent(event: ParallaxTimelineEvent): void {
    if (event.type === 'host-emit-anchor') {
      this.ingestHostEmitAnchor(event)
      return
    }
    if (event.type === 'sink-trim-update') {
      // Targeted by sinkId; drop trims keyed to a different output device than ours. Logged
      // either way — a silently-rejected trim looks exactly like "trim doesn't work" upstream.
      if (!this.ownSinkId || this.ownSinkId !== event.sinkId) {
        console.log(`[astra-receiver] trim update ignored: for sink ${event.sinkId}, we are ${this.ownSinkId ?? '(unset)'}`)
        return
      }
      if (event.outputDeviceId !== this.backend.deviceId) {
        console.log(`[astra-receiver] trim update ignored: keyed to device '${event.outputDeviceId}', ours is '${this.backend.deviceId}'`)
        return
      }
      const previousAdvanceMs = this.advanceMs
      this.advanceMs = Math.max(-500, Math.min(500, event.advanceMs))
      console.log(`[astra-receiver] trim update applied: ${previousAdvanceMs} -> ${this.advanceMs} ms`)
      return
    }
    if (event.type === 'sink-name-update') {
      if (!this.ownSinkId || this.ownSinkId !== event.sinkId) return
      this.assignedSinkName = event.name.trim() || null
      return
    }
    if (event.type === 'sink-playback-update') {
      // The network client owns the surfaced selection state; playout is stopped by the targeted
      // stop event that follows a disable.
      return
    }
    if (event.type === 'stop') {
      this.pendingAudioChunks = []
      this.engine.clearStream()
      this.discardStagedEngine('stop')
      this.latestTimeline = null
      this.pendingSinkEvents = []
      this.activeStream = null
      this.resetHostEmitAnchors()
      this.hardSyncCount = 0
      return
    }
    if (event.type === 'next-stream-start') {
      // §21: stage a second playout engine for the pre-announced next stream, scheduled to start
      // at the boundary output frame. Placing the boundary needs the clock offset — defer like
      // any timeline until priming completes.
      const offsetMs = this.client?.getClockOffsetMs() ?? null
      if (offsetMs === null) {
        this.deferEvent(event)
        return
      }
      this.stageNextStream(event.stream, event.timeline, offsetMs)
      return
    }
    if (event.type === 'next-stream-cancel') {
      if (this.stagedStream?.streamId === event.streamId) {
        this.discardStagedEngine('canceled by host')
      }
      this.pendingAudioChunks = this.pendingAudioChunks.filter((chunk) => chunk.streamId !== event.streamId)
      return
    }
    if (event.type === 'next-stream-promote') {
      this.promoteStagedStream(event)
      return
    }

    const timeline = event.timeline
    if (event.type === 'stream-start') {
      this.resetHostEmitAnchors()
      // §21: a fresh stream-start supersedes any in-flight handoff — including one for the SAME
      // streamId (a reconnect that crossed the boundary re-enters it as the primary stream, and
      // a still-mixing staged engine would double the audio).
      this.discardStagedEngine('superseded by stream-start')
      this.activeStream = event.stream
      if (this.engine.getStreamId() !== event.stream.streamId) {
        const normalization = resolveParallaxStreamNormalization(event.stream)
        this.engine.configureStream({
          streamId: event.stream.streamId,
          sourceSampleRate: event.stream.sampleRate,
          channels: event.stream.channels,
          normalizationGainDb: normalization.normalizationMode === 'off' ? 0 : normalization.normalizationGainDb
        })
        this.latestTimeline = null
      }
      const buffered = this.pendingAudioChunks.filter((chunk) => chunk.streamId === event.stream.streamId)
      this.pendingAudioChunks = this.pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
      for (const chunk of buffered) {
        this.engine.appendChunk(chunk)
        this.applyChunkTimelineIfNeeded(chunk)
      }
    }

    if (event.type === 'timeline' && event.resetAudio) {
      // Seek/scrub: same-stream audio epoch reset — drop buffered chunks before the new anchor.
      this.pendingAudioChunks = this.pendingAudioChunks.filter((chunk) => chunk.streamId !== timeline.streamId)
      this.engine.clearChunks()
      this.resetHostEmitAnchors()
    }

    const offsetMs = this.client?.getClockOffsetMs() ?? null
    if (offsetMs === null) {
      this.deferEvent(event)
      return
    }

    // §17.2(b): a same-stream timeline discontinuity (seek/pause/resume) invalidates the anchor
    // window — old anchors were fit against the previous host start time.
    if (
      event.type === 'timeline'
      && this.latestTimeline !== null
      && (
        this.latestTimeline.startHostTimeMs !== timeline.startHostTimeMs
        || this.latestTimeline.startFrame !== timeline.startFrame
        || this.latestTimeline.playbackState !== timeline.playbackState
      )
    ) {
      this.resetHostEmitAnchors()
    }

    this.latestTimeline = timeline
    this.applyTimelineFromHostClock(timeline, offsetMs, 0)
  }

  private deferEvent(event: ParallaxTimelineEvent): void {
    this.pendingSinkEvents = [...this.pendingSinkEvents, event].slice(-16)
  }

  // ── §21 gapless handoff (staged engine lifecycle) ────────────────────────────

  private stageNextStream(
    stream: ParallaxStreamInfo,
    timeline: ParallaxTimelineState,
    offsetMs: number
  ): void {
    this.discardStagedEngine('replaced by newer pre-announce')
    const engine = new SinkPlayoutEngine(this.backend.sampleRate, this.backend.channels)
    const normalization = resolveParallaxStreamNormalization(stream)
    engine.configureStream({
      streamId: stream.streamId,
      sourceSampleRate: stream.sampleRate,
      channels: stream.channels,
      normalizationGainDb: normalization.normalizationMode === 'off' ? 0 : normalization.normalizationGainDb
    })
    engine.setVolumePercent(this.volumePercent)
    // Adopt pre-fetch chunks that raced ahead of this event.
    const buffered = this.pendingAudioChunks.filter((chunk) => chunk.streamId === stream.streamId)
    this.pendingAudioChunks = this.pendingAudioChunks.filter((chunk) => chunk.streamId !== stream.streamId)
    for (const chunk of buffered) engine.appendChunk(chunk)
    // The boundary: the next-stream timeline is future-anchored — startFrame leaves every
    // speaker at startHostTimeMs. Same mapping as applyTimelineFromHostClock, applied once at
    // stage time; the engine renders silence until this output frame, so the crossover is
    // sample-aligned no matter when the promote bookkeeping event lands. Post-promote drift
    // correction trues up any residual clock movement between staging and the boundary.
    const sinkStartWallTimeMs = mapHostTimeToSinkTimeMs(timeline.startHostTimeMs, offsetMs)
    const startAtOutputFrame = this.driver.outputFrameForWallTime(sinkStartWallTimeMs - this.advanceMs)
    engine.setTimeline({
      startFrame: timeline.startFrame,
      startAtOutputFrame,
      playing: timeline.playbackState === 'playing',
      playbackRatePpm: 0
    }, this.driver.currentOutputFrame())
    this.stagedStream = stream
    this.stagedTimeline = timeline
    this.driver.setStagedEngine(engine)
    const leadMs = Math.max(0, sinkStartWallTimeMs - localNowMs())
    console.log(
      `[astra-receiver] staged next stream "${stream.title ?? stream.streamId}" — boundary in ${(leadMs / 1000).toFixed(1)} s`
    )
  }

  private discardStagedEngine(reason: string): void {
    const staged = this.driver.stagedEngine()
    if (staged === null && this.stagedStream === null) return
    this.driver.setStagedEngine(null)
    const title = this.stagedStream?.title ?? this.stagedStream?.streamId ?? staged?.getStreamId() ?? '?'
    this.stagedStream = null
    this.stagedTimeline = null
    console.log(`[astra-receiver] staged next stream dropped (${reason}): "${title}"`)
  }

  private promoteStagedStream(
    event: Extract<ParallaxTimelineEvent, { type: 'next-stream-promote' }>
  ): void {
    const staged = this.driver.stagedEngine()
    if (
      staged !== null
      && this.stagedStream !== null
      && this.stagedStream.streamId === event.streamId
      && this.stagedTimeline !== null
    ) {
      // §21 gapless: the audible switch already happened at the staged engine's pre-scheduled
      // boundary frame — promote is bookkeeping. Swap the staged engine into the active slot and
      // hand the drift loop the boundary-anchored timeline; do NOT re-anchor the engine (that
      // would undo the sample-aligned crossover). Anchors reset and predictor trust is re-earned
      // for the new stream, mirroring the app.
      const stream = this.stagedStream
      const timeline = this.stagedTimeline
      this.stagedStream = null
      this.stagedTimeline = null
      this.driver.promoteStagedEngine()
      this.activeStream = stream
      this.latestTimeline = timeline
      this.resetHostEmitAnchors()
      this.hardSyncCount = 0
      this.snapPendingTicks = 0
      console.log(`[astra-receiver] gapless promote -> "${stream.title ?? stream.streamId}"`)
      return
    }
    // Nothing staged (joined inside the handoff window without the pre-announce, or staging was
    // still deferred on clock priming): the client already switched its active stream and
    // re-requested audio — reconfigure the engine on the boundary-anchored timeline (the
    // documented §21 fallback, audible as a sub-second seam instead of a glitch).
    this.discardStagedEngine('promote fallback')
    const promoted = this.client?.getPromotedStream() ?? null
    if (!promoted || promoted.stream.streamId !== event.streamId || !promoted.timeline) return
    this.resetHostEmitAnchors()
    this.hardSyncCount = 0
    this.handleEvent({
      type: 'stream-start',
      stream: promoted.stream,
      timeline: promoted.timeline,
      emittedAtHostTimeMs: event.emittedAtHostTimeMs
    })
  }

  // ── Timeline application (AudioEngine scheduling sites, re-based on the driver) ──

  private applyChunkTimelineIfNeeded(chunk: ParallaxAudioChunk): void {
    const stream = this.activeStream
    if (!stream || stream.streamId !== chunk.streamId) return
    const offsetMs = this.client?.getClockOffsetMs() ?? null
    if (offsetMs === null) return
    if (this.latestTimeline?.streamId === chunk.streamId) return
    if (!Number.isFinite(chunk.hostTimeMs) || chunk.hostTimeMs <= 0) return

    const timeline: ParallaxTimelineState = {
      streamId: chunk.streamId,
      playbackState: 'playing',
      startFrame: Math.max(0, Math.floor(chunk.startFrame)),
      startHostTimeMs: chunk.hostTimeMs,
      updatedHostTimeMs: chunk.hostTimeMs,
      groupLatencyMs: stream.groupLatencyMs
    }
    this.latestTimeline = timeline
    this.applyTimelineFromHostClock(timeline, offsetMs, 0)
  }

  private applyTimelineFromHostClock(
    timeline: ParallaxTimelineState,
    hostMinusSinkOffsetMs: number,
    playbackRatePpm: number
  ): void {
    if (this.engine.getStreamId() !== timeline.streamId) return
    if (timeline.playbackState !== 'playing') {
      // Paused timelines carry no emit deadline — park the cursor at startFrame.
      this.engine.setTimeline({
        startFrame: timeline.startFrame,
        startAtOutputFrame: this.driver.currentOutputFrame(),
        playing: false,
        playbackRatePpm
      }, this.driver.currentOutputFrame())
      return
    }
    // Acoustic anchor: the sink's speaker emits startFrame at startHostTimeMs (host clock). A
    // positive trim advances emission. outputFrameForWallTime maps emission time directly onto
    // the write-frame axis, replacing the renderer's ctx-time − sinkLatency arithmetic.
    const sinkStartWallTimeMs = mapHostTimeToSinkTimeMs(timeline.startHostTimeMs, hostMinusSinkOffsetMs)
    const startAtOutputFrame = this.driver.outputFrameForWallTime(sinkStartWallTimeMs - this.advanceMs)
    this.engine.setTimeline({
      startFrame: timeline.startFrame,
      startAtOutputFrame,
      playing: true,
      playbackRatePpm
    }, this.driver.currentOutputFrame())
  }

  private resyncToHostFrame(targetFrame: number, leadSeconds: number): void {
    const startAtOutputFrame = this.driver.outputFrameForWallTime(
      localNowMs() + Math.max(0, leadSeconds) * 1000 - this.advanceMs
    )
    this.engine.setTimeline({
      startFrame: Math.max(0, Math.floor(targetFrame)),
      startAtOutputFrame,
      playing: true,
      playbackRatePpm: 0
    }, this.driver.currentOutputFrame())
  }

  // ── Host-emit-anchor predictor (Phase 2A/2B port) ────────────────────────────

  private resetHostEmitAnchors(): void {
    this.hostEmitAnchors = []
    this.hostEmitAnchorStreamId = null
    this.hostEmitLastSequence = null
    this.hostEmitLastWallMs = null
    this.hostEmitRawPairwisePpm = null
    this.hostEmitPredictor = null
    this.predictorSnapTrusted = false
    this.predictorTrustTickCount = 0
  }

  private ingestHostEmitAnchor(event: Extract<ParallaxTimelineEvent, { type: 'host-emit-anchor' }>): void {
    if (this.hostEmitAnchorStreamId !== null && this.hostEmitAnchorStreamId !== event.streamId) {
      this.resetHostEmitAnchors()
    }
    this.hostEmitAnchorStreamId = event.streamId

    if (!Number.isFinite(event.hostWallTimeMs) || !Number.isFinite(event.sourceFrameAtHostOutput)) return
    if (this.hostEmitLastSequence !== null && event.sequence <= this.hostEmitLastSequence) return
    if (this.hostEmitLastWallMs !== null && event.hostWallTimeMs <= this.hostEmitLastWallMs) return

    const previous = this.hostEmitAnchors.length > 0
      ? this.hostEmitAnchors[this.hostEmitAnchors.length - 1]
      : null
    const stream = this.activeStream
    let rawPpm: number | null = null
    if (previous && stream) {
      const dt = event.hostWallTimeMs - previous.hostWallTimeMs
      if (dt > 0) {
        const slope = (event.sourceFrameAtHostOutput - previous.sourceFrameAtHostOutput) / dt
        rawPpm = hostEmitAnchorSlopeToPpm(slope, stream.sampleRate)
        this.hostEmitRawPairwisePpm = rawPpm
      }
    }
    if (rawPpm !== null && Math.abs(rawPpm) > PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM) {
      // Outlier — skip without updating last-accepted markers.
      return
    }

    this.hostEmitAnchors.push({
      hostWallTimeMs: event.hostWallTimeMs,
      sourceFrameAtHostOutput: event.sourceFrameAtHostOutput,
      sequence: event.sequence
    })
    this.hostEmitLastSequence = event.sequence
    this.hostEmitLastWallMs = event.hostWallTimeMs

    const windowFloorMs = event.hostWallTimeMs - PARALLAX_HOST_EMIT_ANCHOR_WINDOW_MS
    while (this.hostEmitAnchors.length > 0 && this.hostEmitAnchors[0].hostWallTimeMs < windowFloorMs) {
      this.hostEmitAnchors.shift()
    }

    if (this.hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES) {
      this.hostEmitPredictor = fitHostEmitAnchorLine(this.hostEmitAnchors)
    } else {
      this.hostEmitPredictor = null
    }
  }

  private hostEmitPredictorGatesPass(
    hostTimeAtReportMs: number | null,
    activeStreamId: string | null,
    hostRefRatePpm: number | null,
    hostRefAgeMs: number | null
  ): boolean {
    if (hostTimeAtReportMs === null) return false
    if (!this.hostEmitPredictor) return false
    if (this.hostEmitAnchorStreamId === null) return false
    if (activeStreamId !== this.hostEmitAnchorStreamId) return false
    if (hostRefAgeMs === null) return false
    if (Math.abs(hostRefAgeMs) > PARALLAX_HOST_EMIT_ANCHOR_STALE_MS) return false
    if (hostRefRatePpm === null) return false
    if (Math.abs(hostRefRatePpm) > PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM) return false
    return true
  }

  private getHostEmitPredictorTelemetry(
    hostTimeAtReportMs: number | null,
    streamSampleRate: number,
    sinkLatencyMs: number,
    sinkWriteCursorFrame: number
  ): {
    hostRefAgeMs: number | null
    hostRefRatePpm: number | null
    hostRefRateRawPpm: number | null
    hostRefFrame: number | null
    sinkAcousticFrame: number | null
    hostAcousticFrame: number | null
    phase2DriftFrames: number | null
  } {
    const empty = {
      hostRefAgeMs: null,
      hostRefRatePpm: null,
      hostRefRateRawPpm: this.hostEmitRawPairwisePpm,
      hostRefFrame: null,
      sinkAcousticFrame: null,
      hostAcousticFrame: null,
      phase2DriftFrames: null
    }
    if (hostTimeAtReportMs === null) return empty
    if (!this.hostEmitPredictor || this.hostEmitLastWallMs === null) return empty
    const ageMs = hostTimeAtReportMs - this.hostEmitLastWallMs
    const hostRefRatePpm = hostEmitAnchorSlopeToPpm(this.hostEmitPredictor.slopeFramesPerMs, streamSampleRate)
    const hostRefFrame = this.hostEmitPredictor.intercept + this.hostEmitPredictor.slopeFramesPerMs * hostTimeAtReportMs
    const sinkLatencyFrames = (sinkLatencyMs * streamSampleRate) / 1000
    const sinkAcousticFrame = sinkWriteCursorFrame - sinkLatencyFrames
    const phase2DriftFrames = sinkAcousticFrame - hostRefFrame
    return {
      hostRefAgeMs: ageMs,
      hostRefRatePpm,
      hostRefRateRawPpm: this.hostEmitRawPairwisePpm,
      hostRefFrame,
      sinkAcousticFrame,
      hostAcousticFrame: hostRefFrame,
      phase2DriftFrames
    }
  }

  // ── Drift computation (computeRateCorrectionPpm port) ────────────────────────

  private computeRateCorrection(
    timeline: ParallaxTimelineState,
    stream: ParallaxStreamInfo,
    snapshot: { currentFrame: number; currentFrameAtWallMs: number },
    clockOffsetMs: number | null,
    sinkLatencyMs: number
  ): RateCorrection {
    if (timeline.playbackState !== 'playing') {
      return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
    }
    if (clockOffsetMs === null) {
      return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
    }
    if (!Number.isFinite(snapshot.currentFrameAtWallMs) || snapshot.currentFrameAtWallMs <= 0) {
      return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
    }

    // Drift at the wall instant the driver stamped the cursor. The write anchor leads the
    // acoustic anchor by the sink's own latency (queue depth + trim); clamp on the anchor.
    const hostTimeAtReport = snapshot.currentFrameAtWallMs + clockOffsetMs
    const writeAnchorMs = timeline.startHostTimeMs - sinkLatencyMs
    const elapsedMs = Math.max(0, hostTimeAtReport - writeAnchorMs)
    const expectedFrame = timeline.startFrame + Math.floor((elapsedMs * stream.sampleRate) / 1000)
    const driftFrames = snapshot.currentFrame - expectedFrame
    return {
      driftFrames,
      playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2),
      loopSource: 'phase1'
    }
  }

  // ── 1 Hz drift/telemetry tick (parallaxStore ensureTelemetry port) ───────────

  private telemetryTick(): void {
    const client = this.client
    if (!client) return
    const status = client.getStatus()
    const stream = this.activeStream
    const timeline = this.latestTimeline
    const snapshot = this.engine.getSnapshot()
    if (!status.connected || !stream || !timeline) return

    const now = localNowMs()
    const clockOffsetMs = status.clockOffsetMs
    const hasOffset = clockOffsetMs !== null
    // Latency captured at the position stamp keeps drift self-consistent; the live queue depth
    // feeds scheduling (effective snap lead).
    const sinkLatencyMs = snapshot.latencyMsAtStamp + this.advanceMs
    const schedulingLatencyMs = this.driver.currentLatencyMs() + this.advanceMs
    const phase1Correction = this.computeRateCorrection(timeline, stream, snapshot, clockOffsetMs, sinkLatencyMs)

    const hostTimeAtReportMs = (hasOffset && snapshot.currentFrameAtWallMs > 0)
      ? snapshot.currentFrameAtWallMs + clockOffsetMs
      : null
    const phase2 = this.getHostEmitPredictorTelemetry(
      hostTimeAtReportMs,
      stream.sampleRate,
      sinkLatencyMs,
      snapshot.currentFrame
    )

    const gatesPass = this.hostEmitPredictorGatesPass(
      hostTimeAtReportMs,
      stream.streamId,
      phase2.hostRefRatePpm,
      phase2.hostRefAgeMs
    )

    const correction: RateCorrection = (
      PARALLAX_USE_HOST_PREDICTOR
      && gatesPass
      && phase2.phase2DriftFrames !== null
      && phase1Correction.loopSource === 'phase1'
    )
      ? {
          driftFrames: phase2.phase2DriftFrames,
          playbackRatePpm: clampParallaxPlaybackRatePpm(-phase2.phase2DriftFrames * 2),
          loopSource: 'predictor'
        }
      : phase1Correction

    const resolveHostNowMs = (): number => now + (clockOffsetMs ?? 0)

    const liveSnapTarget = (): { targetFrame: number; leadSeconds: number } | null => {
      const effectiveLeadMs = Math.max(PARALLAX_RESYNC_LEAD_MS, schedulingLatencyMs + PARALLAX_RESYNC_GUARD_MS)
      const nominalTarget = (): { targetFrame: number; leadSeconds: number } => {
        const targetFrame = Math.max(
          0,
          Math.min(
            stream.totalFrames,
            timeline.startFrame
              + Math.floor(((resolveHostNowMs() + effectiveLeadMs - timeline.startHostTimeMs) * stream.sampleRate) / 1000)
          )
        )
        return { targetFrame, leadSeconds: effectiveLeadMs / 1000 }
      }
      if (!PARALLAX_USE_HOST_PREDICTOR) {
        return nominalTarget()
      }
      if (correction.loopSource !== 'predictor') {
        // Streams with NO anchors at all — the host publishes emit-anchors only from its normal
        // playback engine, so the trim TEST TONE never grows a predictor — still need snap-based
        // correction: without this, env-on mode leaves them slew-only (1 ms/s) and a live trim
        // change on the tone audibly does nothing (found on first Pi trim calibration). Gated on
        // an empty anchor window so a transient gate blink on an anchored music stream keeps the
        // app's no-phase1-snap rule (a nominal snap there could fight the predictor's truth).
        if (this.hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES) return null
        return nominalTarget()
      }
      if (!this.hostEmitPredictor) return null
      const targetWallMs = resolveHostNowMs() + effectiveLeadMs
      const predicted = this.hostEmitPredictor.intercept + this.hostEmitPredictor.slopeFramesPerMs * targetWallMs
      if (!Number.isFinite(predicted)) return null
      const targetFrame = Math.max(0, Math.min(stream.totalFrames, Math.floor(predicted)))
      return { targetFrame, leadSeconds: effectiveLeadMs / 1000 }
    }

    let syncEvent: 'snap' | 'rebuffer_snap' | null = null
    let appliedPpm = 0

    if (snapshot.rebuffering) {
      // Worklet-equivalent self-pause: hold until the buffer covers the live host frame by a safe
      // margin, then re-anchor to live and resume.
      this.snapPendingTicks = 0
      const marginFrames = Math.floor((PARALLAX_REBUFFER_MARGIN_MS * stream.sampleRate) / 1000)
      const snap = liveSnapTarget()
      if (
        snap !== null
        && timeline.playbackState === 'playing'
        && hasOffset
        && snapshot.bufferedEndFrame >= snap.targetFrame + marginFrames
      ) {
        this.resyncToHostFrame(snap.targetFrame, snap.leadSeconds)
        this.lastHardSyncAtMs = now
        this.hardSyncCount += 1
        syncEvent = 'rebuffer_snap'
        console.log(`[astra-receiver] rebuffer snap -> frame ${snap.targetFrame} (advance ${this.advanceMs} ms)`)
      }
    } else {
      const decision = decideParallaxSinkCorrection(correction.driftFrames, stream.sampleRate)
      const snap = decision.mode === 'snap' ? liveSnapTarget() : null
      const isSnapSizedDrift = decision.mode === 'snap'

      // §17.2(c) fail-closed trust latch: the predictor must prove itself (enough anchors + the
      // fit's intercept stable under the snap threshold for consecutive ticks) before it is
      // allowed to hard-snap. Slew is unaffected.
      const hardSyncFrames = (PARALLAX_HARD_SYNC_MS / 1000) * stream.sampleRate
      const phase2DriftAbs = phase2.phase2DriftFrames !== null ? Math.abs(phase2.phase2DriftFrames) : Infinity
      const stabilityTickOk = correction.loopSource === 'predictor' && phase2DriftAbs < hardSyncFrames
      this.predictorTrustTickCount = stabilityTickOk ? this.predictorTrustTickCount + 1 : 0
      if (!this.predictorSnapTrusted) {
        if (
          this.hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES
          && this.predictorTrustTickCount >= PARALLAX_PREDICTOR_TRUST_TICKS
        ) {
          this.predictorSnapTrusted = true
        }
      }

      // Trust-latch bootstrap (deviation from the app's §17.2(c), deliberate): the latch's
      // stability condition needs |drift| under the snap threshold for consecutive ticks — which
      // is unreachable when the initial anchor lands far off (the daemon's ALSA emission model
      // is not as tight as Web Audio's), so the latch could deadlock and the sink would never
      // snap at all. Once the anchor window is MATURE (≥ TRUSTED_SAMPLES, ~3 s of anchors — the
      // settling-fit risk §17.1 guarded against has passed) a predictor-target snap is allowed
      // even before the latch sets; the snap lands the cursor on the host's real output clock,
      // drift collapses, and the latch then sets through the normal stability path.
      const anchorsMature = this.hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES
      // Anchorless streams (trim test tone) snap against the nominal timeline — mirrored in
      // liveSnapTarget, which only yields a phase-1 target when the anchor window is empty.
      const anchorless = this.hostEmitAnchors.length < PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES
      const canSnap = isSnapSizedDrift
        && timeline.playbackState === 'playing'
        && hasOffset
        && snap !== null
        && (
          !PARALLAX_USE_HOST_PREDICTOR
          || (correction.loopSource === 'predictor' && (this.predictorSnapTrusted || anchorsMature))
          || anchorless
        )
      this.snapPendingTicks = canSnap ? this.snapPendingTicks + 1 : 0
      // For snap-sized drift always slew at max while the snap is suppressed, so the known-large
      // drift discharges instead of sitting at hold.
      appliedPpm = isSnapSizedDrift
        ? clampParallaxPlaybackRatePpm(-correction.driftFrames * 2)
        : decision.playbackRatePpm
      if (
        canSnap
        && snap !== null
        && this.snapPendingTicks >= PARALLAX_SNAP_CONFIRM_TICKS
        && now - this.lastHardSyncAtMs > PARALLAX_RESYNC_MIN_INTERVAL_MS
      ) {
        this.resyncToHostFrame(snap.targetFrame, snap.leadSeconds)
        this.lastHardSyncAtMs = now
        this.snapPendingTicks = 0
        appliedPpm = 0
        this.hardSyncCount += 1
        syncEvent = 'snap'
        console.log(
          `[astra-receiver] snap: drift was ${(correction.driftFrames / stream.sampleRate * 1000).toFixed(1)} ms `
          + `(${correction.loopSource}) -> frame ${snap.targetFrame} (advance ${this.advanceMs} ms)`
        )
      } else {
        this.engine.setRatePpm(appliedPpm)
      }
    }

    const telemetry: ParallaxSinkTelemetry = {
      streamId: snapshot.streamId,
      bufferedMs: stream.sampleRate > 0 ? (snapshot.bufferedFrames / stream.sampleRate) * 1000 : 0,
      driftFrames: correction.driftFrames,
      rttMs: status.rttMs,
      underruns: snapshot.underruns,
      playbackRatePpm: appliedPpm,
      reportedAtMs: Date.now(),
      outputLatencyMs: this.driver.currentLatencyMs(),
      baseLatencyMs: 0,
      timestampLatencyMs: null,
      rebuffering: snapshot.rebuffering,
      starvedFrames: snapshot.starvedFrames,
      hostRefAgeMs: phase2.hostRefAgeMs,
      hostRefRatePpm: phase2.hostRefRatePpm,
      hostRefRateRawPpm: phase2.hostRefRateRawPpm,
      hostRefFrame: phase2.hostRefFrame,
      sinkAcousticFrame: phase2.sinkAcousticFrame,
      hostAcousticFrame: phase2.hostAcousticFrame,
      phase2DriftFrames: phase2.phase2DriftFrames,
      loopSource: correction.loopSource,
      syncEvent,
      hardSyncCount: this.hardSyncCount,
      outputDeviceId: this.backend.deviceId,
      outputDeviceLabel: this.backend.deviceLabel,
      appliedAdvanceMs: this.advanceMs
    }
    this.lastDiagnostics = {
      driftMs: stream.sampleRate > 0 ? (correction.driftFrames / stream.sampleRate) * 1000 : null,
      phase2DriftMs: phase2.phase2DriftFrames !== null && stream.sampleRate > 0
        ? (phase2.phase2DriftFrames / stream.sampleRate) * 1000
        : null,
      loopSource: correction.loopSource,
      appliedPpm,
      bufferedMs: telemetry.bufferedMs,
      latencyMs: sinkLatencyMs,
      anchors: this.hostEmitAnchors.length,
      predictorTrusted: this.predictorSnapTrusted,
      hardSyncCount: this.hardSyncCount,
      underruns: snapshot.underruns,
      rebuffering: snapshot.rebuffering,
      lastSyncEvent: syncEvent ?? this.lastDiagnostics.lastSyncEvent,
      stagedNextTitle: this.stagedStream ? (this.stagedStream.title ?? this.stagedStream.streamId) : null
    }
    void client.publishTelemetry(telemetry)
  }
}
