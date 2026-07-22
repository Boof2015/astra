export const PARALLAX_LAN_HOST = '0.0.0.0'
export const PARALLAX_PROTOCOL_VERSION = 2
export const PARALLAX_DEFAULT_PORT = 38403
export const PARALLAX_MIN_PORT = 1024
export const PARALLAX_MAX_PORT = 65535
export const PARALLAX_DEFAULT_GROUP_LATENCY_MS = 1000
export const PARALLAX_AUDIO_CHUNK_FRAMES = 4096
export const PARALLAX_CLOCK_SAMPLE_LIMIT = 8
export const PARALLAX_AUDIO_PACKET_MAGIC = 0x50584c58 // PXLX
export const PARALLAX_AUDIO_PACKET_VERSION = 2
export const PARALLAX_AUDIO_PACKET_HEADER_BYTES = 40

// Snapcast-style "snap-then-slew" sink correction tuning.
// PARALLAX_MAX_SLEW_PPM bounds the playback-rate nudge used to hold/close small offsets.
// 1000 ppm = 0.1% is musically inaudible (~1.7 cents) yet ~5-24x typical crystal drift, so the
// slew can actually correct a 10-30 ms offset smoothly within seconds and keep drift inside the
// deadzone — leaving the (audible) cursor snap only for genuine large discontinuities.
export const PARALLAX_MAX_SLEW_PPM = 1000
export const PARALLAX_HARD_SYNC_MS = 40
export const PARALLAX_RESYNC_LEAD_MS = 60
export const PARALLAX_RESYNC_MIN_INTERVAL_MS = 2500
export const PARALLAX_SYNC_DEADZONE_FRAMES = 64
// Snap only after drift stays past the threshold for this many consecutive 1s ticks, so a
// single jittery clock/drift measurement can't cause a spurious gap.
export const PARALLAX_SNAP_CONFIRM_TICKS = 2
// After auto output-latency compensation, scheduling subtracts the endpoint's own latency from the
// requested lead time. If the configured PARALLAX_RESYNC_LEAD_MS is smaller than the endpoint's
// latency, the resulting context-time `when` lands before `ctx.currentTime` and the snap silently
// emits late (or, with the fail-loud guard, warns and clamps). The effective lead is therefore
// raised to at least `sinkLatency + PARALLAX_RESYNC_GUARD_MS` so the DAC has positive headroom; the
// target frame is recomputed to match the (possibly extended) emit time.
export const PARALLAX_RESYNC_GUARD_MS = 20

// Phase 2A — host-output-clock reference. See `share` doc §§3, 5, 6.
// Host publishes an emit anchor every 200 ms (5 Hz) while streaming. Sink keeps a rolling 20 s
// window (~100 samples at 5 Hz) and Theil-Sen-fits a host-source-frame-vs-host-wall-time line.
// Validation gates: ≥ 3 valid anchors, latest < 1 s old, filtered rate within ±2000 ppm of nominal.
export const PARALLAX_HOST_EMIT_ANCHOR_INTERVAL_MS = 200
export const PARALLAX_HOST_EMIT_ANCHOR_WINDOW_MS = 20_000
export const PARALLAX_HOST_EMIT_ANCHOR_MIN_SAMPLES = 3
export const PARALLAX_HOST_EMIT_ANCHOR_STALE_MS = 1_000
export const PARALLAX_HOST_EMIT_ANCHOR_MAX_DEVIATION_PPM = 2_000

// §17.2(c). After any anchor-window reset (new stream, mid-stream timeline discontinuity), the
// predictor must "prove itself" before hard-snap eligibility returns. Distinct from the slew
// path which engages immediately on §6 gate pass — slew is bounded by the ±1000 ppm clamp and
// can't move cursor far enough to do damage on a single tick, but a snap can yank cursor by
// thousands of frames if the fit is still settling. Two-part stability gate:
//
//   1. Anchor window has at least TRUSTED_SAMPLES anchors (3 s at 5 Hz). Beyond the §6 MIN of 3
//      which is enough for Theil-Sen to compute *something*, this is "enough samples to trust
//      the fit's intercept is stable, not just its slope."
//   2. |phase2_drift_frames| under the snap threshold for TRUST_TICKS consecutive telemetry
//      ticks. Phase2 drift below the snap threshold means the predictor's intercept is within
//      ~40 ms of where the cursor actually is — i.e. the fit has converged. Two ticks confirms
//      it wasn't a fluke.
//
// Once both conditions are met, the trust latch flips and snaps are allowed. The latch is
// cleared on every anchor reset so each warm-up has to re-earn snap eligibility.
export const PARALLAX_HOST_EMIT_ANCHOR_TRUSTED_SAMPLES = 15
export const PARALLAX_PREDICTOR_TRUST_TICKS = 2

// (Phase 2B §13.4 originally added a `PARALLAX_PHASE2_HANDOFF_SETTLE_MS = 10_000` window to
// suppress hard-sync for 10 s after the predictor's gates first passed. Removed 2026-06-04 — the
// settle was sized for the ~400-frame predictor-handoff bias the 2A CSV exposed, but 400 frames is
// well below the hard-sync threshold (40 ms ≈ 1764 frames), so the slew path was always going to
// handle that case. The settle only kicked in when drift on handoff *exceeded* the snap threshold,
// which is exactly the case we want to snap on — the startup-convergence path notably. Safety net
// is now the §6 validity gates + min-samples + slope sanity, not a time delay after deciding the
// predictor is valid. See share doc §13.4 for the full reasoning.)

// Underrun recovery: if the sink buffer drains while still connected, the worklet self-pauses into
// "rebuffering" after ~PARALLAX_STARVE_TRIGGER_MS of continuous starvation (mirrored as
// starveTriggerFrames in the worklet). The renderer then waits until the buffer covers the live
// host frame by at least PARALLAX_REBUFFER_MARGIN_MS before re-anchoring to live and resuming, so
// the cursor never free-runs into empty data. The host streams ~3 s ahead, so the margin refills fast.
export const PARALLAX_STARVE_TRIGGER_MS = 250
export const PARALLAX_REBUFFER_MARGIN_MS = 500

export type ParallaxPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type ParallaxRole = 'idle' | 'host' | 'sink'
export type ParallaxNormalizationMode = 'off' | 'normalization' | 'replaygain'

export interface ParallaxStreamNormalization {
  normalizationGainDb: number
  normalizationMode: ParallaxNormalizationMode
}

export type ParallaxHostStreamStartInfo =
  Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt' | 'normalizationGainDb' | 'normalizationMode'>
  & Partial<ParallaxStreamNormalization>

function normalizeParallaxNormalizationMode(value: unknown): ParallaxNormalizationMode | null {
  return value === 'off' || value === 'normalization' || value === 'replaygain'
    ? value
    : null
}

