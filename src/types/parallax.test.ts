import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildParallaxClockSample,
  decideParallaxSinkCorrection,
  decideParallaxSinkEnabledFromMeta,
  decideParallaxSecurityV2Migration,
  decodeParallaxAudioPacket,
  encodeParallaxAudioPacket,
  fitHostEmitAnchorLine,
  hostEmitAnchorSlopeToPpm,
  mapHostTimeToSinkTimeMs,
  parseParallaxStreamInfo,
  parseParallaxTimelineEvent,
  resolveParallaxPlaybackEnabled,
  resolveParallaxStreamNormalization,
  selectBestParallaxClockSample,
  selectFilteredParallaxClockOffsetMs,
  validateParallaxJoinResponse,
  type ParallaxJoinValidationReason,
  type ParallaxAudioChunk
} from './parallax.ts'

test('Parallax clock sample estimates RTT and host-minus-sink offset', () => {
  const sample = buildParallaxClockSample({
    sinkSentAtMs: 1000,
    hostReceivedAtMs: 1055,
    hostSentAtMs: 1060
  }, 1010)

  assert.equal(sample.rttMs, 10)
  assert.equal(sample.offsetMs, 52.5)
  assert.equal(mapHostTimeToSinkTimeMs(2052.5, sample.offsetMs), 2000)
})

test('Parallax best clock sample prefers lowest RTT and latest tie', () => {
  const samples = [
    { sinkSentAtMs: 0, sinkReceivedAtMs: 20, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 20, offsetMs: 91 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 8, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 8, offsetMs: 97 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 9, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 8, offsetMs: 96.5 }
  ]

  assert.equal(selectBestParallaxClockSample(samples), samples[2])
})

test('Parallax audio packet round-trips chunk metadata and PCM bytes', () => {
  const pcm = new Float32Array([0, 0.5, -0.25, 1])
  const chunk: ParallaxAudioChunk = {
    streamId: 'stream-1',
    sampleRate: 48000,
    channels: 2,
    startFrame: 128,
    frameCount: 2,
    hostTimeMs: 123456.75,
    pcmData: pcm.buffer
  }

  const packet = new Uint8Array(encodeParallaxAudioPacket(chunk))
  const decoded = decodeParallaxAudioPacket(packet)

  assert.ok(decoded)
  assert.equal(decoded.bytesRead, packet.byteLength)
  assert.equal(decoded.chunk.sampleRate, 48000)
  assert.equal(decoded.chunk.channels, 2)
  assert.equal(decoded.chunk.startFrame, 128)
  assert.equal(decoded.chunk.frameCount, 2)
  assert.equal(decoded.chunk.hostTimeMs, 123456.75)
  assert.deepEqual(Array.from(new Float32Array(decoded.chunk.pcmData)), Array.from(pcm))
})

test('Parallax sink correction snaps on large drift, holds in deadzone, slews between', () => {
  // At 48kHz the hard-sync threshold is 0.04 * 48000 = 1920 frames; deadzone is 64 frames.
  assert.deepEqual(decideParallaxSinkCorrection(5000, 48000), { mode: 'snap', playbackRatePpm: 0 })
  assert.deepEqual(decideParallaxSinkCorrection(-5000, 48000), { mode: 'snap', playbackRatePpm: 0 })
  assert.deepEqual(decideParallaxSinkCorrection(10, 48000), { mode: 'hold', playbackRatePpm: 0 })

  // Slew band: ppm follows -drift * 2, clamped to ±1000 (PARALLAX_MAX_SLEW_PPM).
  assert.deepEqual(decideParallaxSinkCorrection(-100, 48000), { mode: 'slew', playbackRatePpm: 200 })
  assert.deepEqual(decideParallaxSinkCorrection(800, 48000), { mode: 'slew', playbackRatePpm: -1000 })

  // Non-finite drift is a no-op; bad sample rate falls back to 48kHz.
  assert.deepEqual(decideParallaxSinkCorrection(Number.NaN, 48000), { mode: 'hold', playbackRatePpm: 0 })
  assert.deepEqual(decideParallaxSinkCorrection(5000, 0), { mode: 'snap', playbackRatePpm: 0 })
})

