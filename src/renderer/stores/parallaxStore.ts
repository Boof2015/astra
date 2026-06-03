import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import type { Track } from '../types/audio'
import type {
  ParallaxAudioChunk,
  ParallaxPairedSink,
  ParallaxPairResponse,
  ParallaxPairingPin,
  ParallaxSinkConnectionConfig,
  ParallaxStatus,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../../types/parallax'
import {
  clampParallaxPlaybackRatePpm,
  decideParallaxSinkCorrection,
  fitHostEmitAnchorLine,
  hostEmitAnchorSlopeToPpm,
  PARALLAX_DEFAULT_GROUP_LATENCY_MS,
  PARALLAX_HOST_EMIT_ANCHOR_INTERVAL_MS,
  PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM,
  PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES,
  PARALLAX_HOST_EMIT_ANCHOR_WINDOW_MS,
  PARALLAX_REBUFFER_MARGIN_MS,
  PARALLAX_RESYNC_GUARD_MS,
  PARALLAX_RESYNC_LEAD_MS,
  PARALLAX_RESYNC_MIN_INTERVAL_MS,
  PARALLAX_SNAP_CONFIRM_TICKS
} from '../../types/parallax'
import { useAudioSettingsStore } from './audioSettingsStore'

interface ParallaxSettingsStore {
  status: ParallaxStatus | null
  pairedSinks: ParallaxPairedSink[]
  activePairingPin: ParallaxPairingPin | null
  pendingSinkEvent: ParallaxTimelineEvent | null
  latestTimeline: ParallaxTimelineState | null
  sinkSnapshot: {
    streamId: string | null
    currentFrame: number
    currentFrameAtWallMs: number
    bufferedFrames: number
    bufferedEndFrame: number
    underruns: number
    playbackRatePpm: number
    starvedFrames: number
    rebuffering: boolean
  }
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setHostEnabled: (enabled: boolean) => Promise<ParallaxStatus | null>
  setHostPort: (port: number) => Promise<ParallaxStatus | null>
  createPairingPin: () => Promise<ParallaxPairingPin | null>
  pairWithHost: (baseUrl: string, pin: string, sinkName: string) => Promise<ParallaxPairResponse | null>
  connectSink: (config: ParallaxSinkConnectionConfig) => Promise<ParallaxStatus | null>
  disconnectSink: () => Promise<void>
  revokePairedSink: (id: string) => Promise<void>
  revokeAllPairedSinks: () => Promise<number>
  resetToDefaults: () => Promise<ParallaxStatus | null>
  shouldDelayHostPlayback: (track: Track | null | undefined) => boolean
  prepareHostPlayback: (track: Track) => Promise<ParallaxTimelineState | null>
  startHostStreamForCurrentPlayback: (
    track: Track | null | undefined,
    playing: boolean
  ) => Promise<ParallaxTimelineState | null>
  resumeHostPlayback: (track: Track | null | undefined) => Promise<ParallaxTimelineState | null>
  prepareHostSeek: (timeSeconds: number, playing: boolean) => Promise<ParallaxTimelineState | null>
  pauseHostPlayback: () => Promise<void>
  stopHostPlayback: () => Promise<void>
}

let statusUnsubscribe: (() => void) | null = null
let eventUnsubscribe: (() => void) | null = null
let audioChunkUnsubscribe: (() => void) | null = null
let telemetryTimer: number | null = null
let pendingAudioChunks: ParallaxAudioChunk[] = []
let lastHardSyncAtMs = 0
let snapPendingTicks = 0
// Phase 2A — rolling window of host emit anchors and the fitted host-output predictor. The drift
// loop does NOT consume these in 2A (logged-only); the telemetry tick reads `hostEmitPredictor`
// and pushes its components to the CSV so we can calibrate the filter before 2B switches the loop.
interface HostEmitAnchorSample {
  hostWallTimeMs: number
  sourceFrameAtHostOutput: number
  sequence: number
}
let hostEmitAnchors: HostEmitAnchorSample[] = []
let hostEmitAnchorStreamId: string | null = null
let hostEmitLastSequence: number | null = null
let hostEmitLastWallMs: number | null = null
let hostEmitRawPairwisePpm: number | null = null
let hostEmitPredictor: { slopeFramesPerMs: number; intercept: number } | null = null
// Host-side: 5 Hz publish loop + per-stream sequence counter (resets on stream change).
let hostEmitPublishTimer: number | null = null
let hostEmitOutgoingSequence = 0
let hostEmitOutgoingStreamId: string | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update Parallax settings.'
}