export function resolveParallaxStreamNormalization(
  value: { normalizationGainDb?: unknown; normalizationMode?: unknown } | null | undefined
): ParallaxStreamNormalization {
  const normalizationMode = normalizeParallaxNormalizationMode(value?.normalizationMode)
  const normalizationGainDb = value?.normalizationGainDb

  if (
    !normalizationMode
    || normalizationMode === 'off'
    || typeof normalizationGainDb !== 'number'
    || !Number.isFinite(normalizationGainDb)
  ) {
    return {
      normalizationGainDb: 0,
      normalizationMode: 'off'
    }
  }

  return {
    normalizationGainDb,
    normalizationMode
  }
}

// §15.5 — per-output-device manual trim, persisted alongside the paired sink. `outputDeviceId` is
// the storage key resolution from §15.4: prefers `audioSettingsStore.selectedDeviceId` on the sink,
// falls back to a normalized `AudioContext.sinkId` ('' → 'default'). `advanceMs` is positive =
// emit earlier; flows into `getParallaxEndpointLatencyMs()` on the sink. `source` is future-
// proofing for the mic calibration UX in §14; manual entries are the only kind today.
export interface ParallaxSinkTrim {
  outputDeviceId: string
  outputDeviceLabel: string | null
  advanceMs: number
  updatedAtMs: number
  source: 'manual' | 'calibration'
}

export interface ParallaxPairedSink {
  id: string
  name: string
  tokenPrefix: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
  // Host-owned zone selection. Missing values from pre-zone-control pairings resolve to true so
  // existing installations preserve the previous "every connected sink plays" behavior.
  playbackEnabled: boolean
  // §14.1.1. Empty array on existing rows; one entry per output device the user has trimmed for
  // this sink. Host stores; pushed to sink via §15.3 `sink-trim-update` events on connect + change.
  trims?: ParallaxSinkTrim[]
  // §20.19(g). Remote endpoint's role-neutral UUID (the sink's persisted UUID at pair time).
  // Discovery memory only — host UI matches against the wizard's discovery list to render
  // "Already paired" / "Renamed device" badges. Absent on pre-§20 pairings.
  remoteParallaxEndpointUuid?: string
}

export function resolveParallaxPlaybackEnabled(value: unknown): boolean {
  return value !== false
}

export interface ParallaxHostConfig {
  enabled: boolean
  port: number
}

export interface ParallaxSinkConnectionConfig {
  protocolVersion: 2
  baseUrl: string
  sinkId: string
  token: string
  hostCertificatePem: string
  hostCertificateFingerprint: string
}

// §14.1.2 / §16.2 — durable sink-side credential. Persisted on the sink machine via
// `library.setAppMeta(PARALLAX_SINK_CONNECTION_META_KEY, JSON.stringify(...))`, same mechanism
// as the existing PARALLAX_HOST_* persisted settings. Token is the raw bearer credential the
// host's `tokenHash` was derived from at pair time; sensitivity equivalent to `LOCAL_API_TOKEN`
// which is also persisted in app-meta. Single slot today; multi-host belongs with the future
// sink-mode UI per share §16.5.
export interface PersistedParallaxSinkConnection {
  protocolVersion: 2
  baseUrl: string
  sinkId: string
  token: string
  hostCertificatePem: string
  hostCertificateFingerprint: string
  hostName: string | null
  pairedAt: number
  lastConnectedAt: number | null
  // §20.19(g). Host's role-neutral UUID at pair time. Lets the sink remember "I was paired with
  // this host before" symmetric to the sink-UUID-on-host pattern. Absent on pre-§20 pairings.
  hostParallaxEndpointUuid?: string
}

// §14.1.2 / §16.12(c) — status-bearing error thrown by `fetchSinkJson` so the boot-path retry
// loop can distinguish 401 (treat as revoked, R-clear per §16.7) from other failures
// (timeout/network/5xx — keep retrying with backoff). Do not parse error messages; check this
// type via `instanceof ParallaxAuthError`.
export class ParallaxAuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ParallaxAuthError'
    this.status = status
  }
}

export interface ParallaxClockSyncResponse {
  sinkSentAtMs: number
  hostReceivedAtMs: number
  hostSentAtMs: number
}

export interface ParallaxClockSample {
  sinkSentAtMs: number
  sinkReceivedAtMs: number
  hostReceivedAtMs: number
  hostSentAtMs: number
  rttMs: number
  offsetMs: number
}

export interface ParallaxStreamInfo extends ParallaxStreamNormalization {
  streamId: string
  trackId: string
  title: string
  artist: string
  album: string
  sampleRate: number
  channels: number
  durationSeconds: number
  totalFrames: number
  chunkFrames: number
  groupLatencyMs: number
  createdAt: number
}

export interface ParallaxTimelineState {
  streamId: string
  playbackState: ParallaxPlaybackState
  startFrame: number
  // INVARIANT — acoustic time. The host-clock wall instant at which `startFrame` should *leave
  // every endpoint's speaker* (host's and every sink's). Each endpoint compensates by subtracting
  // its own output latency from its scheduled context-time `when`, so this is the shared acoustic
  // anchor — both the host's local playback and every sink's worklet schedule are symmetric
  // around it. Code paths that treat startHostTimeMs as "context start time", "DAC write time", or
  // "host render time" are bugs; see `playCurrentBufferOnParallaxTimeline`,
  // `applyParallaxTimelineFromHostClock`, and `resyncParallaxSinkToHostFrame` in AudioEngine.ts
  // for the canonical scheduling math, and `computeRateCorrectionPpm` in parallaxStore.ts for the
  // paired drift formula (which adds sinkLatencyMs to the expected write cursor).
  startHostTimeMs: number
  updatedHostTimeMs: number
  groupLatencyMs: number
}

// Options for publishHostStreamStart. Defaults reproduce a fresh play from the top.
// A sink joining mid-playback passes the host's current (latency-adjusted) frame and state so the
// stream is anchored to the in-progress song instead of restarting it.
//
// `artworkHash` is OFF-WIRE — never reaches sinks via `ParallaxStreamInfo` (Codex §19.18(e):
// schema unchanged). Main uses it to pre-resolve artwork bytes for this stream and cache by
// streamId, served at `GET /v1/parallax/artwork/current?streamId=<id>`. §14.1.4 Zone Display.
export interface ParallaxHostStreamStartOptions {
  startFrame?: number
  playbackState?: ParallaxPlaybackState
  artworkHash?: string
  // OFF-WIRE. When set, this stream is delivered to ONLY the sink with this id — both the
  // stream-start event and the audio fan-out are gated to it. Used by the trim test tone to send
  // a metronome to a single speaker; other sinks never see the stream.
  targetSinkId?: string
}

// §21 Gapless sink handoff. Options for pre-announcing the NEXT stream. Unlike a fresh
// `publishHostStreamStart` (which anchors `startHostTimeMs` to `now + groupLatency`), the next
// stream is anchored to the host's already-known track boundary, so the caller supplies the
// boundary instant explicitly. `startHostTimeMs` is the host-clock wall time the `startFrame` of
// the next track should leave every speaker.
export interface ParallaxHostNextStreamStartOptions {
  startHostTimeMs: number
  startFrame?: number
  artworkHash?: string
}

