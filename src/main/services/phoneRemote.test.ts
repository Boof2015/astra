import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type {
  CompanionApiRendererCommand,
  CompanionApiTargetType
} from '../../types/companionApi'
import type { PhoneRemoteServiceConfig } from '../../types/phoneRemote'
import { PHONE_REMOTE_PROTOCOL_VERSION } from '../../types/phoneRemote'
import { PHONE_SYNC_FORMAT } from '../../types/phoneSync'
import { createMacDiscoveryBonjour, PhoneRemoteDiscoveryService } from './phoneRemoteDiscovery.ts'
import { PhoneRemoteService } from './phoneRemote.ts'
import { hashToken } from './playbackHttpCore.ts'
import {
  createPhoneRemoteEphemeralKeyPair,
  createPhoneRemotePairingProof,
  createPhoneRemoteTlsIdentity,
  derivePhoneRemotePairingCode,
  derivePhoneRemotePairingKey,
  type PhoneRemotePairingTranscript
} from './phoneRemoteSecurity.ts'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

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
  getSyncRulePlaylists?: ConstructorParameters<typeof PhoneRemoteService>[0]['getSyncRulePlaylists']
  getSyncState?: ConstructorParameters<typeof PhoneRemoteService>[0]['getSyncState']
  applySyncChanges?: ConstructorParameters<typeof PhoneRemoteService>[0]['applySyncChanges']
  config?: Partial<PhoneRemoteServiceConfig>
  pairedDevices?: ConstructorParameters<typeof PhoneRemoteService>[0]['pairedDevices']
}

async function createHarness(options: HarnessOptions = {}) {
  const commands: MiniPlayerCommand[] = []
  const companionCommands: CompanionApiRendererCommand[] = []
  const snapshotState: { current: MiniPlayerSnapshot | null } = {
    current: createSnapshot()
  }
  const port = await getFreePort()
  const config: PhoneRemoteServiceConfig = {
    enabled: true,
    hardwareEnabled: true,
    controlsEnabled: true,
    syncEnabled: true,
    port,
    ...(options.config ?? {})
  }

  let persisted = options.pairedDevices ?? []
  const service = new PhoneRemoteService({
    onPairedDevicesChange: (devices) => { persisted = structuredClone(devices) },
    config,
    getSnapshot: () => snapshotState.current,
    dispatchCommand: (command) => {
      commands.push(command)
    },
    companionApi: {
      getPlayback: () => ({
        state: snapshotState.current?.playbackState ?? 'stopped',
        positionSeconds: snapshotState.current?.currentTime ?? 0,
        durationSeconds: snapshotState.current?.duration ?? 0,
        volume: 0.75,
        muted: false,
        shuffle: false,
        repeat: 'none',
        outputDeviceLabel: 'Test Output',
        queueCount: 0,
        currentTrack: null,
        updatedAt: Date.now()
      }),
      getQueue: () => ({ items: [], updatedAt: Date.now() }),
      listPlaylists: (cursor, limit) => cursor === 'invalid' ? null : ({
        items: [{ ref: 'playlist-ref', title: 'Evening', kind: 'normal', trackCount: 2, artworkUrl: null }],
        total: 1, nextCursor: null, limit
      }),
      search: (query, _types, limit) => ({
        query,
        limit,
        results: [{
          type: 'track',
          ref: 'track-ref',
          title: 'Test Track',
          subtitle: 'Test Artist',
          artworkUrl: null
        }]
      }),
      resolveTarget: (ref: string, expectedType?: CompanionApiTargetType) => {
        if (ref !== 'track-ref' || (expectedType && expectedType !== 'track')) return null
        return {
          type: 'track',
          ref,
          trackPaths: ['/music/test.flac'],
          openTarget: { type: 'track', trackPath: '/music/test.flac' }
        }
      },
      dispatchRendererCommand: (command) => {
        companionCommands.push(command)
        return true
      },
      resolveArtworkDataUrl: async () => null,
      setFavorite: async () => true,
      createPlaylist: async (name) => ({ ref: 'playlist-ref', title: name }),
      renamePlaylist: async () => true,
      addPlaylistItems: async () => true,
      removePlaylistItem: async () => true,
      movePlaylistItem: async () => true,
      getOpenApiDocument: () => ({ openapi: '3.1.0' })
    },
    getIdentity: () => ({
      endpointUuid: 'desktop-test-uuid',
      desktopName: 'Test Desktop',
      protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION
    }),
    getSyncRulePlaylists: options.getSyncRulePlaylists,
    getSyncState: options.getSyncState,
    applySyncChanges: options.applySyncChanges,
    pairedDevices: options.pairedDevices
  })
  const tlsIdentity = await createPhoneRemoteTlsIdentity('Astra Phone Remote Test')
  service.setTlsIdentity(tlsIdentity)

  await service.applyConfig(config)

  return {
    service,
    config,
    commands,
    companionCommands,
    port,
    tlsIdentity,
    persistedDevices: () => persisted,
    publishSnapshot: (snapshot: MiniPlayerSnapshot | null) => {
      snapshotState.current = snapshot
      service.publishSnapshot(snapshot)
    }
  }
}

