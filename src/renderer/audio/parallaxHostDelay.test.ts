import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine } from './AudioEngine.ts'

interface FakeSource {
  buffer: AudioBuffer | null
  onended: (() => void) | null
  starts: Array<{ when: number; offset: number }>
  start: (when: number, offset: number) => void
}

interface DelayTestEngine {
  context: Pick<AudioContext, 'currentTime' | 'createBufferSource'>
  audioBuffer: Pick<AudioBuffer, 'duration' | 'numberOfChannels'>
  sourceNode: FakeSource | null
  playbackOutputMode: 'standard'
  _playbackState: 'playing'
  pauseTime: number
  startTime: number
  stopSource: () => void
  cancelScheduledNext: () => void
  connectSourceWithRouting: () => void
  connectSourceToAnalysisTap: () => void
}

function createPendingStartEngine(): {
  engine: AudioEngine
  replacementSource: FakeSource
  stopped: () => boolean
} {
  const engine = new AudioEngine()
  const replacementSource: FakeSource = {
    buffer: null,
    onended: null,
    starts: [],
    start(when, offset) {
      this.starts.push({ when, offset })
    }
  }
  let oldSourceStopped = false
  const internals = engine as unknown as DelayTestEngine
  internals.context = {
    currentTime: 10,
    createBufferSource: () => replacementSource as unknown as AudioBufferSourceNode
  }
  internals.audioBuffer = { duration: 180, numberOfChannels: 2 }
  internals.sourceNode = {
    buffer: internals.audioBuffer as AudioBuffer,
    onended: null,
    starts: [],
    start: () => undefined
  }
  internals.playbackOutputMode = 'standard'
  internals._playbackState = 'playing'
  internals.pauseTime = 12
  // Scheduled source onset = startTime + offset = 15, five seconds in the future.
  internals.startTime = 3
  internals.stopSource = () => {
    oldSourceStopped = true
    internals.sourceNode = null
  }
  internals.cancelScheduledNext = () => undefined
  internals.connectSourceWithRouting = () => undefined
  internals.connectSourceToAnalysisTap = () => undefined
  return { engine, replacementSource, stopped: () => oldSourceStopped }
}

test('last inactive Parallax zone releases a still-pending local group start', () => {
  const { engine, replacementSource, stopped } = createPendingStartEngine()

  assert.equal(engine.releasePendingParallaxHostStartDelay(), true)
  assert.equal(stopped(), true)
  assert.deepEqual(replacementSource.starts, [{ when: 10, offset: 12 }])
  assert.equal((engine as unknown as DelayTestEngine).startTime, -2)
})

test('zone changes do not restart host audio after its scheduled start has begun', () => {
  const { engine, replacementSource, stopped } = createPendingStartEngine()
  const internals = engine as unknown as DelayTestEngine
  internals.startTime = -2

  assert.equal(engine.releasePendingParallaxHostStartDelay(), false)
  assert.equal(stopped(), false)
  assert.deepEqual(replacementSource.starts, [])
})