test('Parallax filtered clock offset medians the lower-RTT half', () => {
  // 6 samples: lower-RTT half (rounded up) = 3 samples with RTTs 6, 8, 9
  //   → their offsets are 100, 99, 110 → sorted 99, 100, 110 → median 100.
  // High-RTT samples (rtt=20, 30, 50) and their offsets (130, 90, 175) are excluded.
  const samples = [
    { sinkSentAtMs: 0, sinkReceivedAtMs: 50, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 50, offsetMs: 175 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 30, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 30, offsetMs: 90  },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 6,  hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 6,  offsetMs: 100 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 9,  hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 9,  offsetMs: 110 },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 8,  hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 8,  offsetMs: 99  },
    { sinkSentAtMs: 0, sinkReceivedAtMs: 20, hostReceivedAtMs: 100, hostSentAtMs: 102, rttMs: 20, offsetMs: 130 }
  ]
  assert.equal(selectFilteredParallaxClockOffsetMs(samples), 100)

  // Edge: empty list → null.
  assert.equal(selectFilteredParallaxClockOffsetMs([]), null)

  // Edge: single sample → that offset (even though we can't filter or median).
  assert.equal(selectFilteredParallaxClockOffsetMs([samples[2]]), 100)

  // Edge: two samples → lower-RTT half rounds up to 1, returns the lower-RTT one's offset (not the median of both).
  assert.equal(selectFilteredParallaxClockOffsetMs([samples[2], samples[0]]), 100)

  // Edge: even-count survivors average the two middles.
  // 4 samples: lower-RTT half = 2 → offsets 99, 100 → average 99.5.
  const four = [samples[2], samples[3], samples[4], samples[0]] // rtts 6, 9, 8, 50; lower 2 = rtt 6 (off 100), rtt 8 (off 99)
  assert.equal(selectFilteredParallaxClockOffsetMs(four), 99.5)

  // Edge: NaN/Infinity samples are filtered out before median.
  const withBad = [
    samples[2],
    { ...samples[3], offsetMs: Number.NaN },
    { ...samples[4], rttMs: Number.POSITIVE_INFINITY }
  ]
  assert.equal(selectFilteredParallaxClockOffsetMs(withBad), 100)

  // Sign preserved: negative offsets pass through unchanged.
  const negative = [
    { ...samples[2], offsetMs: -50 },
    { ...samples[3], offsetMs: -52 }
  ]
  assert.equal(selectFilteredParallaxClockOffsetMs(negative), -50) // lower-RTT half = 1 sample
})

test('Parallax host-emit-anchor Theil-Sen fit recovers slope and intercept under noise + outliers', () => {
  // Synthetic data: host emits at 44100.5 Hz (+11.34 ppm vs 44100), starting at frame 1000 at t=0.
  // slope (frames/ms) = 44100.5 / 1000 = 44.1005.
  const trueSlope = 44.1005
  const trueIntercept = 1000
  const anchors: { hostWallTimeMs: number; sourceFrameAtHostOutput: number }[] = []
  for (let i = 0; i < 50; i += 1) {
    const t = i * 200 // 5 Hz cadence
    const f = trueIntercept + trueSlope * t
    // Tiny jitter on a handful of samples (well under 1 frame); leave the rest exact.
    const noise = (i % 7 === 0) ? 0.3 : 0
    anchors.push({ hostWallTimeMs: t, sourceFrameAtHostOutput: f + noise })
  }
  // Inject 5 outliers (~10%) — Theil-Sen tolerates these.
  for (const idx of [3, 13, 27, 35, 42]) {
    anchors[idx].sourceFrameAtHostOutput += 250
  }
  const line = fitHostEmitAnchorLine(anchors)
  assert.ok(line, 'expected a fit')
  assert.ok(Math.abs(line.slopeFramesPerMs - trueSlope) < 1e-3, `slope ${line.slopeFramesPerMs} vs ${trueSlope}`)
  assert.ok(Math.abs(line.intercept - trueIntercept) < 30, `intercept ${line.intercept} vs ${trueIntercept}`)

  // ppm conversion against nominal 44100.
  const ppm = hostEmitAnchorSlopeToPpm(line.slopeFramesPerMs, 44100)
  assert.ok(Math.abs(ppm - 11.34) < 0.5, `ppm ${ppm} vs ~11.34`)

  // Edge: empty + single-point + non-monotonic times.
  assert.equal(fitHostEmitAnchorLine([]), null)
  assert.equal(fitHostEmitAnchorLine([{ hostWallTimeMs: 0, sourceFrameAtHostOutput: 0 }]), null)
  const stalled = [
    { hostWallTimeMs: 0, sourceFrameAtHostOutput: 0 },
    { hostWallTimeMs: 0, sourceFrameAtHostOutput: 100 } // dt = 0 → pair skipped
  ]
  assert.equal(fitHostEmitAnchorLine(stalled), null)

  // ppm sanity: invalid inputs.
  assert.equal(hostEmitAnchorSlopeToPpm(Number.NaN, 48000), 0)
  assert.equal(hostEmitAnchorSlopeToPpm(48, 0), 0)
  assert.equal(hostEmitAnchorSlopeToPpm(48, 48000), 0) // exactly nominal
})