// Options for publishing a same-stream timeline update. `resetAudio` marks a source-position
// discontinuity such as seek/scrub: receivers must drop buffered audio from the previous epoch and
// reconnect/backfill from the new timeline frame. Pause/resume timeline updates leave this false.
export interface ParallaxHostTimelinePublishOptions {
  resetAudio?: boolean
}

export type ParallaxTimelineEvent =
  | {
      type: 'stream-start'
      stream: ParallaxStreamInfo
      timeline: ParallaxTimelineState
      emittedAtHostTimeMs: number
    }
  | {
      type: 'timeline'
      timeline: ParallaxTimelineState
      resetAudio?: boolean
      emittedAtHostTimeMs: number
    }
  | {
      type: 'stop'
      streamId: string | null
      emittedAtHostTimeMs: number
    }
  // Phase 2A — host periodically broadcasts the source frame currently leaving its speaker, in
  // host-wall time. Sinks fit a robust host-output-frame predictor from a rolling window of these
  // anchors. The acoustic timeline (startHostTimeMs/startFrame) stays as the static anchor; this
  // is the live host-output-clock reference the sink can chase to absorb hardware-crystal drift
  // between the two machines (invisible to the nominal-rate Phase-1 loop).
  | {
      type: 'host-emit-anchor'
      streamId: string
      hostWallTimeMs: number          // performance.timeOrigin + ts.performanceTime
      sourceFrameAtHostOutput: number // frame the host's speaker emitted at hostWallTimeMs
      hostOutputLatencyMs: number     // diagnostic
      hostBaseLatencyMs: number       // diagnostic
      observedRatePpm: number | null  // diagnostic host-side estimate; sink's fit is authoritative
      sequence: number                // monotonic per stream
      emittedAtHostTimeMs: number
    }
  // §14.1.1 / §15.3 — host pushes a per-sink trim. Targeted by `sinkId` (other sinks ignore). MUST
  // be handled in `handleSinkEvent` via an early-return branch BEFORE the clock-offset-pending
  // fallback, so a push that arrives mid clock-priming still applies. The variant has no timeline
  // payload — do not let it reach the `latestTimeline` set or `event.timeline` access.
  | {
      type: 'sink-trim-update'
      sinkId: string
      advanceMs: number
      outputDeviceId: string          // 'default' for the system route
      emittedAtHostTimeMs: number
    }
  // §14.1.4 — host pushes the speaker's host-assigned display name. Targeted by `sinkId` (other
  // sinks ignore). Pushed on SSE connect + whenever the host renames the sink, mirroring
  // `sink-trim-update`. Surface-only (Zone Display heading); no timeline payload.
  | {
      type: 'sink-name-update'
      sinkId: string
      name: string
      emittedAtHostTimeMs: number
    }
  // Host-owned playback selection, delivered even while the sink is inactive so its idle UI can
  // distinguish "waiting for music" from "connected, but not selected". Older sinks safely ignore
  // this additive event and still stop/start through the ordinary timeline events.
  | {
      type: 'sink-playback-update'
      sinkId: string
      playbackEnabled: boolean
      emittedAtHostTimeMs: number
    }
  // §21 Gapless sink handoff. Host pre-announces the NEXT stream ahead of the track boundary so a
  // sink can pre-load its audio and schedule a sample-aligned crossover, WITHOUT tearing down the
  // currently-playing stream. `timeline` is FUTURE-anchored: `startHostTimeMs` is the host-clock
  // instant the next track's `startFrame` should leave every speaker (the gapless boundary, derived
  // host-side from the current track's scheduled end), and `startFrame` is the next track's resume
  // frame (0 for a fresh next track). A sink that can't honor it safely ignores it and still
  // follows via the boundary `stream-start`/`next-stream-promote` fallback.
  | {
      type: 'next-stream-start'
      stream: ParallaxStreamInfo
      timeline: ParallaxTimelineState
      emittedAtHostTimeMs: number
    }
  // §21. Host withdrew the pre-announced next stream (skip / seek / queue edit / repeat-one / the
  // next track changed before the boundary). Sinks drop the staged stream + any buffered
  // next-stream chunks. `streamId` identifies the withdrawn pending stream.
  | {
      type: 'next-stream-cancel'
      streamId: string
      emittedAtHostTimeMs: number
    }
  // §21. Boundary crossed: the pre-announced next stream is now the live stream. The acoustic
  // crossover already happened on the sink via the scheduled worklet start; this event is the
  // bookkeeping signal for the sink to promote its staged stream to active (status, now-playing,
  // Zone Display artwork). `streamId` is the stream being promoted to active.
  | {
      type: 'next-stream-promote'
      streamId: string
      emittedAtHostTimeMs: number
    }

export interface ParallaxAudioChunk {
  streamId: string
  sampleRate: number
  channels: number
  startFrame: number
  frameCount: number
  hostTimeMs: number
  pcmData: ArrayBuffer
}

export interface ParallaxAudioPacketHeader {
  version: number
  sampleRate: number
  channels: number
  startFrame: number
  frameCount: number
  hostTimeMs: number
  payloadBytes: number
}

// Phase 0 diagnostics: a device's reported audio output-latency signals (all in ms).
// outputLatencyMs/baseLatencyMs come from AudioContext; timestampLatencyMs is the median-filtered
// (currentTime - getOutputTimestamp().contextTime), the un-quantized acoustic-output latency.
export interface ParallaxOutputLatencyMetrics {
  outputLatencyMs: number | null
  baseLatencyMs: number | null
  timestampLatencyMs: number | null
}

