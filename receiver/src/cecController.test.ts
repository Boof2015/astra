import assert from 'node:assert/strict'
import test from 'node:test'
import { createCecController } from './cecController.ts'

const INIT_STDOUT = `Driver Info:
\tPhysical Address           : 1.0.0.0
`
const DISCONNECTED_STDOUT = `Driver Info:
\tPhysical Address           : f.f.f.f
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

test('no CEC adapters disables cleanly with one log line', () => {
  const logs: string[] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: [],
    log: (message) => logs.push(message)
  })
  assert.equal(cec.enabled, false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /no \/dev\/cec\*/)
})

test('first playback registers, wakes the TV and claims the active source', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  cec.notifyPlayback(true) // repeated signal must not double anything
  await flush()
  assert.deepEqual(calls, [
    ['-d', '/dev/cec0', '--playback', '--osd-name', 'Parallax'],
    ['-d', '/dev/cec0', '--to', '0', '--image-view-on'],
    ['-d', '/dev/cec0', '--active-source', 'phys-addr=1.0.0.0']
  ])
  cec.stop()
})

test('probing picks the adapter whose HDMI port has the TV (Pi has one per port)', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0', '/dev/cec1'],
    exec: recordingExec(calls, (args) =>
      args.includes('--playback') ? (args[1] === '/dev/cec0' ? DISCONNECTED_STDOUT : INIT_STDOUT) : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  // Registered on both during the probe, but the driving commands go to cec1.
  const wake = calls.find((args) => args.includes('--image-view-on'))
  assert.deepEqual(wake, ['-d', '/dev/cec1', '--to', '0', '--image-view-on'])
  const active = calls.find((args) => args.includes('--active-source'))
  assert.deepEqual(active, ['-d', '/dev/cec1', '--active-source', 'phys-addr=1.0.0.0'])
  cec.stop()
})

test('every play edge wakes the TV — a manually powered-off TV must come back on play', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  cec.notifyPlayback(false)
  cec.notifyPlayback(true) // user turned the TV off themselves; play again must re-wake
  await flush()
  const wakes = calls.filter((args) => args.includes('--image-view-on'))
  assert.equal(wakes.length, 2)
  cec.stop()
})

test('standby fires after the idle timeout, then resume re-wakes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0'],
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
  assert.deepEqual(calls[calls.length - 1], ['-d', '/dev/cec0', '--to', '0', '--standby'])
  cec.notifyPlayback(true)
  await flush()
  assert.deepEqual(calls[calls.length - 2], ['-d', '/dev/cec0', '--to', '0', '--image-view-on'])
  assert.deepEqual(calls[calls.length - 1], ['-d', '/dev/cec0', '--active-source', 'phys-addr=1.0.0.0'])
  cec.stop()
})

test('resume within the idle window cancels the pending standby', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0'],
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

test('unknown physical address at registration is re-queried at wake time', async () => {
  const calls: string[][] = []
  let tvVisible = false
  const cec = createCecController({
    enabled: true,
    standbyMinutes: 10,
    devicePaths: ['/dev/cec0'],
    // TV off during registration (f.f.f.f); by the time play starts, the query sees it.
    exec: recordingExec(calls, (args) => {
      if (args.includes('--playback')) return DISCONNECTED_STDOUT
      if (args.length === 2) return tvVisible ? INIT_STDOUT : DISCONNECTED_STDOUT
      return ''
    }),
    log: () => undefined
  })
  tvVisible = true
  cec.notifyPlayback(true)
  await flush()
  const active = calls.find((args) => args.includes('--active-source'))
  assert.deepEqual(active, ['-d', '/dev/cec0', '--active-source', 'phys-addr=1.0.0.0'])
  cec.stop()
})