function pairedNativeDevice(token: string): NonNullable<HarnessOptions['pairedDevices']>[number] {
  const now = Date.now()
  return {
    id: 'device-1',
    name: 'Test Phone',
    clientLabel: 'Android Phone',
    tokenPrefix: token.slice(0, 8),
    syncTokenPrefix: token.slice(0, 8),
    clientKind: 'native',
    scopes: ['control', 'sync'],
    credentialIssuedAt: now,
    credentialRotatedAt: now,
    expiresAt: now + 365 * 24 * 60 * 60_000,
    controlTokenHash: hashToken(token),
    syncTokenHash: hashToken(token),
    previousControlTokenHash: null,
    previousSyncTokenHash: null,
    previousTokensValidUntil: null,
    createdAt: now,
    lastSeenAt: null,
    revokedAt: null
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
  service.setTlsIdentity(await createPhoneRemoteTlsIdentity('Astra Phone Remote Test'))

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
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/identity`))
})

test('replacing the desktop certificate invalidates every pairing and cannot happen while active', async (t) => {
  const token = 'certificate-replacement-token'
  const config: PhoneRemoteServiceConfig = {
    enabled: false,
    controlsEnabled: true,
    syncEnabled: true,
    port: await getFreePort()
  }
  const service = new PhoneRemoteService({
    config,
    getSnapshot: () => createSnapshot(),
    dispatchCommand: () => {},
    pairedDevices: [pairedNativeDevice(token)]
  })
  const originalIdentity = await createPhoneRemoteTlsIdentity('Astra Phone Remote Original')
  const replacementIdentity = await createPhoneRemoteTlsIdentity('Astra Phone Remote Replacement')
  service.setTlsIdentity(originalIdentity)
  assert.equal(service.listPairedDevices().length, 1)

  service.setTlsIdentity(replacementIdentity)
  assert.equal(service.listPairedDevices().length, 0)

  await service.applyConfig({ ...config, enabled: true })
  t.after(async () => service.stop())
  await assert.rejects(
    async () => service.setTlsIdentity(originalIdentity),
    /Stop Phone Remote before replacing its TLS identity/
  )
})

test('/remote/ is unreachable when the phone remote is disabled', async (t) => {
  const harness = await createHarness({ config: { enabled: false, hardwareEnabled: false } })
  t.after(async () => {
    await harness.service.stop()
  })

  await assert.rejects(async () => {
    await fetch(`https://127.0.0.1:${harness.port}/remote/`)
  })
})

test('pairing ticket flow issues a per-device token after approval', async (t) => {
  const harness = await createHarness()
  const disabledHarness = await createHarness({ config: { enabled: false } })
  t.after(async () => {
    await harness.service.stop()
    await disabledHarness.service.stop()
  })

  assert.throws(() => disabledHarness.service.createPairingTicket(`https://127.0.0.1:${disabledHarness.port}`), /active/i)

  const ticket = harness.service.createPairingTicket(`https://127.0.0.1:${harness.port}`)
  assert.equal(ticket.identity.desktopName, 'Test Desktop')
  assert.match(ticket.pairingUrl, /^astra:\/\/desktop-remote\?/)
  assert.match(ticket.pairingUrl, /protocolVersion=3/)
  assert.match(ticket.pairingUrl, /fingerprint=/)

  const identityResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/identity`)
  assert.equal(identityResponse.status, 200)
  const identityPayload = await identityResponse.json()
  assert.equal(identityPayload.endpointUuid, 'desktop-test-uuid')

  const claimResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/claim`, {
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

  const duplicateClaimResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/claim`, {
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
    `https://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claimPayload.pollToken)}`,
    { cache: 'no-store' }
  )
  assert.equal(approvedResponse.status, 200)
  const approvedPayload = await approvedResponse.json()
  assert.equal(approvedPayload.state, 'approved')
  assert.equal(typeof approvedPayload.token, 'string')
  assert.equal(typeof approvedPayload.controlToken, 'string')
  assert.equal(typeof approvedPayload.syncToken, 'string')
  assert.deepEqual(approvedPayload.scopes, ['control', 'observe', 'playback-control', 'sync'])
  assert.equal(approvedPayload.identity.endpointUuid, 'desktop-test-uuid')

  const pairedNowPlayingResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(approvedPayload.token)
  })
  assert.equal(pairedNowPlayingResponse.status, 200)

  const consumedResponse = await fetch(
    `https://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claimPayload.pollToken)}`,
    { cache: 'no-store' }
  )
  assert.equal(consumedResponse.status, 410)
})

