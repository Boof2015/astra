import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type { PhoneRemoteServiceConfig } from '../../types/phoneRemote'
import { PHONE_REMOTE_PROTOCOL_VERSION } from '../../types/phoneRemote'
import { PHONE_SYNC_FORMAT } from '../../types/phoneSync'
import { PhoneRemoteDiscoveryService } from './phoneRemoteDiscovery.ts'
import { PhoneRemoteService } from './phoneRemote.ts'
import { hashToken } from './playbackHttpCore.ts'

async function getFreePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate a test port.')
  }

  return address.port
}

function createSnapshot(overrides: Partial<MiniPlayerSnapshot> = {}): MiniPlayerSnapshot {
  return {
    playbackState: 'playing',
    currentTime: 42,
    duration: 185.5,
    queueLength: 3,
    shuffle: false,
    repeat: 'none',
    outputDeviceLabel: 'Test Output',
    timeDisplayMode: 'remaining',
    visualizerLineColor: '#38bdf8',
    currentTrack: {
      id: 'track-1',
      path: '/music/test.flac',
      title: 'Test Track',
      artist: 'Test Artist',
      album: 'Test Album',
      artworkData: null,
      isFavorite: false
    },
    ...overrides
  }
}

interface HarnessOptions {
  config?: Partial<PhoneRemoteServiceConfig>
  pairedDevices?: Array<{
    id: string
    name: string
    clientLabel: string
    tokenHash: string
    tokenPrefix: string
    createdAt: number
    lastSeenAt: number | null
    revokedAt: number | null
  }>
}

async function createHarness(options: HarnessOptions = {}) {
  const commands: MiniPlayerCommand[] = []
  const snapshotState: { current: MiniPlayerSnapshot | null } = {
    current: createSnapshot()
  }
  const port = await getFreePort()
  const config: PhoneRemoteServiceConfig = {
    enabled: true,
    controlsEnabled: true,
    syncEnabled: true,
    port,
    ...(options.config ?? {})
  }

  const service = new PhoneRemoteService({
    config,
    getSnapshot: () => snapshotState.current,
    dispatchCommand: (command) => {
      commands.push(command)
    },
    getIdentity: () => ({
      endpointUuid: 'desktop-test-uuid',
      desktopName: 'Test Desktop',
      protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
    }),
    pairedDevices: options.pairedDevices
  })

  await service.applyConfig(config)

  return {
    service,
    config,
    commands,
    port,
    publishSnapshot: (snapshot: MiniPlayerSnapshot | null) => {
      snapshotState.current = snapshot
      service.publishSnapshot(snapshot)
    }
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`
  }
}

test('phone remote binds to the LAN host when enabled', async (t) => {
  const port = await getFreePort()
  const config: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    syncEnabled: true,
    port
  }
  const service = new PhoneRemoteService({
    config,
    getSnapshot: () => createSnapshot(),
    dispatchCommand: () => {}
  })

  t.after(async () => {
    await service.stop()
  })

  let status = service.getStatus()
  assert.equal(status.active, false)
  assert.equal(status.bindHost, '0.0.0.0')

  status = await service.applyConfig({
    ...config,
    enabled: true
  })
  assert.equal(status.active, true)
  assert.equal(status.bindHost, '0.0.0.0')
})

test('/remote/ is unreachable when the phone remote is disabled', async (t) => {
  const harness = await createHarness({ config: { enabled: false } })
  t.after(async () => {
    await harness.service.stop()
  })

  await assert.rejects(async () => {
    await fetch(`http://127.0.0.1:${harness.port}/remote/`)
  })
})

