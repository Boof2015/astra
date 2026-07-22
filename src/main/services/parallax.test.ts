import test from 'node:test'
import assert from 'node:assert/strict'
import type { Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { ParallaxService } from './parallax.ts'
import type { MiniPlayerCommand } from '../../types/miniPlayer.ts'
import type {
  ParallaxHostConfig,
  ParallaxJoinValidationDiagnostic,
  ParallaxTimelineEvent
} from '../../types/parallax.ts'
import { decodeParallaxAudioPacket } from '../../types/parallax.ts'
import { ParallaxSinkClient } from '../../../receiver/src/sinkClient.ts'
import { createOpaqueSecret, hashToken } from './playbackHttpCore.ts'
import {
  createParallaxPinnedDispatcher,
  createParallaxTlsIdentity,
  type ParallaxTlsIdentity
} from './parallaxSecurity.ts'
import {
  fetch as undiciFetch,
  type Agent,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse
} from 'undici'

type ParallaxSseTestEvent = {
  type: string
  sinkId?: string
  playbackEnabled?: boolean
  streamId?: string | null
  stream?: {
    streamId: string
    normalizationGainDb?: number
    normalizationMode?: string
  }
}

function makePersistedSink(id: string, token: string, name: string, playbackEnabled = true) {
  return {
    id,
    name,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    createdAt: Date.now(),
    lastSeenAt: null,
    revokedAt: null,
    playbackEnabled
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

type TestServer = HttpServer | HttpsServer

async function listenHttpServer(server: TestServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function closeHttpServer(server: TestServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const dispatchersByBaseUrl = new Map<string, Agent>()

async function fetchHost(baseUrl: string, path: string, init: UndiciRequestInit = {}): Promise<UndiciResponse> {
  const dispatcher = dispatchersByBaseUrl.get(baseUrl)
  assert.ok(dispatcher, `missing pinned dispatcher for ${baseUrl}`)
  return await undiciFetch(`${baseUrl}${path}`, { ...init, dispatcher })
}

async function createStartedParallaxService(
  dispatchCommand?: (command: MiniPlayerCommand) => void
): Promise<{ service: ParallaxService; port: number; baseUrl: string; tlsIdentity: ParallaxTlsIdentity }> {
  const port = await getFreePort()
  const config: ParallaxHostConfig = { enabled: true, port }
  const tlsIdentity = await createParallaxTlsIdentity('Parallax Test Host')
  const service = new ParallaxService({ config: { enabled: false, port }, pairedSinks: [], tlsIdentity, dispatchCommand })
  await service.applyHostConfig(config)
  const baseUrl = `https://127.0.0.1:${port}`
  const dispatcher = createParallaxPinnedDispatcher(tlsIdentity.certificatePem, tlsIdentity.fingerprint256)
  dispatchersByBaseUrl.set(baseUrl, dispatcher)
  const stop = service.stop.bind(service)
  service.stop = async () => {
    await stop()
    dispatchersByBaseUrl.delete(baseUrl)
    await dispatcher.close().catch(() => undefined)
  }
  return {
    service,
    port,
    baseUrl,
    tlsIdentity
  }
}

async function tryCreateStartedParallaxService(
  dispatchCommand?: (command: MiniPlayerCommand) => void
): Promise<Awaited<ReturnType<typeof createStartedParallaxService>> | null> {
  try {
    return await createStartedParallaxService(dispatchCommand)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return null
    }
    throw error
  }
}

async function pairSink(service: ParallaxService, _baseUrl: string, sinkName: string = 'Desk'): Promise<{ sinkId: string; token: string }> {
  const sinkId = createOpaqueSecret(16)
  const token = createOpaqueSecret(32)
  service.replacePairedSinks([makePersistedSink(sinkId, token, sinkName)])
  return { sinkId, token }
}

async function readParallaxSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<ParallaxSseTestEvent[]> {
  const decoder = new TextDecoder()
  const events: ParallaxSseTestEvent[] = []
  let buffer = ''

  for (let attempt = 0; attempt < 16 && events.length < count; attempt += 1) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLine = rawEvent.split(/\r?\n/).find((line) => line.startsWith('data: '))
      if (dataLine) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as ParallaxSseTestEvent)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }

  return events
}

test('Parallax playback selection persists per pairing and bulk actions include offline sinks', () => {
  const firstToken = createOpaqueSecret(32)
  const secondToken = createOpaqueSecret(32)
  const persistedSnapshots: boolean[][] = []
  const service = new ParallaxService({
    config: { enabled: false, port: 38403 },
    pairedSinks: [
      makePersistedSink('living-room', firstToken, 'Living Room'),
      makePersistedSink('kitchen', secondToken, 'Kitchen')
    ],
    onPairedSinksChange: (sinks) => persistedSnapshots.push(sinks.map((sink) => sink.playbackEnabled))
  })

  assert.deepEqual(service.listPairedSinks().map((sink) => sink.playbackEnabled), [true, true])
  const oneOff = service.setSinkPlaybackEnabled('living-room', false)
  assert.equal(oneOff.host.connectedSinkCount, 0)
  assert.equal(oneOff.host.activePlaybackSinkCount, 0)
  assert.equal(service.listPairedSinks().find((sink) => sink.id === 'living-room')?.playbackEnabled, false)

  service.setAllSinksPlaybackEnabled(false)
  assert.deepEqual(
    service.listPairedSinks().map((sink) => sink.playbackEnabled),
    [false, false]
  )
  service.setAllSinksPlaybackEnabled(true)
  assert.deepEqual(
    service.listPairedSinks().map((sink) => sink.playbackEnabled),
    [true, true]
  )
  assert.deepEqual(persistedSnapshots, [[false, true], [false, false], [true, true]])
  assert.throws(() => service.setSinkPlaybackEnabled('missing', true), /no longer paired/i)
})

test('Parallax keeps inactive sinks connected while filtering playback delivery', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const livingToken = createOpaqueSecret(32)
  const kitchenToken = createOpaqueSecret(32)
  service.replacePairedSinks([
    makePersistedSink('living-room', livingToken, 'Living Room'),
    makePersistedSink('kitchen', kitchenToken, 'Kitchen')
  ])

  const livingAbort = new AbortController()
  const kitchenAbort = new AbortController()
  let livingEvents: UndiciResponse | null = null
  let kitchenEvents: UndiciResponse | null = null
  try {
    livingEvents = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${livingToken}` },
      signal: livingAbort.signal
    })
    kitchenEvents = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${kitchenToken}` },
      signal: kitchenAbort.signal
    })
    assert.ok(livingEvents.body)
    assert.ok(kitchenEvents.body)
    const livingReader = livingEvents.body.getReader()
    const kitchenReader = kitchenEvents.body.getReader()
    await waitFor(() => service.getStatus().host.connectedSinkCount === 2)
    assert.equal(service.getStatus().host.activePlaybackSinkCount, 2)

    const oneOff = service.setSinkPlaybackEnabled('living-room', false)
    assert.equal(oneOff.host.connectedSinkCount, 2)
    assert.equal(oneOff.host.activePlaybackSinkCount, 1)
    assert.equal(
      oneOff.host.connectedSinks.find((sink) => sink.sinkId === 'living-room')?.playbackEnabled,
      false
    )

    service.publishHostStreamStart({
      streamId: 'zone-stream',
      trackId: 'zone-track',
      title: 'Zone Test',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48_000
    })

    const livingJoinResponse = await fetchHost(baseUrl, '/v1/parallax/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${livingToken}` }
    })
    const livingJoin = await livingJoinResponse.json() as { playbackEnabled: boolean; stream: unknown }
    assert.equal(livingJoin.playbackEnabled, false)
    assert.equal(livingJoin.stream, null)

    const kitchenJoinResponse = await fetchHost(baseUrl, '/v1/parallax/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${kitchenToken}` }
    })
    const kitchenJoin = await kitchenJoinResponse.json() as { playbackEnabled: boolean; stream: { streamId: string } | null }
    assert.equal(kitchenJoin.playbackEnabled, true)
    assert.equal(kitchenJoin.stream?.streamId, 'zone-stream')

    const rejectedAudio = await fetchHost(baseUrl, '/v1/parallax/audio?streamId=zone-stream&fromFrame=0', {
      headers: { Authorization: `Bearer ${livingToken}` }
    })
    assert.equal(rejectedAudio.status, 409)

    const livingControl = await readParallaxSseEvents(livingReader, 4)
    assert.deepEqual(livingControl.map((event) => event.type), [
      'sink-name-update',
      'sink-playback-update',
      'sink-playback-update',
      'stop'
    ])
    const kitchenControl = await readParallaxSseEvents(kitchenReader, 3)
    assert.deepEqual(kitchenControl.map((event) => event.type), [
      'sink-name-update',
      'sink-playback-update',
      'stream-start'
    ])

    service.setSinkPlaybackEnabled('living-room', true)
    assert.equal(service.getStatus().host.activePlaybackSinkCount, 2)
    const livingRejoin = await readParallaxSseEvents(livingReader, 2)
    assert.deepEqual(livingRejoin.map((event) => event.type), [
      'sink-playback-update',
      'stream-start'
    ])
    assert.equal(livingRejoin[1]?.stream?.streamId, 'zone-stream')

    service.setAllSinksPlaybackEnabled(false)
    assert.equal(service.getStatus().host.connectedSinkCount, 2)
    assert.equal(service.getStatus().host.activePlaybackSinkCount, 0)

    service.publishHostStreamStart({
      streamId: 'targeted-tone',
      trackId: 'parallax-test-tone',
      title: 'Test tone',
      artist: 'Astra',
      album: 'Setup',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48_000
    }, { targetSinkId: 'living-room' })
    const targetedJoinResponse = await fetchHost(baseUrl, '/v1/parallax/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${livingToken}` }
    })
    const targetedJoin = await targetedJoinResponse.json() as { playbackEnabled: boolean; stream: { streamId: string } | null }
    assert.equal(targetedJoin.playbackEnabled, false)
    assert.equal(targetedJoin.stream?.streamId, 'targeted-tone')
    service.stopHostStream()

    service.setAllSinksPlaybackEnabled(true)
    assert.equal(service.getStatus().host.activePlaybackSinkCount, 2)
  } finally {
    livingAbort.abort()
    kitchenAbort.abort()
    await livingEvents?.body?.cancel().catch(() => undefined)
    await kitchenEvents?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax reintroduces stream metadata when the first playback zone rejoins mid-stream', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const token = createOpaqueSecret(32)
  service.replacePairedSinks([makePersistedSink('living-room', token, 'Living Room')])

  const eventsAbort = new AbortController()
  let eventsResponse: UndiciResponse | null = null
  try {
    eventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${token}` },
      signal: eventsAbort.signal
    })
    assert.ok(eventsResponse.body)
    await waitFor(() => service.getStatus().host.activePlaybackSinkCount === 1)

    const initialTimeline = service.publishHostStreamStart({
      streamId: 'mid-stream-rejoin',
      trackId: 'zone-track',
      title: 'Zone Test',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 180,
      totalFrames: 8_640_000
    })
    const reader = eventsResponse.body.getReader()
    const initialEvents = await readParallaxSseEvents(reader, 3)
    assert.deepEqual(initialEvents.map((event) => event.type), [
      'sink-name-update',
      'sink-playback-update',
      'stream-start'
    ])

    service.setSinkPlaybackEnabled('living-room', false)
    const disabledEvents = await readParallaxSseEvents(reader, 2)
    assert.deepEqual(disabledEvents.map((event) => event.type), [
      'sink-playback-update',
      'stop'
    ])

    service.setSinkPlaybackEnabled('living-room', true)
    service.publishHostTimeline({
      ...initialTimeline,
      startFrame: 2_400_000,
      startHostTimeMs: initialTimeline.startHostTimeMs + 50_000,
      updatedHostTimeMs: initialTimeline.updatedHostTimeMs + 50_000
    })
    const rejoinEvents = await readParallaxSseEvents(reader, 2)
    assert.deepEqual(rejoinEvents.map((event) => event.type), [
      'sink-playback-update',
      'stream-start'
    ])
    assert.equal(rejoinEvents[1]?.stream?.streamId, 'mid-stream-rejoin')
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax host rejects the legacy pairing route and requires bearer auth for join', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const rejected = await fetchHost(baseUrl, '/v1/parallax/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000', sinkName: 'Kitchen' })
    })
    assert.equal(rejected.status, 401)

    const paired = await pairSink(service, baseUrl, 'Kitchen')
    assert.ok(paired.sinkId)
    assert.ok(paired.token)
    assert.equal(service.listPairedSinks().length, 1)

    const unauthorizedJoin = await fetchHost(baseUrl, '/v1/parallax/join', { method: 'POST' })
    assert.equal(unauthorizedJoin.status, 401)

    const authorizedJoin = await fetchHost(baseUrl, '/v1/parallax/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(authorizedJoin.status, 200)
  } finally {
    await service.stop()
  }
})

test('Parallax sink forget revokes host pairing and removes connected presence', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const eventsAbort = new AbortController()
  let eventsResponse: UndiciResponse | null = null
  try {
    const paired = await pairSink(service, baseUrl, 'Office')
    eventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    await waitFor(() => {
      const status = service.getStatus()
      return status.host.connectedSinkCount === 1
        && status.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId && sink.online)
    })

    const forgot = await fetchHost(baseUrl, '/v1/parallax/sink/forget', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(forgot.status, 200)

    await waitFor(() => {
      const status = service.getStatus()
      return status.host.pairedSinkCount === 0
        && status.host.connectedSinkCount === 0
        && !status.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId)
    })
    const hostRow = service.listPairedSinks().find((sink) => sink.id === paired.sinkId)
    assert.ok(hostRow?.revokedAt, 'host-side row should be retired by sink forget')
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax host presence cache can be cleared without removing pairing credentials', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const eventsAbort = new AbortController()
  let eventsResponse: UndiciResponse | null = null
  try {
    const paired = await pairSink(service, baseUrl, 'Office')
    eventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    await waitFor(() => service.getStatus().host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId))

    const cleared = service.clearHostPresenceCache(paired.sinkId)
    assert.equal(cleared.host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId), false)
    assert.equal(service.listPairedSinks().some((sink) => sink.id === paired.sinkId && sink.revokedAt === null), true)
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax host renames paired sink and updates connected status', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl, 'Desk')
    const eventsAbort = new AbortController()
    const eventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    try {
      await waitFor(() => service.getStatus().host.connectedSinks.some((sink) => sink.sinkId === paired.sinkId))

      const renamed = service.renamePairedSink(paired.sinkId, '  Living    Room   Sink  ')
      assert.equal(renamed?.name, 'Living Room Sink')
      assert.equal(service.listPairedSinks().find((sink) => sink.id === paired.sinkId)?.name, 'Living Room Sink')
      assert.equal(service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)?.name, 'Living Room Sink')

      const capped = service.renamePairedSink(paired.sinkId, ` ${'A'.repeat(90)} `)
      assert.equal(capped?.name, 'A'.repeat(80))
      assert.equal(service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)?.name, 'A'.repeat(80))
    } finally {
      eventsAbort.abort()
      await eventsResponse.body?.cancel().catch(() => undefined)
    }
  } finally {
    await service.stop()
  }
})

test('Parallax host rename returns null for missing or revoked sinks', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    assert.equal(service.renamePairedSink('missing', 'Desk'), null)

    const paired = await pairSink(service, baseUrl, 'Desk')
    assert.ok(service.revokePairedSink(paired.sinkId))
    assert.equal(service.renamePairedSink(paired.sinkId, 'Renamed'), null)
  } finally {
    await service.stop()
  }
})

test('sink transport control rides the shared command dispatch', async (t) => {
  const commands: MiniPlayerCommand[] = []
  const started = await tryCreateStartedParallaxService((command) => commands.push(command))
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const { token } = await pairSink(service, baseUrl)
    const post = (body: unknown, auth: string = token) => fetchHost(baseUrl, '/v1/parallax/control', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal((await post({ command: 'toggle-play' })).status, 200)
    assert.equal((await post({ command: 'next' })).status, 200)
    assert.equal((await post({ command: 'previous' })).status, 200)
    assert.deepEqual(commands, [{ type: 'togglePlay' }, { type: 'playNext' }, { type: 'playPrevious' }])
    assert.equal((await post({ command: 'eject' })).status, 400)
    assert.equal((await post({})).status, 400)
    assert.equal((await post({ command: 'toggle-play' }, createOpaqueSecret(32))).status, 401)
    assert.equal(commands.length, 3, 'rejected requests must never dispatch')
  } finally {
    await service.stop()
  }
})

test('Parallax host telemetry exposes connected sink RTT and preserves output trim state', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl, 'Desk')
    service.setSinkTrim(paired.sinkId, 'speaker-default', 'Desk DAC', 15)

    const telemetry = await fetchHost(baseUrl, '/v1/parallax/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paired.token}`
      },
      body: JSON.stringify({
        streamId: null,
        bufferedMs: 500,
        driftFrames: 0,
        rttMs: 27.4,
        underruns: 0,
        playbackRatePpm: 0,
        reportedAtMs: Date.now(),
        outputDeviceId: 'speaker-default',
        outputDeviceLabel: 'Desk DAC',
        appliedAdvanceMs: 15
      })
    })
    assert.equal(telemetry.status, 200)

    const row = service.getStatus().host.connectedSinks.find((sink) => sink.sinkId === paired.sinkId)
    assert.ok(row)
    assert.equal(row.rttMs, 27.4)
    assert.equal(row.outputDeviceId, 'speaker-default')
    assert.equal(row.outputDeviceLabel, 'Desk DAC')
    assert.equal(row.appliedAdvanceMs, 15)
    assert.equal(
      service.listPairedSinks()
        .find((sink) => sink.id === paired.sinkId)
        ?.trims?.find((trim) => trim.outputDeviceId === 'speaker-default')
        ?.advanceMs,
      15
    )
  } finally {
    await service.stop()
  }
})

