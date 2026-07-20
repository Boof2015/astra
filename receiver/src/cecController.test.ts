import assert from 'node:assert/strict'
import test from 'node:test'
import { createCecController, type CecSettings } from './cecController.ts'

const INIT_STDOUT = `Driver Info:
\tPhysical Address           : 1.0.0.0
`
const DISCONNECTED_STDOUT = `Driver Info:
\tPhysical Address           : f.f.f.f
`

const DEFAULTS: CecSettings = { enabled: true, wakeOn: 'play', switchInput: true, standbyMinutes: 10 }

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
  const cec = createCecController({
    settings: { ...DEFAULTS, enabled: false },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls)
  })
  assert.equal(cec.available, true)
  cec.notifyPlayback(true)
  cec.notifyPlayback(false)
  cec.notifyConnection(true)
  assert.deepEqual(calls, [])
})

test('no CEC adapters disables cleanly with one log line', () => {
  const logs: string[] = []
  const cec = createCecController({
    settings: DEFAULTS,
    devicePaths: [],
    log: (message) => logs.push(message)
  })
  assert.equal(cec.available, false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /no \/dev\/cec\*/)
})

test('first playback registers, wakes the TV and claims the active source', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    settings: DEFAULTS,
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

test('switchInput off wakes the TV without touching the active source', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    settings: { ...DEFAULTS, switchInput: false },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  assert.ok(calls.some((args) => args.includes('--image-view-on')))
  assert.ok(!calls.some((args) => args.includes('--active-source')))
  cec.stop()
})

test("wakeOn 'off' never wakes and therefore never standbys", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    settings: { ...DEFAULTS, wakeOn: 'off' },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, () => INIT_STDOUT),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  cec.notifyConnection(true)
  await flush()
  cec.notifyPlayback(false)
  t.mock.timers.tick(60 * 60_000)
  await flush()
  assert.deepEqual(calls, [])
  cec.stop()
})

test("wakeOn 'connect' wakes on host attach and schedules standby while idle", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    settings: { ...DEFAULTS, wakeOn: 'connect' },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyConnection(true) // host attaches, nothing playing
  await flush()
  assert.ok(calls.some((args) => args.includes('--image-view-on')), 'connect edge must wake')
  // Connected but idle: the TV must still time out.
  t.mock.timers.tick(10 * 60_000)
  await flush()
  assert.deepEqual(calls[calls.length - 1], ['-d', '/dev/cec0', '--to', '0', '--standby'])
  // A play edge still wakes in connect mode (superset).
  cec.notifyPlayback(true)
  await flush()
  assert.deepEqual(calls[calls.length - 2], ['-d', '/dev/cec0', '--to', '0', '--image-view-on'])
  cec.stop()
})

test("wakeOn 'play' ignores connect edges", async () => {
  const calls: string[][] = []
  const cec = createCecController({
    settings: DEFAULTS,
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, () => INIT_STDOUT),
    log: () => undefined
  })
  cec.notifyConnection(true)
  await flush()
  assert.deepEqual(calls, [])
  cec.stop()
})

test('probing picks the adapter whose HDMI port has the TV (Pi has one per port)', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    settings: DEFAULTS,
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
    settings: DEFAULTS,
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
    settings: DEFAULTS,
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
    settings: DEFAULTS,
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

test('standbyMinutes 0 never sends the TV to standby', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    settings: { ...DEFAULTS, standbyMinutes: 0 },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  cec.notifyPlayback(false)
  t.mock.timers.tick(24 * 60 * 60_000)
  await flush()
  assert.ok(!calls.some((args) => args.includes('--standby')))
  cec.stop()
})

test('enabling CEC mid-song via updateSettings wakes the TV immediately', async () => {
  const calls: string[][] = []
  const cec = createCecController({
    settings: { ...DEFAULTS, enabled: false },
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  assert.equal(calls.length, 0, 'disabled controller must stay silent')
  cec.updateSettings({ ...DEFAULTS, enabled: true })
  await flush()
  assert.ok(calls.some((args) => args.includes('--image-view-on')))
  cec.stop()
})

test('disabling CEC via updateSettings cancels a pending standby', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    settings: DEFAULTS,
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  cec.notifyPlayback(false) // standby now pending
  cec.updateSettings({ ...DEFAULTS, enabled: false })
  t.mock.timers.tick(60 * 60_000)
  await flush()
  assert.ok(!calls.some((args) => args.includes('--standby')))
  cec.stop()
})

test('changing the idle timeout reschedules a pending standby at the new duration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[][] = []
  const cec = createCecController({
    settings: DEFAULTS,
    devicePaths: ['/dev/cec0'],
    exec: recordingExec(calls, (args) => args.includes('--playback') ? INIT_STDOUT : ''),
    log: () => undefined
  })
  cec.notifyPlayback(true)
  await flush()
  cec.notifyPlayback(false) // 10-minute standby pending
  cec.updateSettings({ ...DEFAULTS, standbyMinutes: 120 })
  t.mock.timers.tick(30 * 60_000)
  await flush()
  assert.ok(!calls.some((args) => args.includes('--standby')), 'old 10-minute timer must be gone')
  t.mock.timers.tick(120 * 60_000)
  await flush()
  assert.ok(calls.some((args) => args.includes('--standby')))
  cec.stop()
})

test('unknown physical address at registration is re-queried at wake time', async () => {
  const calls: string[][] = []
  let tvVisible = false
  const cec = createCecController({
    settings: DEFAULTS,
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