test('PIN pairing flow issues a per-device token after desktop PIN confirmation', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const phoneEphemeral = createPhoneRemoteEphemeralKeyPair()
  const mismatchedTranscriptResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      deviceName: 'MITM Remote',
      clientLabel: 'Android Phone',
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      observedCertificateFingerprint: '00'.repeat(32)
    })
  })
  assert.equal(mismatchedTranscriptResponse.status, 400)
  const requestResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      deviceName: 'Android Remote',
      clientLabel: 'Android Phone',
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      observedCertificateFingerprint: harness.tlsIdentity.fingerprint256
    })
  })
  assert.equal(requestResponse.status, 200)
  const requestPayload = await requestResponse.json()
  assert.equal(typeof requestPayload.requestId, 'string')
  assert.equal(requestPayload.identity.desktopName, 'Test Desktop')
  const transcript: PhoneRemotePairingTranscript = {
    version: 3,
    pairingId: requestPayload.requestId,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    desktopEphemeralPublicKey: requestPayload.desktopEphemeralPublicKey,
    desktopCertificateFingerprint: requestPayload.certificateFingerprint,
    desktopEndpointUuid: requestPayload.identity.endpointUuid,
    desktopPort: harness.port
  }
  const pairingKey = derivePhoneRemotePairingKey(
    phoneEphemeral.privateKey,
    requestPayload.desktopEphemeralPublicKey,
    transcript
  )

  const pendingRequests = harness.service.listPendingPairingRequests()
  assert.equal(pendingRequests.length, 1)
  assert.equal(pendingRequests[0].pairingMode, 'pin')
  assert.match(pendingRequests[0].pin ?? '', /^\d{6}$/)
  assert.equal(derivePhoneRemotePairingCode(pairingKey, transcript), pendingRequests[0].pin)

  const duplicateRequestResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      deviceName: 'Duplicate Remote',
      clientLabel: 'Android Phone',
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      observedCertificateFingerprint: harness.tlsIdentity.fingerprint256
    })
  })
  assert.equal(duplicateRequestResponse.status, 429)

  const wrongConfirmResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      proof: 'wrong-proof-value-that-is-long-enough-to-parse'
    })
  })
  assert.equal(wrongConfirmResponse.status, 401)

  const confirmResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      proof: createPhoneRemotePairingProof(pairingKey, transcript)
    })
  })
  assert.equal(confirmResponse.status, 200)
  const confirmPayload = await confirmResponse.json()
  assert.equal(confirmPayload.state, 'approved')
  assert.equal(typeof confirmPayload.sealed.nonce, 'string')
  assert.equal(typeof confirmPayload.sealed.ciphertext, 'string')
  assert.equal(typeof confirmPayload.sealed.authTag, 'string')
  assert.equal(confirmPayload.identity.endpointUuid, 'desktop-test-uuid')

  const consumedConfirmResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/pin-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      requestId: requestPayload.requestId,
      proof: createPhoneRemotePairingProof(pairingKey, transcript)
    })
  })
  assert.equal(consumedConfirmResponse.status, 410)
})