test('Parallax host accepts the complete startup clock-priming burst before rate limiting', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl, 'Clock Burst')
    const statuses: number[] = []
    for (let index = 0; index < 13; index += 1) {
      const response = await fetchHost(baseUrl, '/v1/parallax/clock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${paired.token}`
        },
        body: JSON.stringify({ sinkSentAtMs: Date.now() + index })
      })
      statuses.push(response.status)
      await response.text()
    }
    assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200))
    assert.equal(statuses[11], 200)
    assert.equal(statuses[12], 429)
  } finally {
    await service.stop()
  }
})

test('Parallax legacy pairing endpoint cannot create credentials', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const response = await fetchHost(baseUrl, '/v1/parallax/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '123456', sinkName: 'Desk' })
    })
    assert.equal(response.status, 401)
    assert.equal(service.listPairedSinks().length, 0)
  } finally {
    await service.stop()
  }
})

test('Parallax audio endpoint streams timestamped PCM packets', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  const eventsAbort = new AbortController()
  let eventsResponse: UndiciResponse | null = null
  try {
    const paired = await pairSink(service, baseUrl)
    eventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${paired.token}` },
      signal: eventsAbort.signal
    })
    assert.equal(eventsResponse.status, 200)
    await waitFor(() => service.getStatus().host.activePlaybackSinkCount === 1)

    const timeline = service.publishHostStreamStart({
      streamId: 'stream-audio-test',
      trackId: 'track-audio-test',
      title: 'Audio Test',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48000
    })

    const pcm = new Float32Array([0.25, -0.25, 0.5, -0.5])
    service.publishHostAudioChunk({
      streamId: 'stream-audio-test',
      sampleRate: 48000,
      channels: 2,
      startFrame: 0,
      frameCount: 2,
      hostTimeMs: timeline.startHostTimeMs,
      pcmData: pcm.buffer
    })

    const response = await fetchHost(baseUrl, '/v1/parallax/audio?streamId=stream-audio-test&fromFrame=0', {
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(response.status, 200)
    assert.ok(response.body)

    const reader = response.body.getReader()
    const pendingChunks: Uint8Array[] = []
    let pendingBytes = 0
    let decoded: ReturnType<typeof decodeParallaxAudioPacket> = null
    try {
      for (let attempt = 0; attempt < 4 && !decoded; attempt += 1) {
        const { done, value } = await reader.read()
        assert.equal(done, false)
        assert.ok(value)
        pendingChunks.push(value)
        pendingBytes += value.byteLength
        const pending = new Uint8Array(pendingBytes)
        let offset = 0
        for (const chunk of pendingChunks) {
          pending.set(chunk, offset)
          offset += chunk.byteLength
        }
        decoded = decodeParallaxAudioPacket(pending)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    assert.ok(decoded)
    assert.equal(decoded.chunk.sampleRate, 48000)
    assert.equal(decoded.chunk.channels, 2)
    assert.equal(decoded.chunk.startFrame, 0)
    assert.equal(decoded.chunk.frameCount, 2)
    assert.equal(decoded.chunk.hostTimeMs, timeline.startHostTimeMs)
    assert.deepEqual(Array.from(new Float32Array(decoded.chunk.pcmData)), Array.from(pcm))
  } finally {
    eventsAbort.abort()
    await eventsResponse?.body?.cancel().catch(() => undefined)
    await service.stop()
  }
})

test('Parallax stream metadata carries host normalization gain through status and join', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl)
    service.publishHostStreamStart({
      streamId: 'stream-normalized-test',
      trackId: 'track-normalized-test',
      title: 'Normalized Test',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48000,
      normalizationGainDb: -8.25,
      normalizationMode: 'replaygain'
    })

    const activeStream = service.getStatus().host.activeStream
    assert.equal(activeStream?.streamId, 'stream-normalized-test')
    assert.equal(activeStream?.normalizationGainDb, -8.25)
    assert.equal(activeStream?.normalizationMode, 'replaygain')

    const joinResponse = await fetchHost(baseUrl, '/v1/parallax/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(joinResponse.status, 200)
    const join = await joinResponse.json() as {
      stream: {
        streamId: string
        normalizationGainDb: number
        normalizationMode: string
      } | null
    }
    assert.equal(join.stream?.streamId, 'stream-normalized-test')
    assert.equal(join.stream?.normalizationGainDb, -8.25)
    assert.equal(join.stream?.normalizationMode, 'replaygain')
  } finally {
    await service.stop()
  }
})

test('Parallax events endpoint delivers consecutive stream-start metadata updates', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service, baseUrl } = started
  try {
    const paired = await pairSink(service, baseUrl)
    const response = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${paired.token}` }
    })
    assert.equal(response.status, 200)
    assert.ok(response.body)
    const reader = response.body.getReader()
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      service.publishHostStreamStart({
        streamId: 'stream-one',
        trackId: 'track-one',
        title: 'One',
        artist: 'Astra',
        album: 'Parallax',
        sampleRate: 48000,
        channels: 2,
        durationSeconds: 1,
        totalFrames: 48000,
        normalizationGainDb: -3.5,
        normalizationMode: 'normalization'
      })
      service.publishHostStreamStart({
        streamId: 'stream-two',
        trackId: 'track-two',
        title: 'Two',
        artist: 'Astra',
        album: 'Parallax',
        sampleRate: 48000,
        channels: 2,
        durationSeconds: 1,
        totalFrames: 48000,
        normalizationGainDb: 1.25,
        normalizationMode: 'replaygain'
      })

      const events = await readParallaxSseEvents(reader, 4)
      const streamStarts = events.filter((event) => event.type === 'stream-start')
      assert.deepEqual(
        streamStarts.map((event) => event.stream?.streamId),
        ['stream-one', 'stream-two']
      )
      assert.deepEqual(
        streamStarts.map((event) => event.stream?.normalizationGainDb),
        [-3.5, 1.25]
      )
      assert.deepEqual(
        streamStarts.map((event) => event.stream?.normalizationMode),
        ['normalization', 'replaygain']
      )
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } finally {
    await service.stop()
  }
})

