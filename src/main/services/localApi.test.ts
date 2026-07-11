import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type { LocalApiServiceConfig } from '../../types/localApi'
import { LocalApiService, generateLocalApiToken } from './localApi.ts'

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

async function createHarness(configOverrides: Partial<LocalApiServiceConfig> = {}) {
  const commands: MiniPlayerCommand[] = []
  const snapshotState: { current: MiniPlayerSnapshot | null } = {
    current: createSnapshot()
  }
  const port = await getFreePort()
  const config: LocalApiServiceConfig = {
    enabled: true,
    controlsEnabled: true,
    port,
    token: generateLocalApiToken(),
    ...configOverrides
  }

  const service = new LocalApiService({
    config,
    getSnapshot: () => snapshotState.current,
    dispatchCommand: (command) => {
      commands.push(command)
    }
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

test('local API always binds to loopback when enabled', async (t) => {
  const port = await getFreePort()
  const config: LocalApiServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    port,
    token: generateLocalApiToken()
  }
  const service = new LocalApiService({
    config,
    getSnapshot: () => createSnapshot(),
    dispatchCommand: () => {}
  })

  t.after(async () => {
    await service.stop()
  })

  let status = service.getStatus()
  assert.equal(status.active, false)
  assert.equal(status.bindHost, '127.0.0.1')

  status = await service.applyConfig({
    ...config,
    enabled: true
  })

  assert.equal(status.active, true)
  assert.equal(status.bindHost, '127.0.0.1')
  assert.equal(status.baseUrl, `http://127.0.0.1:${port}`)
})

test('local API routes reject unauthorized requests', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const nowPlaying = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`)
  assert.equal(nowPlaying.status, 401)

  const events = await fetch(`http://127.0.0.1:${harness.port}/v1/events`)
  assert.equal(events.status, 401)

  const artwork = await fetch(`http://127.0.0.1:${harness.port}/v1/artwork/current?trackId=track-1`)
  assert.equal(artwork.status, 401)

  const control = await fetch(`http://127.0.0.1:${harness.port}/v1/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ command: 'play' })
  })
  assert.equal(control.status, 401)
})

test('now-playing exposes joined artist display and parsed artist arrays', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  harness.publishSnapshot(createSnapshot({
    currentTrack: {
      id: 'jamule-chilla-13',
      path: '/music/Jamule & Chilla - 13.mp3',
      title: '13',
      artist: 'Jamule',
      artistNames: ['Jamule', 'Chilla'],
      album: '13',
      albumArtist: 'Jamule',
      albumArtistNames: ['Jamule', 'Chilla'],
      artworkData: null,
      isFavorite: false
    }
  }))

  const response = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(response.status, 200)

  const body = await response.json() as Record<string, unknown>
  const currentTrack = body.currentTrack as Record<string, unknown>
  assert.equal(currentTrack.artist, 'Jamule & Chilla')
  assert.deepEqual(currentTrack.artists, ['Jamule', 'Chilla'])
  assert.deepEqual(currentTrack.albumArtists, ['Jamule', 'Chilla'])
})

test('seek control clamps to the track duration and rejects missing tracks', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const floorResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/control`, {
    method: 'POST',
    headers: {
      ...authHeaders(harness.config.token),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ command: 'seek', time: -15 })
  })
  assert.equal(floorResponse.status, 200)

  const ceilResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/control`, {
    method: 'POST',
    headers: {
      ...authHeaders(harness.config.token),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ command: 'seek', time: 999 })
  })
  assert.equal(ceilResponse.status, 200)

  assert.deepEqual(harness.commands, [
    { type: 'seek', time: 0 },
    { type: 'seek', time: 185.5 }
  ])

  harness.publishSnapshot(null)

  const rejectedResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/control`, {
    method: 'POST',
    headers: {
      ...authHeaders(harness.config.token),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ command: 'seek', time: 12 })
  })
  assert.equal(rejectedResponse.status, 409)
})

test('rotating the token closes existing event streams and rejects the old token', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const streamResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/events`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(streamResponse.status, 200)
  assert.ok(streamResponse.body)

  const reader = streamResponse.body?.getReader()
  assert.ok(reader)

  const firstChunk = await reader?.read()
  assert.equal(firstChunk?.done, false)

  const nextToken = generateLocalApiToken()
  await harness.service.applyConfig({
    ...harness.config,
    token: nextToken
  })

  const finalChunk = await reader?.read()
  assert.equal(finalChunk?.done, true)

  const staleTokenResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(staleTokenResponse.status, 401)

  const freshTokenResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: authHeaders(nextToken)
  })
  assert.equal(freshTokenResponse.status, 200)
})
