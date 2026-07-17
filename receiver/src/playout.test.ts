import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ParallaxAudioChunk } from '../../src/types/parallax'
import { NullOutput } from './output/nullOutput'
import { PlayoutDriver, SinkPlayoutEngine } from './playout'

const DEVICE_RATE = 48000

function makeChunk(
  streamId: string,
  startFrame: number,
  frameCount: number,
  channels = 2,
  sampleRate = DEVICE_RATE,
  fill?: (frame: number, channel: number) => number
): ParallaxAudioChunk {
  const interleaved = new Float32Array(frameCount * channels)
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      interleaved[frame * channels + channel] = fill
        ? fill(startFrame + frame, channel)
        : (startFrame + frame) / 1_000_000
    }
  }
  return {
    streamId,
    sampleRate,
    channels,
    startFrame,
    frameCount,
    hostTimeMs: 1,
    pcmData: interleaved.buffer
  }
}

function makeEngine(sourceRate = DEVICE_RATE): SinkPlayoutEngine {
  const engine = new SinkPlayoutEngine(DEVICE_RATE, 2)
  engine.configureStream({
    streamId: 's1',
    sourceSampleRate: sourceRate,
    channels: 2,
    normalizationGainDb: 0
  })
  return engine
}

test('renders appended chunks from the timeline anchor', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 4096))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(256 * 2)
  engine.render(out, 256, 0)
  assert.equal(out[0], 0)
  assert.ok(Math.abs(out[2] - 1 / 1_000_000) < 1e-12, 'second frame reads source frame 1')
  assert.equal(engine.getSnapshot().currentFrame, 256)
})

test('pre-roll holds the cursor until startAtOutputFrame', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 4096))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 100, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(256 * 2)
  engine.render(out, 256, 0)
  // First 100 output frames are silent pre-roll; cursor advanced only 156 frames.
  assert.equal(out[0], 0)
  assert.equal(engine.getSnapshot().currentFrame, 156)
})

test('resampling: fractional cursor advances at sourceRate/deviceRate', () => {
  const engine = makeEngine(44100)
  engine.appendChunk(makeChunk('s1', 0, 4096, 2, 44100))
  engine.appendChunk(makeChunk('s1', 4096, 4096, 2, 44100))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(4800 * 2)
  engine.render(out, 4800, 0)
  // 4800 output frames at 44100/48000 = 4410 source frames (±1 for float accumulation).
  const expected = 4800 * (44100 / 48000)
  const cursor = engine.getSnapshot().currentFrame
  assert.ok(Math.abs(cursor - expected) <= 1, `cursor ${cursor} ≈ ${expected}`)
})

test('slew: ppm nudges the playback rate', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 4096))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)
  engine.setRatePpm(1000)

  const out = new Float32Array(4000 * 2)
  engine.render(out, 4000, 0)
  // 4000 output frames at (1 + 1000 ppm) → ~4004 source frames; ppm=0 would give exactly 4000.
  const cursor = engine.getSnapshot().currentFrame
  assert.ok(cursor >= 4003 && cursor <= 4004, `slew advanced the cursor (${cursor})`)
  assert.equal(engine.getSnapshot().playbackRatePpm, 1000)
})

test('slew clamps to ±1000 ppm', () => {
  const engine = makeEngine()
  engine.setRatePpm(5000)
  assert.equal(engine.getSnapshot().playbackRatePpm, 1000)
  engine.setRatePpm(-5000)
  assert.equal(engine.getSnapshot().playbackRatePpm, -1000)
})

test('gap in buffered chunks skips, not starves', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 1000))
  engine.appendChunk(makeChunk('s1', 2000, 1000))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(1500 * 2)
  engine.render(out, 1500, 0)
  const snapshot = engine.getSnapshot()
  // After consuming 0..999 the cursor jumps to 2000 and keeps playing.
  assert.ok(snapshot.currentFrame >= 2000, `cursor jumped the gap (${snapshot.currentFrame})`)
  assert.equal(snapshot.rebuffering, false)
})

