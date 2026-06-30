// §22 Commit 2 — Parallax loopback calibration (renderer-side).
//
// Generates a known calibration signal (log chirp), schedules it through Web Audio, captures
// the loopback output, and cross-correlates to compute `measured_host_output_bias`. Multi-chirp
// run with median + range gate per Codex §22.11(c). Confidence-gated per Codex §22.11(c) —
// low-confidence cycles produce `null`, never guessed values.
//
// Clock-domain invariant (Codex §22.11(a)): the two ends of the measurement live in the SAME
// clock domain — both T_scheduled and T_observed come from `window.parallaxLoopbackAPI.wallNowMs()`
// (steady_clock). NEVER mix in AudioContext.currentTime / performance.now() / getOutputTimestamp().
//
// This module exposes a single `runHostOutputCalibration()` entry point. Commit 3 will wire it
// behind a Settings dev-mode button; for now it's callable from devtools as
// `window.parallaxCalibration.run()`.

// ============================================================================
// Constants (per share §22.6 / §22.11(c) / §22.11(d))
// ============================================================================

const CHIRP_DURATION_MS = 50
const CHIRP_START_HZ = 200
const CHIRP_END_HZ = 8000
const CHIRP_AMPLITUDE = 0.178             // ≈ −15 dBFS linear — bumped from -20 for SNR margin
const CHIRP_FADE_MS = 5                    // edge fade per Codex
const CHIRP_REPEAT_COUNT = 3
const CHIRP_REPEAT_INTERVAL_MS = 150
const CAPTURE_WINDOW_MS = 400              // collect captures this long after scheduling
const SCHEDULE_LEAD_MS = 30                // Web Audio scheduling lead — small but non-zero
const CONFIDENCE_THRESHOLD = 0.7           // normalized correlation peak ≥ this counts as valid
const RANGE_THRESHOLD_MS = 10.0            // v1 data-collection threshold — Codex spec calls
                                            // 2-3 ms the GOAL after we've seen real Windows
                                            // hardware data. Loosened to capture restart-vs-
                                            // restart stability data; tighten once validation
                                            // shows what's achievable on typical Windows audio.
const MIN_VALID_CHIRPS = 2                 // need ≥ this many valid chirps to produce a measurement

// ============================================================================
// Public API
// ============================================================================

export interface SingleChirpMeasurement {
  scheduledWallMs: number       // T_scheduled — when we called `start()` on the Web Audio node
  observedWallMs: number | null // T_observed — when the chirp peaked in loopback, or null if no match
  observedLatencyMs: number | null
  confidence: number            // 0–1, normalized correlation peak height
  peakLagSamples: number | null
  rejected: boolean
  rejectReason?: string
  // Diagnostics (Commit 2 debugging): visibility into the capture buffer itself, so a "no peak"
  // result can be distinguished between "loopback empty" and "loopback has audio but correlator
  // failed."
  captureFrames: number
  captureRms: number            // RMS amplitude across the capture window (≈0 means silent)
  captureMaxAbs: number         // max(|sample|) across the capture window
}

export interface CalibrationResult {
  ok: boolean
  measuredLatencyMs: number | null   // median of valid chirps; null on reject
  rangeMs: number | null             // max − min across valid chirps
  meanConfidence: number             // mean correlation peak across valid chirps
  validChirpCount: number
  totalChirpCount: number
  estimatedLatencyMs: number         // AudioContext.outputLatency + baseLatency in ms (for comparison)
  endpoint: {
    deviceId: string
    deviceName: string
    sampleRate: number
    channelCount: number
  } | null
  chirps: SingleChirpMeasurement[]
  rejectReason?: string
}