test('Parallax app sink initial join reports a structured sanitized validation diagnostic', async (t) => {
  let port: number
  try {
    port = await getFreePort()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('Local socket binding is blocked in this environment.')
      return
    }
    throw error
  }
  const tlsIdentity = await createParallaxTlsIdentity('Invalid Initial Join Host')
  const baseUrl = `https://127.0.0.1:${port}`
  const token = 'app-test-bearer-token-never-log'
  const rawPayloadMarker = 'app-raw-response-body-never-log'
  const diagnostics: ParallaxJoinValidationDiagnostic[] = []
  const server = createHttpsServer({
    key: tlsIdentity.privateKeyPem,
    cert: tlsIdentity.certificatePem,
    minVersion: 'TLSv1.2'
  }, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    res.writeHead(200, { 'Content-Type': 'application/problem+json; charset=utf-8' })
    res.end(JSON.stringify({
      sinkId: 'app-sink',
      groupLatencyMs: 1000,
      hostTimeMs: Date.now(),
      stream: null,
      timeline: { marker: rawPayloadMarker },
      secret: token
    }))
  })
  await listenHttpServer(server, port)

  const sinkService = new ParallaxService({
    config: { enabled: false, port },
    pairedSinks: [],
    softwareVersion: 'astra-app-test',
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
  try {
    await assert.rejects(sinkService.connectSink({
      protocolVersion: 2,
      baseUrl,
      sinkId: 'app-sink',
      token,
      hostCertificatePem: tlsIdentity.certificatePem,
      hostCertificateFingerprint: tlsIdentity.fingerprint256
    }), /invalid join response \(invalid-timeline-fields\)/)

    assert.deepEqual(diagnostics, [{
      event: 'parallax_join_validation_failed',
      joinPhase: 'initial',
      reason: 'invalid-timeline-fields',
      httpStatus: 200,
      contentType: 'application/problem+json; charset=utf-8',
      protocolVersion: 2,
      softwareVersion: 'astra-app-test'
    }])
    assert.match(sinkService.getStatus().sink.lastError ?? '', /invalid-timeline-fields/)
    const surfaced = JSON.stringify({ diagnostics, status: sinkService.getStatus() })
    assert.equal(surfaced.includes(token), false)
    assert.equal(surfaced.includes(rawPayloadMarker), false)
  } finally {
    await sinkService.stop()
    await closeHttpServer(server)
  }
})

