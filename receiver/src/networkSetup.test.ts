import assert from 'node:assert/strict'
import test from 'node:test'
import { createNetworkSetup, parseNmcliTerse, parseWifiList, SETUP_AP_CONNECTION } from './networkSetup.ts'

const DEVICE_LIST = 'wlan0:wifi\nlo:loopback\n'
const OFFLINE_STATE = 'wlan0:wifi:disconnected\nlo:loopback:unmanaged\n'
const ONLINE_STATE = 'eth0:ethernet:connected\nwlan0:wifi:disconnected\n'
const WIFI_LIST = 'HomeNet:82:WPA2\nHomeNet:41:WPA2\nCoffeeShop:60:\nNeighbor 5G:35:WPA2 WPA3\n'

test('parseNmcliTerse handles escaped colons and backslashes', () => {
  assert.deepEqual(parseNmcliTerse('My\\:Net:70:WPA2'), ['My:Net', '70', 'WPA2'])
  assert.deepEqual(parseNmcliTerse('Back\\\\slash:9:'), ['Back\\slash', '9', ''])
})

test('parseWifiList dedupes by strongest signal and flags security', () => {
  const networks = parseWifiList(WIFI_LIST)
  assert.deepEqual(networks, [
    { ssid: 'HomeNet', signal: 82, secured: true },
    { ssid: 'CoffeeShop', signal: 60, secured: false },
    { ssid: 'Neighbor 5G', signal: 35, secured: true }
  ])
})

interface ExecCall { args: string[] }

function fakeNmcli(behavior: {
  state?: () => string
  connectFails?: boolean
  wifiProfiles?: boolean
}) {
  const calls: ExecCall[] = []
  const exec = async (_command: string, args: string[]) => {
    calls.push({ args })
    const joined = args.join(' ')
    if (joined === '-t -f DEVICE,TYPE device') return { stdout: DEVICE_LIST }
    if (joined === '-t -f DEVICE,TYPE,STATE device') return { stdout: (behavior.state ?? (() => OFFLINE_STATE))() }
    if (joined === '-t -f UUID,TYPE connection show') {
      return { stdout: 'uuid-wifi-1:802-11-wireless\nuuid-setup-ap:802-11-wireless\nuuid-eth:802-3-ethernet\nlo-uuid:loopback\n' }
    }
    if (joined === '-t -f NAME,TYPE connection show') {
      // Default: a provisioned device (has a saved Wi-Fi profile) so threshold tests use the
      // full offline threshold; virgin-boot tests override.
      return { stdout: behavior.wifiProfiles === false ? 'lo:loopback\n' : 'HomeNet:802-11-wireless\nlo:loopback\n' }
    }
    if (joined.startsWith('-t -f SSID,SIGNAL,SECURITY device wifi list')) return { stdout: WIFI_LIST }
    if (joined.startsWith('device wifi connect')) {
      if (behavior.connectFails) throw new Error('Error: Connection activation failed: Secrets were required')
      return { stdout: '' }
    }
    return { stdout: '' }
  }
  return { exec, calls }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('disabled setup never runs nmcli', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: false, exec })
  await setup.tick()
  assert.equal(setup.applyCredentials('HomeNet', 'pw'), false)
  assert.deepEqual(await setup.scanNetworks(), [])
  assert.deepEqual(calls, [])
})

test('raises the open AP after sustained offline, not before', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: true, exec, offlineChecksBeforeAp: 3, log: () => undefined })
  await setup.tick()
  await setup.tick()
  assert.ok(!calls.some((c) => c.args.includes('ap')), 'AP must not be raised early')
  await setup.tick()
  const addCall = calls.find((c) => c.args[0] === 'connection' && c.args[1] === 'add')
  assert.ok(addCall, 'AP connection added')
  assert.ok(addCall.args.includes('Parallax-Setup'))
  assert.ok(addCall.args.includes('802-11-wireless.mode'))
  // Open network: no wifi-sec settings at all.
  assert.ok(!addCall.args.some((a) => a.includes('wifi-sec')))
  assert.equal(setup.getState().apActive, true)
  // While the AP is up, ticks are no-ops (no scan/state churn under the hosted radio).
  const before = calls.length
  await setup.tick()
  assert.equal(calls.length, before)
})