export interface ParallaxSinkTelemetry {
  streamId: string | null
  bufferedMs: number
  driftFrames: number
  rttMs: number | null
  underruns: number
  playbackRatePpm: number
  reportedAtMs: number
  // Phase 0 diagnostics: the sink's own reported output-latency signals (optional; absent on older sinks).
  outputLatencyMs?: number | null
  baseLatencyMs?: number | null
  timestampLatencyMs?: number | null
  // Underrun-recovery diagnostics.
  rebuffering?: boolean
  starvedFrames?: number
  // Phase 2A diagnostics — host-output-clock reference predictor on the sink. All optional so
  // older sinks remain compatible. The loop ignores these in 2A (logged-only); 2B switches drift
  // and snap to use them when validation gates pass.
  hostRefAgeMs?: number | null         // age of most recent valid anchor (ms)
  hostRefRatePpm?: number | null       // filtered rate from rolling-window fit, in ppm vs nominal
  hostRefRateRawPpm?: number | null    // last pairwise Δframe/Δt rate, for filter validation
  hostRefFrame?: number | null         // host source frame predicted at currentFrameAtWallMs
  sinkAcousticFrame?: number | null    // sink write cursor − sinkLatency*sr in frames
  hostAcousticFrame?: number | null    // same as hostRefFrame; renamed for symmetry in the CSV
  phase2DriftFrames?: number | null    // sinkAcoustic − hostAcoustic; what 2B will steer against
  // Phase 2B (§13.2). Which branch produced the drift the loop is steering against this tick.
  // 'predictor' = host-output-clock predictor (gates pass + env flag on).
  // 'phase1'    = nominal-timeline fallback (predictor unavailable, or flag off).
  // 'hold'      = no usable drift signal (clock offset missing / playback stopped / first tick).
  loopSource?: 'predictor' | 'phase1' | 'hold' | null
  // Phase 2B §13.4 follow-up. Explicit per-tick marker for hard-sync events so the next debug pass
  // doesn't have to infer them from `ppm=0` + snap-sized drift. 'snap' = playing-path rate
  // corrector fired resyncParallaxSinkToHostFrame; 'rebuffer_snap' = same call but from the
  // buffer-drain recovery path. null/absent means no hard sync this tick.
  syncEvent?: 'snap' | 'rebuffer_snap' | null
  // Running count of hard syncs since this sink session started. Lets the CSV reader compute
  // rate/spacing without parsing the per-event column.
  hardSyncCount?: number
  // §14.1.1 / §15.4 — sink's current output device identity, sourced from
  // audioSettingsStore.selectedDeviceId (preferred) or normalized AudioContext.sinkId (fallback).
  // Host uses this to look up the matching trim from the paired-sink store and push it back.
  outputDeviceId?: string | null
  outputDeviceLabel?: string | null
  // §14.1.1. The trim the sink's AudioEngine currently has applied (echoed from
  // `audioEngine.getParallaxSinkAdvanceMs()`). Reported by the sink so the host's
  // `ParallaxConnectedSinkState.appliedAdvanceMs` reflects observed truth — not the host's
  // most-recent push, which can briefly diverge from "applied" during a sink-trim-update flight.
  appliedAdvanceMs?: number
}

// §14.1.1 / §15 (Codex P1 shape, 2026-06-06). Per-connected-sink ephemeral state as seen by the
// host. Combines persistent pairing identity (`sinkId`, `name`) with telemetry-reported truth
// (`outputDevice*`, `appliedAdvanceMs`, `lastSeenAt`). `appliedAdvanceMs` is the sink's *echoed*
// value (mirror of `ParallaxSinkTelemetry.appliedAdvanceMs`), not the host's pushed intent — so
// the UI can detect in-flight or unapplied pushes.
export interface ParallaxConnectedSinkState {
  sinkId: string
  name: string
  online: boolean
  playbackEnabled: boolean
  outputDeviceId: string | null
  outputDeviceLabel: string | null
  appliedAdvanceMs: number
  lastSeenAt: number | null
  // Host-visible network health mirrored from sink telemetry. Null until the sink has reported
  // at least one clock sample.
  rttMs?: number | null
}

export interface ParallaxHostStatus {
  enabled: boolean
  active: boolean
  bindHost: string
  port: number
  lanUrls: string[]
  pairedSinkCount: number
  connectedSinkCount: number
  // Selected AND currently connected sinks. Host scheduling/publishing must use this count rather
  // than connectedSinkCount so inactive zones retain control presence without adding lookahead.
  activePlaybackSinkCount: number
  activeStream: ParallaxStreamInfo | null
  lastError: string | null
  // §14.1.1. Per-sink connected-state list. Empty when no sinks are connected. Renderer reads to
  // render per-sink rows (output device + trim stepper) and to know which `(sinkId, outputDeviceId)`
  // tuple the slider edits live-update.
  connectedSinks: ParallaxConnectedSinkState[]
  // Phase 0 diagnostics: the host's own reported output-latency signals (ms), reported by the host renderer.
  outputLatencyMs?: number | null
  baseLatencyMs?: number | null
  timestampLatencyMs?: number | null
}

export interface ParallaxSinkStatus {
  connected: boolean
  // Host-authored zone selection. Optional for compatibility with status snapshots produced by
  // older hosts; renderer surfaces should treat missing as enabled.
  playbackEnabled?: boolean
  // §14.1.4 — host reachability from the SSE control channel. `connected` only means a connection
  // config exists (and auto-reconnect is running); `hostReachable` is false once the host has been
  // unreachable past the grace window (e.g. the host app quit). UI uses this to leave now-playing
  // for an idle "reconnecting" state instead of showing a frozen, stale track.
  hostReachable?: boolean
  baseUrl: string | null
  sinkId: string | null
  activeStream: ParallaxStreamInfo | null
  clockOffsetMs: number | null
  rttMs: number | null
  lastError: string | null
  // §14.1.1. Local sink-mode status: this app instance's own output device identity, resolved by
  // the sink renderer the same way it sources the value for outgoing telemetry — settings-store
  // primary, AudioContext.sinkId fallback. UI reads this for the "I am a sink running on …" view.
  outputDeviceId?: string | null
  outputDeviceLabel?: string | null
  // §14.1.1. The trim the local sink's AudioEngine has applied (echoed from
  // `audioEngine.getParallaxSinkAdvanceMs()`). This is the sink-side observed truth — distinct
  // from `ParallaxConnectedSinkState.appliedAdvanceMs` (the host's view of a remote sink, which
  // mirrors this value via telemetry). Not derived from any host paired-sink lookup.
  appliedAdvanceMs?: number
  // §14.1.2 follow-up (Codex round 1, finding 3). Renderer-visible mirror of the sink-side
  // durable credential. UI gates Connect/Forget visibility on `hasPersistedConnection` instead of
  // a local-component token cache — so when main wipes creds on R-clear (host revoke), the
  // already-open Settings panel updates via the existing onStatus subscription. The actual token
  // never leaves main; renderer reuses the credential via the `reconnectFromPersisted` IPC.
  hasPersistedConnection?: boolean
  persistedHostName?: string | null
  // §14.1.2 follow-up. True after an in-session 401 surfaced the host's revocation. Lets the UI
  // show an explicit "Removed by host" state instead of the generic "Unauthorized" lastError.
  // Cleared on successful re-pair.
  removedByHost?: boolean
  // §20 / §14.1.5. Sink-role toggle (persisted in main). Gates mDNS advertisement, the sink
  // HTTP listener, and auto-reconnect. Off by default for new installs; migrated to true for
  // installs that already had a persisted sink connection from §14.1.2.
  sinkEnabled?: boolean
  // §20 Commit 3. Live pending pair-request on this sink, set by the sink HTTP listener when a
  // host POSTs `pair-request` and shows the PIN. Null when idle. Renderer (Commit 4) renders
  // the PIN card from this. Cleared on confirm success / 3-fail lockout / expiry / sink toggle
  // off / explicit cancellation.
  incomingPairRequest?: ParallaxIncomingPairRequest | null
}

export interface ParallaxIncomingPairRequest {
  pairingId: string
  pin: string
  hostName: string
  hostParallaxEndpointUuid: string | null
  hostUrl: string
  expiresAtMs: number
  awaitingApproval: boolean
}

export interface ParallaxIdentity {
  // §20.19(c). Role-neutral persisted UUID per Astra install. Advertised over mDNS when sink
  // is enabled; sent in pair-request when acting as host. Discovery memory only — auth
  // identity is still the host-issued `sinkId`.
  endpointUuid: string
}

