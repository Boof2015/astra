import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParallaxTimelineEvent } from '../../src/types/parallax.ts'
import type { OutputBackend } from './output/types.ts'
import type { ParallaxSinkClient } from './sinkClient.ts'
import { SinkSession } from './sinkSession.ts'

function makeBackend(): OutputBackend {
  return {
    deviceId: 'speaker-default',
    deviceLabel: 'Test output',
    sampleRate: 48_000,
    channels: 2,
    write: (_interleaved, frames) => frames,
    framesWritten: () => 0,
    bufferedFrames: () => 0,
    underruns: () => 0,
    close: () => undefined
  }
}

function trimEvent(advanceMs: number): Extract<ParallaxTimelineEvent, { type: 'sink-trim-update' }> {
  return {
    type: 'sink-trim-update',
    sinkId: 'living-room',
    outputDeviceId: 'speaker-default',
    advanceMs,
    emittedAtHostTimeMs: Date.now()
  }
}

test('Pi trim events coalesce to one pending realignment at the latest value', () => {
  const session = new SinkSession(makeBackend())
  session.attachClient({} as ParallaxSinkClient, 'living-room')

  session.handleEvent(trimEvent(1))
  session.handleEvent(trimEvent(2))
  session.handleEvent(trimEvent(7))

  const internals = session as unknown as { advanceMs: number; trimRealignPending: boolean }
  assert.equal(internals.advanceMs, 7)
  assert.equal(internals.trimRealignPending, true)

  session.handleEvent({
    type: 'stop',
    streamId: 'tone',
    emittedAtHostTimeMs: Date.now()
  })
  assert.equal(internals.trimRealignPending, false)
})

test('Pi trim acceptance stays keyed to the active output device', () => {
  const session = new SinkSession(makeBackend())
  session.attachClient({} as ParallaxSinkClient, 'living-room')
  session.handleEvent({ ...trimEvent(25), outputDeviceId: 'stale-device' })

  const internals = session as unknown as { advanceMs: number; trimRealignPending: boolean }
  assert.equal(internals.advanceMs, 0)
  assert.equal(internals.trimRealignPending, false)
})