export async function runHostOutputCalibration(audioContext: AudioContext): Promise<CalibrationResult> {
  const api = window.parallaxLoopbackAPI
  const support = api?.isSupported()
  if (!api || !support?.supported) {
    return rejectResult({
      reason: support?.reason ?? 'parallax loopback unsupported',
      audioContext
    })
  }

  // Bring up loopback first so any captures from the lead-time before the first chirp don't
  // hit a cold pipeline. Discarded by drain() below.
  const startResult = api.start()
  if (!startResult.ok) {
    return rejectResult({ reason: startResult.error ?? 'loopback start failed', audioContext })
  }
  const endpoint = startResult.endpoint ?? null

  // Warm-up drain to clear anything captured before our first chirp.
  await delay(100)
  api.drain()

  const chirps: SingleChirpMeasurement[] = []
  try {
    const chirpSamples = generateLogChirp({
      durationMs: CHIRP_DURATION_MS,
      startHz: CHIRP_START_HZ,
      endHz: CHIRP_END_HZ,
      amplitude: CHIRP_AMPLITUDE,
      fadeMs: CHIRP_FADE_MS,
      sampleRate: audioContext.sampleRate
    })

    for (let i = 0; i < CHIRP_REPEAT_COUNT; i += 1) {
      const measurement = await runSingleChirp({
        api,
        audioContext,
        chirpSamples,
        captureSampleRate: endpoint?.sampleRate ?? Math.round(audioContext.sampleRate)
      })
      chirps.push(measurement)
      if (i < CHIRP_REPEAT_COUNT - 1) {
        await delay(CHIRP_REPEAT_INTERVAL_MS)
      }
    }
  } finally {
    api.stop()
  }

  const estimatedLatencyMs = computeEstimatedLatencyMs(audioContext)

  const validChirps = chirps.filter((c) => !c.rejected && c.observedLatencyMs !== null && c.confidence >= CONFIDENCE_THRESHOLD)
  if (validChirps.length < MIN_VALID_CHIRPS) {
    return {
      ok: false,
      measuredLatencyMs: null,
      rangeMs: null,
      meanConfidence: meanOf(chirps.map((c) => c.confidence)),
      validChirpCount: validChirps.length,
      totalChirpCount: chirps.length,
      estimatedLatencyMs,
      endpoint,
      chirps,
      rejectReason: `only ${validChirps.length}/${chirps.length} chirps cleared confidence ≥ ${CONFIDENCE_THRESHOLD}`
    }
  }

  const latencies = validChirps.map((c) => c.observedLatencyMs as number).sort((l, r) => l - r)
  const range = latencies[latencies.length - 1] - latencies[0]
  if (range > RANGE_THRESHOLD_MS) {
    return {
      ok: false,
      measuredLatencyMs: null,
      rangeMs: range,
      meanConfidence: meanOf(validChirps.map((c) => c.confidence)),
      validChirpCount: validChirps.length,
      totalChirpCount: chirps.length,
      estimatedLatencyMs,
      endpoint,
      chirps,
      rejectReason: `chirp range ${range.toFixed(2)} ms exceeds ${RANGE_THRESHOLD_MS} ms threshold`
    }
  }

  const median = latencies[Math.floor(latencies.length / 2)]
  return {
    ok: true,
    measuredLatencyMs: median,
    rangeMs: range,
    meanConfidence: meanOf(validChirps.map((c) => c.confidence)),
    validChirpCount: validChirps.length,
    totalChirpCount: chirps.length,
    estimatedLatencyMs,
    endpoint,
    chirps
  }
}

// ============================================================================
// Per-chirp execution
// ============================================================================

interface RunSingleChirpArgs {
  api: NonNullable<typeof window.parallaxLoopbackAPI>
  audioContext: AudioContext
  chirpSamples: Float32Array
  captureSampleRate: number
}

