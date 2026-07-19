import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import type { Track } from '../types/audio'
import type {
  ParallaxAudioChunk,
  ParallaxHostStreamStartInfo,
  ParallaxPairedSink,
  ParallaxHostTimelinePublishOptions,
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
  PARALLAX_HARD_SYNC_MS,
  PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM,
  PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES,
  PARALLAX_HOST_EMIT_ANCHOR_STALE_MS,
  PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES,
  PARALLAX_PREDICTOR_TRUST_TICKS,
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
  // §14.1.4 — base64 data URL of artwork for the active sink stream (hero image on Zone
  // Display). Null when no stream, no artwork available, or fetch hasn't completed yet.
  sinkActiveArtworkUrl: string | null
  // §14.1.4 — the host-assigned display name for this speaker, pushed via `sink-name-update` on
  // connect + rename. Null until the host pushes (or after disconnect). Zone Display prefers this
  // over the local zone-name override and the hostname.
  assignedSinkName: string | null
  // Whether the host is currently streaming the trim test tone (synced metronome), and which
  // single speaker it's targeted at (null = no test running). The host always plays it locally as
  // the reference; only `testToneSinkId` hears it among the sinks.
  isTestToneActive: boolean
  testToneSinkId: string | null
  init: () => Promise<void>
  refresh: () => Promise<void>
  setHostEnabled: (enabled: boolean) => Promise<ParallaxStatus | null>
  setSinkEnabled: (enabled: boolean) => Promise<ParallaxStatus | null>
  setHostPort: (port: number) => Promise<ParallaxStatus | null>
  // §14.1.2 follow-up (Codex round 2, finding 2). Manual reconnect path that goes through the
  // same renderer-side prep as `connectSink()` (Standard-mode check, ensureSubscriptions,
  // audioEngine.stop), but reuses the credential main already holds rather than receiving it
  // from the renderer. SettingsView's Connect button + the auto-reconnect bootstrap call this.
  reconnectFromPersisted: () => Promise<ParallaxStatus | null>
  disconnectSink: () => Promise<void>
  revokePairedSink: (id: string) => Promise<void>
  renamePairedSink: (id: string, name: string) => Promise<ParallaxPairedSink | null>
  setSinkPlaybackEnabled: (id: string, enabled: boolean) => Promise<void>
  setAllSinksPlaybackEnabled: (enabled: boolean) => Promise<void>
  // §14.1.1. Host-side action: persists trim per (sinkId, outputDeviceId) and pushes to the sink.
  setSinkTrim: (sinkId: string, outputDeviceId: string, outputDeviceLabel: string | null, advanceMs: number) => Promise<void>
  revokeAllPairedSinks: () => Promise<number>
  clearHostPresenceCache: (sinkId?: string) => Promise<ParallaxStatus | null>
  resetToDefaults: () => Promise<ParallaxStatus | null>
  shouldDelayHostPlayback: (track: Track | null | undefined) => boolean
  handleHostPlaybackAudienceLost: () => void
  prepareHostPlayback: (track: Track) => Promise<ParallaxTimelineState | null>
  startHostStreamForCurrentPlayback: (
    track: Track | null | undefined,
    playing: boolean
  ) => Promise<ParallaxTimelineState | null>
  resumeHostPlayback: (track: Track | null | undefined) => Promise<ParallaxTimelineState | null>
  // §21 Gapless sink handoff (host control surface).
  publishHostNextStream: (nextTrack: Track | null | undefined) => Promise<void>
  cancelHostNextStream: () => Promise<void>
  promoteHostNextStream: (currentTrack: Track | null | undefined) => Promise<void>
  prepareHostSeek: (timeSeconds: number, playing: boolean) => Promise<ParallaxTimelineState | null>
  pauseHostPlayback: () => Promise<void>
  stopHostPlayback: () => Promise<void>
  startTestTone: (targetSinkId?: string) => Promise<void>
  stopTestTone: () => Promise<void>
}