// §20 Commit 2. Discovery wire shape — the renderer wizard renders rows from this. Built from
// bonjour-service's `Service` payload by the parallaxDiscovery wrapper, never carries
// credentials. `endpointUuid` lets the host UI match against its `pairedSinks` to render
// "Already paired" badges; absent uuid (older sink or non-Astra advert spoofing the type) is a
// valid but degraded state — the row stays selectable, just without paired-status memory.
export interface ParallaxDiscoveredSink {
  endpointUuid: string | null
  name: string
  baseUrl: string
  address: string
  port: number
  version: number | null
  compatible: boolean
  lastSeenAt: number
}

// IPC event variant for discovery push notifications. `added` covers both first-seen and
// txt-update / srv-update (latest state replaces prior). `removed` fires on goodbye / TTL
// expiry. Renderer keeps a Map keyed by endpointUuid || `${address}:${port}` and reconciles.
export type ParallaxDiscoveryEvent =
  | { type: 'added'; sink: ParallaxDiscoveredSink }
  | { type: 'removed'; endpointUuid: string | null; address: string; port: number }

export interface ParallaxStatus {
  role: ParallaxRole
  host: ParallaxHostStatus
  sink: ParallaxSinkStatus
  // §20.19(c). Same UUID surfaces in either role.
  identity?: ParallaxIdentity
  securityMigrationRequired?: boolean
}

// §20.19(d) migration. Pure decision: given the persisted `parallax_sink_enabled_v1` meta value
// (or `null` for never-written) and whether a sanitized §14.1.2 sink credential already exists,
// return the boolean to apply + whether the result still needs to be written to disk (first-read
// migration path). Exposed for tests without spinning up sqlite — see parallax.test.ts.
export function decideParallaxSinkEnabledFromMeta(
  rawMeta: string | null,
  hasPersistedSinkConnection: boolean
): { enabled: boolean; needsPersist: boolean } {
  if (rawMeta === null) {
    return { enabled: hasPersistedSinkConnection, needsPersist: true }
  }
  if (rawMeta === '1') return { enabled: true, needsPersist: false }
  return { enabled: false, needsPersist: false }
}

export function decideParallaxSecurityV2Migration(
  currentVersion: string | null,
  rawPairedSinks: string | null,
  rawSinkConnection: string | null
): { needsMigration: boolean; showRepairNotice: boolean } {
  if (currentVersion === String(PARALLAX_PROTOCOL_VERSION)) {
    return { needsMigration: false, showRepairNotice: false }
  }
  let hadPairedSinks = false
  if (rawPairedSinks?.trim()) {
    try {
      const parsed = JSON.parse(rawPairedSinks)
      hadPairedSinks = Array.isArray(parsed) ? parsed.length > 0 : true
    } catch {
      hadPairedSinks = true
    }
  }
  return {
    needsMigration: true,
    showRepairNotice: hadPairedSinks || Boolean(rawSinkConnection?.trim())
  }
}

// §20 / §14.1.5 constants. PIN flow + listener.
export const PARALLAX_SINK_DEFAULT_PORT = 38404
export const PARALLAX_PAIR_PIN_TTL_MS = 90_000
export const PARALLAX_PAIR_CANDIDATE_TTL_MS = 90_000
export const PARALLAX_PAIR_PIN_MAX_FAILS = 3
export const PARALLAX_PAIR_RATE_LIMIT_MS = 10_000
export const PARALLAX_PAIR_LOCKOUT_COOLDOWN_MS = 60_000

// §20.6 wire shapes. `pair-request` carries no credentials (Codex round 1 correction);
// `pair-confirm` carries the candidate `(sinkId, token)` only after the user has read the PIN
// from the sink screen, so the wire flow only after physical presence is established.
export interface ParallaxPairRequestBody {
  version: 2
  pairingId: string
  hostName: string
  hostPort: number
  parallaxEndpointUuid: string
  hostEphemeralPublicKey: string
  hostCertificatePem: string
  hostCertificateFingerprint: string
}

export interface ParallaxPairRequestResponse {
  version: 2
  expiresInSeconds: number
  parallaxEndpointUuid: string
  sinkName: string
  sinkEphemeralPublicKey: string
}

export interface ParallaxPairConfirmBody {
  pairingId: string
  nonce: string
  ciphertext: string
  authTag: string
}

export interface ParallaxPairConfirmResponse {
  nonce: string
  ciphertext: string
  authTag: string
}

export interface ParallaxSinkIdentityResponse {
  name: string
  endpoint_uuid: string
  paired: boolean
}

export interface ParallaxJoinResponse {
  sinkId: string
  groupLatencyMs: number
  hostTimeMs: number
  // Additive v2 field. Missing means enabled for compatibility with older hosts.
  playbackEnabled: boolean
  stream: ParallaxStreamInfo | null
  timeline: ParallaxTimelineState | null
  // §21 Gapless sink handoff. A sink joining after the host pre-announced the next stream receives
  // it here too, so it can pre-stage the upcoming track instead of waiting for the boundary. Null /
  // omitted when no next stream is pending.
  nextStream?: ParallaxStreamInfo | null
  nextTimeline?: ParallaxTimelineState | null
}

export type ParallaxJoinValidationReason =
  | 'response-not-object'
  | 'invalid-sink-id'
  | 'invalid-group-latency-ms'
  | 'invalid-host-time-ms'
  | 'invalid-stream-fields'
  | 'invalid-timeline-fields'
  | 'invalid-next-stream-fields'
  | 'invalid-next-timeline-fields'
  | 'active-presence-mismatch'
  | 'next-presence-mismatch'
  | 'active-id-mismatch'
  | 'next-id-mismatch'
  | 'sink-id-mismatch'

export type ParallaxJoinValidationResult =
  | { ok: true; value: ParallaxJoinResponse }
  | { ok: false; reason: ParallaxJoinValidationReason }

export type ParallaxJoinPhase = 'initial' | 'reconnect'

export interface ParallaxJoinValidationDiagnostic {
  event: 'parallax_join_validation_failed'
  joinPhase: ParallaxJoinPhase
  reason: ParallaxJoinValidationReason
  httpStatus: number
  contentType: string | null
  protocolVersion: number
  softwareVersion: string
  expectedSinkId?: string
  actualSinkId?: string
}

function parallaxRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parallaxWireString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== 'string' || value.length > maxLength) return null
  const normalized = value.trim()
  return normalized || allowEmpty ? normalized : null
}

function parallaxFiniteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