test('Parallax app sink reconnect reports the exact failed invariant', async (t) => {
  let port: number
  try {
    port = await getFreePort()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('Local socket binding is blocked in this environment.')
      return
    }
    throw error
  }
  const tlsIdentity = await createParallaxTlsIdentity('Invalid Reconnect Join Host')
  const baseUrl = `https://127.0.0.1:${port}`
  const diagnostics: ParallaxJoinValidationDiagnostic[] = []
  let joinCount = 0
  const server = createHttpsServer({
    key: tlsIdentity.privateKeyPem,
    cert: tlsIdentity.certificatePem,
    minVersion: 'TLSv1.2'
  }, (req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    if (req.method === 'POST' && url.pathname === '/v1/parallax/join') {
      joinCount += 1
      const stream = {
        streamId: 'active-stream',
        trackId: 'track',
        title: 'Title',
        artist: 'Artist',
        album: 'Album',
        sampleRate: 48_000,
        channels: 2,
        durationSeconds: 1,
        totalFrames: 48_000,
        chunkFrames: 4096,
        groupLatencyMs: 1000,
        createdAt: 1
      }
      const timeline = {
        streamId: joinCount === 1 ? 'active-stream' : 'different-stream',
        playbackState: 'playing',
        startFrame: 0,
        startHostTimeMs: Date.now(),
        updatedHostTimeMs: Date.now(),
        groupLatencyMs: 1000
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkId: 'app-sink',
        groupLatencyMs: 1000,
        hostTimeMs: Date.now(),
        stream,
        timeline
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/parallax/clock') {
      const now = Date.now()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sinkSentAtMs: now, hostReceivedAtMs: now, hostSentAtMs: now }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/parallax/events') {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('offline')
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/parallax/audio') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No audio' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  await listenHttpServer(server, port)

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, timeout === 2_000 || timeout === 120 ? 0 : timeout, ...args)
  }) as typeof setTimeout
  const sinkService = new ParallaxService({
    config: { enabled: false, port },
    pairedSinks: [],
    softwareVersion: 'astra-app-test',
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
  try {
    await sinkService.connectSink({
      protocolVersion: 2,
      baseUrl,
      sinkId: 'app-sink',
      token: 'token',
      hostCertificatePem: tlsIdentity.certificatePem,
      hostCertificateFingerprint: tlsIdentity.fingerprint256
    })
    await waitFor(() => diagnostics.some((diagnostic) => diagnostic.joinPhase === 'reconnect'), 3_000)

    assert.deepEqual(diagnostics.find((diagnostic) => diagnostic.joinPhase === 'reconnect'), {
      event: 'parallax_join_validation_failed',
      joinPhase: 'reconnect',
      reason: 'active-id-mismatch',
      httpStatus: 200,
      contentType: 'application/json',
      protocolVersion: 2,
      softwareVersion: 'astra-app-test'
    })
    assert.match(sinkService.getStatus().sink.lastError ?? '', /active-id-mismatch/)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    await sinkService.stop()
    await closeHttpServer(server)
  }
})

test('Parallax host and receiver lifecycle keeps stop, forget, re-pair, and gapless reconnect joins valid', async (t) => {
  const started = await tryCreateStartedParallaxService()
  if (!started) {
    t.skip('Local socket binding is blocked in this environment.')
    return
  }
  const { service: host, baseUrl, tlsIdentity } = started
  const diagnostics: ParallaxJoinValidationDiagnostic[] = []
  const events: ParallaxTimelineEvent[] = []
  const receiver = new ParallaxSinkClient({
    softwareVersion: 'receiver-integration-test',
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onEvent: (event) => events.push(event),
    onAudioChunk: () => undefined,
    onStatus: () => undefined,
    onAuthRevoked: () => undefined
  })
  const originalSetTimeout = globalThis.setTimeout
  const anchorAbort = new AbortController()
  let anchorEventsResponse: UndiciResponse | null = null
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, timeout === 2_000 || timeout === 120 ? 0 : timeout, ...args)
  }) as typeof setTimeout

  const connectReceiver = async (sinkId: string, token: string): Promise<void> => {
    await receiver.connect({
      protocolVersion: 2,
      baseUrl,
      sinkId,
      token,
      hostCertificatePem: tlsIdentity.certificatePem,
      hostCertificateFingerprint: tlsIdentity.fingerprint256
    })
    await waitFor(() => host.getStatus().host.connectedSinkCount === 1, 3_000)
  }

  try {
    const firstSinkId = 'receiver-before-repair'
    const firstToken = createOpaqueSecret(32)
    host.replacePairedSinks([makePersistedSink(firstSinkId, firstToken, 'Receiver Before Re-pair')])
    await connectReceiver(firstSinkId, firstToken)

    host.publishHostStreamStart({
      streamId: 'stream-before-stop',
      trackId: 'track-before-stop',
      title: 'Before Stop',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 1,
      totalFrames: 48_000
    })
    host.stopHostStream()
    await waitFor(() => events.some((event) => event.type === 'stop'))

    await receiver.disconnect()
    await connectReceiver(firstSinkId, firstToken)
    assert.equal(receiver.getStatus().activeStream, null)
    assert.equal(receiver.getStatus().timeline, null)

    await receiver.forgetOnHost()
    await waitFor(() => host.getStatus().host.pairedSinkCount === 0)
    await receiver.disconnect()

    const repairedSinkId = 'receiver-after-repair'
    const repairedToken = createOpaqueSecret(32)
    const anchorSinkId = 'receiver-reconnect-anchor'
    const anchorToken = createOpaqueSecret(32)
    host.replacePairedSinks([
      makePersistedSink(repairedSinkId, repairedToken, 'Receiver After Re-pair'),
      makePersistedSink(anchorSinkId, anchorToken, 'Reconnect Anchor')
    ])
    await connectReceiver(repairedSinkId, repairedToken)
    anchorEventsResponse = await fetchHost(baseUrl, '/v1/parallax/events', {
      headers: { Authorization: `Bearer ${anchorToken}` },
      signal: anchorAbort.signal
    })
    assert.equal(anchorEventsResponse.status, 200)
    await waitFor(() => host.getStatus().host.connectedSinkCount === 2, 3_000)

    const activeTimeline = host.publishHostStreamStart({
      streamId: 'gapless-active',
      trackId: 'gapless-active-track',
      title: 'Gapless Active',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 120,
      totalFrames: 5_760_000
    })
    host.publishHostNextStreamStart({
      streamId: 'gapless-next',
      trackId: 'gapless-next-track',
      title: 'Gapless Next',
      artist: 'Astra',
      album: 'Parallax',
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 120,
      totalFrames: 5_760_000
    }, { startHostTimeMs: activeTimeline.startHostTimeMs + 120_000 })
    await waitFor(() => events.some((event) => event.type === 'next-stream-start'))

    const activeEventsBeforeReconnect = events.filter((event) => event.type === 'stream-start').length
    const nextEventsBeforeReconnect = events.filter((event) => event.type === 'next-stream-start').length
    const receiverInternals = receiver as unknown as {
      connection: object | null
      reconnect: (connection: object) => Promise<void>
    }
    assert.ok(receiverInternals.connection)
    await receiverInternals.reconnect(receiverInternals.connection)
    await waitFor(() => (
      events.filter((event) => event.type === 'stream-start').length > activeEventsBeforeReconnect
      && events.filter((event) => event.type === 'next-stream-start').length > nextEventsBeforeReconnect
    ), 3_000)

    assert.equal(diagnostics.length, 0)
    assert.equal(receiver.getStatus().lastError, null)
    assert.equal(receiver.getStatus().activeStream?.streamId, 'gapless-active')
  } finally {
    globalThis.setTimeout = originalSetTimeout
    anchorAbort.abort()
    await anchorEventsResponse?.body?.cancel().catch(() => undefined)
    await receiver.disconnect()
    await host.stop()
  }
})