async function runSingleChirp(args: RunSingleChirpArgs): Promise<SingleChirpMeasurement> {
  const { api, audioContext, chirpSamples, captureSampleRate } = args

  // The Web Audio graph is at audioContext.sampleRate. The loopback capture is at the OS
  // device's sample rate. These are normally the same on modern Windows, but resample on
  // mismatch so the correlator sees the chirp at the capture rate.
  let referenceChirp = chirpSamples
  if (Math.abs(captureSampleRate - audioContext.sampleRate) > 0.5) {
    referenceChirp = linearResample(chirpSamples, audioContext.sampleRate, captureSampleRate)
  }

  // Build the AudioBufferSourceNode FIRST — its construction time isn't part of the bias.
  // Then take the wall-clock anchor AT the moment we call .start(), which is the closest we
  // can get to "now we asked Web Audio to play this."
  const stereoBuffer = audioContext.createBuffer(2, chirpSamples.length, audioContext.sampleRate)
  // Copy via channel data set rather than `copyToChannel` — the latter has a strict
  // `Float32Array<ArrayBuffer>` parameter type that doesn't match the buffer-agnostic
  // Float32Array we generated above. Direct set is equivalent and simpler.
  stereoBuffer.getChannelData(0).set(chirpSamples)
  stereoBuffer.getChannelData(1).set(chirpSamples)
  const source = audioContext.createBufferSource()
  source.buffer = stereoBuffer
  source.connect(audioContext.destination)

  const startCtxTime = audioContext.currentTime + SCHEDULE_LEAD_MS / 1000
  const scheduledWallMs = api.wallNowMs()
  source.start(startCtxTime)

  // Collect captures for a window long enough to see the chirp arrive.
  const captureWaitMs = SCHEDULE_LEAD_MS + CHIRP_DURATION_MS + CAPTURE_WINDOW_MS
  await delay(captureWaitMs)

  const segments = api.drain()
  if (segments.length === 0) {
    return {
      scheduledWallMs,
      observedWallMs: null,
      observedLatencyMs: null,
      confidence: 0,
      peakLagSamples: null,
      rejected: true,
      rejectReason: 'no captured segments',
      captureFrames: 0,
      captureRms: 0,
      captureMaxAbs: 0
    }
  }

  // Glue captured segments into one contiguous mono buffer for correlation. Take channel 0.
  const channelCount = segments[0].channelCount
  let totalFrames = 0
  for (const seg of segments) totalFrames += seg.frameCount
  const captureMono = new Float32Array(totalFrames)
  let writeOffset = 0
  const segmentFrameOffsets: Array<{ wallMs: number; firstFrameInGlued: number }> = []
  for (const seg of segments) {
    segmentFrameOffsets.push({ wallMs: seg.captureWallMs, firstFrameInGlued: writeOffset })
    for (let i = 0; i < seg.frameCount; i += 1) {
      captureMono[writeOffset + i] = seg.pcm[i * channelCount]
    }
    writeOffset += seg.frameCount
  }

  // Diagnostic energy probes (added Commit 2 debug pass). Distinguishes "loopback returned a
  // silent buffer" from "loopback returned audio but correlator missed it."
  let energySum = 0
  let maxAbs = 0
  for (let i = 0; i < captureMono.length; i += 1) {
    const v = captureMono[i]
    energySum += v * v
    const a = v < 0 ? -v : v
    if (a > maxAbs) maxAbs = a
  }
  const captureRms = captureMono.length > 0 ? Math.sqrt(energySum / captureMono.length) : 0

  // Cross-correlate the reference chirp against the captured mono signal.
  const corr = crossCorrelate(referenceChirp, captureMono)
  if (corr.peakLagSamples === null || corr.peakConfidence < 1e-6) {
    return {
      scheduledWallMs,
      observedWallMs: null,
      observedLatencyMs: null,
      confidence: 0,
      peakLagSamples: null,
      rejected: true,
      rejectReason: corr.peakLagSamples === null
        ? `correlator returned no peak (capture frames=${captureMono.length}, rms=${captureRms.toExponential(2)}, maxAbs=${maxAbs.toExponential(2)})`
        : 'correlator peak below floor',
      captureFrames: captureMono.length,
      captureRms,
      captureMaxAbs: maxAbs
    }
  }

  // Translate peak position back into wall time using the per-segment captureWallMs anchors.
  // The segment whose `firstFrameInGlued` is the largest value ≤ peakLagSamples carries the
  // captureWallMs we anchor against.
  let segIdx = segmentFrameOffsets.length - 1
  for (let i = 0; i < segmentFrameOffsets.length; i += 1) {
    if (segmentFrameOffsets[i].firstFrameInGlued > corr.peakLagSamples) {
      segIdx = i - 1
      break
    }
  }
  if (segIdx < 0) segIdx = 0
  const seg = segmentFrameOffsets[segIdx]
  const framesIntoSegment = corr.peakLagSamples - seg.firstFrameInGlued
  const observedWallMs = seg.wallMs + (framesIntoSegment / captureSampleRate) * 1000

  return {
    scheduledWallMs,
    observedWallMs,
    observedLatencyMs: observedWallMs - scheduledWallMs,
    confidence: corr.peakConfidence,
    peakLagSamples: corr.peakLagSamples,
    rejected: false,
    captureFrames: captureMono.length,
    captureRms,
    captureMaxAbs: maxAbs
  }
}

// ============================================================================
// Chirp generation
// ============================================================================

interface ChirpOptions {
  durationMs: number
  startHz: number
  endHz: number
  amplitude: number
  fadeMs: number
  sampleRate: number
}

