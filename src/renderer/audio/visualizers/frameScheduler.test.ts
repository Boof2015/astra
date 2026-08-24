import { strict as assert } from 'node:assert'
import test from 'node:test'
import { FrameScheduler } from './frameScheduler.ts'

type RafCallback = (timestamp: number) => void

function withFakeAnimationFrames(runTest: (runFrame: (timestamp: number) => void) => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let nextFrameId = 1
  const callbacks = new Map<number, RafCallback>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame: (callback: RafCallback) => {
        const frameId = nextFrameId++
        callbacks.set(frameId, callback)
        return frameId
      },
      cancelAnimationFrame: (frameId: number) => callbacks.delete(frameId),
    },
  })

  try {
    runTest((timestamp) => {
      const next = callbacks.entries().next().value as [number, RafCallback] | undefined
      assert.ok(next, 'expected a scheduled animation frame')
      callbacks.delete(next[0])
      next[1](timestamp)
    })
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('default display-sync dispatch avoids FPS-window bookkeeping until requested', () => {
  withFakeAnimationFrames((runFrame) => {
    const scheduler = new FrameScheduler()
    let dispatches = 0
    const unsubscribe = scheduler.subscribe(() => { dispatches += 1 })

    runFrame(0)
    runFrame(16)
    runFrame(32)
    const state = scheduler as unknown as { dispatchTimestamps: number[] }
    assert.equal(dispatches, 3)
    assert.equal(state.dispatchTimestamps.length, 0)

    assert.equal(scheduler.getActualFps(), 0)
    runFrame(48)
    runFrame(64)
    assert.equal(state.dispatchTimestamps.length, 2)
    assert.ok(scheduler.getActualFps() > 60)
    unsubscribe()
  })
})

test('fixed frame targets use a scalar dispatch timestamp when telemetry is idle', () => {
  withFakeAnimationFrames((runFrame) => {
    const scheduler = new FrameScheduler({ frameTarget: 30 })
    let dispatches = 0
    const unsubscribe = scheduler.subscribe(() => { dispatches += 1 })

    for (const timestamp of [0, 16, 34, 50, 68]) {
      runFrame(timestamp)
    }

    const state = scheduler as unknown as { dispatchTimestamps: number[] }
    assert.equal(dispatches, 3)
    assert.equal(state.dispatchTimestamps.length, 0)
    unsubscribe()
  })
})