test('Parallax sink auto-rejoins after an event stream failure', async () => {
  const port = await getFreePort()
  const tlsIdentity = await createParallaxTlsIdentity('Retry Test Host')
  const baseUrl = `https://127.0.0.1:${port}`
  let joinCount = 0
  let eventRequestCount = 0
  const server = createHttpsServer({
    key: tlsIdentity.privateKeyPem,
    cert: tlsIdentity.certificatePem,
    minVersion: 'TLSv1.2'
  }, (req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    if (req.method === 'POST' && url.pathname === '/v1/parallax/join') {
      joinCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkId: 'sink-retry',
        groupLatencyMs: 1000,
        hostTimeMs: Date.now(),
        stream: null,
        timeline: null
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/parallax/clock') {
      const now = Date.now()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sinkSentAtMs: now,
        hostReceivedAtMs: now,
        hostSentAtMs: now
      }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/parallax/events') {
      eventRequestCount += 1
      if (eventRequestCount === 1) {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('offline')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache'
      })
      res.write(': connected\n\n')
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  await listenHttpServer(server, port)

  const originalSetTimeout = globalThis.setTimeout
  const originalFetch = globalThis.fetch
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, timeout === 2_000 ? 0 : timeout, ...args)
  }) as typeof setTimeout
  globalThis.fetch = (() => {
    throw new Error('Pinned Parallax HTTPS must not use Electron/Node global fetch.')
  }) as typeof fetch

  const sinkService = new ParallaxService({ config: { enabled: false, port }, pairedSinks: [] })
  try {
    await sinkService.connectSink({
      protocolVersion: 2,
      baseUrl,
      sinkId: 'sink-retry',
      token: 'token',
      hostCertificatePem: tlsIdentity.certificatePem,
      hostCertificateFingerprint: tlsIdentity.fingerprint256
    })
    await waitFor(() => joinCount >= 2 && eventRequestCount >= 2 && sinkService.getStatus().sink.lastError === null)
    assert.equal(sinkService.getStatus().sink.connected, true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.fetch = originalFetch
    await sinkService.stop()
    await closeHttpServer(server)
  }
})

