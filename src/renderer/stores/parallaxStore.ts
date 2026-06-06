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
  PARALLAX_HOST_EMIT_ANCHOR_STALE_MS,
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
  // §14.1.1. Host-side action: persists trim per (sinkId, outputDeviceId) and pushes to the sink.
  setSinkTrim: (sinkId: string, outputDeviceId: string, outputDeviceLabel: string | null, advanceMs: number) => Promise<void>
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
// Phase 2B §13.4 follow-up — running count of hard syncs (both rate-corrector and rebuffer-resume)
// since this sink session started. Per-tick `syncEvent` marker is built locally in the telemetry
// tick; the count persists so each CSV row's `hard_sync_count` is monotonic over the session.
// Reset only on sink-event 'stop' (full disconnect), not on stream-start — they accumulate across
// track changes within a sink session, which is what the rig debug pass actually wants to see.
let hostEmitHardSyncCount = 0
// Read once at module load via preload. Default ON since 2B validation (share §13.5 retired the
// original opt-in flag); the kill switch is PARALLAX_DISABLE_HOST_PREDICTOR=1 on the sink, which
// falls back to the Phase-1 nominal-timeline loop. Preload owns the env read + resolution; this
// const is just the resolved boolean.
const PARALLAX_USE_HOST_PREDICTOR: boolean =
  typeof window !== 'undefined' && Boolean(window.electronAPI?.parallax?.useHostPredictor)

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

// Phase 2B (§13.2). The drift signal the loop will steer against this tick, plus a marker for which
// branch produced it. `loopSource: 'hold'` means no usable drift signal (the three pre-check holds
// below); `'phase1'` means the nominal-timeline fallback formula ran; `'predictor'` is set by the
// caller after upgrading a 'phase1' return value when the §6 gates pass.
type ParallaxRateCorrection = {
  driftFrames: number
  playbackRatePpm: number
  loopSource: 'predictor' | 'phase1' | 'hold'
}