test('pairing ticket flow issues a per-device token after approval', async (t) => {
  const harness = await createHarness()
  const disabledHarness = await createHarness({ config: { enabled: false } })
  t.after(async () => {
    await harness.service.stop()
    await disabledHarness.service.stop()
  })

  assert.throws(() => disabledHarness.service.createPairingTicket(`http://127.0.0.1:${disabledHarness.port}`), /active/i)

  const ticket = harness.service.createPairingTicket(`http://127.0.0.1:${harness.port}`)
  assert.equal(ticket.identity.desktopName, 'Test Desktop')

  const identityResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/identity`)
  assert.equal(identityResponse.status, 200)
  const identityPayload = await identityResponse.json()
  assert.equal(identityPayload.endpointUuid, 'desktop-test-uuid')

  const claimResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ticket: ticket.ticket,
      deviceName: 'Test Phone',
      clientLabel: 'iPhone'
    })
  })
  assert.equal(claimResponse.status, 200)
  const claimPayload = await claimResponse.json()
  assert.equal(typeof claimPayload.pollToken, 'string')
  assert.equal(claimPayload.identity.desktopName, 'Test Desktop')

  const duplicateClaimResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ticket: ticket.ticket,
      deviceName: 'Duplicate Phone',
      clientLabel: 'iPhone'
    })
  })
  assert.equal(duplicateClaimResponse.status, 409)

  const pendingRequests = harness.service.listPendingPairingRequests()
  assert.equal(pendingRequests.length, 1)
  assert.equal(pendingRequests[0].deviceName, 'Test Phone')

  harness.service.approvePairingRequest(pendingRequests[0].id)

  const approvedResponse = await fetch(
    `http://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claimPayload.pollToken)}`,
    { cache: 'no-store' }
  )
  assert.equal(approvedResponse.status, 200)
  const approvedPayload = await approvedResponse.json()
  assert.equal(approvedPayload.state, 'approved')
  assert.equal(typeof approvedPayload.token, 'string')
  assert.equal(approvedPayload.identity.endpointUuid, 'desktop-test-uuid')

  const pairedNowPlayingResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(approvedPayload.token)
  })
  assert.equal(pairedNowPlayingResponse.status, 200)

  const consumedResponse = await fetch(
    `http://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claimPayload.pollToken)}`,
    { cache: 'no-store' }
  )
  assert.equal(consumedResponse.status, 410)
})

test('PIN pairing flow issues a per-device token after desktop PIN confirmation', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const requestResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/pin-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      deviceName: 'Android Remote',
      clientLabel: 'Android Phone'
    })
  })
  assert.equal(requestResponse.status, 200)
  const requestPayload = await requestResponse.json()
  assert.equal(typeof requestPayload.requestId, 'string')
  assert.equal(requestPayload.identity.desktopName, 'Test Desktop')

  const pendingRequests = harness.service.listPendingPairingRequests()
  assert.equal(pendingRequests.length, 1)
  assert.equal(pendingRequests[0].pairingMode, 'pin')
  assert.match(pendingRequests[0].pin ?? '', /^\d{6}$/)

  const duplicateRequestResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/pin-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      deviceName: 'Duplicate Remote',
      clientLabel: 'Android Phone'
    })
  })
  assert.equal(duplicateRequestResponse.status, 409)

  const wrongPin = pendingRequests[0].pin === '000000' ? '000001' : '000000'
  const wrongConfirmResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      pin: wrongPin
    })
  })
  assert.equal(wrongConfirmResponse.status, 401)

  const confirmResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      pin: pendingRequests[0].pin
    })
  })
  assert.equal(confirmResponse.status, 200)
  const confirmPayload = await confirmResponse.json()
  assert.equal(confirmPayload.state, 'approved')
  assert.equal(typeof confirmPayload.token, 'string')
  assert.equal(confirmPayload.identity.endpointUuid, 'desktop-test-uuid')

  const pairedNowPlayingResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(confirmPayload.token)
  })
  assert.equal(pairedNowPlayingResponse.status, 200)

  const consumedConfirmResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      pin: pendingRequests[0].pin
    })
  })
  assert.equal(consumedConfirmResponse.status, 410)
})

test('phone remote discovery advertises only non-secret identity fields', () => {
  const published: Array<{
    name: string
    type: string
    protocol: string
    port: number
    txt: Record<string, string>
  }> = []
  let stopped = 0
  const service = new PhoneRemoteDiscoveryService({
    createBonjour: () => ({
      publish: (options) => {
        published.push(options)
        return { stop: () => { stopped += 1 } }
      },
      destroy: () => {}
    })
  })

  service.startAdvertising({
    name: 'Desk',
    port: 38402,
    endpointUuid: 'uuid-1',
    protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
  })
  service.startAdvertising({
    name: 'Desk',
    port: 38402,
    endpointUuid: 'uuid-1',
    protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
  })

  assert.equal(published.length, 1)
  assert.equal(published[0].type, 'astra-remote')
  assert.equal(published[0].protocol, 'tcp')
  assert.equal(published[0].txt.endpoint_uuid, 'uuid-1')
  assert.equal(published[0].txt.protocol_version, String(PHONE_REMOTE_PROTOCOL_VERSION))
  assert.equal('url' in published[0].txt, false)
  assert.equal('token' in published[0].txt, false)

  service.stopAdvertising()
  assert.equal(stopped, 1)
})