test('web pairing retains v1 control and cannot call sync endpoints', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())
  const ticket = harness.service.createPairingTicket(
    `https://127.0.0.1:${harness.port}`,
    'web'
  )
  const claimResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ticket: ticket.ticket, deviceName: 'Web Phone', clientLabel: 'Mobile Browser' })
  })
  const claim = await claimResponse.json()
  harness.service.approvePairingRequest(claim.requestId)
  const statusResponse = await fetch(
    `https://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claim.pollToken)}`
  )
  const status = await statusResponse.json()
  assert.equal(typeof status.controlToken, 'string')
  assert.equal(status.syncToken, null)
  assert.deepEqual(status.scopes, ['control', 'observe', 'playback-control'])
  const controlResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(status.controlToken)
  })
  assert.equal(controlResponse.status, 200)
  const syncResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/sync/state`, {
    headers: authHeaders(status.controlToken)
  })
  assert.equal(syncResponse.status, 401)
})

test('paired HTTPS grants only the approved companion scope subset', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())
  const ticket = harness.service.createPairingTicket(
    `https://127.0.0.1:${harness.port}`,
    'web'
  )
  const claimResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ticket: ticket.ticket,
      deviceName: 'Playlist Maker',
      clientLabel: 'Test Integration',
      requestedScopes: ['observe', 'playback-control', 'library-search', 'library-write']
    })
  })
  assert.equal(claimResponse.status, 200)
  const claim = await claimResponse.json()
  assert.deepEqual(
    harness.service.listPendingPairingRequests()[0].requestedScopes,
    ['observe', 'playback-control', 'library-search', 'library-write']
  )
  harness.service.approvePairingRequest(claim.requestId, ['observe', 'library-search'])

  const statusResponse = await fetch(
    `https://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${encodeURIComponent(claim.pollToken)}`
  )
  const status = await statusResponse.json()
  assert.deepEqual(status.scopes, ['control', 'observe', 'library-search'])

  const capabilitiesResponse = await fetch(`https://127.0.0.1:${harness.port}/v2/capabilities`, {
    headers: authHeaders(status.controlToken)
  })
  assert.equal(capabilitiesResponse.status, 200)
  assert.deepEqual((await capabilitiesResponse.json()).grantedScopes, ['library-search', 'observe'])

  const searchResponse = await fetch(`https://127.0.0.1:${harness.port}/v2/search?q=test`, {
    headers: authHeaders(status.controlToken)
  })
  assert.equal(searchResponse.status, 200)

  const controlResponse = await fetch(`https://127.0.0.1:${harness.port}/v2/playback/actions`, {
    method: 'POST',
    headers: { ...authHeaders(status.controlToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(controlResponse.status, 403)

  const writeResponse = await fetch(`https://127.0.0.1:${harness.port}/v2/tracks/track-ref/favorite`, {
    method: 'PUT',
    headers: { ...authHeaders(status.controlToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: true })
  })
  assert.equal(writeResponse.status, 403)
})

test('credentials rotate after the required age and preserve a 24-hour recovery hash', async (t) => {
  const oldToken = 'old-device-token'
  const device = pairedNativeDevice(oldToken)
  device.credentialRotatedAt = Date.now() - 121 * 24 * 60 * 60_000
  const harness = await createHarness({ pairedDevices: [device] })
  t.after(async () => harness.service.stop())

  const blockedResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(oldToken)
  })
  assert.equal(blockedResponse.status, 401)

  const rotationResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/session/rotate`, {
    method: 'POST',
    headers: authHeaders(oldToken)
  })
  assert.equal(rotationResponse.status, 200)
  const rotated = await rotationResponse.json()
  assert.equal(typeof rotated.controlToken, 'string')
  assert.equal(typeof rotated.syncToken, 'string')
  assert.ok(rotated.previousValidUntil > Date.now())

  const recoveryResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/session`, {
    headers: authHeaders(oldToken)
  })
  assert.equal(recoveryResponse.status, 200)
  const recoverySession = await recoveryResponse.json()
  assert.equal(recoverySession.usingPreviousCredential, true)

  const retryRotationResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/session/rotate`, {
    method: 'POST',
    headers: authHeaders(oldToken)
  })
  assert.equal(retryRotationResponse.status, 200)
  const repeatedRecoveryResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/session`, {
    headers: authHeaders(oldToken)
  })
  assert.equal(repeatedRecoveryResponse.status, 200)
  assert.equal((await repeatedRecoveryResponse.json()).usingPreviousCredential, true)

  const currentResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/session`, {
    headers: authHeaders((await retryRotationResponse.json()).controlToken)
  })
  assert.equal(currentResponse.status, 200)
  assert.equal((await currentResponse.json()).usingPreviousCredential, false)
})

test('paired devices expire only after 365 days without successful authenticated use', async (t) => {
  const token = 'inactive-device-token'
  const device = pairedNativeDevice(token)
  device.createdAt = Date.now() - 366 * 24 * 60 * 60_000
  device.credentialIssuedAt = device.createdAt
  device.credentialRotatedAt = Date.now()
  device.expiresAt = device.createdAt + 365 * 24 * 60 * 60_000
  const harness = await createHarness({ pairedDevices: [device] })
  t.after(async () => harness.service.stop())
  const response = await fetch(`https://127.0.0.1:${harness.port}/v1/session`, {
    headers: authHeaders(token)
  })
  assert.equal(response.status, 401)
  assert.equal(harness.service.listPairedDevices()[0].revokedAt !== null, true)
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
    protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION,
    transport: 'https',
    certificateFingerprint: 'AA:BB'
  })
  service.startAdvertising({
    name: 'Desk',
    port: 38402,
    endpointUuid: 'uuid-1',
    protocolVersion: PHONE_REMOTE_PROTOCOL_VERSION,
    transport: 'https',
    certificateFingerprint: 'AA:BB'
  })

  assert.equal(published.length, 1)
  assert.equal(published[0].type, 'astra-remote')
  assert.equal(published[0].protocol, 'tcp')
  assert.equal(published[0].txt.endpoint_uuid, 'uuid-1')
  assert.equal(published[0].txt.protocol_version, String(PHONE_REMOTE_PROTOCOL_VERSION))
  assert.equal(published[0].txt.transport, 'https')
  assert.equal(published[0].txt.companion_api, '2')
  assert.equal(published[0].txt.hardware_pairing, 'hardware-v1')
  assert.equal(published[0].txt.certificate_fingerprint, 'AA:BB')
  assert.equal('url' in published[0].txt, false)
  assert.equal('token' in published[0].txt, false)

  service.stopAdvertising()
  assert.equal(stopped, 1)
})

test('PWA uses v3 token storage and explains the private HTTPS certificate warning', async () => {
  const [appSource, html] = await Promise.all([
    readFile(new URL('../../renderer/public/remote/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../renderer/public/remote/index.html', import.meta.url), 'utf8')
  ])
  assert.match(appSource, /astra-remote-api-token-v3/)
  assert.doesNotMatch(appSource, /astra-remote-api-token-v1/)
  assert.match(html, /private HTTPS certificate/i)
  assert.match(html, /SHA-256 fingerprint/i)
})

