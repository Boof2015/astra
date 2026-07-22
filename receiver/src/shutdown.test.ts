import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createShutdownCoordinator,
  type ShutdownTimer
} from './shutdown.ts'

class ManualTimer implements ShutdownTimer {
  private nowMs = 0
  private nextId = 1
  private readonly scheduled = new Map<number, { atMs: number; callback: () => void }>()

  get size(): number {
    return this.scheduled.size
  }

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId
    this.nextId += 1
    this.scheduled.set(id, { atMs: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.scheduled.delete(Number(handle))
  }

  advance(delayMs: number): void {
    this.nowMs += delayMs
    const due = [...this.scheduled.entries()]
      .filter(([, timer]) => timer.atMs <= this.nowMs)
      .sort((left, right) => left[1].atMs - right[1].atMs)
    for (const [id, timer] of due) {
      if (!this.scheduled.delete(id)) continue
      timer.callback()
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('shutdown cleanup finishes normally and cancels the internal deadline', async () => {
  const timer = new ManualTimer()
  const calls: string[] = []
  const logs: string[] = []
  const shutdown = createShutdownCoordinator({
    deadlineMs: 10_000,
    timer,
    log: (message) => logs.push(message),
    exit: (code) => calls.push(`exit:${code}`),
    prepare: [{ name: 'prepare', run: () => calls.push('prepare') }],
    cleanup: [
      { name: 'one', run: async () => { calls.push('cleanup:one') } },
      { name: 'two', run: async () => { calls.push('cleanup:two') } }
    ],
    finalizers: [{ name: 'finalize', run: () => calls.push('finalize') }]
  })

  await shutdown('SIGTERM')

  assert.deepEqual(calls, ['prepare', 'cleanup:one', 'cleanup:two', 'finalize', 'exit:0'])
  assert.equal(timer.size, 0)
  assert.equal(logs.some((message) => message.includes('deadline expired')), false)
})

test('shutdown deadline identifies unfinished cleanup and finalizes exactly once', async () => {
  const timer = new ManualTimer()
  const calls: string[] = []
  const logs: string[] = []
  const never = new Promise<void>(() => undefined)
  const shutdown = createShutdownCoordinator({
    deadlineMs: 10_000,
    timer,
    log: (message) => logs.push(message),
    exit: (code) => calls.push(`exit:${code}`),
    prepare: [{ name: 'prepare', run: () => calls.push('prepare') }],
    cleanup: [
      { name: 'fast component', run: async () => { calls.push('cleanup:fast') } },
      { name: 'stalled component', run: () => { calls.push('cleanup:stalled'); return never } }
    ],
    finalizers: [
      { name: 'first', run: () => calls.push('finalize:first') },
      { name: 'second', run: () => calls.push('finalize:second') }
    ]
  })

  const first = shutdown('web restart')
  const repeated = shutdown('SIGTERM')
  assert.equal(first, repeated)
  assert.deepEqual(calls, ['prepare', 'cleanup:fast', 'cleanup:stalled'])

  timer.advance(9_999)
  await flushMicrotasks()
  assert.equal(calls.includes('finalize:first'), false)

  timer.advance(1)
  await first
  assert.deepEqual(calls, [
    'prepare',
    'cleanup:fast',
    'cleanup:stalled',
    'finalize:first',
    'finalize:second',
    'exit:0'
  ])
  assert.equal(logs.some((message) => (
    message.includes('deadline expired after 10000 ms')
    && message.includes('stalled component')
    && !message.includes('fast component')
  )), true)

  await shutdown('SIGINT')
  assert.equal(calls.filter((call) => call === 'prepare').length, 1)
  assert.equal(calls.filter((call) => call === 'finalize:first').length, 1)
  assert.equal(calls.filter((call) => call === 'exit:0').length, 1)
})

test('cleanup and finalizer failures are logged without skipping exit', async () => {
  const timer = new ManualTimer()
  const logs: string[] = []
  const calls: string[] = []
  const shutdown = createShutdownCoordinator({
    timer,
    log: (message) => logs.push(message),
    exit: (code) => calls.push(`exit:${code}`),
    prepare: [],
    cleanup: [{ name: 'broken cleanup', run: async () => { throw new Error('cleanup boom') } }],
    finalizers: [
      { name: 'broken finalizer', run: () => { throw new Error('finalizer boom') } },
      { name: 'last finalizer', run: () => calls.push('last finalizer') }
    ]
  })

  await shutdown('test')

  assert.equal(logs.some((message) => message.includes("'broken cleanup' failed: cleanup boom")), true)
  assert.equal(logs.some((message) => message.includes("'broken finalizer' failed: finalizer boom")), true)
  assert.deepEqual(calls, ['last finalizer', 'exit:0'])
})