// ============================================================================================
// §20 Commit 3 — sink listener + host-side pair flow. Codex 'tests early' list:
//   1. pair-request creates PIN; no token persisted yet.
//   2. wrong PIN never activates host candidate.
//   3. success persists sink credential AND activates host paired sink.
//   4. busy: second pair-request returns 409 while pending.
//   5. expiry: pair-confirm after TTL returns 410.
//   6. 3-fail lockout: 3 wrong PINs → next pair-confirm returns 404 (pending cleared).
// ============================================================================================

import { ParallaxSinkListener, type ParallaxSinkListenerPairedInfo } from './parallaxSinkListener.ts'

interface PairFixture {
  listener: ParallaxSinkListener
  port: number
  sinkBaseUrl: string
  host: ParallaxService
  hostPort: number
  paired: ParallaxSinkListenerPairedInfo[]
  incoming: Array<unknown>
  endpointUuid: string
}

async function createPairFixture(overrides: { sinkName?: string; hasPersisted?: boolean; pinTtlMs?: number } = {}): Promise<PairFixture> {
  const sinkPort = await getFreePort()
  const hostPort = await getFreePort()
  const paired: ParallaxSinkListenerPairedInfo[] = []
  const incoming: Array<unknown> = []
  const endpointUuid = '11111111-2222-3333-4444-555555555555'
  const listener = new ParallaxSinkListener({
    getEndpointUuid: () => endpointUuid,
    getSinkName: () => overrides.sinkName ?? 'Test Sink',
    getHasPersistedConnection: () => overrides.hasPersisted ?? false,
    onPaired: async (info) => { paired.push(info) },
    onIncomingPairChange: (state) => { incoming.push(state) }
  }, { pinTtlMs: overrides.pinTtlMs })
  await listener.start(sinkPort)

  const tlsIdentity = await createParallaxTlsIdentity('Test Host')
  const host = new ParallaxService({
    config: { enabled: true, port: hostPort },
    tlsIdentity,
    pairedSinks: [],
    getHostDisplayName: () => 'Test Host',
    getEndpointUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  })
  await host.applyHostConfig({ enabled: true, port: hostPort })

  return {
    listener,
    port: sinkPort,
    sinkBaseUrl: `http://127.0.0.1:${sinkPort}`,
    host,
    hostPort,
    paired,
    incoming,
    endpointUuid
  }
}

