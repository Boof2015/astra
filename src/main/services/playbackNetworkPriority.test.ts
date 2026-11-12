import assert from 'node:assert/strict'
import test from 'node:test'
import { PlaybackNetworkPriority } from './playbackNetworkPriority.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('artwork downloads run a few at a time', async () => {
  const priority = new PlaybackNetworkPriority(2)
  const gates = [deferred(), deferred(), deferred()]
  let active = 0, peak = 0
  const runs = gates.map(gate => priority.run(async () => {
    active++; peak = Math.max(peak, active)
    await gate.promise
    active--
  }))
  await tick()
  assert.equal(active, 2)
  for (const gate of gates) gate.resolve()
  await Promise.all(runs)
  assert.equal(peak, 2)
})

test('starting playback stops artwork at once and resumes it, restarted, after release', async () => {
  const priority = new PlaybackNetworkPriority(4)
  const attempts: string[] = []
  const finish = deferred()
  const inFlight = priority.run(async signal => {
    attempts.push('started')
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      void finish.promise.then(resolve)
    })
    return 'art'
  })
  await tick()
  const release = priority.hold()
  const queued = priority.run(async () => { attempts.push('queued'); return 'later' })
  await tick(); await tick()
  assert.deepEqual(attempts, ['started'], 'nothing new starts while playback holds the link')
  release()
  await tick(); await tick()
  assert.deepEqual(attempts.sort(), ['queued', 'started', 'started'])
  finish.resolve()
  assert.equal(await inFlight, 'art')
  assert.equal(await queued, 'later')
})

test('only the last of several holds releases, and real failures still reject', async () => {
  const priority = new PlaybackNetworkPriority()
  const first = priority.hold(), second = priority.hold()
  let ran = false
  const work = priority.run(async () => { ran = true })
  first(); first()
  await tick()
  assert.equal(ran, false)
  second()
  await work
  assert.equal(ran, true)
  await assert.rejects(priority.run(async () => { throw new Error('404') }), /404/)
})