let statusUnsubscribe: (() => void) | null = null
let eventUnsubscribe: (() => void) | null = null
let audioChunkUnsubscribe: (() => void) | null = null
let sinkPairedUnsubscribe: (() => void) | null = null
let telemetryTimer: number | null = null
let pendingAudioChunks: ParallaxAudioChunk[] = []
// §21 Gapless sink handoff. Pre-announce the next stream this many ms BEFORE the track boundary
// (rather than at prebuffer-complete, which can be ~10s+ early). The crossover boundary is a nominal
// projection, so a shorter projection window means less nominal-vs-real clock drift at the seam.
// Kept comfortably above the host chunk lookahead (3s) so the sink still has lead time to pre-buffer.
const PARALLAX_NEXT_STREAM_LEAD_MS = 4000
// §21 Seam trim. A fixed amount (ms) to advance the staged crossover EARLIER than the projected
// boundary. TUNING DIAL: higher = crossover starts earlier. ASYMMETRY: too EARLY = the two tracks
// OVERLAP (worse artifact); too LATE = a tiny gap (more forgiving) — so favor "just barely late",
// never overshoot early. By-ear (2026-06-27): the residual seam wobble is at the jitter floor (the
// worklet starts on 128-frame render quanta, ~2.9ms of non-deterministic wobble per transition), so
// a static trim can't reliably null it — kept at 0 to sit on the safe slightly-late side. Drift is
// handled separately by PARALLAX_NEXT_STREAM_LEAD_MS.
const PARALLAX_NEXT_STREAM_SEAM_TRIM_MS = 0
let nextStreamPublishTimer: ReturnType<typeof setTimeout> | null = null
// Trim test tone: after a cold start both ends report ~0 output latency until audio has flowed, so
// the first anchor lands at a wrong offset. We let it play for this long, then restart once so the
// host reference and the sink re-join both anchor with real (warm) latency.
let testToneWarmRestartTimer: ReturnType<typeof setTimeout> | null = null
const TEST_TONE_WARM_RESTART_MS = 2500
// §14.1.4 — sink Zone Display artwork cache. Keyed by trackId so cross-stream re-resolves of
// the same track don't re-hit the host. Module-level so it survives ZoneDisplay remounts (the
// Library escape unmounts and remounts the surface). Cap loosely to avoid unbounded growth.
const SINK_ARTWORK_CACHE_CAP = 64
const sinkArtworkByTrackId = new Map<string, string>()
let sinkArtworkInFlightStreamId: string | null = null
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
// §17 round 2 (Codex finding 1). True when `cancelParallaxHostPublishing()` was called while
// `activeStream` was still in main's cache AND no playback sinks were active — i.e. the host went
// from "publishing to sinks" to "tracking only" because all sinks left. On the next sink-connect
// we need to restart publishing for the existing stream instead of early-returning. Set true in
// the no-sink tracking paths (resumeHostPlayback / prepareHostSeek / pauseHostPlayback when
// `activePlaybackSinkCount === 0`) and false whenever publishCurrentBufferToParallax fires. Reset on
// stream lifecycle events (new stream, stop).
//
// §17 round 3 (Codex correctness cleanup). The pause-with-sinks case must NOT latch this —
// paused-with-sinks cancels chunk flow legitimately (host stopped emitting) but doesn't need
// "restart publishing" until the user resumes, and a second sink joining the paused host would
// see flag=true and trigger a spurious republish-timeline that the predictor would treat as a
// timeline discontinuity reset. Only the no-sink transitions arm this.
let hostPublishingCanceledForActiveStream = false
// §17 round 4 (Codex). Serialization chain for non-anchor sink events so a fresh `timeline`
// arriving while a preceding `stream-start` is mid `loadParallaxSinkStream(...)` can't apply
// first. Before this chain: stream-start's await yielded the microtask, the next timeline
// event's handler ran straight through, applied to a non-loaded sink (no-op), advanced
// `latestTimeline`; then stream-start's await resolved and its (stale) timeline overwrote.
// Symptom was mid-join misalignment that pause/play later "corrected" by sending a fresh
// timeline post-load. Anchors stay on the sync fast path — they're 5 Hz and have their own
// rolling-window semantics, ordering against stream-start doesn't matter.
let sinkEventChain: Promise<void> = Promise.resolve()
// §17.2(c). Snap fail-closed trust-gate state. `predictorSnapTrusted` is the latch — false until
// both the sample-count condition (≥TRUSTED_SAMPLES anchors in window) AND the stability
// condition (≥TRUST_TICKS consecutive ticks of |phase2_drift| under snap threshold) are met.
// `predictorTrustTickCount` is the consecutive-tick counter; reset to 0 whenever a tick fails
// the stability condition. Both reset to false/0 on every anchor reset (new stream OR same-
// stream timeline discontinuity) so each warm-up has to re-earn snap eligibility.
let predictorSnapTrusted = false
let predictorTrustTickCount = 0
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
): ParallaxHostStreamStartInfo {
  return {
    streamId,
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    sampleRate: buffer.sampleRate,
    channels: Math.max(1, Math.min(8, buffer.numberOfChannels)),
    durationSeconds: buffer.duration,
    totalFrames: buffer.length,
    normalizationGainDb: audioEngine.getNormalizationGainDb(),
    normalizationMode: audioEngine.getNormalizationMode()
  }
}