async function destroyPairFixture(fixture: PairFixture): Promise<void> {
  await fixture.listener.stop()
  await fixture.host.stop()
}

async function postJson(url: string, body: unknown): Promise<{ status: number; payload: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload }
}

test('§20 pair-request creates PIN on sink; no token stored', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    assert.equal(typeof initiate.pairingId, 'string')
    assert.equal(initiate.expiresInSeconds > 0, true)

    // Host has staged a candidate but it is NOT yet in pairedSinks.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    const pending = fixture.host.getPendingPairSnapshot(initiate.pairingId)
    assert.ok(pending)

    // Sink has shown a PIN and the incoming-pair callback has fired.
    const lastIncoming = fixture.incoming.at(-1) as { pin?: string } | null
    assert.ok(lastIncoming, 'sink should have emitted an incoming-pair state')
    assert.equal(typeof lastIncoming!.pin, 'string')
    assert.equal((lastIncoming!.pin as string).length, 6)

    // Sink did NOT receive a token in the pair-request.
    assert.equal(fixture.paired.length, 0, 'pair-request must not persist credentials')
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm wrong PIN never activates host candidate', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const incoming = fixture.incoming.at(-1) as { pin: string }
    const wrongCode = incoming.pin === '000000' ? '111111' : '000000'
    await assert.rejects(
      fixture.host.submitPairPin(initiate.pairingId, wrongCode),
      (error: any) => error?.status === 401
    )
    assert.equal(fixture.paired.length, 0, 'sink must not persist on wrong PIN')
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0, 'host must not activate candidate on wrong PIN')
    // Candidate still present (only 1 of 3 fails consumed).
    const pending = fixture.host.getPendingPairSnapshot(initiate.pairingId)
    assert.ok(pending)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm success persists sink credential AND activates host paired sink', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string }
    const submitPromise = fixture.host.submitPairPin(initiate.pairingId, lastIncoming.pin, 'Studio Desk')
    await waitFor(() => Boolean((fixture.incoming.at(-1) as { awaitingApproval?: boolean } | null)?.awaitingApproval))
    assert.equal(fixture.listener.approvePending(), true)
    const submitted = await submitPromise
    assert.equal(typeof submitted.sinkId, 'string')
    assert.equal(submitted.sinkName, 'Studio Desk')

    // Sink persisted via onPaired callback.
    assert.equal(fixture.paired.length, 1)
    const persistedInfo = fixture.paired[0]
    assert.equal(persistedInfo.sinkId, submitted.sinkId)
    assert.equal(typeof persistedInfo.token, 'string')
    assert.equal(persistedInfo.token.length > 0, true)
    assert.equal(persistedInfo.hostName, 'Test Host')
    // Host URL derived from socket remote address — must be 127.0.0.1, NOT 0.0.0.0.
    assert.match(persistedInfo.hostUrl, /^https:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(persistedInfo.protocolVersion, 2)
    assert.ok(persistedInfo.hostCertificateFingerprint)

    // Host activated the candidate into pairedSinks.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 1)
    assert.equal(fixture.host.listPairedSinks()[0]?.playbackEnabled, true)
    assert.equal(fixture.host.getPendingPairSnapshot(initiate.pairingId), null)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 rejecting during explicit approval does not persist or activate the pairing', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const incoming = fixture.incoming.at(-1) as { pin: string }
    const submitPromise = fixture.host.submitPairPin(initiate.pairingId, incoming.pin)
    await waitFor(() => Boolean(
      (fixture.incoming.at(-1) as { awaitingApproval?: boolean } | null)?.awaitingApproval
    ))

    fixture.listener.cancelPending()
    await assert.rejects(submitPromise, /pairing-not-approved/)
    assert.equal(fixture.listener.approvePending(), false)
    assert.equal(fixture.incoming.at(-1), null)
    assert.equal(fixture.paired.length, 0)
    assert.equal(fixture.host.getStatus().host.pairedSinkCount, 0)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('Parallax v2 rejects a second pair-request while approval is pending', async () => {
  const fixture = await createPairFixture()
  try {
    await fixture.host.initiatePair(fixture.sinkBaseUrl)
    // A fresh request cannot silently replace the code currently visible to the user.
    const second = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-request`, {
      pairingId: 'second',
      hostName: 'Same Host Retry',
      hostPort: fixture.hostPort,
      parallaxEndpointUuid: 'second-uuid'
    })
    assert.equal(second.status, 409)
    assert.equal(second.payload?.error, 'busy')
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('Parallax v2 rejects duplicate confirmations while sink approval is pending', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const incoming = fixture.incoming.at(-1) as { pin: string }
    const firstConfirmation = fixture.host.submitPairPin(initiate.pairingId, incoming.pin)
    await waitFor(() => Boolean((fixture.incoming.at(-1) as { awaitingApproval?: boolean } | null)?.awaitingApproval))
    await assert.rejects(
      fixture.host.submitPairPin(initiate.pairingId, incoming.pin),
      /confirmation-already-pending/
    )
    assert.equal(fixture.listener.approvePending(), true)
    await firstConfirmation
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 pair-confirm after expiry returns 410 via the tombstone', async () => {
  // Short PIN TTL so the listener's own expiry timer fires inside the test window. The
  // tombstone (Codex round 1 finding, low) lets the confirm POST-expiry still resolve as 410
  // instead of degrading to a generic 404.
  const fixture = await createPairFixture({ pinTtlMs: 60 })
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string; pairingId: string }
    await new Promise((resolve) => setTimeout(resolve, 120))
    const confirmAttempt = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-confirm`, {
      pairingId: lastIncoming.pairingId,
      pin: lastIncoming.pin,
      sinkId: 'spoof-sink-id',
      token: 'spoof-token'
    })
    assert.equal(confirmAttempt.status, 410, 'post-expiry confirm should be 410, not 404')
    assert.equal(confirmAttempt.payload?.error, 'expired')

    // Host candidate stays pending until TTL or explicit cancel.
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    fixture.host.cancelPair(initiate.pairingId)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 confirm for a pairingId that never existed still returns 404', async () => {
  // Negative case for the tombstone — without a matching pending OR tombstone, the generic
  // "no pending" path is correct.
  const fixture = await createPairFixture()
  try {
    const confirmAttempt = await postJson(`${fixture.sinkBaseUrl}/v1/parallax/pair-confirm`, {
      pairingId: 'never-existed',
      pin: '000000',
      sinkId: 'spoof-sink-id',
      token: 'spoof-token'
    })
    assert.equal(confirmAttempt.status, 404)
  } finally {
    await destroyPairFixture(fixture)
  }
})

test('§20 stop() drains pending pair timers (Codex round 1, medium)', async () => {
  // The 90s candidate TTL setTimeout used to keep the event loop alive after stop(); the test
  // process took ~91s to exit. clearAllPendingPairs() in stop() fixes that.
  const fixture = await createPairFixture()
  await fixture.host.initiatePair(fixture.sinkBaseUrl)
  // Stop both ends.
  await destroyPairFixture(fixture)
  // If stop() did not drain the candidate timers, the suite would hang here for ~90s. The
  // fact that this test returns immediately is the real assertion; the explicit check below
  // just confirms the host's view of pendingPairs is consistent post-stop.
  const stopped = fixture.host.getPendingPairSnapshot('any-id')
  assert.equal(stopped, null)
})

test('§20 3 wrong PINs lock out further attempts', async () => {
  const fixture = await createPairFixture()
  try {
    const initiate = await fixture.host.initiatePair(fixture.sinkBaseUrl)
    const lastIncoming = fixture.incoming.at(-1) as { pin: string; pairingId: string }
    const wrongPin = lastIncoming.pin === '000000' ? '111111' : '000000'

    // Drain three wrong-PIN attempts; pending state clears after the 3rd.
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        fixture.host.submitPairPin(initiate.pairingId, wrongPin),
        (error: any) => error?.status === 401
      )
    }

    // 4th attempt — with the correct PIN, even — must NOT activate because pending was cleared.
    await assert.rejects(
      fixture.host.submitPairPin(initiate.pairingId, lastIncoming.pin),
      (error: any) => /Sink has no record|Pair candidate not found/.test(String(error?.message ?? ''))
    )
    await assert.rejects(
      fixture.host.initiatePair(fixture.sinkBaseUrl),
      /temporarily locked/i
    )
    const status = fixture.host.getStatus()
    assert.equal(status.host.pairedSinkCount, 0)
    assert.equal(fixture.paired.length, 0)
  } finally {
    await destroyPairFixture(fixture)
  }
})