test('sync conflict reports preserve rich playlist snapshots and allow legacy summaries', async (t) => {
  const deviceToken = 'test-device-token'
  const harness = await createHarness({ pairedDevices: [pairedNativeDevice(deviceToken)] })
  t.after(async () => {
    await harness.service.stop()
  })

  const response = await fetch(`https://127.0.0.1:${harness.port}/v1/sync/conflicts`, {
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
  const harness = await createHarness({ pairedDevices: [pairedNativeDevice(deviceToken)] })
  t.after(async () => {
    await harness.service.stop()
  })

  const deviceStream = await fetch(`https://127.0.0.1:${harness.port}/v1/events`, {
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

  const deviceStillWorks = await fetch(`https://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(deviceToken)
  })
  assert.equal(deviceStillWorks.status, 200)

  harness.service.revokeAllPairedDevices()

  let streamClosed = await reader?.read()
  for (let index = 0; index < 4 && !streamClosed?.done; index += 1) {
    streamClosed = await reader?.read()
  }
  assert.equal(streamClosed?.done, true)

  const revokedResponse = await fetch(`https://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(deviceToken)
  })
  assert.equal(revokedResponse.status, 401)
})

async function requestHardwarePairing(harness: Awaited<ReturnType<typeof createHarness>>, scopes?: string[], deviceInfo?: { modelId: string; softwareVersion: string }) {
  const ephemeral = createPhoneRemoteEphemeralKeyPair()
  const response = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/hardware-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Astra Thing', clientLabel: 'Hardware test',
      phoneEphemeralPublicKey: ephemeral.publicKey,
      observedCertificateFingerprint: harness.tlsIdentity.fingerprint256,
      ...(scopes ? { requestedScopes: scopes } : {}), ...(deviceInfo ? { deviceInfo } : {}) })
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  const transcript: PhoneRemotePairingTranscript = {
    version: 3, pairingId: payload.requestId,
    phoneEphemeralPublicKey: ephemeral.publicKey,
    desktopEphemeralPublicKey: payload.desktopEphemeralPublicKey,
    desktopCertificateFingerprint: payload.certificateFingerprint,
    desktopEndpointUuid: payload.identity.endpointUuid,
    desktopPort: harness.port, hardware: payload.hardware
  }
  const key = derivePhoneRemotePairingKey(ephemeral.privateKey, payload.desktopEphemeralPublicKey, transcript)
  const proof = createPhoneRemotePairingProof(key, transcript)
  const confirm = (route = 'hardware-confirm', suppliedProof = proof) => fetch(`https://127.0.0.1:${harness.port}/v1/pairing/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: payload.requestId, proof: suppliedProof })
  })
  return { payload, transcript, key, confirm }
}

test('hardware code pairing requires desktop approval and key proof; grants survive reconnect and rotation', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.service.stop())
  const pair = await requestHardwarePairing(harness)
  const pending = harness.service.listPendingPairingRequests()[0]
  assert.equal(pending.pairingMode, 'code')
  assert.equal(pending.pin, derivePhoneRemotePairingCode(pair.key, pair.transcript))
  assert.equal(pair.payload.pin, undefined)
  assert.deepEqual(pending.requestedScopes, ['observe', 'playback-control', 'library-search'])
  assert.equal((await pair.confirm()).status, 409)
  assert.equal((await pair.confirm('pin-confirm')).status, 404)
  assert.equal(harness.service.listPairedDevices().length, 0)

  harness.service.approvePairingRequest(pair.payload.requestId)
  assert.equal(harness.service.listPairedDevices().length, 0)
  const poll = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/status?pollToken=${pair.payload.pollToken}`)
  assert.deepEqual(Object.keys(await poll.json()).sort(), ['expiresAt', 'state'])
  assert.equal((await pair.confirm('hardware-confirm', 'invalid-proof-that-is-long-enough-to-parse')).status, 401)
  const response = await pair.confirm()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.controlToken, undefined)
  const { createDecipheriv, createHash } = await import('node:crypto')
  const tr = pair.transcript
  const serialized = JSON.stringify([tr.version, tr.pairingId, tr.phoneEphemeralPublicKey,
    tr.desktopEphemeralPublicKey, tr.desktopCertificateFingerprint.replace(/:/g, '').toUpperCase(),
    tr.desktopEndpointUuid, tr.desktopPort, tr.hardware!.profile, tr.hardware!.deviceName,
    tr.hardware!.clientLabel, tr.hardware!.requestedScopes])
  const decipher = createDecipheriv('aes-256-gcm', pair.key, Buffer.from(body.sealed.nonce, 'base64url'))
  decipher.setAAD(Buffer.concat([Buffer.from('astra-phone-remote-v3-confirm:'), createHash('sha256').update(serialized).digest()]))
  decipher.setAuthTag(Buffer.from(body.sealed.authTag, 'base64url'))
  const credentials = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.sealed.ciphertext, 'base64url')), decipher.final()]).toString())
  assert.equal(credentials.syncToken, null)
  assert.deepEqual(credentials.scopes, ['control', 'observe', 'playback-control', 'library-search'])
  assert.equal(harness.service.listPairedDevices()[0].clientKind, 'hardware')
  assert.equal((await pair.confirm()).status, 410)

  const headers = { Authorization: `Bearer ${credentials.controlToken}` }
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v2/playlists`, { headers })).status, 200)
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v2/search?q=Test`, { headers })).status, 200)
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v2/playlists`, { method: 'POST', headers, body: JSON.stringify({ name: 'Blocked' }) })).status, 403)
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v1/sync/state`, { headers })).status, 401)
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v1/control`, { method: 'POST', headers, body: JSON.stringify({ command: 'next' }) })).status, 401)
  assert.equal((await fetch(`https://127.0.0.1:${harness.port}/v1/queue`, { headers })).status, 401)
  const rotated = await fetch(`https://127.0.0.1:${harness.port}/v1/session/rotate`, { method: 'POST', headers })
  assert.equal(rotated.status, 200)
  const nextCredentials = await rotated.json()
  assert.equal(nextCredentials.syncToken, null)
  const reconnect = await createHarness({ pairedDevices: harness.persistedDevices() })
  t.after(() => reconnect.service.stop())
  const nextHeaders = { Authorization: `Bearer ${nextCredentials.controlToken}` }
  const capabilities = await fetch(`https://127.0.0.1:${reconnect.port}/v2/capabilities`, { headers: nextHeaders })
  assert.deepEqual((await capabilities.json()).grantedScopes, ['library-search', 'observe', 'playback-control'])
  reconnect.service.revokePairedDevice(credentials.deviceId)
  assert.equal((await fetch(`https://127.0.0.1:${reconnect.port}/v2/playback`, { headers: nextHeaders })).status, 401)
})