function computeRateCorrectionPpm(
  timeline: ParallaxTimelineState,
  stream: ParallaxStreamInfo,
  snapshot: { currentFrame: number; currentFrameAtWallMs: number },
  status: ParallaxStatus | null,
  sinkLatencyMs: number
): ParallaxRateCorrection {
  if (timeline.playbackState !== 'playing') {
    return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
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
    return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
  }
  // Drift only makes sense once the worklet has reported at least one timestamped position. Before
  // that the formula would compare a frame=0 cursor against a positive expected frame and produce a
  // spurious large drift on the very first tick.
  if (!Number.isFinite(snapshot.currentFrameAtWallMs) || snapshot.currentFrameAtWallMs <= 0) {
    return { driftFrames: 0, playbackRatePpm: 0, loopSource: 'hold' }
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
    playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2),
    loopSource: 'phase1'
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

  // Phase 2B (share §6). Evaluate the predictor-control gates. Telemetry is published regardless
  // of whether these pass — `phase2_drift_frames` always reflects the predictor's view, so we can
  // see in the CSV exactly when the gates flip. These gates are the decision *whether the control
  // loop is allowed to consume that signal*, not whether to compute it.
  //
  // The existing `getHostEmitPredictorTelemetry` already enforces two of the five §6 conditions
  // implicitly (returns empty when `hostTimeAtReportMs === null` covers "no valid clockOffsetMs",
  // and when `hostEmitPredictor === null` covers "<3 anchors"). This helper checks the remaining
  // three explicitly so the call site is self-documenting.
  const hostEmitPredictorGatesPass = (
    hostTimeAtReportMs: number | null,
    activeStreamId: string | null,
    hostRefRatePpm: number | null,
    hostRefAgeMs: number | null
  ): boolean => {
    if (hostTimeAtReportMs === null) return false                  // no clockOffsetMs
    if (!hostEmitPredictor) return false                            // <3 anchors / not fit
    if (hostEmitAnchorStreamId === null) return false               // stream lifecycle
    if (activeStreamId !== hostEmitAnchorStreamId) return false     // streamId match
    if (hostRefAgeMs === null) return false
    if (hostRefAgeMs > PARALLAX_HOST_EMIT_ANCHOR_STALE_MS) return false // <1s old
    if (hostRefRatePpm === null) return false
    if (Math.abs(hostRefRatePpm) > PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM) return false // ±2000 ppm
    return true
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
      const phase1Correction = computeRateCorrectionPpm(timeline, stream, snapshot, status, sinkLatencyMs)

      // Phase 2A predictor telemetry — moved AHEAD of the snap decision so 2B can upgrade the
      // correction with it. Anchors live in host-wall; `currentFrameAtWallMs` is sink-wall — map
      // through the clock offset (same conversion the drift formula does). Null offset → empty
      // telemetry, which the gate evaluator translates to "predictor unavailable" → Phase-1
      // fallback for slew, and §13.1(b) no-snap.
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

      // §6 gate eval — does the predictor pass all gates this tick?
      const gatesPass = hostEmitPredictorGatesPass(
        hostTimeAtReportMs,
        stream.streamId,
        phase2.hostRefRatePpm,
        phase2.hostRefAgeMs
      )

      // Phase 2B upgrade (§13.1.a). Only when env flag is on, gates pass, and the Phase-1 path
      // itself produced a real signal (not 'hold' — which covers clock-offset missing / pre-first-
      // tick / stopped, all of which must continue to hold regardless of predictor state).
      const correction: ParallaxRateCorrection = (
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

      // Live host frame + effective lead for hard snap / rebuffer resume. PARALLAX_RESYNC_LEAD_MS
      // (60 ms) is too short for endpoints whose own latency exceeds it (Fedora ≈ 58 ms, Bluetooth
      // can be 200 ms+): scheduling would land in the past and the snap would emit late even though
      // the target frame was computed for the unextended lead. We raise the lead to at least
      // `sinkLatency + GUARD` AND advance the target frame by the same delta, so the snap stays
      // valid and the speaker emits the right frame at the right wall instant.
      //
      // Phase 2B has two modes here:
      //   - Env OFF (§13.5 baseline): Phase-1 IS the loop, not a fallback. Use the original
      //     nominal-timeline target unchanged so the env-on/env-off rig comparison is meaningful.
      //   - Env ON (§13.1.b): predictor must be both the active drift source AND able to produce a
      //     target wall-frame. Otherwise return null — Phase-1 fallback may slew, never snaps.
      const liveSnapTarget = (): { targetFrame: number; leadSeconds: number } | null => {
        const effectiveLeadMs = Math.max(PARALLAX_RESYNC_LEAD_MS, sinkLatencyMs + PARALLAX_RESYNC_GUARD_MS)
        if (!PARALLAX_USE_HOST_PREDICTOR) {
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
        if (correction.loopSource !== 'predictor') return null
        if (!hostEmitPredictor) return null
        // resolveHostNowMs() adds clockOffset, so targetWallMs is in host-wall — the same domain
        // the predictor was fit in, so intercept+slope*targetWallMs returns a host source frame.
        const targetWallMs = resolveHostNowMs(status) + effectiveLeadMs
        const predicted = hostEmitPredictor.intercept + hostEmitPredictor.slopeFramesPerMs * targetWallMs
        if (!Number.isFinite(predicted)) return null
        const targetFrame = Math.max(0, Math.min(stream.totalFrames, Math.floor(predicted)))
        return { targetFrame, leadSeconds: effectiveLeadMs / 1000 }
      }

      // §13.4 originally had a 10 s handoff-settle window here that blocked snap right after the
      // predictor's gates first passed. Removed 2026-06-04 — see share doc §13.4 follow-up. The
      // gates from §6 (min samples, slope sanity, staleness, streamId, clock offset) are the
      // safety net; a time-delay-after-validity converted snap-sized startup drift into 12 s of
      // audible mis-sync in the first sanity run.

      // Per-tick hard-sync marker. Cleared each tick; set to 'snap' or 'rebuffer_snap' when the
      // corresponding branch fires `resyncParallaxSinkToHostFrame` below. CSV consumers no longer
      // have to infer hard-sync from ppm=0 + snap-sized drift.
      let syncEvent: 'snap' | 'rebuffer_snap' | null = null

      let appliedPpm = 0
      if (snapshot.rebuffering) {
        // The worklet self-paused after its buffer drained. Hold (no snap/slew) until the buffer
        // covers the live host frame by a safe margin, then re-anchor to live and resume — so the
        // cursor never free-runs into empty data (the underrun spiral that previously killed the sink).
        // §13.1(b): rebuffer resume needs a snap; without a predictor target there's no snap, so
        // hold — we're not playing anyway, and re-anchoring with nominal-timeline would defeat the
        // predictor-only-snap rule.
        snapPendingTicks = 0
        const marginFrames = Math.floor((PARALLAX_REBUFFER_MARGIN_MS * stream.sampleRate) / 1000)
        const snap = liveSnapTarget()
        if (
          snap !== null &&
          timeline.playbackState === 'playing' &&
          hasOffset &&
          snapshot.bufferedEndFrame >= snap.targetFrame + marginFrames
        ) {
          audioEngine.resyncParallaxSinkToHostFrame(snap.targetFrame, snap.leadSeconds)
          lastHardSyncAtMs = now
          hostEmitHardSyncCount += 1
          syncEvent = 'rebuffer_snap'
        }
      } else {
        const decision = decideParallaxSinkCorrection(correction.driftFrames, stream.sampleRate)
        // Compute snap target up front so we can pivot on it without recomputing.
        const snap = decision.mode === 'snap' ? liveSnapTarget() : null
        // Distinguish "drift is snap-sized" (controls slew rate) from "snap is allowed to fire
        // THIS tick" (controls actual hard-sync). decideParallaxSinkCorrection returns ppm=0 for
        // snap mode on the assumption that we'll snap instead of slew — but when snap is
        // suppressed (handoff settle, predictor unavailable, cooldown, confirm window), we must
        // still slew at max so the known-large drift discharges instead of sitting at hold.
        const isSnapSizedDrift = decision.mode === 'snap'
        // Snap eligibility: env-off uses classic Phase-1 gates so the rig A/B baseline is
        // preserved (§13.5). Env-on requires the predictor to actually be driving the loop
        // (§13.1(b)) — Phase-1 fallback may slew but never snaps in env-on. snap !== null covers
        // both modes (env-off returns a nominal target; env-on returns null whenever the predictor
        // can't produce a target). No time-based settle: if §6 says the predictor is valid, the
        // snap path is allowed to fire immediately.
        const canSnap = isSnapSizedDrift
          && timeline.playbackState === 'playing'
          && hasOffset
          && snap !== null
          && (
            !PARALLAX_USE_HOST_PREDICTOR
            || correction.loopSource === 'predictor'
          )
        snapPendingTicks = canSnap ? snapPendingTicks + 1 : 0
        // For snap-sized drift, always slew at max — covers confirm window, cooldown, handoff
        // settle, and env-on-but-fallback. Otherwise the decision's slew/hold value is the right
        // thing.
        appliedPpm = isSnapSizedDrift
          ? clampParallaxPlaybackRatePpm(-correction.driftFrames * 2)
          : decision.playbackRatePpm
        if (
          canSnap &&
          snap !== null &&
          snapPendingTicks >= PARALLAX_SNAP_CONFIRM_TICKS &&
          now - lastHardSyncAtMs > PARALLAX_RESYNC_MIN_INTERVAL_MS
        ) {
          audioEngine.resyncParallaxSinkToHostFrame(snap.targetFrame, snap.leadSeconds)
          lastHardSyncAtMs = now
          snapPendingTicks = 0
          appliedPpm = 0
          hostEmitHardSyncCount += 1
          syncEvent = 'snap'
        } else {
          audioEngine.setParallaxSinkPlaybackRate(appliedPpm)
        }
      }
      const sinkLatency = audioEngine.getOutputLatencyMetrics()
      // §14.1.1 / §15.4 / §15.11(b). Output device identity resolution: audio settings primary,
      // AudioContext.sinkId fallback. Settings reflect user intent and survive context restarts;
      // sinkId is brittle for the default route ('') and pre-context initialization. We report
      // both id and label so the host UI can render "Trim for <label>" without re-resolving.
      const audioSettings = useAudioSettingsStore.getState()
      const selectedDeviceId = audioSettings.selectedDeviceId.trim()
      let outputDeviceId: string | null
      let outputDeviceLabel: string | null
      if (selectedDeviceId) {
        outputDeviceId = selectedDeviceId
        outputDeviceLabel = audioSettings.availableDevices.find((d) => d.deviceId === selectedDeviceId)?.label ?? null
      } else {
        const fallback = audioEngine.getOutputDeviceId()
        outputDeviceId = fallback || null
        outputDeviceLabel = null
      }
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
        phase2DriftFrames: phase2.phase2DriftFrames,
        loopSource: correction.loopSource,
        syncEvent,
        hardSyncCount: hostEmitHardSyncCount,
        outputDeviceId,
        outputDeviceLabel,
        appliedAdvanceMs: audioEngine.getParallaxSinkAdvanceMs()
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
    // §14.1.1 / §15.11(a). Trim updates are targeted by sinkId — a sink ignores trims meant for
    // other sinks. Apply unconditionally: must NOT wait on clockOffsetMs (a push that arrives mid
    // clock-priming still has to land), must NOT reach the timeline/pending-chunk branches below
    // (the variant has no `event.timeline`, the access downstream would crash). Same early-return
    // shape as host-emit-anchor.
    if (event.type === 'sink-trim-update') {
      const ownSinkId = get().status?.sink.sinkId
      if (ownSinkId && ownSinkId === event.sinkId) {
        audioEngine.setParallaxSinkAdvanceMs(event.advanceMs)
      }
      return
    }
    const status = get().status
    if (event.type === 'stop') {
      pendingAudioChunks = []
      audioEngine.stopParallaxSinkPlayback()
      resetHostEmitAnchors()
      hostEmitHardSyncCount = 0
      set({
        latestTimeline: null,
        pendingSinkEvent: null,
        sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
      })
      return
    }

    const timeline = event.type === 'stream-start' ? event.timeline : event.timeline
    if (event.type === 'stream-start') {
      // Phase 2B carry-forward from 2A review (share §13.3.a). The 2A code only reset the anchor
      // window on stop or implicitly on the first anchor of a new stream — leaving a one-tick gap
      // where the predictor still held stale anchors from the previous stream. Reset explicitly here
      // so the new stream starts with a clean window and a fresh handoff settle timer.
      resetHostEmitAnchors()
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

    setSinkTrim: async (sinkId, outputDeviceId, outputDeviceLabel, advanceMs) => {
      try {
        const status = await window.electronAPI.parallax.setSinkTrim(sinkId, outputDeviceId, outputDeviceLabel, advanceMs)
        if (status) applyStatus(status)
        // Refresh paired-sinks so the UI's persisted-trims snapshot picks up the new value
        // (lastSeenAt + trims array). The status update handles connectedSinks; this catches
        // the persisted side.
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
