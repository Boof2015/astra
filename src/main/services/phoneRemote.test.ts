import assert from 'node:assert/strict'
import { once } from 'node:events'
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
import { PhoneRemoteDiscoveryService } from './phoneRemoteDiscovery.ts'
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
  const harness = await createHarness({ config: { enabled: false } })
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