test('virgin device (no saved Wi-Fi) raises the AP fast and reports a countdown', async () => {
  const { exec, calls } = fakeNmcli({ wifiProfiles: false })
  const setup = createNetworkSetup({
    enabled: true, exec, offlineChecksBeforeAp: 8, checkIntervalMs: 15_000, log: () => undefined
  })
  await setup.tick()
  assert.equal(setup.getState().apEtaSeconds, 15, 'one fast check left → ~15s')
  assert.ok(!calls.some((c) => c.args[1] === 'add'))
  await setup.tick()
  assert.ok(calls.some((c) => c.args[1] === 'add'), 'AP raised on the fast path')
  assert.ok(calls.some((c) => c.args.join(' ') === 'radio wifi on'), 'defensive radio enable ran')
  assert.equal(setup.getState().apEtaSeconds, null, 'no countdown while the AP is up')
})

test('online LAN resets the offline counter', async () => {
  let online = false
  const { exec, calls } = fakeNmcli({ state: () => (online ? ONLINE_STATE : OFFLINE_STATE) })
  const setup = createNetworkSetup({ enabled: true, exec, offlineChecksBeforeAp: 2, log: () => undefined })
  await setup.tick()
  online = true
  await setup.tick() // resets counter
  online = false
  await setup.tick()
  assert.ok(!calls.some((c) => c.args[1] === 'add'), 'AP not raised: counter was reset')
})

test('successful credentials drop the AP and join the network', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: true, exec, offlineChecksBeforeAp: 1, log: () => undefined })
  await setup.tick()
  assert.equal(setup.getState().apActive, true)
  assert.equal(setup.applyCredentials('HomeNet', 'hunter22'), true)
  assert.equal(setup.applyCredentials('HomeNet', 'hunter22'), false, 'second apply while busy is rejected')
  await flush()
  const state = setup.getState()
  assert.equal(state.apActive, false)
  assert.equal(state.connecting, false)
  assert.equal(state.lastError, null)
  const connect = calls.find((c) => c.args.join(' ').startsWith('device wifi connect'))
  assert.deepEqual(connect?.args, ['device', 'wifi', 'connect', 'HomeNet', 'password', 'hunter22', 'ifname', 'wlan0'])
  const downs = calls.filter((c) => c.args[0] === 'connection' && c.args[1] === 'down')
  assert.ok(downs.some((c) => c.args[2] === SETUP_AP_CONNECTION), 'AP taken down before joining')
})

test('failed join re-raises the AP with a friendly error', async () => {
  const { exec, calls } = fakeNmcli({ connectFails: true })
  const setup = createNetworkSetup({ enabled: true, exec, offlineChecksBeforeAp: 1, log: () => undefined })
  await setup.tick()
  setup.applyCredentials('HomeNet', 'wrongpw')
  await flush()
  const state = setup.getState()
  assert.equal(state.apActive, true, 'AP came back after the failure')
  assert.match(state.lastError ?? '', /check the password/)
  const adds = calls.filter((c) => c.args[0] === 'connection' && c.args[1] === 'add')
  assert.equal(adds.length, 2, 'AP raised twice (initial + after failure)')
})

test('scan serves the pre-AP cache while hosting', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: true, exec, offlineChecksBeforeAp: 1, log: () => undefined })
  await setup.tick() // raises AP, caching a scan first
  const scans = calls.filter((c) => c.args.join(' ').startsWith('-t -f SSID,SIGNAL,SECURITY')).length
  const networks = await setup.scanNetworks()
  assert.equal(networks[0].ssid, 'HomeNet')
  const scansAfter = calls.filter((c) => c.args.join(' ').startsWith('-t -f SSID,SIGNAL,SECURITY')).length
  assert.equal(scansAfter, scans, 'no live scan while the AP is hosted')
})

test('forgetWifiConnections deletes exactly the Wi-Fi profiles and resets the fast path', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: true, exec, log: () => undefined })
  const removed = await setup.forgetWifiConnections()
  assert.equal(removed, 2)
  const deletes = calls.filter((c) => c.args[0] === 'connection' && c.args[1] === 'delete')
  assert.deepEqual(deletes.map((c) => c.args[2]), ['uuid-wifi-1', 'uuid-setup-ap'])
  // The wired profile survives.
  assert.ok(!deletes.some((c) => c.args[2] === 'uuid-eth'))
})

test('disabled setup reports zero forgotten profiles without running nmcli', async () => {
  const { exec, calls } = fakeNmcli({})
  const setup = createNetworkSetup({ enabled: false, exec })
  assert.equal(await setup.forgetWifiConnections(), 0)
  assert.deepEqual(calls, [])
})