export function parseParallaxStreamInfo(value: unknown): ParallaxStreamInfo | null {
  const record = parallaxRecord(value)
  if (!record) return null
  const streamId = parallaxWireString(record.streamId, 128)
  const trackId = parallaxWireString(record.trackId, 256, true)
  const title = parallaxWireString(record.title, 512, true)
  const artist = parallaxWireString(record.artist, 512, true)
  const album = parallaxWireString(record.album, 512, true)
  const sampleRate = parallaxFiniteNumber(record.sampleRate, 8_000, 384_000)
  const channels = parallaxFiniteNumber(record.channels, 1, 8)
  const durationSeconds = parallaxFiniteNumber(record.durationSeconds, 0, 7 * 24 * 60 * 60)
  const totalFrames = parallaxFiniteNumber(record.totalFrames, 0, Number.MAX_SAFE_INTEGER)
  const chunkFrames = parallaxFiniteNumber(record.chunkFrames, 1, PARALLAX_AUDIO_CHUNK_FRAMES)
  const groupLatencyMs = parallaxFiniteNumber(record.groupLatencyMs, 0, 60_000)
  const createdAt = parallaxFiniteNumber(record.createdAt, 0, Number.MAX_SAFE_INTEGER)
  if (
    streamId === null || trackId === null || title === null || artist === null || album === null
    || sampleRate === null || channels === null || !Number.isInteger(channels)
    || durationSeconds === null || totalFrames === null || !Number.isSafeInteger(totalFrames)
    || chunkFrames === null || !Number.isInteger(chunkFrames)
    || groupLatencyMs === null || createdAt === null
  ) return null
  return {
    streamId,
    trackId,
    title,
    artist,
    album,
    sampleRate,
    channels,
    durationSeconds,
    totalFrames,
    chunkFrames,
    groupLatencyMs,
    createdAt,
    ...resolveParallaxStreamNormalization(record)
  }
}

export function parseParallaxTimelineState(value: unknown): ParallaxTimelineState | null {
  const record = parallaxRecord(value)
  if (!record) return null
  const streamId = parallaxWireString(record.streamId, 128)
  const playbackState = record.playbackState
  const startFrame = parallaxFiniteNumber(record.startFrame, 0, Number.MAX_SAFE_INTEGER)
  const startHostTimeMs = parallaxFiniteNumber(record.startHostTimeMs, 0, Number.MAX_SAFE_INTEGER)
  const updatedHostTimeMs = parallaxFiniteNumber(record.updatedHostTimeMs, 0, Number.MAX_SAFE_INTEGER)
  const groupLatencyMs = parallaxFiniteNumber(record.groupLatencyMs, 0, 60_000)
  if (
    streamId === null
    || (playbackState !== 'stopped' && playbackState !== 'playing' && playbackState !== 'paused' && playbackState !== 'loading')
    || startFrame === null || !Number.isSafeInteger(startFrame)
    || startHostTimeMs === null || updatedHostTimeMs === null || groupLatencyMs === null
  ) return null
  return { streamId, playbackState, startFrame, startHostTimeMs, updatedHostTimeMs, groupLatencyMs }
}

export function validateParallaxJoinResponse(
  value: unknown,
  expectedSinkId: string
): ParallaxJoinValidationResult {
  const record = parallaxRecord(value)
  if (!record) return { ok: false, reason: 'response-not-object' }
  const sinkId = parallaxWireString(record.sinkId, 128)
  if (sinkId === null) return { ok: false, reason: 'invalid-sink-id' }
  const groupLatencyMs = parallaxFiniteNumber(record.groupLatencyMs, 0, 60_000)
  if (groupLatencyMs === null) return { ok: false, reason: 'invalid-group-latency-ms' }
  const hostTimeMs = parallaxFiniteNumber(record.hostTimeMs, 0, Number.MAX_SAFE_INTEGER)
  if (hostTimeMs === null) return { ok: false, reason: 'invalid-host-time-ms' }
  const playbackEnabled = typeof record.playbackEnabled === 'boolean' ? record.playbackEnabled : true
  const stream = record.stream == null ? null : parseParallaxStreamInfo(record.stream)
  if (record.stream != null && stream === null) return { ok: false, reason: 'invalid-stream-fields' }
  const timeline = record.timeline == null ? null : parseParallaxTimelineState(record.timeline)
  if (record.timeline != null && timeline === null) return { ok: false, reason: 'invalid-timeline-fields' }
  const nextStream = record.nextStream == null ? null : parseParallaxStreamInfo(record.nextStream)
  if (record.nextStream != null && nextStream === null) return { ok: false, reason: 'invalid-next-stream-fields' }
  const nextTimeline = record.nextTimeline == null ? null : parseParallaxTimelineState(record.nextTimeline)
  if (record.nextTimeline != null && nextTimeline === null) return { ok: false, reason: 'invalid-next-timeline-fields' }
  if ((stream === null) !== (timeline === null)) return { ok: false, reason: 'active-presence-mismatch' }
  if ((nextStream === null) !== (nextTimeline === null)) return { ok: false, reason: 'next-presence-mismatch' }
  if (stream && timeline && stream.streamId !== timeline.streamId) {
    return { ok: false, reason: 'active-id-mismatch' }
  }
  if (nextStream && nextTimeline && nextStream.streamId !== nextTimeline.streamId) {
    return { ok: false, reason: 'next-id-mismatch' }
  }
  if (sinkId !== expectedSinkId) return { ok: false, reason: 'sink-id-mismatch' }
  return {
    ok: true,
    value: { sinkId, groupLatencyMs, hostTimeMs, playbackEnabled, stream, timeline, nextStream, nextTimeline }
  }
}

function parallaxDiagnosticString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return sanitized ? sanitized.slice(0, maxLength) : null
}

export function buildParallaxJoinValidationDiagnostic(options: {
  value: unknown
  expectedSinkId: string
  joinPhase: ParallaxJoinPhase
  reason: ParallaxJoinValidationReason
  httpStatus: number
  contentType: string | null
  softwareVersion: string
}): ParallaxJoinValidationDiagnostic {
  const diagnostic: ParallaxJoinValidationDiagnostic = {
    event: 'parallax_join_validation_failed',
    joinPhase: options.joinPhase,
    reason: options.reason,
    httpStatus: options.httpStatus,
    contentType: parallaxDiagnosticString(options.contentType, 256),
    protocolVersion: PARALLAX_PROTOCOL_VERSION,
    softwareVersion: parallaxDiagnosticString(options.softwareVersion, 128) ?? 'unknown'
  }
  if (options.reason !== 'sink-id-mismatch') return diagnostic
  const expectedSinkId = parallaxDiagnosticString(options.expectedSinkId, 128)
  const actualSinkId = parallaxRecord(options.value)
    ? parallaxWireString((options.value as Record<string, unknown>).sinkId, 128)
    : null
  if (expectedSinkId) diagnostic.expectedSinkId = expectedSinkId
  if (actualSinkId) diagnostic.actualSinkId = actualSinkId
  return diagnostic
}