test('hardware approval cannot be obtained through the phone flow or after rejection/expiry', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.service.stop())
  const pair = await requestHardwarePairing(harness)
  harness.service.rejectPairingRequest(pair.payload.requestId)
  assert.equal(harness.service.approvePairingRequest(pair.payload.requestId), null)
  assert.equal((await pair.confirm()).status, 403)
  assert.equal(harness.service.listPairedDevices().length, 0)

  const expiring = await createHarness()
  t.after(() => expiring.service.stop())
  const second = await requestHardwarePairing(expiring)
  const now = Date.now
  Date.now = () => second.payload.expiresAt + 1
  try { assert.equal(expiring.service.approvePairingRequest(second.payload.requestId), null) }
  finally { Date.now = now }
  assert.equal((await second.confirm()).status, 410)
  assert.equal(expiring.service.listPairedDevices().length, 0)
})

test('hardware rejects library write scopes, invalid certificate observations, and ticket pairing', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.service.stop())
  const ephemeral = createPhoneRemoteEphemeralKeyPair()
  for (const overrides of [{ requestedScopes: ['library-write'] }, { observedCertificateFingerprint: '00'.repeat(32) }]) {
    const result = await fetch(`https://127.0.0.1:${harness.port}/v1/pairing/hardware-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneEphemeralPublicKey: ephemeral.publicKey,
        observedCertificateFingerprint: harness.tlsIdentity.fingerprint256, ...overrides })
    })
    assert.equal(result.status, 400)
  }
  assert.throws(() => harness.service.createPairingTicket(undefined, 'hardware'), /matching-code/)
  assert.equal(harness.service.listPendingPairingRequests().length, 0)
})


test('macOS hardware discovery registers through DNS-SD and cleans up on stop', () => {
  const calls: string[][] = []
  let killed = 0
  const children: EventEmitter[] = []
  const bonjour = createMacDiscoveryBonjour(args => {
    calls.push(args)
    const child = Object.assign(new EventEmitter(), { kill: () => { killed++; return true } })
    children.push(child)
    return child as unknown as ChildProcess
  })
  const options = { name: "Music Mac; $(ignored)", type: 'astra-remote', protocol: 'tcp' as const,
    port: 38402, txt: { hardware_pairing: 'hardware-v1', name: 'Music Mac' } }
  const service = bonjour.publish(options)
  assert.deepEqual(calls[0], ['-R', options.name, '_astra-remote._tcp', 'local', '38402',
    'hardware_pairing=hardware-v1', 'name=Music Mac'])
  service.stop()
  assert.equal(killed, 1)
  bonjour.destroy?.()
  assert.equal(killed, 1)
  bonjour.publish(options)
  bonjour.destroy?.()
  assert.equal(killed, 2)
  bonjour.publish(options)
  children[2].emit('exit', 0)
  bonjour.destroy?.()
  assert.equal(killed, 2)
})

function pairedHardwareDevice(token: string, id = 'thing-1'): NonNullable<HarnessOptions['pairedDevices']>[number] {
  return { ...pairedNativeDevice(token), id, name: 'Astra Thing', clientLabel: 'Astra Thing', clientKind: 'hardware',
    syncTokenHash: null, syncTokenPrefix: null, scopes: ['control', 'observe', 'playback-control', 'library-search'] }
}

async function drainClosed(reader: ReadableStreamDefaultReader<Uint8Array>) {
  for (let i = 0; i < 12; i++) { if ((await reader.read()).done) return }
  assert.fail('The disabled stream did not close')
}

test('hardware and phones pause independently, retain credentials and only close their own streams', async (t) => {
  const hardwareToken = 'hardware-isolation-token', phoneToken = 'phone-isolation-token'
  const harness = await createHarness({ pairedDevices: [pairedHardwareDevice(hardwareToken), pairedNativeDevice(phoneToken)] })
  t.after(() => harness.service.stop())
  const get = (path: string, token: string) => fetch(`https://127.0.0.1:${harness.port}${path}`, { headers: authHeaders(token) })
  const hardwareStream = (await get('/v2/events', hardwareToken)).body!.getReader()
  const phoneStream = (await get('/v2/events', phoneToken)).body!.getReader()
  await hardwareStream.read(); await phoneStream.read()
  assert.equal(harness.service.listPairedDevices().find(d => d.id === 'thing-1')?.connected, true)
  assert.equal(harness.service.getStatus().pairedDeviceCount, 1)
  assert.equal(harness.service.getStatus().connectedClients, 1)

  await harness.service.applyConfig({ ...harness.config, enabled: false, controlsEnabled: false })
  assert.equal(harness.service.getStatus().active, false)
  assert.equal(harness.service.getStatus().hardwareActive, true)
  await drainClosed(phoneStream)
  assert.equal((await get('/v1/session', phoneToken)).status, 503)
  assert.equal((await get('/remote/', phoneToken)).status, 503)
  assert.equal((await get('/remote/', '')).status, 404)
  assert.equal((await get('/v1/session', hardwareToken)).status, 200)
  const capabilities = await get('/v2/capabilities', hardwareToken)
  assert.ok((await capabilities.json()).grantedScopes.includes('playback-control'))
  assert.equal(harness.service.listPairedDevices().find(d => d.id === 'thing-1')?.connected, true)
  harness.publishSnapshot(createSnapshot({ currentTime: 17 }))
  assert.equal((await hardwareStream.read()).done, false)

  await harness.service.applyConfig({ ...harness.config, hardwareEnabled: false })
  await drainClosed(hardwareStream)
  assert.equal((await get('/v1/session', hardwareToken)).status, 503)
  assert.equal((await get('/v1/session', phoneToken)).status, 200)
  assert.equal(harness.service.listPairedDevices().find(d => d.id === 'thing-1')?.connected, false)
  assert.ok(harness.service.listPairedDevices().every(d => d.revokedAt === null))
  await harness.service.applyConfig(harness.config)
  assert.equal((await get('/v1/session', hardwareToken)).status, 200)
})

