import assert from 'node:assert/strict'
import test from 'node:test'
import { createSystemdNotifier } from './systemdNotify.ts'

test('without NOTIFY_SOCKET every call is a silent no-op', () => {
  const sent: string[] = []
  const notifier = createSystemdNotifier({
    env: {},
    send: (state) => {
      sent.push(state)
      return true
    }
  })
  assert.equal(notifier.enabled, false)
  notifier.ready()
  notifier.startWatchdog()
  notifier.stopping()
  notifier.stopWatchdog()
  assert.deepEqual(sent, [])
})

test('with NOTIFY_SOCKET sends READY and STOPPING states', () => {
  const sent: string[] = []
  const notifier = createSystemdNotifier({
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    send: (state) => {
      sent.push(state)
      return true
    }
  })
  assert.equal(notifier.enabled, true)
  notifier.ready()
  notifier.stopping()
  assert.deepEqual(sent, ['READY=1', 'STOPPING=1'])
})

test('watchdog pings at half of WATCHDOG_USEC until stopped', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const sent: string[] = []
  const notifier = createSystemdNotifier({
    // 30 s WatchdogSec → pings every 15 s.
    env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
    send: (state) => {
      sent.push(state)
      return true
    }
  })
  notifier.startWatchdog()
  notifier.startWatchdog() // second call must not double the timer
  t.mock.timers.tick(15_000)
  t.mock.timers.tick(15_000)
  assert.deepEqual(sent, ['WATCHDOG=1', 'WATCHDOG=1'])
  notifier.stopWatchdog()
  t.mock.timers.tick(60_000)
  assert.equal(sent.length, 2)
})

test('missing or invalid WATCHDOG_USEC disables the ping timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const sent: string[] = []
  for (const usec of [undefined, '0', 'nonsense']) {
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: usec },
      send: (state) => {
        sent.push(state)
        return true
      }
    })
    notifier.startWatchdog()
  }
  t.mock.timers.tick(600_000)
  assert.deepEqual(sent, [])
})

test('unavailable sd_notify warns loudly exactly once', () => {
  const warnings: string[] = []
  const notifier = createSystemdNotifier({
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    // Loader that throws — the shape of a missing-addon install; an addon built before
    // v0.2.0 (no sdNotify export) takes the same warning path.
    loadAddon: () => {
      throw new Error('ALSA addon not built.')
    },
    log: (message) => warnings.push(message)
  })
  notifier.ready()
  notifier.stopping()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /NOTIFY_SOCKET is set but sd_notify is unavailable/)
})