export function parseParallaxTimelineEvent(value: unknown): ParallaxTimelineEvent | null {
  const record = parallaxRecord(value)
  if (!record || typeof record.type !== 'string') return null
  const emittedAtHostTimeMs = parallaxFiniteNumber(record.emittedAtHostTimeMs, 0, Number.MAX_SAFE_INTEGER)
  if (emittedAtHostTimeMs === null) return null
  if (record.type === 'stream-start' || record.type === 'next-stream-start') {
    const stream = parseParallaxStreamInfo(record.stream)
    const timeline = parseParallaxTimelineState(record.timeline)
    if (!stream || !timeline || stream.streamId !== timeline.streamId) return null
    return { type: record.type, stream, timeline, emittedAtHostTimeMs }
  }
  if (record.type === 'timeline') {
    const timeline = parseParallaxTimelineState(record.timeline)
    if (!timeline) return null
    return { type: 'timeline', timeline, resetAudio: record.resetAudio === true, emittedAtHostTimeMs }
  }
  if (record.type === 'stop') {
    const streamId = record.streamId == null ? null : parallaxWireString(record.streamId, 128)
    if (record.streamId != null && streamId === null) return null
    return { type: 'stop', streamId, emittedAtHostTimeMs }
  }
  if (record.type === 'next-stream-cancel' || record.type === 'next-stream-promote') {
    const streamId = parallaxWireString(record.streamId, 128)
    return streamId ? { type: record.type, streamId, emittedAtHostTimeMs } : null
  }
  if (record.type === 'sink-name-update') {
    const sinkId = parallaxWireString(record.sinkId, 128)
    const name = parallaxWireString(record.name, 80)
    return sinkId && name ? { type: 'sink-name-update', sinkId, name, emittedAtHostTimeMs } : null
  }
  if (record.type === 'sink-playback-update') {
    const sinkId = parallaxWireString(record.sinkId, 128)
    return sinkId && typeof record.playbackEnabled === 'boolean'
      ? { type: 'sink-playback-update', sinkId, playbackEnabled: record.playbackEnabled, emittedAtHostTimeMs }
      : null
  }
  if (record.type === 'sink-trim-update') {
    const sinkId = parallaxWireString(record.sinkId, 128)
    const outputDeviceId = parallaxWireString(record.outputDeviceId, 256)
    const advanceMs = parallaxFiniteNumber(record.advanceMs, -500, 500)
    return sinkId && outputDeviceId && advanceMs !== null
      ? { type: 'sink-trim-update', sinkId, outputDeviceId, advanceMs, emittedAtHostTimeMs }
      : null
  }
  if (record.type === 'host-emit-anchor') {
    const streamId = parallaxWireString(record.streamId, 128)
    const hostWallTimeMs = parallaxFiniteNumber(record.hostWallTimeMs, 0, Number.MAX_SAFE_INTEGER)
    const sourceFrameAtHostOutput = parallaxFiniteNumber(record.sourceFrameAtHostOutput, 0, Number.MAX_SAFE_INTEGER)
    const hostOutputLatencyMs = parallaxFiniteNumber(record.hostOutputLatencyMs, 0, 60_000)
    const hostBaseLatencyMs = parallaxFiniteNumber(record.hostBaseLatencyMs, 0, 60_000)
    const sequence = parallaxFiniteNumber(record.sequence, 0, Number.MAX_SAFE_INTEGER)
    const observedRatePpm = record.observedRatePpm == null
      ? null
      : parallaxFiniteNumber(record.observedRatePpm, -100_000, 100_000)
    if (!streamId || hostWallTimeMs === null || sourceFrameAtHostOutput === null
      || hostOutputLatencyMs === null || hostBaseLatencyMs === null || sequence === null
      || (record.observedRatePpm != null && observedRatePpm === null)) return null
    return {
      type: 'host-emit-anchor', streamId, hostWallTimeMs, sourceFrameAtHostOutput,
      hostOutputLatencyMs, hostBaseLatencyMs, observedRatePpm, sequence, emittedAtHostTimeMs
    }
  }
  return null
}

export function buildParallaxClockSample(
  response: ParallaxClockSyncResponse,
  sinkReceivedAtMs: number
): ParallaxClockSample {
  const rttMs = Math.max(0, sinkReceivedAtMs - response.sinkSentAtMs)
  const offsetMs = (
    (response.hostReceivedAtMs - response.sinkSentAtMs)
    + (response.hostSentAtMs - sinkReceivedAtMs)
  ) / 2

  return {
    sinkSentAtMs: response.sinkSentAtMs,
    sinkReceivedAtMs,
    hostReceivedAtMs: response.hostReceivedAtMs,
    hostSentAtMs: response.hostSentAtMs,
    rttMs,
    offsetMs
  }
}

export function selectBestParallaxClockSample(
  samples: readonly ParallaxClockSample[]
): ParallaxClockSample | null {
  let best: ParallaxClockSample | null = null

  for (const sample of samples) {
    if (!Number.isFinite(sample.rttMs) || !Number.isFinite(sample.offsetMs)) continue
    if (!best || sample.rttMs < best.rttMs) {
      best = sample
      continue
    }
    if (best && sample.rttMs === best.rttMs && sample.sinkReceivedAtMs > best.sinkReceivedAtMs) {
      best = sample
    }
  }

  return best
}

export function mapHostTimeToSinkTimeMs(hostTimeMs: number, hostMinusSinkOffsetMs: number): number {
  return hostTimeMs - hostMinusSinkOffsetMs
}

// Robust host↔sink clock offset across recent probes. Takes the lower-RTT half (rounded up) and
// medians those offsets. Asymmetric one-way times on a WiFi link skew the NTP-style per-sample
// offset estimate, so restricting to low-RTT samples reduces that error; medianing the survivors
// then makes the result robust to a single bad probe within the best-RTT set. Sign is preserved
// (host − sink) at every step. Returns null when no usable samples are available.
export function selectFilteredParallaxClockOffsetMs(
  samples: readonly ParallaxClockSample[]
): number | null {
  const valid = samples.filter((sample) =>
    Number.isFinite(sample.offsetMs) && Number.isFinite(sample.rttMs)
  )
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0].offsetMs
  const sortedByRtt = [...valid].sort((left, right) => left.rttMs - right.rttMs)
  const half = Math.max(1, Math.ceil(sortedByRtt.length / 2))
  const offsets = sortedByRtt.slice(0, half).map((sample) => sample.offsetMs).sort((a, b) => a - b)
  const mid = Math.floor(offsets.length / 2)
  return offsets.length % 2 === 1 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2
}

export function clampParallaxPlaybackRatePpm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-PARALLAX_MAX_SLEW_PPM, Math.min(PARALLAX_MAX_SLEW_PPM, value))
}

// Phase 2A — Theil-Sen robust line fit over host-output anchors. See `share` doc §5.
// Median of pairwise Δframe/Δtime, intercept from median residual. Theil-Sen tolerates up to ~29%
// outliers in the median; a stray bad anchor produces N-1 bad pairwise slopes which the median
// rejects. Returns null when fewer than 2 distinct-time points are available. Caller converts the
// returned slope (frames per ms) to ppm against the stream's nominal sampleRate.
export interface ParallaxHostEmitAnchorLine {
  slopeFramesPerMs: number
  intercept: number  // source frame at hostWallTimeMs = 0
}

