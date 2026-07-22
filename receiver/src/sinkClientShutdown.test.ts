import assert from 'node:assert/strict'
import test from 'node:test'
import { ParallaxSinkClient } from './sinkClient.ts'
import { createShutdownCoordinator, type ShutdownTimer } from './shutdown.ts'

test('stalled reader cancellation cannot hold receiver shutdown past its deadline', async () => {
  const controller = new AbortController()
  const cancellations: string[] = []
  const never = new Promise<void>(() => undefined)
  const fakeReader = (name: string, result: Promise<void>): ReadableStreamDefaultReader<Uint8Array> => ({
    cancel: () => {
      cancellations.push(name)
      return result
    }
  }) as unknown as ReadableStreamDefaultReader<Uint8Array>
  const statuses: boolean[] = []
  const client = new ParallaxSinkClient({
    onEvent: () => undefined,
    onAudioChunk: () => undefined,
    onStatus: (status) => statuses.push(status.connected),
    onAuthRevoked: () => undefined
  })
  const dispatcherCloseCalls: string[] = []
  ;(client as unknown as { connection: unknown }).connection = {
    baseUrl: 'https://host.invalid',
    sinkId: 'sink',
    token: 'token',
    dispatcher: {
      close: () => {
        dispatcherCloseCalls.push('close')
        return Promise.resolve()
      }
    },
    abortController: controller,
    eventReader: fakeReader('events', never),
    audioReader: fakeReader('audio', Promise.resolve()),
    activeAudioStreamId: 'stream',
    eventGeneration: 1,
    audioGeneration: 1,
    nextAudioReader: fakeReader('next audio', Promise.resolve()),
    nextAudioStreamId: 'next-stream',
    nextAudioGeneration: 1
  }

  const deadlineState: { fire?: () => void } = {}
  const timer: ShutdownTimer = {
    setTimeout: (callback, delayMs) => {
      assert.equal(delayMs, 10_000)
      deadlineState.fire = callback
      return 1
    },
    clearTimeout: () => undefined
  }
  const logs: string[] = []
  let finalized = 0
  const shutdown = createShutdownCoordinator({
    timer,
    log: (message) => logs.push(message),
    exit: () => undefined,
    prepare: [],
    cleanup: [{ name: 'host client', run: () => client.disconnect() }],
    finalizers: [{ name: 'finalizer', run: () => { finalized += 1 } }]
  })

  const shutdownPromise = shutdown('SIGTERM')
  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(cancellations, ['events', 'audio', 'next audio'])
  assert.deepEqual(dispatcherCloseCalls, ['close'])
  assert.equal(statuses.at(-1), false)
  const fireDeadline = deadlineState.fire
  assert.ok(fireDeadline)

  fireDeadline()
  await shutdownPromise

  assert.equal(finalized, 1)
  assert.equal(logs.some((message) => message.includes('unfinished: host client')), true)
})