test('sync conflict reports preserve rich playlist snapshots and allow legacy summaries', async (t) => {
  const deviceToken = 'test-device-token'
  const harness = await createHarness({ pairedDevices: [{
    id: 'device-1',
    name: 'Test Phone',
    clientLabel: 'Android Phone',
    tokenHash: hashToken(deviceToken),
    tokenPrefix: deviceToken.slice(0, 8),
    createdAt: Date.now(),
    lastSeenAt: null,
    revokedAt: null
  }] })
  t.after(async () => {
    await harness.service.stop()
  })

  const response = await fetch(`http://127.0.0.1:${harness.port}/v1/sync/conflicts`, {
    method: 'POST',
    headers: {
      ...authHeaders(deviceToken),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      syncFormat: PHONE_SYNC_FORMAT,
      consumedResolutions: [],
      conflicts: [{
        kind: 'concurrent-edit',
        syncUid: 'sync-1',
        name: 'Road Mix',
        playlistKind: 'normal',
        phoneName: 'Road Mix',
        desktopName: 'Road Mix Desktop',
        phoneUpdatedAt: 20,
        desktopUpdatedAt: 10,
        phoneTrackCount: 1,
        desktopTrackCount: 1,
        phoneSnapshot: {
          name: 'Road Mix',
          kind: 'normal',
          dynamicRules: null,
          updatedAt: 20,
          trackCount: 1,
          entries: [{
            title: 'Phone Track',
            artist: 'Artist',
            album: 'Album',
            durationSeconds: 100,
            position: 0,
            addedAt: 20,
            sourcePath: '/phone.flac'
          }]
        },
        desktopSnapshot: {
          name: 'Road Mix Desktop',
          kind: 'normal',
          dynamicRules: null,
          updatedAt: 10,
          trackCount: 1,
          entries: [{
            title: 'Desktop Track',
            artist: 'Artist',
            album: 'Album',
            durationSeconds: 100,
            position: 0,
            addedAt: 10,
            sourcePath: '/desktop.flac'
          }]
        }
      }, {
        kind: 'first-pairing',
        syncUid: 'sync-legacy',
        name: 'Legacy Mix',
        playlistKind: 'normal',
        phoneName: 'Legacy Mix',
        desktopName: 'Legacy Mix',
        phoneUpdatedAt: 1,
        desktopUpdatedAt: 2,
        phoneTrackCount: 2,
        desktopTrackCount: 3
      }]
    })
  })

  assert.equal(response.status, 200)
  const status = harness.service.getStatus()
  assert.equal(status.sync.conflicts.length, 2)
  assert.equal(status.sync.conflicts[0].phoneSnapshot?.entries?.[0].title, 'Phone Track')
  assert.equal(status.sync.conflicts[0].desktopSnapshot?.entries?.[0].title, 'Desktop Track')
  assert.equal(status.sync.conflicts[1].phoneSnapshot, undefined)
  assert.equal(status.sync.conflicts[1].desktopSnapshot, undefined)
})

test('paired device tokens survive phone remote config changes and revocation closes device streams', async (t) => {
  const deviceToken = 'test-device-token'
  const harness = await createHarness({ pairedDevices: [{
    id: 'device-1',
    name: 'Test Phone',
    clientLabel: 'Android Phone',
    tokenHash: hashToken(deviceToken),
    tokenPrefix: deviceToken.slice(0, 8),
    createdAt: Date.now(),
    lastSeenAt: null,
    revokedAt: null
  }] })
  t.after(async () => {
    await harness.service.stop()
  })

  const deviceStream = await fetch(`http://127.0.0.1:${harness.port}/v1/events`, {
    headers: authHeaders(deviceToken)
  })
  assert.equal(deviceStream.status, 200)
  assert.ok(deviceStream.body)
  const reader = deviceStream.body?.getReader()
  assert.ok(reader)
  await reader?.read()

  await harness.service.applyConfig({
    ...harness.config,
    controlsEnabled: false
  })

  const deviceStillWorks = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(deviceToken)
  })
  assert.equal(deviceStillWorks.status, 200)

  harness.service.revokeAllPairedDevices()

  const streamClosed = await reader?.read()
  assert.equal(streamClosed?.done, true)

  const revokedResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(deviceToken)
  })
  assert.equal(revokedResponse.status, 401)
})