function createStreamId(track: Track): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${track.id}`
}

function buildParallaxStreamInfo(
  track: Track,
  streamId: string,
  buffer: AudioBuffer
): Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'> {
  return {
    streamId,
    trackId: track.id,
    trackPath: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    sampleRate: buffer.sampleRate,
    channels: Math.max(1, Math.min(8, buffer.numberOfChannels)),
    durationSeconds: buffer.duration,
    totalFrames: buffer.length
  }
}

function resolveHostNowMs(status: ParallaxStatus | null): number {
  const offsetMs = status?.sink.clockOffsetMs ?? 0
  return performance.timeOrigin + performance.now() + offsetMs
}

function localNowMs(): number {
  return performance.timeOrigin + performance.now()
}

function buildHostTimeline(
  stream: ParallaxStreamInfo,
  playbackState: ParallaxTimelineState['playbackState'],
  startFrame: number,
  delayMs: number = 0
): ParallaxTimelineState {
  const now = localNowMs()
  return {
    streamId: stream.streamId,
    playbackState,
    startFrame: Math.max(0, Math.min(stream.totalFrames, Math.floor(startFrame))),
    startHostTimeMs: now + Math.max(0, delayMs),
    updatedHostTimeMs: now,
    groupLatencyMs: stream.groupLatencyMs
  }
}

function computeRateCorrectionPpm(
  timeline: ParallaxTimelineState,
  stream: ParallaxStreamInfo,
  snapshot: { currentFrame: number; currentFrameAtWallMs: number },
  status: ParallaxStatus | null,
  sinkLatencyMs: number
): { driftFrames: number; playbackRatePpm: number } {
  if (timeline.playbackState !== 'playing') {
    return { driftFrames: 0, playbackRatePpm: 0 }
  }
  // `currentFrameAtWallMs` is in *sink* wall time; `timeline.startHostTimeMs` is in *host* wall
  // time. Treating sink-wall as host-wall when the clock offset is unknown produces a drift error
  // equal to the absolute clock delta between the two machines — typically hundreds of ms (at
  // 44.1 k, a 1 s clock delta lights up as ~44 000 frames of phantom drift, which then snaps).
  // The offset is null during the clock-priming window of every connect/reconnect; without this
  // guard a watchdog-triggered reconnect mid-playback fires a spurious ~900 ms drift spike that
  // the loop reacts to. Hold drift at 0 until the offset is back; the snap path's own hasOffset
  // gate stops the snap from firing anyway, but the rate loop must stay quiet too.
  if (status?.sink.clockOffsetMs === null || status?.sink.clockOffsetMs === undefined) {
    return { driftFrames: 0, playbackRatePpm: 0 }
  }
  // Drift only makes sense once the worklet has reported at least one timestamped position. Before
  // that the formula would compare a frame=0 cursor against a positive expected frame and produce a
  // spurious large drift on the very first tick.
  if (!Number.isFinite(snapshot.currentFrameAtWallMs) || snapshot.currentFrameAtWallMs <= 0) {
    return { driftFrames: 0, playbackRatePpm: 0 }
  }

  // Compute drift at the wall instant the worklet reported the cursor, not at "now" — this is the
  // step-3 timing cleanup that kills the ~1 s aliasing between the 1 Hz tick and the ~46 ms worklet
  // report cadence.
  //
  // Auto-comp scheduling (step 5) makes the worklet *write* startFrame at host time
  // `writeAnchorMs = startHostTimeMs − sinkLatency` so the DAC emits it AT `startHostTimeMs`. The
  // write cursor at any later host time `h` is therefore `startFrame + (h − writeAnchorMs)·sr/1000`,
  // valid for the entire write window — including the pre-roll sinkLatency before `startHostTimeMs`
  // where setTimeline's forced position report would otherwise produce a spurious negative drift
  // of one output-latency window. Clamp on the *anchor*, not on (host − startHostTime) + latency.
  const offsetMs = status?.sink.clockOffsetMs ?? 0
  const hostTimeAtReport = snapshot.currentFrameAtWallMs + offsetMs
  const writeAnchorMs = timeline.startHostTimeMs - sinkLatencyMs
  const elapsedMs = Math.max(0, hostTimeAtReport - writeAnchorMs)
  const expectedFrame = timeline.startFrame
    + Math.floor((elapsedMs * stream.sampleRate) / 1000)
  const driftFrames = snapshot.currentFrame - expectedFrame
  return {
    driftFrames,
    playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2)
  }
}

export const useParallaxStore = create<ParallaxSettingsStore>((set, get) => {
  const applyStatus = (status: ParallaxStatus): ParallaxStatus => {
    const serviceError = status.sink.lastError ?? status.host.lastError ?? ''
    set({
      status,
      activePairingPin: status.host.activePairingPin,
      errorMessage: serviceError
    })

    const pending = get().pendingSinkEvent
    if (pending && status.sink.clockOffsetMs !== null) {
      set({ pendingSinkEvent: null })
      void handleSinkEvent(pending)
    }

    return status
  }

  const refreshPairedSinks = async (): Promise<void> => {
    const pairedSinks = await window.electronAPI.parallax.listPairedSinks()
    set({ pairedSinks })
  }

  const resetHostEmitAnchors = (): void => {
    hostEmitAnchors = []
    hostEmitAnchorStreamId = null
    hostEmitLastSequence = null
    hostEmitLastWallMs = null
    hostEmitRawPairwisePpm = null
    hostEmitPredictor = null
  }

  // Host-side: publish one anchor (5 Hz timer body). Stops itself only when there's no active
  // host stream at all. Does NOT use `getActiveHostStream()` because that gates on
  // `connectedSinkCount > 0`, which would strand the timer if every sink transiently disconnected
  // — a new sink joining later would then never receive anchors until host playback restarted.
  const publishOneHostEmitAnchor = (): void => {
    const hostStatus = get().status?.host
    const hostStream = hostStatus?.active ? hostStatus.activeStream ?? null : null
    if (!hostStream) {
      stopHostEmitAnchorPublish()
      return
    }
    if (hostEmitOutgoingStreamId !== hostStream.streamId) {
      hostEmitOutgoingStreamId = hostStream.streamId
      hostEmitOutgoingSequence = 0
    }
    const anchor = audioEngine.getHostEmitAnchor()
    if (!anchor) return // no audio at the output yet — wait for next tick
    hostEmitOutgoingSequence += 1
    void window.electronAPI.parallax.publishHostEmitAnchor({
      type: 'host-emit-anchor',
      streamId: hostStream.streamId,
      hostWallTimeMs: anchor.hostWallTimeMs,
      sourceFrameAtHostOutput: anchor.sourceFrameAtHostOutput,
      hostOutputLatencyMs: anchor.hostOutputLatencyMs,
      hostBaseLatencyMs: anchor.hostBaseLatencyMs,
      observedRatePpm: anchor.observedRatePpm,
      sequence: hostEmitOutgoingSequence
    })
  }

  const startHostEmitAnchorPublish = (): void => {
    if (hostEmitPublishTimer !== null) return
    hostEmitPublishTimer = window.setInterval(publishOneHostEmitAnchor, PARALLAX_HOST_EMIT_ANCHOR_INTERVAL_MS)
  }

  const stopHostEmitAnchorPublish = (): void => {
    if (hostEmitPublishTimer !== null) {
      window.clearInterval(hostEmitPublishTimer)
      hostEmitPublishTimer = null
    }
    hostEmitOutgoingStreamId = null
    hostEmitOutgoingSequence = 0
  }

  // Phase 2A — ingest one host-emit-anchor into the rolling window and refit the predictor.
  // Sync, fast, runs at 5 Hz. Updates module state only; the telemetry tick reads it and ships the
  // components to the CSV. The loop does NOT consume these in 2A — that switch is Phase 2B.
  const ingestHostEmitAnchor = (event: Extract<ParallaxTimelineEvent, { type: 'host-emit-anchor' }>): void => {
    // Stream change resets the window. Old anchors are meaningless for the new stream's frame
    // origin, and including them would corrupt the fit until they fall out of the window.
    if (hostEmitAnchorStreamId !== null && hostEmitAnchorStreamId !== event.streamId) {
      resetHostEmitAnchors()
    }
    hostEmitAnchorStreamId = event.streamId

    // Pre-filter rejections (per share doc §5). Monotonicity is compared against the *last
    // accepted* anchor, not last seen — that way a rejected outlier doesn't block subsequent good
    // anchors whose sequence is greater than the rejected one but less than the next one we'd
    // have accepted.
    //   - non-finite frame or wall time
    //   - non-monotonic sequence (duplicate / out-of-order delivery)
    //   - non-monotonic hostWallTimeMs (clock went backwards on host)
    //   - pairwise slope vs previous accepted anchor exceeds ±MAX_DEVIATION_PPM of nominal
    if (!Number.isFinite(event.hostWallTimeMs) || !Number.isFinite(event.sourceFrameAtHostOutput)) return
    if (hostEmitLastSequence !== null && event.sequence <= hostEmitLastSequence) return
    if (hostEmitLastWallMs !== null && event.hostWallTimeMs <= hostEmitLastWallMs) return

    // Raw pairwise ppm vs the previous accepted anchor — used both for the sanity gate AND as a
    // CSV column so we can see the filter doing its job (raw should be visibly noisier than
    // filtered). Always update the CSV column, even if the resulting anchor is rejected — that's
    // exactly when the raw vs filtered comparison is most informative.
    const previous = hostEmitAnchors.length > 0 ? hostEmitAnchors[hostEmitAnchors.length - 1] : null
    const stream = get().status?.sink.activeStream ?? null
    let rawPpm: number | null = null
    if (previous && stream) {
      const dt = event.hostWallTimeMs - previous.hostWallTimeMs
      if (dt > 0) {
        const slope = (event.sourceFrameAtHostOutput - previous.sourceFrameAtHostOutput) / dt
        rawPpm = hostEmitAnchorSlopeToPpm(slope, stream.sampleRate)
        hostEmitRawPairwisePpm = rawPpm
      }
    }
    if (rawPpm !== null && Math.abs(rawPpm) > PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM) {
      // Outlier — likely a `getOutputTimestamp` jitter spike. Skip it; do NOT update the
      // last-accepted markers so the next anchor is still compared against the previous good one.
      return
    }

    hostEmitAnchors.push({
      hostWallTimeMs: event.hostWallTimeMs,
      sourceFrameAtHostOutput: event.sourceFrameAtHostOutput,
      sequence: event.sequence
    })
    hostEmitLastSequence = event.sequence
    hostEmitLastWallMs = event.hostWallTimeMs

    // Drop anchors that have fallen out of the rolling window. We trim from the front (oldest)
    // since anchors are appended in monotonic-time order.
    const windowFloorMs = event.hostWallTimeMs - PARALLAX_HOST_EMIT_ANCHOR_WINDOW_MS
    while (hostEmitAnchors.length > 0 && hostEmitAnchors[0].hostWallTimeMs < windowFloorMs) {
      hostEmitAnchors.shift()
    }

    // Refit when we have enough samples. Theil-Sen is O(N²) — at 5 Hz × 20 s = 100 samples that's
    // 4950 pairwise slopes. Cheap (sub-ms). Runs on every anchor (every 200 ms), not on the 1 Hz
    // tick, so by the time telemetry publishes the predictor reflects the latest line.
    if (hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES) {
      hostEmitPredictor = fitHostEmitAnchorLine(hostEmitAnchors)
    } else {
      hostEmitPredictor = null
    }
  }

  // Snapshot the predictor's state for telemetry/CSV. Computed lazily on each tick, never cached.
  // `hostTimeAtReportMs` is the report instant expressed in host-wall time — the caller must map
  // the sink-wall snapshot through `status.sink.clockOffsetMs` first, or pass null if the offset
  // is unknown (priming window of any connect/reconnect). If we predicted against sink-wall the
  // result would be off by the absolute machine clock delta — tens of thousands of frames.
  const getHostEmitPredictorTelemetry = (
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
  } => {
    const empty = {
      hostRefAgeMs: null,
      hostRefRatePpm: null,
      hostRefRateRawPpm: hostEmitRawPairwisePpm,
      hostRefFrame: null,
      sinkAcousticFrame: null,
      hostAcousticFrame: null,
      phase2DriftFrames: null
    }
    if (hostTimeAtReportMs === null) return empty
    if (!hostEmitPredictor || hostEmitLastWallMs === null) return empty
    const ageMs = hostTimeAtReportMs - hostEmitLastWallMs
    const hostRefRatePpm = hostEmitAnchorSlopeToPpm(hostEmitPredictor.slopeFramesPerMs, streamSampleRate)
    // Predict host's source frame at the report instant in host-wall time.
    const hostRefFrame = hostEmitPredictor.intercept + hostEmitPredictor.slopeFramesPerMs * hostTimeAtReportMs
    // Acoustic frame on each side: host is by definition emit-time; sink write cursor leads emit by
    // sinkLatency, so subtract to get the emit frame.
    const sinkLatencyFrames = (sinkLatencyMs * streamSampleRate) / 1000
    const sinkAcousticFrame = sinkWriteCursorFrame - sinkLatencyFrames
    const phase2DriftFrames = sinkAcousticFrame - hostRefFrame
    return {
      hostRefAgeMs: ageMs,
      hostRefRatePpm,
      hostRefRateRawPpm: hostEmitRawPairwisePpm,
      hostRefFrame,
      sinkAcousticFrame,
      hostAcousticFrame: hostRefFrame,
      phase2DriftFrames
    }
  }

  const getActiveHostStream = (): ParallaxStreamInfo | null => {
    const status = get().status
    if (!status?.host.active || status.host.connectedSinkCount <= 0) return null
    return status.host.activeStream
  }

  const getHostFrameForTime = (stream: ParallaxStreamInfo, timeSeconds: number): number => {
    if (!Number.isFinite(timeSeconds)) return 0
    return Math.max(0, Math.min(stream.totalFrames, Math.round(timeSeconds * stream.sampleRate)))
  }

  // `audioEngine.currentTime` is the host's *write* cursor position (returns context.currentTime −
  // startTime, and startTime is set from the auto-comp-shifted scheduling instant). It leads what
  // the host's speaker is actually emitting by `hostLatency`. Timeline anchors (startHostTimeMs) are
  // acoustic time per the invariant on ParallaxTimelineState, so any code that translates "where is
  // the host *now*" into a timeline frame must use the emit cursor — not the write cursor — or the
  // resulting startFrame will be `hostLatency` frames ahead of where the host is actually playing,
  // and joining sinks will start `hostLatency` ms ahead of the host.
  const getHostAcousticCurrentTimeSeconds = (): number => {
    const writeCursorSec = audioEngine.currentTime
    if (!Number.isFinite(writeCursorSec)) return 0
    return Math.max(0, writeCursorSec - audioEngine.getParallaxEndpointLatencyMs() / 1000)
  }

  const publishHostTimeline = async (timeline: ParallaxTimelineState): Promise<ParallaxTimelineState> => {
    await window.electronAPI.parallax.publishHostTimeline(timeline)
    return timeline
  }

  const ensureTelemetry = () => {
    if (telemetryTimer !== null) return
    telemetryTimer = window.setInterval(() => {
      const status = get().status
      // Phase 0 diagnostics: when acting as host with a connected sink, report our own output-latency
      // signals to the main process so the host-side telemetry CSV can log both ends in one row.
      if (status?.host.active && status.host.connectedSinkCount > 0) {
        void window.electronAPI.parallax.reportHostLatency(audioEngine.getOutputLatencyMetrics())
      }
      const stream = status?.sink.activeStream ?? null
      const timeline = get().latestTimeline
      const snapshot = audioEngine.getParallaxSinkSnapshot()
      set({ sinkSnapshot: snapshot })
      if (!status?.sink.connected || !stream || !timeline) return

      const now = performance.timeOrigin + performance.now()
      const hasOffset = status.sink.clockOffsetMs !== null && status.sink.clockOffsetMs !== undefined
      // Canonical latency — the exact same value AudioEngine subtracts in its three scheduling
      // sites. Using `audioEngine.getParallaxEndpointLatencyMs()` (not a fresh sum of components
      // from getOutputLatencyMetrics) keeps scheduling and drift target in lockstep, so a future
      // PARALLAX_SINK_ADVANCE_MS shifts both together and the loop doesn't slew to undo the trim.
      const sinkLatencyMs = audioEngine.getParallaxEndpointLatencyMs()
      const correction = computeRateCorrectionPpm(timeline, stream, snapshot, status, sinkLatencyMs)
      // Live host frame + effective lead for hard snap / rebuffer resume. PARALLAX_RESYNC_LEAD_MS
      // (60 ms) is too short for endpoints whose own latency exceeds it (Fedora ≈ 58 ms, Bluetooth
      // can be 200 ms+): scheduling would land in the past and the snap would emit late even though
      // the target frame was computed for the unextended lead. We raise the lead to at least
      // `sinkLatency + GUARD` AND advance the target frame by the same delta, so the snap stays
      // valid and the speaker emits the right frame at the right wall instant.
      const liveSnapTarget = (): { targetFrame: number; leadSeconds: number } => {
        const effectiveLeadMs = Math.max(PARALLAX_RESYNC_LEAD_MS, sinkLatencyMs + PARALLAX_RESYNC_GUARD_MS)
        const targetFrame = Math.max(
          0,
          Math.min(
            stream.totalFrames,
            timeline.startFrame +
              Math.floor(((resolveHostNowMs(status) + effectiveLeadMs - timeline.startHostTimeMs) * stream.sampleRate) / 1000)
          )
        )
        return { targetFrame, leadSeconds: effectiveLeadMs / 1000 }
      }

      let appliedPpm = 0
      if (snapshot.rebuffering) {
        // The worklet self-paused after its buffer drained. Hold (no snap/slew) until the buffer
        // covers the live host frame by a safe margin, then re-anchor to live and resume — so the
        // cursor never free-runs into empty data (the underrun spiral that previously killed the sink).
        snapPendingTicks = 0
        const marginFrames = Math.floor((PARALLAX_REBUFFER_MARGIN_MS * stream.sampleRate) / 1000)
        const snap = liveSnapTarget()
        if (
          timeline.playbackState === 'playing' &&
          hasOffset &&
          snapshot.bufferedEndFrame >= snap.targetFrame + marginFrames
        ) {
          audioEngine.resyncParallaxSinkToHostFrame(snap.targetFrame, snap.leadSeconds)
          lastHardSyncAtMs = now
        }
      } else {
        const decision = decideParallaxSinkCorrection(correction.driftFrames, stream.sampleRate)
        const wantsSnap = decision.mode === 'snap' && timeline.playbackState === 'playing' && hasOffset
        snapPendingTicks = wantsSnap ? snapPendingTicks + 1 : 0
        appliedPpm = decision.playbackRatePpm
        if (
          wantsSnap &&
          snapPendingTicks >= PARALLAX_SNAP_CONFIRM_TICKS &&
          now - lastHardSyncAtMs > PARALLAX_RESYNC_MIN_INTERVAL_MS
        ) {
          const snap = liveSnapTarget()
          audioEngine.resyncParallaxSinkToHostFrame(snap.targetFrame, snap.leadSeconds)
          lastHardSyncAtMs = now
          snapPendingTicks = 0
          appliedPpm = 0
        } else {
          // Slew toward the host. During the pre-snap confirmation window we still apply the full
          // rate correction so a real offset starts closing smoothly; if it was just measurement
          // noise the next tick falls back into the deadzone and no gap is ever produced.
          appliedPpm = wantsSnap
            ? clampParallaxPlaybackRatePpm(-correction.driftFrames * 2)
            : decision.playbackRatePpm
          audioEngine.setParallaxSinkPlaybackRate(appliedPpm)
        }
      }
      const sinkLatency = audioEngine.getOutputLatencyMetrics()
      // Phase 2A — predictor telemetry, computed at the same wall instant we just used for drift.
      // Logged-only in 2A; 2B reads these and steers the loop against them when validation passes.
      // Anchors live in host-wall, but `currentFrameAtWallMs` is in sink-wall — map through the
      // clock offset (same conversion the drift formula does), and pass null when the offset is
      // unknown so the predictor returns empty telemetry instead of predicting in the wrong domain.
      const phase2ClockOffsetMs = status.sink.clockOffsetMs
      const hostTimeAtReportMs = (phase2ClockOffsetMs !== null && phase2ClockOffsetMs !== undefined && snapshot.currentFrameAtWallMs > 0)
        ? snapshot.currentFrameAtWallMs + phase2ClockOffsetMs
        : null
      const phase2 = getHostEmitPredictorTelemetry(
        hostTimeAtReportMs,
        stream.sampleRate,
        sinkLatencyMs,
        snapshot.currentFrame
      )
      void window.electronAPI.parallax.publishSinkTelemetry({
        streamId: snapshot.streamId,
        bufferedMs: stream.sampleRate > 0 ? (snapshot.bufferedFrames / stream.sampleRate) * 1000 : 0,
        driftFrames: correction.driftFrames,
        rttMs: status.sink.rttMs,
        underruns: snapshot.underruns,
        playbackRatePpm: appliedPpm,
        reportedAtMs: Date.now(),
        outputLatencyMs: sinkLatency.outputLatencyMs,
        baseLatencyMs: sinkLatency.baseLatencyMs,
        timestampLatencyMs: sinkLatency.timestampLatencyMs,
        rebuffering: snapshot.rebuffering,
        starvedFrames: snapshot.starvedFrames,
        hostRefAgeMs: phase2.hostRefAgeMs,
        hostRefRatePpm: phase2.hostRefRatePpm,
        hostRefRateRawPpm: phase2.hostRefRateRawPpm,
        hostRefFrame: phase2.hostRefFrame,
        sinkAcousticFrame: phase2.sinkAcousticFrame,
        hostAcousticFrame: phase2.hostAcousticFrame,
        phase2DriftFrames: phase2.phase2DriftFrames
      })
    }, 1000)
  }

  const applyChunkTimelineIfNeeded = (chunk: ParallaxAudioChunk): void => {
    const status = get().status
    const stream = status?.sink.activeStream
    if (!status?.sink.connected || !stream || stream.streamId !== chunk.streamId) return
    if (status.sink.clockOffsetMs === null || status.sink.clockOffsetMs === undefined) return

    const latestTimeline = get().latestTimeline
    if (latestTimeline?.streamId === chunk.streamId) return
    if (!Number.isFinite(chunk.hostTimeMs) || chunk.hostTimeMs <= 0) return

    const timeline: ParallaxTimelineState = {
      streamId: chunk.streamId,
      playbackState: 'playing',
      startFrame: Math.max(0, Math.floor(chunk.startFrame)),
      startHostTimeMs: chunk.hostTimeMs,
      updatedHostTimeMs: chunk.hostTimeMs,
      groupLatencyMs: stream.groupLatencyMs
    }
    set({ latestTimeline: timeline })
    audioEngine.applyParallaxTimelineFromHostClock(timeline, status.sink.clockOffsetMs, 0)
  }

  const ensureSubscriptions = () => {
    if (!statusUnsubscribe) {
      statusUnsubscribe = window.electronAPI.parallax.onStatus((status) => {
        applyStatus(status)
        void refreshPairedSinks().catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
      })
    }

    if (!eventUnsubscribe) {
      eventUnsubscribe = window.electronAPI.parallax.onEvent((event) => {
        // Phase 2A — anchors take the fast sync path; stream-start/timeline/stop go through the
        // async chunk-pending / stream-load flow.
        if (event.type === 'host-emit-anchor') {
          ingestHostEmitAnchor(event)
          return
        }
        void handleSinkEvent(event).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
      })
    }

    if (!audioChunkUnsubscribe) {
      audioChunkUnsubscribe = window.electronAPI.parallax.onAudioChunk((chunk) => {
        if (audioEngine.getParallaxSinkSnapshot().streamId !== chunk.streamId) {
          pendingAudioChunks = [...pendingAudioChunks, chunk].slice(-256)
          return
        }
        audioEngine.appendParallaxSinkAudioChunk(chunk)
        set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
        applyChunkTimelineIfNeeded(chunk)
      })
    }

    ensureTelemetry()
  }

  const fetchAll = async (): Promise<ParallaxStatus> => {
    const status = await window.electronAPI.parallax.getStatus()
    ensureSubscriptions()
    applyStatus(status)
    await refreshPairedSinks()
    return status
  }

  const handleSinkEvent = async (event: ParallaxTimelineEvent): Promise<void> => {
    // Host emit anchors are handled by ingestHostEmitAnchor (sync, fast — 5 Hz). They never need
    // the async stream-load / pending-chunk logic this function exists for.
    if (event.type === 'host-emit-anchor') return
    const status = get().status
    if (event.type === 'stop') {
      pendingAudioChunks = []
      audioEngine.stopParallaxSinkPlayback()
      resetHostEmitAnchors()
      set({
        latestTimeline: null,
        pendingSinkEvent: null,
        sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
      })
      return
    }

    const timeline = event.type === 'stream-start' ? event.timeline : event.timeline
    if (event.type === 'stream-start') {
      try {
        if (audioEngine.getParallaxSinkSnapshot().streamId !== event.stream.streamId) {
          await audioEngine.loadParallaxSinkStream(event.stream)
        }
      } catch (error) {
        pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
        set({
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          errorMessage: toErrorMessage(error)
        })
        return
      }
      const bufferedChunks = pendingAudioChunks.filter((chunk) => chunk.streamId === event.stream.streamId)
      pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
      for (const chunk of bufferedChunks) {
        audioEngine.appendParallaxSinkAudioChunk(chunk)
        applyChunkTimelineIfNeeded(chunk)
      }
      set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
    }

    if (status?.sink.clockOffsetMs === null || status?.sink.clockOffsetMs === undefined) {
      set({ pendingSinkEvent: event })
      return
    }

    set({ latestTimeline: timeline })
    audioEngine.applyParallaxTimelineFromHostClock(timeline, status.sink.clockOffsetMs, 0)
  }

  return {
    status: null,
    pairedSinks: [],
    activePairingPin: null,
    pendingSinkEvent: null,
    latestTimeline: null,
    sinkSnapshot: {
      streamId: null,
      currentFrame: 0,
      currentFrameAtWallMs: 0,
      bufferedFrames: 0,
      bufferedEndFrame: 0,
      underruns: 0,
      playbackRatePpm: 0,
      starvedFrames: 0,
      rebuffering: false
    },
    isLoading: false,
    isInitialized: false,
    errorMessage: '',

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        await fetchAll()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    refresh: async () => {
      set({ isLoading: true })
      try {
        await fetchAll()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    setHostEnabled: async (enabled) => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.setHostEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    setHostPort: async (port) => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.setHostPort(port)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    createPairingPin: async () => {
      set({ isLoading: true })
      try {
        const pin = await window.electronAPI.parallax.createPairingPin()
        set({ activePairingPin: pin, errorMessage: '' })
        return pin
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    pairWithHost: async (baseUrl, pin, sinkName) => {
      set({ isLoading: true })
      try {
        const response = await window.electronAPI.parallax.pairWithHost(baseUrl, pin, sinkName)
        set({ errorMessage: '' })
        return response
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    connectSink: async (config) => {
      if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') {
        set({ errorMessage: 'Parallax sink mode is only available in Standard output mode.' })
        return null
      }

      set({ isLoading: true })
      try {
        ensureSubscriptions()
        audioEngine.stop()
        const status = await window.electronAPI.parallax.connectSink(config)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    disconnectSink: async () => {
      set({ isLoading: true })
      try {
        await window.electronAPI.parallax.disconnectSink()
        pendingAudioChunks = []
        audioEngine.stopParallaxSinkPlayback()
        set({
          latestTimeline: null,
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          errorMessage: ''
        })
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    revokePairedSink: async (id) => {
      try {
        await window.electronAPI.parallax.revokePairedSink(id)
        await refreshPairedSinks()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokeAllPairedSinks: async () => {
      try {
        const revoked = await window.electronAPI.parallax.revokeAllPairedSinks()
        await refreshPairedSinks()
        return revoked
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return 0
      }
    },

    resetToDefaults: async () => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.resetToDefaults()
        pendingAudioChunks = []
        audioEngine.stopParallaxSinkPlayback()
        set({
          pairedSinks: [],
          latestTimeline: null,
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
        })
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    shouldDelayHostPlayback: (track) => {
      const status = get().status
      if (!track) return false
      if (track.sourceType && track.sourceType !== 'local') return false
      if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') return false
      return Boolean(status?.host.active && status.host.connectedSinkCount > 0)
    },

    prepareHostPlayback: async (track) => {
      if (!get().shouldDelayHostPlayback(track)) return null
      ensureTelemetry()
      startHostEmitAnchorPublish()
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const streamId = createStreamId(track)
      try {
        const timeline = await window.electronAPI.parallax.publishHostStreamStart(
          buildParallaxStreamInfo(track, streamId, buffer)
        )
        void audioEngine.publishCurrentBufferToParallax(streamId, timeline).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    startHostStreamForCurrentPlayback: async (track, playing) => {
      // A sink joined while the host is already on a local track but no stream is published yet.
      // Anchor a stream at the host's current position so the sink joins the in-progress song,
      // WITHOUT rescheduling the host's own audio (no playCurrentBufferOnParallaxTimeline call).
      if (!get().shouldDelayHostPlayback(track) || !track) return null
      if (getActiveHostStream()) return null
      ensureTelemetry()
      startHostEmitAnchorPublish()
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const streamId = createStreamId(track)
      // While playing, anchor one group-latency ahead on the host's real timeline so the joining
      // sink gets buffering headroom while the host keeps playing seamlessly. While paused, anchor
      // at the current frame (a later resume republishes a fresh playing timeline + chunks).
      const leadSeconds = playing ? PARALLAX_DEFAULT_GROUP_LATENCY_MS / 1000 : 0
      // Anchor against the acoustic emit cursor — startHostTimeMs is acoustic time, so startFrame
      // must be the frame the host's *speaker* will reach in `leadSeconds`, not the write cursor +
      // leadSeconds (which would put the sink hostLatency ahead of the host).
      const startFrame = Math.max(
        0,
        Math.min(buffer.length, Math.round((getHostAcousticCurrentTimeSeconds() + leadSeconds) * buffer.sampleRate))
      )
      try {
        const timeline = await window.electronAPI.parallax.publishHostStreamStart(
          buildParallaxStreamInfo(track, streamId, buffer),
          { startFrame, playbackState: playing ? 'playing' : 'paused' }
        )
        if (playing) {
          void audioEngine.publishCurrentBufferToParallax(streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        }
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    resumeHostPlayback: async (track) => {
      const stream = getActiveHostStream()
      if (!stream || !track || stream.trackPath !== track.path) return null
      const timeline = buildHostTimeline(
        stream,
        'playing',
        getHostFrameForTime(stream, getHostAcousticCurrentTimeSeconds()),
        stream.groupLatencyMs
      )
      try {
        await publishHostTimeline(timeline)
        void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    prepareHostSeek: async (timeSeconds, playing) => {
      const stream = getActiveHostStream()
      if (!stream) return null
      const timeline = buildHostTimeline(
        stream,
        playing ? 'playing' : 'paused',
        getHostFrameForTime(stream, timeSeconds),
        playing ? stream.groupLatencyMs : 0
      )
      try {
        await publishHostTimeline(timeline)
        if (playing) {
          void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        } else {
          audioEngine.cancelParallaxHostPublishing()
        }
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    pauseHostPlayback: async () => {
      const stream = getActiveHostStream()
      if (!stream) return
      const timeline = buildHostTimeline(
        stream,
        'paused',
        getHostFrameForTime(stream, getHostAcousticCurrentTimeSeconds())
      )
      audioEngine.cancelParallaxHostPublishing()
      try {
        await publishHostTimeline(timeline)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    stopHostPlayback: async () => {
      audioEngine.cancelParallaxHostPublishing()
      stopHostEmitAnchorPublish()
      try {
        await window.electronAPI.parallax.stopHostStream()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    }
  }
})