test('phone revoke-all and individual hardware forget leave other device streams connected', async (t) => {
  const harness = await createHarness({ pairedDevices: [pairedHardwareDevice('first-hardware-token'), pairedHardwareDevice('second-hardware-token', 'thing-2'), pairedNativeDevice('native-token')] })
  t.after(() => harness.service.stop())
  const stream = async (token: string) => (await fetch(`https://127.0.0.1:${harness.port}/v2/events`, { headers: authHeaders(token) })).body!.getReader()
  const first = await stream('first-hardware-token'), second = await stream('second-hardware-token')
  await first.read(); await second.read()
  assert.equal(harness.service.revokeAllPairedDevices('phone'), 1)
  assert.equal(harness.service.listPairedDevices().filter(d => d.connected).length, 2)
  harness.service.revokePairedDevice('thing-1')
  await drainClosed(first)
  assert.equal(harness.service.listPairedDevices().find(d => d.id === 'thing-2')?.connected, true)
  harness.publishSnapshot(createSnapshot({ currentTime: 22 }))
  assert.equal((await second.read()).done, false)
  await second.cancel()
})

test('authenticated device metadata survives reconnect and renaming without changing credentials or scopes', async (t) => {
  const harness = await createHarness({ config: { enabled: false }, pairedDevices: [pairedHardwareDevice('metadata-token')] })
  t.after(() => harness.service.stop())
  const update = (body: unknown, token = 'metadata-token') => fetch(`https://127.0.0.1:${harness.port}/v1/session/device-info`, {
    method: 'POST', headers: { ...authHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  assert.equal((await update({ modelId: 'astra-thing', softwareVersion: '0.2.1-dev' }, 'unknown-token')).status, 401)
  for (const body of [{ modelId: '../../bad.svg' }, { modelId: 'https://bad/logo.svg' }, { modelId: 'astra-thing', softwareVersion: '\u0000' }]) assert.equal((await update(body)).status, 400)
  const before = harness.persistedDevices()[0]
  assert.equal((await update({ modelId: 'astra-thing', softwareVersion: '0.2.1-dev' })).status, 200)
  assert.equal(harness.service.renamePairedDevice('thing-1', 'Desk Thing')?.name, 'Desk Thing')
  assert.equal((await update({ modelId: 'astra-thing', softwareVersion: '0.2.2-dev' })).status, 200)
  assert.equal(harness.service.listPairedDevices()[0].name, 'Desk Thing')
  assert.throws(() => harness.service.renamePairedDevice('thing-1', '   '))
  assert.throws(() => harness.service.renamePairedDevice('thing-1', '\u0000name'))
  const after = harness.persistedDevices()[0]
  assert.equal(after.controlTokenHash, before.controlTokenHash)
  assert.deepEqual(after.scopes, before.scopes)
  const restored = await createHarness({ config: { enabled: false }, pairedDevices: harness.persistedDevices() })
  t.after(() => restored.service.stop())
  assert.deepEqual(restored.service.listPairedDevices()[0].deviceInfo, { modelId: 'astra-thing', softwareVersion: '0.2.2-dev' })
  assert.equal(restored.service.listPairedDevices()[0].name, 'Desk Thing')
  assert.equal(restored.service.listPairedDevices()[0].connected, false)
})

test('hardware can pair with Phone Remote off; the code binds reported device metadata', async (t) => {
  const harness = await createHarness({ config: { enabled: false, hardwareEnabled: true } })
  t.after(() => harness.service.stop())
  const pair = await requestHardwarePairing(harness, undefined, { modelId: 'astra-thing', softwareVersion: '0.2.1-dev' })
  assert.deepEqual(harness.service.listPendingPairingRequests()[0].deviceInfo, pair.transcript.hardware?.deviceInfo)
  const changed = structuredClone(pair.transcript)
  changed.hardware!.deviceInfo!.modelId = 'other-device'
  const invalidProof = createPhoneRemotePairingProof(pair.key, changed)
  harness.service.approvePairingRequest(pair.payload.requestId)
  assert.equal((await pair.confirm('hardware-confirm', invalidProof)).status, 401)
  assert.equal((await pair.confirm()).status, 200)
  assert.equal(harness.service.listPairedDevices()[0].deviceInfo?.modelId, 'astra-thing')
  assert.throws(() => harness.service.createPairingTicket(), /only available/)
})

test('pausing hardware rejects a pending approval and stops its discovery capability', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.service.stop())
  const pair = await requestHardwarePairing(harness)
  await harness.service.applyConfig({ ...harness.config, hardwareEnabled: false })
  assert.equal(harness.service.listPendingPairingRequests().length, 0)
  assert.equal(harness.service.approvePairingRequest(pair.payload.requestId), null)
  assert.equal((await pair.confirm()).status, 409)
  const published: { txt: Record<string, string> }[] = []
  const discovery = new PhoneRemoteDiscoveryService({ createBonjour: () => ({ publish(options) { published.push(options);return {stop(){}} } }) })
  t.after(() => discovery.destroy())
  discovery.startAdvertising({ name: 'Astra',port:harness.port,endpointUuid:'test',protocolVersion:3,transport:'https',certificateFingerprint:'ab',hardwareEnabled:false,phoneEnabled:true })
  assert.equal(published[0].txt.hardware_pairing, undefined)
  discovery.startAdvertising({ name: 'Astra',port:harness.port,endpointUuid:'test',protocolVersion:3,transport:'https',certificateFingerprint:'ab',hardwareEnabled:true,phoneEnabled:false })
  assert.equal(published[1].txt.hardware_pairing, 'hardware-v1')
  assert.equal(published[1].txt.phone_remote, '0')
})

test('grouped playlists block legacy sync before state disclosure, writes, or conflict acknowledgements', async (t) => {
  const token = 'groups-sync-token'
  let version = 2
  let preparations = 0
  let writes = 0
  const harness = await createHarness({
    pairedDevices: [pairedNativeDevice(token)],
    getSyncRulePlaylists: () => [{ kind: 'dynamic', dynamicRules: JSON.stringify({ version }) }],
    getSyncState: () => { preparations++; return {
      syncFormat: PHONE_SYNC_FORMAT, now: 1, favorites: [], favoriteTombstones: [], playlistTombstones: [],
      playlists: [{ syncUid: 'grouped', name: 'Grouped', kind: 'dynamic', dynamicRules: JSON.stringify({ version }), createdAt: 1, updatedAt: 1, entries: null }]
    } },
    applySyncChanges: () => { writes++; return null }
  })
  t.after(() => harness.service.stop())
  harness.service.resolveSyncConflict('grouped', 'desktop')
  const endpoint = `https://127.0.0.1:${harness.port}/v1/sync/`
  const getState = (query = '') => fetch(endpoint + 'state' + query, { headers: authHeaders(token) })
  const legacy = await getState()
  assert.equal(legacy.status, 409)
  assert.match((await legacy.json() as { error: string }).error, /Update the phone/)
  for (const path of ['apply', 'conflicts']) {
    const result = await fetch(endpoint + path, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ syncFormat: PHONE_SYNC_FORMAT, conflicts: [], consumedResolutions: ['grouped'] })
    })
    assert.equal(result.status, 409)
  }
  assert.equal(writes, 0)
  assert.equal(preparations, 0)
  const current = await getState('?dynamicPlaylistRulesVersion=2')
  assert.equal(current.status, 200)
  const state = await current.json() as { dynamicPlaylistRulesVersion: number; pendingResolutions: unknown[] }
  assert.equal(state.dynamicPlaylistRulesVersion, 2)
  assert.equal(state.pendingResolutions.length, 1)
  version = 1
  assert.equal((await getState()).status, 200)
  const incoming = await fetch(endpoint + 'apply', {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ playlistUpserts: [{ kind: 'dynamic', dynamicRules: '{"version":2}' }] })
  })
  assert.equal(incoming.status, 409)
  assert.equal(writes, 0)
})