test('Parallax audio packet waits for complete frame', () => {
  const pcm = new Float32Array([0, 1])
  const packet = new Uint8Array(encodeParallaxAudioPacket({
    streamId: 'stream-1',
    sampleRate: 44100,
    channels: 1,
    startFrame: 0,
    frameCount: 2,
    hostTimeMs: 5000,
    pcmData: pcm.buffer
  }))

  assert.equal(decodeParallaxAudioPacket(packet.slice(0, packet.byteLength - 1)), null)
})

test('Parallax stream normalization preserves finite host gain metadata', () => {
  assert.deepEqual(
    resolveParallaxStreamNormalization({
      normalizationGainDb: -7.25,
      normalizationMode: 'normalization'
    }),
    {
      normalizationGainDb: -7.25,
      normalizationMode: 'normalization'
    }
  )

  assert.deepEqual(
    resolveParallaxStreamNormalization({
      normalizationGainDb: 2.5,
      normalizationMode: 'replaygain'
    }),
    {
      normalizationGainDb: 2.5,
      normalizationMode: 'replaygain'
    }
  )
})

test('Parallax stream normalization defaults missing or malformed metadata to off', () => {
  const expected = {
    normalizationGainDb: 0,
    normalizationMode: 'off'
  }

  assert.deepEqual(resolveParallaxStreamNormalization(undefined), expected)
  assert.deepEqual(resolveParallaxStreamNormalization({}), expected)
  assert.deepEqual(
    resolveParallaxStreamNormalization({
      normalizationGainDb: -6,
      normalizationMode: 'off'
    }),
    expected
  )
  assert.deepEqual(
    resolveParallaxStreamNormalization({
      normalizationGainDb: Number.NaN,
      normalizationMode: 'normalization'
    }),
    expected
  )
  assert.deepEqual(
    resolveParallaxStreamNormalization({
      normalizationGainDb: -6,
      normalizationMode: 'invalid-mode'
    }),
    expected
  )
})

// §20.19(d) migration. Existing persisted sink connection should migrate `parallaxSinkEnabled`
// to true on first read so paired sinks from §14.1.2 keep auto-reconnecting transparently.
test('§20.19(d) migration: existing persisted sink connection → sinkEnabled = true', () => {
  const decision = decideParallaxSinkEnabledFromMeta(null, true)
  assert.equal(decision.enabled, true)
  assert.equal(decision.needsPersist, true, 'first-read migration must persist the new value')
})

test('§20.19(d) migration: no persisted sink connection → sinkEnabled = false', () => {
  const decision = decideParallaxSinkEnabledFromMeta(null, false)
  assert.equal(decision.enabled, false)
  assert.equal(decision.needsPersist, true, 'first read still persists the default so subsequent reads are stable')
})

test('§20.19(d) migration: meta "1" wins regardless of persisted-connection state', () => {
  assert.deepEqual(decideParallaxSinkEnabledFromMeta('1', false), { enabled: true, needsPersist: false })
  assert.deepEqual(decideParallaxSinkEnabledFromMeta('1', true), { enabled: true, needsPersist: false })
})

test('§20.19(d) migration: meta "0" pins false even when a credential exists', () => {
  // User explicitly disabled sink — must NOT auto-re-enable just because a credential exists.
  assert.deepEqual(decideParallaxSinkEnabledFromMeta('0', true), { enabled: false, needsPersist: false })
})

test('§20.19(d) migration: malformed meta collapses to false without persisting', () => {
  // Defensive: unknown values shouldn't trigger the first-read migration write path.
  assert.deepEqual(decideParallaxSinkEnabledFromMeta('garbage', true), { enabled: false, needsPersist: false })
})

test('Parallax v2 migration clears legacy credentials and requests one-time re-pairing', () => {
  assert.deepEqual(
    decideParallaxSecurityV2Migration('1', '[{"id":"old"}]', '{"token":"old"}'),
    { needsMigration: true, showRepairNotice: true }
  )
  assert.deepEqual(
    decideParallaxSecurityV2Migration(null, '[]', ''),
    { needsMigration: true, showRepairNotice: false }
  )
  assert.deepEqual(
    decideParallaxSecurityV2Migration('2', '[{"id":"current"}]', '{"protocolVersion":2}'),
    { needsMigration: false, showRepairNotice: false }
  )
})