export function fitHostEmitAnchorLine(
  anchors: readonly { hostWallTimeMs: number; sourceFrameAtHostOutput: number }[]
): ParallaxHostEmitAnchorLine | null {
  const valid = anchors.filter((a) =>
    Number.isFinite(a.hostWallTimeMs) && Number.isFinite(a.sourceFrameAtHostOutput)
  )
  if (valid.length < 2) return null

  // All pairwise slopes; skip pairs with identical or non-increasing time to avoid divide-by-zero
  // and to enforce monotonicity (the host publishes anchors in order; out-of-order arrivals are
  // pre-filtered upstream, but be defensive).
  const slopes: number[] = []
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const dt = valid[j].hostWallTimeMs - valid[i].hostWallTimeMs
      if (dt <= 0) continue
      const df = valid[j].sourceFrameAtHostOutput - valid[i].sourceFrameAtHostOutput
      slopes.push(df / dt)
    }
  }
  if (slopes.length === 0) return null

  const slopeFramesPerMs = parallaxMedian(slopes)
  // Intercept: median of (frame_i − slope * time_i). Robust to the same outliers the slope was.
  const intercepts = valid.map((a) => a.sourceFrameAtHostOutput - slopeFramesPerMs * a.hostWallTimeMs)
  const intercept = parallaxMedian(intercepts)
  return { slopeFramesPerMs, intercept }
}

function parallaxMedian(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Convert a fitted slope (frames per ms of wall time) into ppm deviation from a nominal sampleRate.
// Nominal slope = sampleRate / 1000 frames per ms; ppm = (slope / nominalSlope − 1) × 1e6.
export function hostEmitAnchorSlopeToPpm(slopeFramesPerMs: number, nominalSampleRate: number): number {
  if (!Number.isFinite(slopeFramesPerMs) || !Number.isFinite(nominalSampleRate) || nominalSampleRate <= 0) return 0
  const nominal = nominalSampleRate / 1000
  return (slopeFramesPerMs / nominal - 1) * 1_000_000
}

export type ParallaxSinkCorrectionMode = 'hold' | 'slew' | 'snap'

export interface ParallaxSinkCorrection {
  mode: ParallaxSinkCorrectionMode
  playbackRatePpm: number
}

// Decide how the sink should react to measured drift (currentFrame - expectedFrame):
// - |drift| beyond PARALLAX_HARD_SYNC_MS  -> 'snap' the cursor (rate correction can't catch up)
// - |drift| within PARALLAX_SYNC_DEADZONE_FRAMES -> 'hold' (avoid micro-hunting around zero)
// - otherwise -> 'slew' the playback rate to counter ongoing drift.
export function decideParallaxSinkCorrection(
  driftFrames: number,
  sampleRate: number
): ParallaxSinkCorrection {
  if (!Number.isFinite(driftFrames)) return { mode: 'hold', playbackRatePpm: 0 }
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  const hardSyncFrames = (PARALLAX_HARD_SYNC_MS / 1000) * safeSampleRate
  const magnitude = Math.abs(driftFrames)
  if (magnitude > hardSyncFrames) {
    return { mode: 'snap', playbackRatePpm: 0 }
  }
  if (magnitude < PARALLAX_SYNC_DEADZONE_FRAMES) {
    return { mode: 'hold', playbackRatePpm: 0 }
  }
  return { mode: 'slew', playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2) }
}

export function encodeParallaxAudioPacket(chunk: ParallaxAudioChunk): ArrayBuffer {
  const source = new Uint8Array(chunk.pcmData)
  const payloadBytes = source.byteLength
  const packet = new ArrayBuffer(PARALLAX_AUDIO_PACKET_HEADER_BYTES + payloadBytes)
  const view = new DataView(packet)

  view.setUint32(0, PARALLAX_AUDIO_PACKET_MAGIC, true)
  view.setUint16(4, PARALLAX_AUDIO_PACKET_VERSION, true)
  view.setUint16(6, 0, true)
  view.setUint32(8, Math.max(1, Math.round(chunk.sampleRate)), true)
  view.setUint16(12, Math.max(1, Math.min(8, Math.round(chunk.channels))), true)
  view.setUint16(14, 0, true)
  view.setUint32(16, Math.max(0, Math.floor(chunk.startFrame)), true)
  view.setUint32(20, Math.max(0, Math.floor(chunk.frameCount)), true)
  view.setUint32(24, payloadBytes, true)
  view.setFloat64(28, Number.isFinite(chunk.hostTimeMs) ? chunk.hostTimeMs : 0, true)
  view.setUint32(36, 0, true)
  new Uint8Array(packet, PARALLAX_AUDIO_PACKET_HEADER_BYTES).set(source)

  return packet
}

export function readParallaxAudioPacketHeader(
  bytes: Uint8Array,
  offset: number = 0
): ParallaxAudioPacketHeader | null {
  if (bytes.byteLength - offset < PARALLAX_AUDIO_PACKET_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, PARALLAX_AUDIO_PACKET_HEADER_BYTES)
  if (view.getUint32(0, true) !== PARALLAX_AUDIO_PACKET_MAGIC) return null
  const version = view.getUint16(4, true)
  if (version !== PARALLAX_AUDIO_PACKET_VERSION) return null

  const sampleRate = view.getUint32(8, true)
  const channels = view.getUint16(12, true)
  const frameCount = view.getUint32(20, true)
  const payloadBytes = view.getUint32(24, true)
  const hostTimeMs = view.getFloat64(28, true)
  if (sampleRate < 8_000 || sampleRate > 384_000) return null
  if (channels < 1 || channels > 8) return null
  if (frameCount < 1 || frameCount > PARALLAX_AUDIO_CHUNK_FRAMES) return null
  if (payloadBytes !== frameCount * channels * Float32Array.BYTES_PER_ELEMENT) return null
  if (payloadBytes > PARALLAX_AUDIO_CHUNK_FRAMES * 8 * Float32Array.BYTES_PER_ELEMENT) return null
  if (!Number.isFinite(hostTimeMs) || hostTimeMs < 0) return null

  return {
    version,
    sampleRate,
    channels,
    startFrame: view.getUint32(16, true),
    frameCount,
    hostTimeMs,
    payloadBytes
  }
}

export function decodeParallaxAudioPacket(
  bytes: Uint8Array,
  offset: number = 0
): { chunk: Omit<ParallaxAudioChunk, 'streamId'>; bytesRead: number } | null {
  const header = readParallaxAudioPacketHeader(bytes, offset)
  if (!header) return null
  const packetBytes = PARALLAX_AUDIO_PACKET_HEADER_BYTES + header.payloadBytes
  if (bytes.byteLength - offset < packetBytes) return null

  const payloadStart = offset + PARALLAX_AUDIO_PACKET_HEADER_BYTES
  const payload = bytes.slice(payloadStart, payloadStart + header.payloadBytes)
  return {
    chunk: {
      sampleRate: header.sampleRate,
      channels: header.channels,
      startFrame: header.startFrame,
      frameCount: header.frameCount,
      hostTimeMs: header.hostTimeMs,
      pcmData: payload.buffer
    },
    bytesRead: packetBytes
  }
}