test('sustained starvation self-pauses into rebuffering', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 1000))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  // 1000 real frames + more than 0.25 * 48000 starved frames.
  const frames = 1000 + Math.ceil(0.25 * DEVICE_RATE) + 100
  const out = new Float32Array(frames * 2)
  engine.render(out, frames, 0)
  const snapshot = engine.getSnapshot()
  assert.equal(snapshot.rebuffering, true)
  assert.equal(snapshot.playing, false)
  // Cursor froze at the end of the buffered audio instead of free-running.
  assert.equal(snapshot.currentFrame, 1000)
})

test('a fresh timeline clears rebuffering (rebuffer_snap re-anchor)', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('s1', 0, 1000))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)
  const starveFrames = 1000 + Math.ceil(0.25 * DEVICE_RATE) + 100
  engine.render(new Float32Array(starveFrames * 2), starveFrames, 0)
  assert.equal(engine.getSnapshot().rebuffering, true)

  engine.appendChunk(makeChunk('s1', 48000, 4096))
  engine.setTimeline({ startFrame: 48000, startAtOutputFrame: starveFrames, playing: true, playbackRatePpm: 0 }, starveFrames)
  const snapshot = engine.getSnapshot()
  assert.equal(snapshot.rebuffering, false)
  assert.equal(snapshot.playing, true)
  assert.equal(snapshot.currentFrame, 48000)
})

test('normalization gain and volume scale the output', () => {
  const engine = new SinkPlayoutEngine(DEVICE_RATE, 2)
  engine.configureStream({
    streamId: 's1',
    sourceSampleRate: DEVICE_RATE,
    channels: 2,
    normalizationGainDb: -6
  })
  engine.setVolumePercent(50)
  engine.appendChunk(makeChunk('s1', 0, 256, 2, DEVICE_RATE, () => 1))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(16 * 2)
  engine.render(out, 16, 0)
  const expected = 0.5 * Math.pow(10, -6 / 20)
  assert.ok(Math.abs(out[0] - expected) < 1e-6, `gain applied (${out[0]} vs ${expected})`)
})

test('mono source duplicates into both output channels', () => {
  const engine = new SinkPlayoutEngine(DEVICE_RATE, 2)
  engine.configureStream({
    streamId: 's1',
    sourceSampleRate: DEVICE_RATE,
    channels: 1,
    normalizationGainDb: 0
  })
  engine.appendChunk(makeChunk('s1', 0, 256, 1, DEVICE_RATE, () => 0.25))
  engine.setTimeline({ startFrame: 0, startAtOutputFrame: 0, playing: true, playbackRatePpm: 0 }, 0)

  const out = new Float32Array(4 * 2)
  engine.render(out, 4, 0)
  assert.ok(Math.abs(out[0] - 0.25) < 1e-6)
  assert.ok(Math.abs(out[1] - 0.25) < 1e-6)
})

test('chunks for other streams are ignored', () => {
  const engine = makeEngine()
  engine.appendChunk(makeChunk('other', 0, 1000))
  assert.equal(engine.getSnapshot().bufferedEndFrame, 0)
})

test('driver keeps the backend queue at the target and maps wall time to output frames', () => {
  let now = 1_000_000
  const nowMs = () => now
  const backend = new NullOutput({ sampleRate: DEVICE_RATE, channels: 2, nowMs })
  const engine = new SinkPlayoutEngine(DEVICE_RATE, 2)
  const driver = new PlayoutDriver({ backend, engine, targetBufferMs: 120, nowMs })

  driver.tick()
  const target = Math.round(0.12 * DEVICE_RATE)
  assert.equal(backend.bufferedFrames(), target)
  assert.equal(backend.framesWritten(), target)

  // 60 ms pass: the device consumed ~2880 frames; the next tick refills to the target.
  now += 60
  const consumed = Math.floor(0.06 * DEVICE_RATE)
  assert.equal(backend.bufferedFrames(), target - consumed)
  driver.tick()
  assert.equal(backend.bufferedFrames(), target)

  // Emission mapping: the consumption head emits "now"; a wall instant 1 s out lands one
  // sample-rate's worth of frames past the head.
  const head = backend.framesWritten() - backend.bufferedFrames()
  assert.equal(driver.outputFrameForWallTime(now), head)
  assert.equal(driver.outputFrameForWallTime(now + 1000), head + DEVICE_RATE)
  assert.ok(Math.abs(driver.currentLatencyMs() - 120) < 1)
})