test('Parallax audio decoder rejects inconsistent and oversized payload declarations', () => {
  const packet = new Uint8Array(encodeParallaxAudioPacket({
    streamId: 'wire-guard',
    sampleRate: 48_000,
    channels: 2,
    startFrame: 0,
    frameCount: 2,
    hostTimeMs: 1,
    pcmData: new Float32Array(4).buffer
  }))
  const inconsistent = packet.slice()
  new DataView(inconsistent.buffer).setUint32(24, 4, true)
  assert.equal(decodeParallaxAudioPacket(inconsistent), null)

  const oversized = packet.slice()
  new DataView(oversized.buffer).setUint32(20, 4097, true)
  assert.equal(decodeParallaxAudioPacket(oversized), null)
})

test('Parallax stream parser bounds peer metadata and strips host filesystem paths', () => {
  const parsed = parseParallaxStreamInfo({
    streamId: 'stream',
    trackId: 'track',
    trackPath: '/private/music/secret.flac',
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: 2,
    totalFrames: 96_000,
    chunkFrames: 4096,
    groupLatencyMs: 1000,
    createdAt: 1,
    normalizationGainDb: 0,
    normalizationMode: 'off'
  })
  assert.ok(parsed)
  assert.equal('trackPath' in parsed, false)
  assert.equal(parseParallaxStreamInfo({ ...parsed, title: 'x'.repeat(513) }), null)
})

const validJoinStream = {
  streamId: 'active-stream',
  trackId: 'active-track',
  title: 'Active title',
  artist: 'Active artist',
  album: 'Active album',
  sampleRate: 48_000,
  channels: 2,
  durationSeconds: 120,
  totalFrames: 5_760_000,
  chunkFrames: 4096,
  groupLatencyMs: 1000,
  createdAt: 1
}

const validJoinTimeline = {
  streamId: 'active-stream',
  playbackState: 'playing',
  startFrame: 0,
  startHostTimeMs: 100,
  updatedHostTimeMs: 100,
  groupLatencyMs: 1000
}

const validNextJoinStream = {
  ...validJoinStream,
  streamId: 'next-stream',
  trackId: 'next-track',
  title: 'Next title'
}

const validNextJoinTimeline = {
  ...validJoinTimeline,
  streamId: 'next-stream',
  startHostTimeMs: 120_100,
  updatedHostTimeMs: 200
}

function validJoinResponse(): Record<string, unknown> {
  return {
    sinkId: 'living-room',
    groupLatencyMs: 1000,
    hostTimeMs: 100,
    playbackEnabled: true,
    stream: null,
    timeline: null,
    nextStream: null,
    nextTimeline: null
  }
}

