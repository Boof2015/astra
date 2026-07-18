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
}

export interface SinkSessionInfo {
  assignedSinkName: string | null
  appliedAdvanceMs: number
  streamTitle: string | null
  streamArtist: string | null
  playbackState: string
  diagnostics: SinkSessionDiagnostics
}

function localNowMs(): number {
  return performance.timeOrigin + performance.now()
}

export class SinkSession {
  private readonly backend: OutputBackend
  private readonly engine: SinkPlayoutEngine
  private readonly driver: PlayoutDriver
  private client: ParallaxSinkClient | null = null
  private ownSinkId: string | null = null

  private latestTimeline: ParallaxTimelineState | null = null
  private pendingSinkEvent: ParallaxTimelineEvent | null = null
  private pendingAudioChunks: ParallaxAudioChunk[] = []
  private activeStream: ParallaxStreamInfo | null = null
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
    lastSyncEvent: null
  }

  constructor(backend: OutputBackend) {
    this.backend = backend
    this.engine = new SinkPlayoutEngine(backend.sampleRate, backend.channels)
    this.driver = new PlayoutDriver({ backend, engine: this.engine })
  }

  attachClient(client: ParallaxSinkClient, ownSinkId: string): void {
    this.client = client
    this.ownSinkId = ownSinkId
  }

  setVolumePercent(volumePercent: number): void {
    this.engine.setVolumePercent(volumePercent)
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
    this.latestTimeline = null
    this.pendingSinkEvent = null
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
      playbackState: this.latestTimeline?.playbackState ?? 'stopped',
      diagnostics: this.lastDiagnostics
    }
  }

  // ── Client callbacks ─────────────────────────────────────────────────────────

  handleStatus(status: SinkClientStatus): void {
    // Release a deferred event once clock priming produced a usable offset (parallaxStore's
    // pendingSinkEvent mechanism).
    const pending = this.pendingSinkEvent
    if (pending && status.clockOffsetMs !== null) {
      this.pendingSinkEvent = null
      this.handleEvent(pending)
    }
    if (!status.connected) {
      this.engine.clearStream()
      this.latestTimeline = null
      this.pendingSinkEvent = null
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
    // Early chunk — buffer until its stream-start configures the engine.
    this.pendingAudioChunks = [...this.pendingAudioChunks, chunk].slice(-256)
  }

  handleEvent(event: ParallaxTimelineEvent): void {
    if (event.type === 'host-emit-anchor') {
      this.ingestHostEmitAnchor(event)
      return
    }
    if (event.type === 'sink-trim-update') {
      // Targeted by sinkId; drop trims keyed to a different output device than ours.
      if (!this.ownSinkId || this.ownSinkId !== event.sinkId) return
      if (event.outputDeviceId !== this.backend.deviceId) return
      this.advanceMs = Math.max(-500, Math.min(500, event.advanceMs))
      return
    }
    if (event.type === 'sink-name-update') {
      if (!this.ownSinkId || this.ownSinkId !== event.sinkId) return
      this.assignedSinkName = event.name.trim() || null
      return
    }
    if (event.type === 'stop') {
      this.pendingAudioChunks = []
      this.engine.clearStream()
      this.latestTimeline = null
      this.pendingSinkEvent = null
      this.activeStream = null
      this.resetHostEmitAnchors()
      this.hardSyncCount = 0
      return
    }
    if (event.type === 'next-stream-start' || event.type === 'next-stream-cancel') {
      // §21 MVP: no staged engine — the client tracks the pending stream; nothing to do here.
      return
    }
    if (event.type === 'next-stream-promote') {
      // The client already switched its active stream and re-requested audio. Reconfigure the
      // engine for the promoted stream on its boundary-anchored timeline (the documented §21
      // fallback for sinks without a staged crossover).
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
      return
    }

    const timeline = event.timeline
    if (event.type === 'stream-start') {
      this.resetHostEmitAnchors()
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
      this.pendingSinkEvent = event
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
      if (!PARALLAX_USE_HOST_PREDICTOR) {
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
      if (correction.loopSource !== 'predictor') return null
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
      const canSnap = isSnapSizedDrift
        && timeline.playbackState === 'playing'
        && hasOffset
        && snap !== null
        && (
          !PARALLAX_USE_HOST_PREDICTOR
          || (correction.loopSource === 'predictor' && (this.predictorSnapTrusted || anchorsMature))
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
      lastSyncEvent: syncEvent ?? this.lastDiagnostics.lastSyncEvent
    }
    void client.publishTelemetry(telemetry)
  }
}
