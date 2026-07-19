import assert from 'node:assert/strict'
import test from 'node:test'
import { createCecController } from './cecController.ts'

const INIT_STDOUT = `Driver Info:
\tPhysical Address           : 1.0.0.0
`

function recordingExec(calls: string[][], stdoutFor: (args: string[]) => string = () => '') {
  return async (_command: string, args: string[]) => {
    calls.push(args)
    return { stdout: stdoutFor(args) }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('disabled controller never execs', () => {
  const calls: string[][] = []
  const cec = createCecController({ enabled: false, standbyMinutes: 10, exec: recordingExec(calls) })
  assert.equal(cec.enabled, false)
  cec.notifyPlayback(true)
  cec.notifyPlayback(false)
  assert.deepEqual(calls, [])
})

test('missing CEC device disables cleanly with one log line', () => {
  const logs: string[] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePath: '/definitely/not/a/cec/device',
    log: (message) => logs.push(message)
  })
  assert.equal(cec.enabled, false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /does not exist/)
})

test('first playback wakes the TV and claims the active source', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePath: '/dev/null',
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  cec.notifyPlayback(true) // repeated signal must not double anything
  await flush()
  assert.deepEqual(calls, [
    ['--playback', '--osd-name', 'Parallax'],
    ['--to', '0', '--image-view-on'],
    ['--active-source', 'phys-addr=1.0.0.0']
  ])
  cec.stop()
})

test('standby fires after the idle timeout, not on pause itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePath: '/dev/null',
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  const wakes = calls.length
  cec.notifyPlayback(false)
  await flush()
  assert.equal(calls.length, wakes, 'standby must not fire immediately')
  t.mock.timers.tick(10 * 60_000)
  await flush()
  assert.deepEqual(calls[calls.length - 1], ['--to', '0', '--standby'])
  // Resuming after standby wakes the TV again (no re-init).
  cec.notifyPlayback(true)
  await flush()
  assert.deepEqual(calls[calls.length - 2], ['--to', '0', '--image-view-on'])
  assert.deepEqual(calls[calls.length - 1], ['--active-source', 'phys-addr=1.0.0.0'])
  cec.stop()
})

test('resume within the idle window cancels the pending standby', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePath: '/dev/null',
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  cec.notifyPlayback(false)
  t.mock.timers.tick(5 * 60_000)
  cec.notifyPlayback(true) // resume before the timeout
  t.mock.timers.tick(60 * 60_000)
  await flush()
  assert.ok(!calls.some((args) => args.includes('--standby')), 'standby must have been cancelled')
  cec.stop()
})