function generateLogChirp(opts: ChirpOptions): Float32Array {
  const totalSamples = Math.floor((opts.durationMs / 1000) * opts.sampleRate)
  const fadeSamples = Math.floor((opts.fadeMs / 1000) * opts.sampleRate)
  const out = new Float32Array(totalSamples)

  // Log chirp: f(t) = f0 * (f1/f0)^(t/T)
  // Phase: φ(t) = 2π * f0 * T / ln(f1/f0) * ((f1/f0)^(t/T) - 1)
  const f0 = opts.startHz
  const f1 = opts.endHz
  const T = opts.durationMs / 1000
  const k = Math.log(f1 / f0)
  const phaseScale = (2 * Math.PI * f0 * T) / k

  for (let n = 0; n < totalSamples; n += 1) {
    const t = n / opts.sampleRate
    const phase = phaseScale * (Math.exp(k * (t / T)) - 1)
    let sample = opts.amplitude * Math.sin(phase)
    // Edge fades to avoid click-on/click-off artifacts that would smear the correlation peak.
    if (n < fadeSamples) {
      sample *= n / fadeSamples
    } else if (n >= totalSamples - fadeSamples) {
      sample *= (totalSamples - 1 - n) / fadeSamples
    }
    out[n] = sample
  }
  return out
}

// ============================================================================
// Cross-correlation (sliding time-domain dot product, normalized peak)
// ============================================================================
//
// Given a reference signal `ref` of length M and an observed signal `obs` of length N (M < N),
// returns the lag at which `obs[lag .. lag+M-1]` best matches `ref`. "Best" = peak of the
// normalized cross-correlation. Confidence = peak / sqrt(refEnergy * obsWindowEnergy).
//
// Time complexity O(N * M) ≈ 50M ops for our window sizes. Fine for a one-shot run; the
// validation pass doesn't need FFT-based speed.

interface CorrelationResult {
  peakLagSamples: number | null
  peakConfidence: number
}

function crossCorrelate(ref: Float32Array, obs: Float32Array): CorrelationResult {
  if (ref.length === 0 || obs.length <= ref.length) {
    return { peakLagSamples: null, peakConfidence: 0 }
  }
  let refEnergy = 0
  for (let i = 0; i < ref.length; i += 1) refEnergy += ref[i] * ref[i]
  if (refEnergy <= 1e-12) return { peakLagSamples: null, peakConfidence: 0 }
  const sqrtRefEnergy = Math.sqrt(refEnergy)

  // Track the peak by absolute value — handles polarity-inverted audio paths (some Windows
  // drivers / USB interfaces deliver a 180°-flipped copy on loopback). Confidence is the
  // absolute normalized correlation.
  let peakLag = -1
  let peakNormalizedAbs = 0
  const maxLag = obs.length - ref.length
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let dot = 0
    let obsEnergy = 0
    for (let i = 0; i < ref.length; i += 1) {
      const r = ref[i]
      const o = obs[lag + i]
      dot += r * o
      obsEnergy += o * o
    }
    if (obsEnergy <= 1e-12) continue
    const normalized = dot / (sqrtRefEnergy * Math.sqrt(obsEnergy))
    const absNormalized = normalized < 0 ? -normalized : normalized
    if (absNormalized > peakNormalizedAbs) {
      peakNormalizedAbs = absNormalized
      peakLag = lag
    }
  }
  return {
    peakLagSamples: peakLag >= 0 ? peakLag : null,
    peakConfidence: peakNormalizedAbs
  }
}

// ============================================================================
// Small helpers
// ============================================================================

function linearResample(input: Float32Array, fromHz: number, toHz: number): Float32Array {
  const outLength = Math.round((input.length * toHz) / fromHz)
  const out = new Float32Array(outLength)
  const ratio = fromHz / toHz
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = i * ratio
    const idx0 = Math.floor(srcIdx)
    const idx1 = Math.min(idx0 + 1, input.length - 1)
    const frac = srcIdx - idx0
    out[i] = input[idx0] * (1 - frac) + input[idx1] * frac
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function meanOf(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function computeEstimatedLatencyMs(audioContext: AudioContext): number {
  // Same number the current control loop trusts — kept here for side-by-side comparison in
  // the CalibrationResult. v1 does NOT use it for scheduling decisions; this is for the
  // validation diff per share §22.4.
  return ((audioContext.outputLatency ?? 0) + (audioContext.baseLatency ?? 0)) * 1000
}

function rejectResult(args: { reason: string; audioContext: AudioContext }): CalibrationResult {
  return {
    ok: false,
    measuredLatencyMs: null,
    rangeMs: null,
    meanConfidence: 0,
    validChirpCount: 0,
    totalChirpCount: 0,
    estimatedLatencyMs: computeEstimatedLatencyMs(args.audioContext),
    endpoint: null,
    chirps: [],
    rejectReason: args.reason
  }
}