test('Parallax join validation reports every failed invariant with stable precedence', () => {
  const cases: Array<{
    name: string
    value: unknown
    expectedSinkId?: string
    reason: ParallaxJoinValidationReason
  }> = [
    { name: 'response is null', value: null, reason: 'response-not-object' },
    { name: 'response is an array', value: [], reason: 'response-not-object' },
    { name: 'sink ID is empty', value: { ...validJoinResponse(), sinkId: '   ' }, reason: 'invalid-sink-id' },
    { name: 'sink ID is oversized', value: { ...validJoinResponse(), sinkId: 'x'.repeat(129) }, reason: 'invalid-sink-id' },
    { name: 'latency is negative', value: { ...validJoinResponse(), groupLatencyMs: -1 }, reason: 'invalid-group-latency-ms' },
    { name: 'latency is non-finite', value: { ...validJoinResponse(), groupLatencyMs: Number.POSITIVE_INFINITY }, reason: 'invalid-group-latency-ms' },
    { name: 'host time exceeds safe range', value: { ...validJoinResponse(), hostTimeMs: Number.MAX_SAFE_INTEGER + 1 }, reason: 'invalid-host-time-ms' },
    { name: 'host time is non-finite', value: { ...validJoinResponse(), hostTimeMs: Number.NaN }, reason: 'invalid-host-time-ms' },
    {
      name: 'active stream fields are malformed',
      value: { ...validJoinResponse(), stream: { ...validJoinStream, sampleRate: 7999 } },
      reason: 'invalid-stream-fields'
    },
    {
      name: 'active timeline fields are malformed',
      value: { ...validJoinResponse(), timeline: { ...validJoinTimeline, playbackState: 'buffering' } },
      reason: 'invalid-timeline-fields'
    },
    {
      name: 'next stream fields are malformed',
      value: { ...validJoinResponse(), nextStream: { ...validNextJoinStream, channels: 0 } },
      reason: 'invalid-next-stream-fields'
    },
    {
      name: 'next timeline fields are malformed',
      value: { ...validJoinResponse(), nextTimeline: { ...validNextJoinTimeline, startFrame: -1 } },
      reason: 'invalid-next-timeline-fields'
    },
    {
      name: 'active stream is missing its timeline',
      value: { ...validJoinResponse(), stream: validJoinStream },
      reason: 'active-presence-mismatch'
    },
    {
      name: 'next timeline is missing its stream',
      value: { ...validJoinResponse(), nextTimeline: validNextJoinTimeline },
      reason: 'next-presence-mismatch'
    },
    {
      name: 'active stream and timeline IDs differ',
      value: {
        ...validJoinResponse(),
        stream: validJoinStream,
        timeline: { ...validJoinTimeline, streamId: 'different-active-stream' }
      },
      reason: 'active-id-mismatch'
    },
    {
      name: 'next stream and timeline IDs differ',
      value: {
        ...validJoinResponse(),
        nextStream: validNextJoinStream,
        nextTimeline: { ...validNextJoinTimeline, streamId: 'different-next-stream' }
      },
      reason: 'next-id-mismatch'
    },
    {
      name: 'response sink differs from requested sink',
      value: validJoinResponse(),
      expectedSinkId: 'kitchen',
      reason: 'sink-id-mismatch'
    },
    {
      name: 'field syntax wins before expected sink mismatch',
      value: { ...validJoinResponse(), groupLatencyMs: -1 },
      expectedSinkId: 'kitchen',
      reason: 'invalid-group-latency-ms'
    }
  ]

  for (const entry of cases) {
    const result = validateParallaxJoinResponse(entry.value, entry.expectedSinkId ?? 'living-room')
    assert.deepEqual(result, { ok: false, reason: entry.reason }, entry.name)
  }
})

test('Parallax join validation accepts field boundaries and complete gapless state', () => {
  const lowerBoundary = validateParallaxJoinResponse({
    sinkId: 'x'.repeat(128),
    groupLatencyMs: 0,
    hostTimeMs: 0,
    stream: null,
    timeline: null
  }, 'x'.repeat(128))
  assert.equal(lowerBoundary.ok, true)

  const upperBoundary = validateParallaxJoinResponse({
    sinkId: 'living-room',
    groupLatencyMs: 60_000,
    hostTimeMs: Number.MAX_SAFE_INTEGER,
    stream: validJoinStream,
    timeline: validJoinTimeline,
    nextStream: validNextJoinStream,
    nextTimeline: validNextJoinTimeline
  }, 'living-room')
  assert.equal(upperBoundary.ok, true)
  if (upperBoundary.ok) {
    assert.equal(upperBoundary.value.stream?.streamId, 'active-stream')
    assert.equal(upperBoundary.value.nextStream?.streamId, 'next-stream')
  }
})

test('Parallax zone-control wire fields are additive and active by default', () => {
  assert.equal(resolveParallaxPlaybackEnabled(undefined), true)
  assert.equal(resolveParallaxPlaybackEnabled(true), true)
  assert.equal(resolveParallaxPlaybackEnabled(false), false)
  const legacyJoin = validateParallaxJoinResponse({
    sinkId: 'living-room',
    groupLatencyMs: 1000,
    hostTimeMs: 100,
    stream: null,
    timeline: null
  }, 'living-room')
  assert.equal(legacyJoin.ok, true)
  if (legacyJoin.ok) assert.equal(legacyJoin.value.playbackEnabled, true)

  const inactiveJoin = validateParallaxJoinResponse({
    sinkId: 'living-room',
    groupLatencyMs: 1000,
    hostTimeMs: 100,
    playbackEnabled: false,
    stream: null,
    timeline: null
  }, 'living-room')
  assert.equal(inactiveJoin.ok, true)
  if (inactiveJoin.ok) assert.equal(inactiveJoin.value.playbackEnabled, false)

  assert.deepEqual(parseParallaxTimelineEvent({
    type: 'sink-playback-update',
    sinkId: 'living-room',
    playbackEnabled: false,
    emittedAtHostTimeMs: 200
  }), {
    type: 'sink-playback-update',
    sinkId: 'living-room',
    playbackEnabled: false,
    emittedAtHostTimeMs: 200
  })
})