// §21 Gapless sink handoff. Like buildParallaxStreamInfo but stamps the NEXT track's normalization
// (the pre-buffered track's replay gain, not the currently-playing one) so the sink stages it at the
// correct loudness.
function buildParallaxNextStreamInfo(
  track: Track,
  streamId: string,
  buffer: AudioBuffer
): ParallaxHostStreamStartInfo {
  const normalization = audioEngine.getNextNormalization()
  return {
    ...buildParallaxStreamInfo(track, streamId, buffer),
    normalizationGainDb: normalization.gainDb,
    normalizationMode: normalization.mode
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
    // §17.2(c). Each warm-up has to re-earn snap eligibility. Slew is unaffected — only the
    // snap path is fail-closed, so the loop still tracks but won't yank cursor by thousands
    // of frames on a settling fit.
    predictorSnapTrusted = false
    predictorTrustTickCount = 0
  }

  // Host-side: publish one anchor (5 Hz timer body). Stops itself only when there's no active
  // host stream at all. Does NOT use `getActiveHostStream()` because that gates on
  // `activePlaybackSinkCount > 0`, which would strand the timer if every zone became inactive
  // — a new sink joining later would then never receive anchors until host playback restarted.
  const publishOneHostEmitAnchor = (): void => {
    const hostStatus = get().status?.host
    const hostStream = hostStatus?.active ? hostStatus.activeStream ?? null : null
    if (!hostStream) {
      stopHostEmitAnchorPublish()
      return
    }
    if ((hostStatus?.activePlaybackSinkCount ?? 0) <= 0) return
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
    // §14.1.1 follow-up (Codex 2026-06-06). Symmetric ±STALE_MS bound. Same reasoning either
    // direction: anchors arrive every 200 ms, so an age outside ±1 s implies either the host
    // stopped emitting (positive) or the clock-offset mapping is fundamentally wrong (negative).
    // Small negative ages (single-digit to tens of ms) are normal clock-noise from the sink-wall
    // → host-wall mapping; the prior bound `> STALE_MS` admitted arbitrarily-large negative ages,
    // and the §14.1.1 acceptance run had a benign −13.8 ms tick that confirmed the noise floor.
    // Earlier debug sessions saw larger negative ages fire bogus predictor ticks.
    if (Math.abs(hostRefAgeMs) > PARALLAX_HOST_EMIT_ANCHOR_STALE_MS) return false
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

  // §17 — broadcast-side getter: "are there sinks we need to broadcast to right now?". Use for
  // anything that *publishes* (chunks, anchors, latency reports) — those legitimately need an
  // active receiver. Pause/seek/resume must NOT use this — see `getActiveHostStreamForControl`.
  const getActiveHostStream = (): ParallaxStreamInfo | null => {
    const status = get().status
    if (!status?.host.active || status.host.activePlaybackSinkCount <= 0) return null
    return status.host.activeStream
  }

  // §17 — control-side getter: "does the host have an active Parallax stream whose timeline
  // needs to track local playback?" NO connected-sink gate. Use for prepareHostSeek /
  // pauseHostPlayback / resumeHostPlayback so the cached timeline keeps tracking local state
  // even when zero sinks are listening. Otherwise a sink that disconnects, then host pauses /
  // seeks / resumes, then sink reconnects → `/join` extrapolates the stale frozen timeline
  // forward by wall delta and the rejoining sink lands ~5.7 s ahead of host's true emit
  // (the staircase-snap bug surfaced 2026-06-06). See share §17.1 for the CSV diagnosis.
  const getActiveHostStreamForControl = (): ParallaxStreamInfo | null => {
    const status = get().status
    if (!status?.host.active) return null
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

  // §21 Gapless sink handoff. The actual next-stream announce — computes the boundary FRESH at call
  // time (so deferring it close to the boundary shrinks the projection window) and starts streaming
  // the next track's audio to sinks. Called either immediately or from the deferral timer below.
  const doPublishHostNextStream = async (nextTrack: Track): Promise<void> => {
    if (!get().shouldDelayHostPlayback(nextTrack)) return
    const buffer = audioEngine.getNextAudioBuffer()
    const currentBuffer = audioEngine.getAudioBuffer()
    if (!buffer || !currentBuffer) return
    const remainingSec = Math.max(0, currentBuffer.duration - getHostAcousticCurrentTimeSeconds())
    const boundaryHostTimeMs = localNowMs() + remainingSec * 1000 - PARALLAX_NEXT_STREAM_SEAM_TRIM_MS
    const streamId = createStreamId(nextTrack)
    ensureTelemetry()
    try {
      const timeline = await window.electronAPI.parallax.publishHostNextStreamStart(
        buildParallaxNextStreamInfo(nextTrack, streamId, buffer),
        { startHostTimeMs: boundaryHostTimeMs, startFrame: 0, artworkHash: nextTrack.artworkHash }
      )
      void audioEngine.publishNextBufferToParallax(streamId, timeline).catch((error) => {
        set({ errorMessage: toErrorMessage(error) })
      })
    } catch (error) {
      set({ errorMessage: toErrorMessage(error) })
    }
  }

  const clearNextStreamPublishTimer = (): void => {
    if (nextStreamPublishTimer) {
      clearTimeout(nextStreamPublishTimer)
      nextStreamPublishTimer = null
    }
  }

  const publishHostTimeline = async (
    timeline: ParallaxTimelineState,
    options?: ParallaxHostTimelinePublishOptions
  ): Promise<ParallaxTimelineState> => {
    await window.electronAPI.parallax.publishHostTimeline(timeline, options)
    return timeline
  }

  const cancelTestToneWarmRestart = (): void => {
    if (testToneWarmRestartTimer) {
      clearTimeout(testToneWarmRestartTimer)
      testToneWarmRestartTimer = null
    }
  }

  // Start (or restart) the metronome stream + host-local reference for the trim test tone.
  const startTestToneStream = async (targetSinkId?: string): Promise<boolean> => {
    try {
      const specs = await audioEngine.prepareParallaxTestTone()
      const streamId = `parallax-test-${Date.now()}`
      const info: ParallaxHostStreamStartInfo = {
        streamId,
        trackId: 'parallax-test-tone',
        title: 'Parallax test tone',
        artist: 'Astra',
        album: 'Setup',
        sampleRate: specs.sampleRate,
        channels: specs.channels,
        durationSeconds: specs.durationSeconds,
        totalFrames: specs.totalFrames,
        normalizationGainDb: 0,
        normalizationMode: 'off'
      }
      const timeline = await window.electronAPI.parallax.publishHostStreamStart(info, {
        startFrame: 0,
        playbackState: 'playing',
        targetSinkId
      })
      await audioEngine.playTestToneOnParallaxTimeline(timeline)
      void audioEngine.publishTestToneToParallax(streamId, timeline).catch((error) => {
        set({ errorMessage: toErrorMessage(error) })
      })
      return true
    } catch (error) {
      set({ errorMessage: toErrorMessage(error) })
      return false
    }
  }

  const teardownTestToneStream = async (): Promise<void> => {
    audioEngine.stopParallaxTestTone()
    try {
      await window.electronAPI.parallax.stopHostStream()
    } catch {
      // best-effort; a subsequent stream-start replaces the slot anyway
    }
  }

  const ensureTelemetry = () => {
    if (telemetryTimer !== null) return
    telemetryTimer = window.setInterval(() => {
      const status = get().status
      // Phase 0 diagnostics: when acting as host with a connected sink, report our own output-latency
      // signals to the main process so the host-side telemetry CSV can log both ends in one row.
      if (status?.host.active && status.host.activePlaybackSinkCount > 0) {
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
        // §17.2(c). Update the predictor trust latch BEFORE evaluating canSnap. Stability
        // condition: |phase2_drift| under the snap threshold (≈1764 frames at 44.1k) for
        // TRUST_TICKS consecutive ticks while on the predictor branch. Sample-count condition:
        // anchor window has ≥TRUSTED_SAMPLES entries. Once both hit, the latch flips and stays
        // true until the next anchor reset. Slew is unaffected — only the snap path consults
        // the latch. This is the safety net against the staircase-snap bug from §17.1: a
        // settling fit reports huge phase2_drift, the loop tries to snap, but the latch is
        // still false so the snap is suppressed and slew handles the drift down instead.
        const hardSyncFrames = (PARALLAX_HARD_SYNC_MS / 1000) * stream.sampleRate
        const phase2DriftAbs = phase2.phase2DriftFrames !== null ? Math.abs(phase2.phase2DriftFrames) : Infinity
        const stabilityTickOk = correction.loopSource === 'predictor' && phase2DriftAbs < hardSyncFrames
        predictorTrustTickCount = stabilityTickOk ? predictorTrustTickCount + 1 : 0
        if (!predictorSnapTrusted) {
          if (
            hostEmitAnchors.length >= PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES &&
            predictorTrustTickCount >= PARALLAX_PREDICTOR_TRUST_TICKS
          ) {
            predictorSnapTrusted = true
          }
        }

        // Snap eligibility: env-off uses classic Phase-1 gates so the rig A/B baseline is
        // preserved (§13.5). Env-on requires the predictor to actually be driving the loop
        // (§13.1(b)) — Phase-1 fallback may slew but never snaps in env-on. snap !== null covers
        // both modes (env-off returns a nominal target; env-on returns null whenever the predictor
        // can't produce a target). §17 adds the trust latch: env-on snaps require the fit to
        // have proven itself per §17.2(c).
        const canSnap = isSnapSizedDrift
          && timeline.playbackState === 'playing'
          && hasOffset
          && snap !== null
          && (
            !PARALLAX_USE_HOST_PREDICTOR
            || (correction.loopSource === 'predictor' && predictorSnapTrusted)
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
        // §17 round 4 (Codex). Chain non-anchor events so a fresh `timeline` arriving while a
        // preceding `stream-start` is mid-async-load can't slip past and apply first. See the
        // `sinkEventChain` declaration for the race description. `.catch()` returns void so the
        // chain progresses through errors — losing one event's error surface is better than
        // jamming all subsequent events.
        sinkEventChain = sinkEventChain
          .then(() => handleSinkEvent(event))
          .catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
      })
    }

    if (!audioChunkUnsubscribe) {
      audioChunkUnsubscribe = window.electronAPI.parallax.onAudioChunk((chunk) => {
        if (audioEngine.getParallaxSinkSnapshot().streamId === chunk.streamId) {
          audioEngine.appendParallaxSinkAudioChunk(chunk)
          set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
          applyChunkTimelineIfNeeded(chunk)
          return
        }
        // §21 — route to the staged next stream if it's the one pre-buffering for the gapless handoff.
        if (audioEngine.getStagedParallaxSinkStreamId() === chunk.streamId) {
          audioEngine.appendParallaxNextSinkAudioChunk(chunk)
          return
        }
        // Unknown/early chunk — buffer until its stream-start / next-stream-start loads a node.
        pendingAudioChunks = [...pendingAudioChunks, chunk].slice(-256)
      })
    }

    if (!sinkPairedUnsubscribe) {
      sinkPairedUnsubscribe = window.electronAPI.parallax.onSinkPaired(() => {
        if (get().status?.sink.connected) return
        void get().reconnectFromPersisted().catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
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

  // §21 Gapless sink handoff (sink side). Staged stream's info + timeline, held from next-stream-start
  // so the trackId is available for Zone Display artwork at promote time and so promote can mark the
  // promoted stream as already-anchored (preventing a re-anchor restart at the seam). `scheduled`
  // tracks whether the crossover was actually scheduled (needs a primed clock offset).
  let stagedSinkStream: ParallaxStreamInfo | null = null
  let stagedSinkTimeline: ParallaxTimelineState | null = null
  let stagedSinkScheduled = false

  // Resolve + apply Zone Display artwork for a stream (cache-hit instant; else main-side fetch).
  // Mirrors the stream-start artwork flow; reused for the promoted next stream.
  const loadSinkArtworkForStream = (stream: ParallaxStreamInfo): void => {
    const trackId = stream.trackId
    const streamIdAtRequest = stream.streamId
    const cachedArtwork = trackId ? sinkArtworkByTrackId.get(trackId) ?? null : null
    if (cachedArtwork) {
      set({ sinkActiveArtworkUrl: cachedArtwork })
      return
    }
    set({ sinkActiveArtworkUrl: null })
    sinkArtworkInFlightStreamId = streamIdAtRequest
    void window.electronAPI.parallax.fetchSinkArtwork(streamIdAtRequest)
      .then((dataUrl) => {
        if (sinkArtworkInFlightStreamId !== streamIdAtRequest) return
        sinkArtworkInFlightStreamId = null
        if (!dataUrl) return
        if (trackId) {
          if (sinkArtworkByTrackId.size >= SINK_ARTWORK_CACHE_CAP) {
            const firstKey = sinkArtworkByTrackId.keys().next().value
            if (firstKey !== undefined) sinkArtworkByTrackId.delete(firstKey)
          }
          sinkArtworkByTrackId.set(trackId, dataUrl)
        }
        if (audioEngine.getParallaxSinkSnapshot().streamId === streamIdAtRequest) {
          set({ sinkActiveArtworkUrl: dataUrl })
        }
      })
      .catch(() => {
        if (sinkArtworkInFlightStreamId === streamIdAtRequest) sinkArtworkInFlightStreamId = null
      })
  }

  // Pre-load the staged next stream + schedule its boundary crossover. Inert unless we're a connected
  // sink already playing a stream (loadParallaxNextSinkStream no-ops otherwise).
  const handleNextStreamStart = (
    event: Extract<ParallaxTimelineEvent, { type: 'next-stream-start' }>
  ): void => {
    if (audioEngine.getStagedParallaxSinkStreamId() !== event.stream.streamId) {
      audioEngine.loadParallaxNextSinkStream(event.stream)
    }
    if (audioEngine.getStagedParallaxSinkStreamId() !== event.stream.streamId) return // couldn't stage
    stagedSinkStream = event.stream
    stagedSinkTimeline = event.timeline
    // Drain any next-stream chunks that arrived before the staged node existed.
    const staged = pendingAudioChunks.filter((chunk) => chunk.streamId === event.stream.streamId)
    pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
    for (const chunk of staged) {
      audioEngine.appendParallaxNextSinkAudioChunk(chunk)
    }
    // Schedule the crossover at the future boundary (needs a primed clock offset — a sink mid-playback
    // already has one; if not yet primed, the boundary promote still falls back gracefully).
    const offsetMs = get().status?.sink.clockOffsetMs
    if (offsetMs !== null && offsetMs !== undefined) {
      audioEngine.scheduleParallaxNextSinkStart(event.timeline, offsetMs, 0)
      stagedSinkScheduled = true
    } else {
      stagedSinkScheduled = false
    }
  }

  const clearStagedSinkStream = (): void => {
    stagedSinkStream = null
    stagedSinkTimeline = null
    stagedSinkScheduled = false
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
    //
    // §14.1.1 follow-up (Codex round 3, 2026-06-06). Also drop trims targeted at a different
    // output device than the sink is currently using — guards against the race where the user
    // moves the slider, host pushes the new value keyed to device A, then the sink switches to
    // device B before the SSE event arrives. Resolved the same way as outgoing telemetry:
    // audioSettings.selectedDeviceId primary, AudioEngine.getOutputDeviceId() fallback.
    if (event.type === 'sink-trim-update') {
      const ownSinkId = get().status?.sink.sinkId
      if (!ownSinkId || ownSinkId !== event.sinkId) return
      const audioSettings = useAudioSettingsStore.getState()
      const selectedDeviceId = audioSettings.selectedDeviceId.trim()
      const currentOutputDeviceId = selectedDeviceId || audioEngine.getOutputDeviceId() || 'default'
      if (event.outputDeviceId !== currentOutputDeviceId) return
      audioEngine.setParallaxSinkAdvanceMs(event.advanceMs)
      return
    }
    // §14.1.4. Host-assigned name push — targeted by sinkId, no timeline payload (early-return like
    // the trim branch above). Drives the Zone Display heading.
    if (event.type === 'sink-name-update') {
      const ownSinkId = get().status?.sink.sinkId
      if (!ownSinkId || ownSinkId !== event.sinkId) return
      const name = event.name.trim() || null
      if (name !== get().assignedSinkName) set({ assignedSinkName: name })
      return
    }
    if (event.type === 'sink-playback-update') {
      // Main mirrors this into status.sink.playbackEnabled before forwarding the event. Keep this
      // control-only variant out of the timeline/clock-offset handling below.
      return
    }
    const status = get().status
    if (event.type === 'stop') {
      pendingAudioChunks = []
      audioEngine.stopParallaxSinkPlayback()
      clearStagedSinkStream()
      resetHostEmitAnchors()
      hostEmitHardSyncCount = 0
      sinkArtworkInFlightStreamId = null
      set({
        latestTimeline: null,
        pendingSinkEvent: null,
        sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
        sinkActiveArtworkUrl: null
      })
      return
    }

    // §21 Gapless sink handoff. These variants drive the staged next-stream node (pre-load /
    // crossover / cancel) and — for cancel/promote — carry no `event.timeline`, so they MUST
    // early-return before the shared `event.timeline` access below (same discipline as the
    // trim/name/stop branches).
    if (event.type === 'next-stream-start') {
      handleNextStreamStart(event)
      return
    }
    if (event.type === 'next-stream-cancel') {
      pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.streamId)
      if (audioEngine.getStagedParallaxSinkStreamId() === event.streamId) {
        audioEngine.clearParallaxNextSink()
      }
      if (stagedSinkStream?.streamId === event.streamId) clearStagedSinkStream()
      return
    }
    if (event.type === 'next-stream-promote') {
      // The acoustic crossover already happened via the staged node's scheduled start; promote the
      // bookkeeping (active slot + master normalization + Zone Display artwork).
      if (audioEngine.getStagedParallaxSinkStreamId() === event.streamId) {
        resetHostEmitAnchors()
        hostEmitHardSyncCount = 0
        const wasScheduled = stagedSinkScheduled
        const promotedTimeline = stagedSinkTimeline
        audioEngine.promoteParallaxNextSink()
        set({
          // §21 If the staged crossover was scheduled, it's already playing on its own anchor — mark
          // the promoted stream as already-anchored so the post-promote re-fetched chunks (which
          // resume from ~frame 0 at the boundary) do NOT re-anchor it and RESTART the new track at
          // the seam. If it wasn't scheduled (no clock offset), leave it null so the chunk-driven
          // anchor starts it.
          latestTimeline: wasScheduled ? promotedTimeline : null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
        })
        if (stagedSinkStream?.streamId === event.streamId) {
          loadSinkArtworkForStream(stagedSinkStream)
        }
      }
      if (stagedSinkStream?.streamId === event.streamId) clearStagedSinkStream()
      return
    }

    const timeline = event.type === 'stream-start' ? event.timeline : event.timeline
    if (event.type === 'stream-start') {
      // Phase 2B carry-forward from 2A review (share §13.3.a). The 2A code only reset the anchor
      // window on stop or implicitly on the first anchor of a new stream — leaving a one-tick gap
      // where the predictor still held stale anchors from the previous stream. Reset explicitly here
      // so the new stream starts with a clean window and a fresh handoff settle timer.
      resetHostEmitAnchors()
      // §21 A fresh stream supersedes any staged gapless handoff (manual change / non-gapless boundary).
      clearStagedSinkStream()
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

      // §14.1.4 / §19.18(e) — artwork resolution. Cache-hit by trackId is instant; otherwise
      // fire a main-side fetch. Stale-fetch guard: only apply the result if the stream that
      // requested it is still the active one. Failures are silent (Zone Display placeholder).
      const trackId = event.stream.trackId
      const streamIdAtRequest = event.stream.streamId
      const cachedArtwork = trackId ? sinkArtworkByTrackId.get(trackId) ?? null : null
      if (cachedArtwork) {
        set({
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          sinkActiveArtworkUrl: cachedArtwork
        })
      } else {
        set({
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          sinkActiveArtworkUrl: null
        })
        sinkArtworkInFlightStreamId = streamIdAtRequest
        void window.electronAPI.parallax.fetchSinkArtwork(streamIdAtRequest)
          .then((dataUrl) => {
            if (sinkArtworkInFlightStreamId !== streamIdAtRequest) return
            sinkArtworkInFlightStreamId = null
            if (!dataUrl) return
            if (trackId) {
              if (sinkArtworkByTrackId.size >= SINK_ARTWORK_CACHE_CAP) {
                const firstKey = sinkArtworkByTrackId.keys().next().value
                if (firstKey !== undefined) sinkArtworkByTrackId.delete(firstKey)
              }
              sinkArtworkByTrackId.set(trackId, dataUrl)
            }
            // Only update store if the active stream still matches.
            const currentStream = get().status?.sink.activeStream
            if (currentStream?.streamId === streamIdAtRequest) {
              set({ sinkActiveArtworkUrl: dataUrl })
            }
          })
          .catch(() => {
            if (sinkArtworkInFlightStreamId === streamIdAtRequest) {
              sinkArtworkInFlightStreamId = null
            }
          })
      }
    }

    if (event.type === 'timeline' && event.resetAudio) {
      // Seek/scrub is a same-stream audio epoch reset. Drop retained chunks from the previous
      // timeline before applying the new anchor; otherwise old future chunks can make the worklet
      // jump across a hole and play from the pre-seek position.
      pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== timeline.streamId)
      audioEngine.clearParallaxSinkAudioChunks()
      resetHostEmitAnchors()
      set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
    }

    if (status?.sink.clockOffsetMs === null || status?.sink.clockOffsetMs === undefined) {
      set({ pendingSinkEvent: event })
      return
    }

    // §17.2(b). Timeline discontinuity (same stream, but the host moved the anchor — seek,
    // pause, resume) invalidates every anchor currently in the predictor's rolling window.
    // The anchors were fit against the OLD host startTime; after the discontinuity, host's
    // getOutputTimestamp() reports source-frames relative to a NEW startTime. Theil-Sen with a
    // mix of old + new anchors produces a coherent slope but an intercept that's off by the
    // wall delta — exactly the staircase-snap bug. Reset BEFORE applying the new timeline so
    // the next anchor enters a clean window.
    const previousTimeline = get().latestTimeline
    if (
      event.type === 'timeline' &&
      previousTimeline !== null &&
      (
        previousTimeline.startHostTimeMs !== timeline.startHostTimeMs ||
        previousTimeline.startFrame !== timeline.startFrame ||
        previousTimeline.playbackState !== timeline.playbackState
      )
    ) {
      resetHostEmitAnchors()
    }

    set({ latestTimeline: timeline })
    audioEngine.applyParallaxTimelineFromHostClock(timeline, status.sink.clockOffsetMs, 0)
  }

  return {
    status: null,
    pairedSinks: [],
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
    sinkActiveArtworkUrl: null,
    assignedSinkName: null,
    isTestToneActive: false,
    testToneSinkId: null,

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        // fetchAll calls ensureSubscriptions(), so by the time it resolves the renderer is
        // subscribed to host events / audio chunks and the AudioEngine is reachable.
        await fetchAll()
        // §14.1.2 follow-up (Codex round 2, finding 1+2). NOW main can safely start its retry
        // loop — the stream-start event and early audio chunks from a successful /join will
        // reach the renderer instead of being dropped on the floor. Main short-circuits if
        // there are no persisted creds or host mode is enabled (§16.12(b) precedence). We also
        // honor bitperfect mode here so auto-reconnect inherits the same Standard-only
        // precondition as the manual `connectSink` / `reconnectFromPersisted` actions —
        // otherwise a user who left Parallax sink mode active and then switched to bitperfect
        // would get a silent reconnect attempt that fails downstream.
        if (useAudioSettingsStore.getState().playbackOutputMode !== 'bitperfect') {
          await window.electronAPI.parallax.startAutoReconnect()
        }
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

    // §20 Commit 1. Sink-role toggle. Codex round 1 finding (high): main intentionally only
    // persists the toggle — the on-enable reconnect goes through `reconnectFromPersisted()` so
    // the Standard-output gate and audioEngine.stop() prep run before any sink stream lands.
    // Starting auto-reconnect from main would bypass that prep and could collide with local
    // playback or bitperfect mode.
    setSinkEnabled: async (enabled) => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.setSinkEnabled(enabled)
        applyStatus(status)
        // Off path is fully handled in main (cancel reconnect + disconnect). On path follows up
        // here, but only if a persisted credential actually exists — otherwise there's nothing
        // to reconnect to and the user has to pair first via Settings or the Commit-4 wizard.
        if (enabled && status?.sink.hasPersistedConnection) {
          set({ isLoading: false })
          return await get().reconnectFromPersisted()
        }
        return status
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

    // §14.1.2 follow-up (Codex round 2, finding 2). Mirrors connectSink's prep — Standard-mode
    // gate, ensureSubscriptions, audioEngine.stop — then triggers main to connect with the
    // credential it already holds. Used by the SettingsView Connect button and by the init()
    // auto-reconnect bootstrap. Bitperfect rejection mirrors connectSink so the user gets the
    // same error message either way.
    reconnectFromPersisted: async () => {
      if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') {
        set({ errorMessage: 'Parallax sink mode is only available in Standard output mode.' })
        return null
      }

      set({ isLoading: true })
      try {
        ensureSubscriptions()
        audioEngine.stop()
        const status = await window.electronAPI.parallax.reconnectFromPersisted()
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
        sinkArtworkInFlightStreamId = null
        set({
          latestTimeline: null,
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          errorMessage: '',
          sinkActiveArtworkUrl: null,
          assignedSinkName: null
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

    renamePairedSink: async (id, name) => {
      try {
        const renamed = await window.electronAPI.parallax.renamePairedSink(id, name)
        if (renamed) {
          set((state) => ({
            pairedSinks: state.pairedSinks.map((sink) => (sink.id === renamed.id ? renamed : sink)),
            errorMessage: ''
          }))
        }
        await refreshPairedSinks()
        return renamed
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
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

    setSinkPlaybackEnabled: async (id, enabled) => {
      try {
        const status = await window.electronAPI.parallax.setSinkPlaybackEnabled(id, enabled)
        applyStatus(status)
        await refreshPairedSinks()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        throw error
      }
    },

    setAllSinksPlaybackEnabled: async (enabled) => {
      try {
        const status = await window.electronAPI.parallax.setAllSinksPlaybackEnabled(enabled)
        applyStatus(status)
        await refreshPairedSinks()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        throw error
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

    clearHostPresenceCache: async (sinkId) => {
      try {
        const status = await window.electronAPI.parallax.clearHostPresenceCache(sinkId)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
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
      return Boolean(status?.host.active && status.host.activePlaybackSinkCount > 0)
    },

    handleHostPlaybackAudienceLost: () => {
      clearNextStreamPublishTimer()
      audioEngine.cancelParallaxHostPublishing()
      audioEngine.cancelParallaxHostNextPublishing()
      stopHostEmitAnchorPublish()
      hostPublishingCanceledForActiveStream = Boolean(get().status?.host.activeStream)
      void window.electronAPI.parallax.publishHostNextStreamCancel().catch(() => undefined)
      audioEngine.releasePendingParallaxHostStartDelay()
    },

    prepareHostPlayback: async (track) => {
      if (get().isTestToneActive) {
        cancelTestToneWarmRestart()
        audioEngine.stopParallaxTestTone()
        set({ isTestToneActive: false, testToneSinkId: null })
      }
      if (!get().shouldDelayHostPlayback(track)) return null
      ensureTelemetry()
      startHostEmitAnchorPublish()
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const streamId = createStreamId(track)
      try {
        const timeline = await window.electronAPI.parallax.publishHostStreamStart(
          buildParallaxStreamInfo(track, streamId, buffer),
          { artworkHash: track.artworkHash }
        )
        hostPublishingCanceledForActiveStream = false
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
      // §17 round 2 (Codex finding 1). The original early-return on `getActiveHostStream()`
      // skipped restarting publication even when the no-sink tracking path had explicitly
      // canceled it — sinks rejoining would land on a "live" stream identity with no live audio
      // flow. Three cases:
      //   - No existing stream → fresh start (existing path).
      //   - Existing stream for THIS track + publishing was canceled while tracking → restart
      //     publication on the same streamId; sink rejoins seamlessly.
      //   - Existing stream for THIS track + publishing already active → another sink joining
      //     an already-broadcasting host. No-op; the sink's own /join handles it.
      //   - Existing stream for a DIFFERENT track → fresh start replaces (publishHostStreamStart
      //     overwrites main's activeStream slot).
      const existing = getActiveHostStream()
      if (existing && existing.trackId === track.id && !hostPublishingCanceledForActiveStream) {
        return null
      }
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const leadSeconds = playing ? PARALLAX_DEFAULT_GROUP_LATENCY_MS / 1000 : 0
      // Anchor against the acoustic emit cursor — startHostTimeMs is acoustic time, so startFrame
      // must be the frame the host's *speaker* will reach in `leadSeconds`, not the write cursor +
      // leadSeconds (which would put the sink hostLatency ahead of the host).
      const startFrame = Math.max(
        0,
        Math.min(buffer.length, Math.round((getHostAcousticCurrentTimeSeconds() + leadSeconds) * buffer.sampleRate))
      )
      // Rejoin-same-track path: reuse the existing streamId so the sink doesn't see a spurious
      // "new stream" event — publish a fresh mid-join timeline aligned to current acoustic
      // position + group lead. Fresh-start path: createStreamId for a brand-new identity.
      const isRejoinRestart = existing !== null && existing.trackId === track.id
      const streamId = isRejoinRestart ? existing.streamId : createStreamId(track)
      ensureTelemetry()
      startHostEmitAnchorPublish()
      try {
        let timeline: ParallaxTimelineState
        if (isRejoinRestart) {
          // Republish the timeline (keeps streamId, updates startFrame/startHostTimeMs/state).
          timeline = buildHostTimeline(
            existing,
            playing ? 'playing' : 'paused',
            startFrame,
            playing ? existing.groupLatencyMs : 0
          )
          await publishHostTimeline(timeline)
        } else {
          timeline = await window.electronAPI.parallax.publishHostStreamStart(
            buildParallaxStreamInfo(track, streamId, buffer),
            { startFrame, playbackState: playing ? 'playing' : 'paused', artworkHash: track.artworkHash }
          )
        }
        // A connected sink has now been serviced for this active stream. Clear the no-sink
        // restart latch even for paused joins; resume will start chunk publishing later.
        hostPublishingCanceledForActiveStream = false
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
      if (get().isTestToneActive) {
        cancelTestToneWarmRestart()
        audioEngine.stopParallaxTestTone()
        set({ isTestToneActive: false, testToneSinkId: null })
      }
      // §17 control-side: timeline tracking must run even with zero connected sinks, so a sink
      // reconnecting later doesn't get a stale-extrapolated timeline. But Codex round 1 review
      // of §17 caught a regression here: returning the timeline to playerStore unconditionally
      // makes it call `playCurrentBufferOnParallaxTimeline()` with group-latency delay even
      // when nobody's listening, adding 1 s of delay to the user's own playback. Fix shape:
      //   - When sinks ARE connected: group-latency timeline (host waits for sinks), return it
      //     so playerStore schedules local playback through Parallax. Existing behavior.
      //   - When sinks are NOT connected: host-output-latency timeline (host plays normally,
      //     timeline reflects acoustic emit truth for the eventual joiner). Publish so future
      //     joiners see correct state, but return null so playerStore plays via audioEngine.play.
      const stream = getActiveHostStreamForControl()
      if (!stream || !track || stream.trackId !== track.id) return null
      const hasSinks = (get().status?.host.activePlaybackSinkCount ?? 0) > 0
      const hostLatencyMs = audioEngine.getParallaxEndpointLatencyMs()
      // §17 round 2 (Codex MEDIUM). When this returns null (no sinks), playerStore calls
      // `audioEngine.play()`, which resumes from the write cursor (`audioEngine.currentTime`).
      // That frame leaves the speaker at `now + hostLatency`. So the tracking timeline must
      // pair (startFrame = write-cursor frame, startHostTimeMs = now + hostLatency). The
      // previous combo (acoustic-emit frame + now + hostLatency wall) put the timeline one
      // host-latency behind acoustic truth. When sinks ARE connected, host playback gets
      // scheduled through Parallax with group-latency lead — startFrame stays acoustic-emit
      // and delayMs = groupLatencyMs.
      const startFrame = hasSinks
        ? getHostFrameForTime(stream, getHostAcousticCurrentTimeSeconds())
        : Math.max(0, Math.min(stream.totalFrames, Math.round(audioEngine.currentTime * stream.sampleRate)))
      const delayMs = hasSinks ? stream.groupLatencyMs : hostLatencyMs
      const timeline = buildHostTimeline(stream, 'playing', startFrame, delayMs)
      try {
        await publishHostTimeline(timeline)
        if (hasSinks) {
          hostPublishingCanceledForActiveStream = false
          void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        } else {
          audioEngine.cancelParallaxHostPublishing()
          hostPublishingCanceledForActiveStream = true
        }
        return hasSinks ? timeline : null
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    // §21 Gapless sink handoff. Pre-announce the pre-buffered next track to sinks, anchored to the
    // current track's boundary (host-clock instant the current track's last frame leaves the
    // speaker), and start streaming its audio ahead of time. No-op unless hosting with connected
    // sinks on a local non-bitperfect track and a next track is buffered.
    publishHostNextStream: async (nextTrack) => {
      // A new pre-announce supersedes any pending deferral.
      clearNextStreamPublishTimer()
      if (!nextTrack) return
      if (!get().shouldDelayHostPlayback(nextTrack)) return
      const currentBuffer = audioEngine.getAudioBuffer()
      if (!audioEngine.getNextAudioBuffer() || !currentBuffer) return
      const remainingSec = Math.max(0, currentBuffer.duration - getHostAcousticCurrentTimeSeconds())
      const leadSec = PARALLAX_NEXT_STREAM_LEAD_MS / 1000
      // Defer the announce to ~leadSec before the boundary so the boundary projection window is
      // short (less nominal-vs-real clock drift at the crossover seam). If the track is shorter than
      // the lead (or we're already inside it), announce now.
      if (remainingSec > leadSec) {
        nextStreamPublishTimer = setTimeout(() => {
          nextStreamPublishTimer = null
          void doPublishHostNextStream(nextTrack)
        }, (remainingSec - leadSec) * 1000)
        return
      }
      await doPublishHostNextStream(nextTrack)
    },

    // §21. Withdraw a pre-announced next stream (skip / seek / queue edit / next-track change).
    cancelHostNextStream: async () => {
      clearNextStreamPublishTimer()
      audioEngine.cancelParallaxHostNextPublishing()
      try {
        await window.electronAPI.parallax.publishHostNextStreamCancel()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    // §21. Boundary crossed — promote the pre-announced next stream to active. Falls back to the
    // Phase-1 boundary start when nothing was pre-announced (e.g. handoff couldn't pre-buffer in time).
    promoteHostNextStream: async (currentTrack) => {
      audioEngine.promoteParallaxHostNextPublish()
      let promotedTimeline: ParallaxTimelineState | null = null
      try {
        promotedTimeline = await window.electronAPI.parallax.publishHostPromoteNextStream()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
      if (!promotedTimeline) {
        await get().startHostStreamForCurrentPlayback(currentTrack, true)
      }
    },

    prepareHostSeek: async (timeSeconds, playing) => {
      // §17 control-side: same hasSinks-gated return shape as resumeHostPlayback. See that
      // function's comment for the full rationale on tracking-only vs schedule-host.
      const stream = getActiveHostStreamForControl()
      if (!stream) return null
      const hasSinks = (get().status?.host.activePlaybackSinkCount ?? 0) > 0
      const delayMs = playing
        ? (hasSinks ? stream.groupLatencyMs : audioEngine.getParallaxEndpointLatencyMs())
        : 0
      // Seeks set the cursor explicitly to `timeSeconds`. The frame at the speaker at
      // `now + delayMs` matches that requested seek position. For both sinks-present and
      // tracking-only cases, anchor at the requested frame; the delayMs handles the wall
      // mapping.
      const timeline = buildHostTimeline(
        stream,
        playing ? 'playing' : 'paused',
        getHostFrameForTime(stream, timeSeconds),
        delayMs
      )
      try {
        await publishHostTimeline(timeline, { resetAudio: true })
        if (playing && hasSinks) {
          hostPublishingCanceledForActiveStream = false
          void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        } else {
          // §17 round 3 (Codex). Only latch the rejoin flag in the no-sink branch; a paused
          // seek with sinks present is the same shape as `pauseHostPlayback` — legitimate
          // publishing pause, resume re-publishes naturally.
          audioEngine.cancelParallaxHostPublishing()
          if (!hasSinks) {
            hostPublishingCanceledForActiveStream = true
          }
        }
        // Only return when playerStore should switch to Parallax scheduling — playing AND
        // sinks present. Pause and no-sink cases publish for tracking but return null so the
        // user's local playback continues without group-latency delay.
        return (playing && hasSinks) ? timeline : null
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    pauseHostPlayback: async () => {
      // §17 control-side: pause is void-returning, so the playerStore regression that hit
      // resume/seek doesn't apply here — pauseHostPlayback never made playerStore use
      // Parallax scheduling. Publishing the paused timeline regardless of sink count is the
      // correct fix; future joiners now see the actual paused state instead of a frozen
      // extrapolating `playing` timeline.
      const stream = getActiveHostStreamForControl()
      if (!stream) return
      const timeline = buildHostTimeline(
        stream,
        'paused',
        getHostFrameForTime(stream, getHostAcousticCurrentTimeSeconds())
      )
      // §17 round 2 + round 3 correctness (Codex). Pause cancels publishing (chunks stop
      // flowing because host stopped emitting), but only latch the rejoin flag if there are
      // no sinks. With sinks connected, pause is a legitimate publishing pause — the next
      // resume re-publishes the playing timeline + chunk flow naturally, no rejoin restart
      // needed.
      audioEngine.cancelParallaxHostPublishing()
      if ((get().status?.host.activePlaybackSinkCount ?? 0) === 0) {
        hostPublishingCanceledForActiveStream = true
      }
      try {
        await publishHostTimeline(timeline)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    stopHostPlayback: async () => {
      audioEngine.cancelParallaxHostPublishing()
      stopHostEmitAnchorPublish()
      // §17 round 2. Stream lifecycle reset — there's no activeStream to rejoin into, so the
      // "canceled while existing" flag must clear too, otherwise a stale `true` survives across
      // streams and the next stream's first sink-connect tries to restart publishing it has
      // never started.
      hostPublishingCanceledForActiveStream = false
      try {
        await window.electronAPI.parallax.stopHostStream()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    // Trim test tone: a synced metronome streamed to all sinks so the user can tune a speaker by
    // ear. Reuses the proven host-stream path (sinks play + trim it with zero changes). Mutually
    // exclusive with track playback — the UI gates it on "not playing", and the music stream
    // entry points stop it if it's somehow still running.
    startTestTone: async (targetSinkId) => {
      if (!(get().status?.host.enabled ?? false)) return
      cancelTestToneWarmRestart()
      // Switching target: tear the current test down first (stops the host stream so the previous
      // target goes idle rather than stalling on a stream that no longer flows).
      if (get().isTestToneActive) await teardownTestToneStream()
      const ok = await startTestToneStream(targetSinkId)
      if (!ok) return
      set({ isTestToneActive: true, testToneSinkId: targetSinkId ?? null })
      // Warm-up restart: both ends are playing now, which fills `outputLatency`. After a short
      // beat, restart so the host reference + the sink's re-join hard-anchor with the real latency
      // instead of the cold ~0. One-shot; cancelled if the test is stopped or switched first.
      testToneWarmRestartTimer = setTimeout(() => {
        testToneWarmRestartTimer = null
        if (!get().isTestToneActive || get().testToneSinkId !== (targetSinkId ?? null)) return
        void (async () => {
          await teardownTestToneStream()
          const restarted = await startTestToneStream(targetSinkId)
          if (!restarted) set({ isTestToneActive: false, testToneSinkId: null })
        })()
      }, TEST_TONE_WARM_RESTART_MS)
    },

    stopTestTone: async () => {
      cancelTestToneWarmRestart()
      await teardownTestToneStream()
      set({ isTestToneActive: false, testToneSinkId: null })
    }
  }
})
