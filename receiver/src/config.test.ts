import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from './config'

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'astra-receiver-test-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('creates defaults and persists a stable endpoint UUID', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    const first = new ConfigStore(path)
    const uuid = first.get().endpointUuid
    assert.ok(uuid.length > 10)
    assert.equal(first.get().connection, null)

    const second = new ConfigStore(path)
    assert.equal(second.get().endpointUuid, uuid)
  })
})

test('round-trips a paired connection', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    const store = new ConfigStore(path)
    store.setConnection({
      protocolVersion: 2,
      baseUrl: 'https://192.168.1.10:38403',
      sinkId: 'sink-1',
      token: 'token-1',
      hostCertificatePem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n',
      hostCertificateFingerprint: 'AA'.repeat(32),
      hostName: 'Studio Mac',
      pairedAt: 123,
      lastConnectedAt: null,
      hostParallaxEndpointUuid: 'uuid-h'
    })

    const reloaded = new ConfigStore(path)
    const connection = reloaded.get().connection
    assert.ok(connection)
    assert.equal(connection.baseUrl, 'https://192.168.1.10:38403')
    assert.equal(connection.sinkId, 'sink-1')
    assert.equal(connection.hostParallaxEndpointUuid, 'uuid-h')
  })
})

test('rejects malformed connections and clamps settings', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({
      endpointUuid: 'keep-me',
      volumePercent: 250,
      listenerPort: 0,
      connection: { protocolVersion: 1, baseUrl: 'https://x', sinkId: 's', token: 't' }
    }))
    const store = new ConfigStore(path)
    assert.equal(store.get().endpointUuid, 'keep-me')
    assert.equal(store.get().volumePercent, 100)
    assert.equal(store.get().listenerPort, 38404)
    assert.equal(store.get().connection, null)
  })
})

test('privileged ports are valid, garbage ports fall back', () => {
  withTempDir((dir) => {
    // The Parallax OS image bakes webPort 80 (the unit grants CAP_NET_BIND_SERVICE).
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ webPort: 80 }))
    assert.equal(new ConfigStore(path).get().webPort, 80)

    for (const bad of [0, -80, 65536, 1.5, 'eighty']) {
      writeFileSync(path, JSON.stringify({ webPort: bad }))
      assert.equal(new ConfigStore(path).get().webPort, 38405, `webPort ${String(bad)}`)
    }
  })
})

test('CEC and clock settings default sensibly and reject garbage', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({}))
    const defaults = new ConfigStore(path).get()
    assert.equal(defaults.cecWakeOn, 'play')
    assert.equal(defaults.cecSwitchInput, true)
    assert.equal(defaults.cecStandbyMinutes, 10)
    assert.equal(defaults.clockFormat, 'auto')

    writeFileSync(path, JSON.stringify({
      cecWakeOn: 'connect',
      cecSwitchInput: false,
      cecStandbyMinutes: 0, // 0 = never standby, and must survive
      clockFormat: '24'
    }))
    const set = new ConfigStore(path).get()
    assert.equal(set.cecWakeOn, 'connect')
    assert.equal(set.cecSwitchInput, false)
    assert.equal(set.cecStandbyMinutes, 0)
    assert.equal(set.clockFormat, '24')

    writeFileSync(path, JSON.stringify({
      cecWakeOn: 'sometimes',
      cecStandbyMinutes: -5,
      clockFormat: '13'
    }))
    const garbage = new ConfigStore(path).get()
    assert.equal(garbage.cecWakeOn, 'play')
    assert.equal(garbage.cecStandbyMinutes, 10)
    assert.equal(garbage.clockFormat, 'auto')
  })
})

test('factory reset keeps image provisioning and resets everything user-owned', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    // A provisioned + used appliance: image-baked fields plus user changes and a pairing.
    writeFileSync(path, JSON.stringify({
      endpointUuid: 'old-uuid',
      sinkName: 'Living Room',
      audioBackend: 'alsa',
      audioDevice: 'plughw:vc4hdmi0,0',
      volumePercent: 40,
      webPort: 80,
      apSetup: true,
      cecControl: true,
      cecWakeOn: 'connect',
      cecStandbyMinutes: 0,
      clockFormat: '24'
    }))
    const store = new ConfigStore(path)
    store.setConnection({
      protocolVersion: 2,
      baseUrl: 'https://192.168.1.10:38403',
      sinkId: 'sink-1',
      token: 'token-1',
      hostCertificatePem: 'pem',
      hostCertificateFingerprint: 'AA'.repeat(32),
      hostName: 'Studio Mac',
      pairedAt: 123,
      lastConnectedAt: null,
      hostParallaxEndpointUuid: 'uuid-h'
    })

    const reset = store.factoryReset()
    // Provisioning survives — losing apSetup/webPort would strand a reset appliance.
    assert.equal(reset.webPort, 80)
    assert.equal(reset.apSetup, true)
    assert.equal(reset.cecControl, true)
    assert.equal(reset.audioBackend, 'alsa')
    // User-owned state is factory-fresh.
    assert.notEqual(reset.endpointUuid, 'old-uuid')
    assert.equal(reset.connection, null)
    assert.notEqual(reset.sinkName, 'Living Room')
    assert.equal(reset.audioDevice, 'default')
    assert.equal(reset.volumePercent, 100)
    assert.equal(reset.cecWakeOn, 'play')
    assert.equal(reset.cecStandbyMinutes, 10)
    assert.equal(reset.clockFormat, 'auto')
    // And it is durable.
    const reloaded = new ConfigStore(path).get()
    assert.equal(reloaded.endpointUuid, reset.endpointUuid)
    assert.equal(reloaded.connection, null)
    assert.equal(reloaded.webPort, 80)
  })
})

test('writes are atomic (no partial file left behind)', () => {
  withTempDir((dir) => {
    const path = join(dir, 'config.json')
    const store = new ConfigStore(path)
    store.update({ sinkName: 'Kitchen Pi' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.sinkName, 'Kitchen Pi')
  })
})
