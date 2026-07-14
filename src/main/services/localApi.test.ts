import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type { LocalApiServiceConfig } from '../../types/localApi'
import type {
  CompanionApiRendererCommand,
  CompanionApiTargetType
} from '../../types/companionApi'
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
  const companionCommands: CompanionApiRendererCommand[] = []
  let rendererAvailable = true
  const snapshotState: { current: MiniPlayerSnapshot | null } = {
    current: createSnapshot()
  }
  const port = await getFreePort()
  const config: LocalApiServiceConfig = {
    enabled: true,
    controlsEnabled: true,
    librarySearchEnabled: false,
    libraryWriteEnabled: false,
    port,
    token: generateLocalApiToken(),
    ...configOverrides
  }

  const service = new LocalApiService({
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
        queueCount: 1,
        currentTrack: snapshotState.current?.currentTrack
          ? {
              ref: 'track-ref',
              title: snapshotState.current.currentTrack.title,
              artist: snapshotState.current.currentTrack.artist,
              artists: [snapshotState.current.currentTrack.artist],
              album: snapshotState.current.currentTrack.album,
              albumArtists: [],
              durationSeconds: snapshotState.current.duration,
              year: null,
              genres: [],
              format: 'flac',
              sampleRateHz: 96_000,
              bitDepth: 24,
              channels: 2,
              favorite: false,
              artworkUrl: null
            }
          : null,
        updatedAt: Date.now()
      }),
      getQueue: () => ({
        items: [],
        updatedAt: Date.now()
      }),
      search: (query, _types, limit) => ({
        query,
        limit,
        results: [{
          type: 'track',
          ref: 'track-ref',
          title: 'Test Track',
          subtitle: 'Test Artist · Test Album',
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
        if (!rendererAvailable) return false
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
    }
  })

  await service.applyConfig(config)

  return {
    service,
    config,
    commands,
    companionCommands,
    port,
    setRendererAvailable: (available: boolean) => {
      rendererAvailable = available
    },
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

const CORS_TEST_ORIGIN = 'http://127.0.0.1:5173'

test('local API always binds to loopback when enabled', async (t) => {
  const port = await getFreePort()
  const config: LocalApiServiceConfig = {
    enabled: false,
    controlsEnabled: false,
    librarySearchEnabled: false,
    libraryWriteEnabled: false,
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

  const nowPlaying = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing`, {
    headers: { Origin: CORS_TEST_ORIGIN }
  })
  assert.equal(nowPlaying.status, 401)
  assert.equal(nowPlaying.headers.get('access-control-allow-origin'), '*')

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

test('local API answers GET CORS preflight requests', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const response = await fetch(`http://127.0.0.1:${harness.port}/v1/now-playing?inlineArtwork=1`, {
    method: 'OPTIONS',
    headers: {
      Origin: CORS_TEST_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization'
    }
  })

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type')
  assert.equal(response.headers.get('access-control-max-age'), '600')
  assert.equal(response.headers.get('access-control-allow-credentials'), null)
  assert.equal(await response.text(), '')
})

test('local API answers POST CORS preflight requests', async (t) => {
  const harness = await createHarness()
  t.after(async () => {
    await harness.service.stop()
  })

  const response = await fetch(`http://127.0.0.1:${harness.port}/v1/control`, {
    method: 'OPTIONS',
    headers: {
      Origin: CORS_TEST_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  })

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type')
  assert.equal(response.headers.get('access-control-max-age'), '600')
  assert.equal(await response.text(), '')
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
    headers: {
      ...authHeaders(harness.config.token),
      Origin: CORS_TEST_ORIGIN
    }
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')

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

  let finalChunk = await reader?.read()
  for (let index = 0; index < 4 && !finalChunk?.done; index += 1) {
    finalChunk = await reader?.read()
  }
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

test('v2 serves its contract publicly but authenticates application resources', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())

  const contract = await fetch(`http://127.0.0.1:${harness.port}/v2/openapi.json`)
  assert.equal(contract.status, 200)
  assert.equal((await contract.json() as { openapi: string }).openapi, '3.1.0')

  const unauthorized = await fetch(`http://127.0.0.1:${harness.port}/v2/capabilities`)
  assert.equal(unauthorized.status, 401)
  assert.deepEqual(await unauthorized.json(), {
    error: { code: 'unauthorized', message: 'A valid bearer token is required.' }
  })
})

test('v2 reports local scopes and keeps library permissions off by default', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())

  const response = await fetch(`http://127.0.0.1:${harness.port}/v2/capabilities`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { grantedScopes: string[]; transport: string }
  assert.equal(body.transport, 'loopback')
  assert.deepEqual(body.grantedScopes, ['observe', 'playback-control'])

  const search = await fetch(`http://127.0.0.1:${harness.port}/v2/search?q=test`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(search.status, 403)
  assert.equal((await search.json() as { error: { code: string } }).error.code, 'insufficient_scope')
})

test('v2 playback is sanitized and never returns the internal track path', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())

  const response = await fetch(`http://127.0.0.1:${harness.port}/v2/playback`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal(text.includes('/music/test.flac'), false)
  const body = JSON.parse(text) as { currentTrack: { ref: string }; volume: number }
  assert.equal(body.currentTrack.ref, 'track-ref')
  assert.equal(body.volume, 0.75)
})

test('v2 bounded search validates queries and clamps result limits', async (t) => {
  const harness = await createHarness({ librarySearchEnabled: true })
  t.after(async () => harness.service.stop())

  const missingQuery = await fetch(`http://127.0.0.1:${harness.port}/v2/search`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(missingQuery.status, 400)

  const response = await fetch(`http://127.0.0.1:${harness.port}/v2/search?q=Test&types=track&limit=999`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { query: string; limit: number; results: unknown[] }
  assert.equal(body.query, 'Test')
  assert.equal(body.limit, 50)
  assert.equal(body.results.length, 1)
})

test('v2 dispatches typed playback actions and high-level intents', async (t) => {
  const harness = await createHarness({ librarySearchEnabled: true })
  t.after(async () => harness.service.stop())

  const action = await fetch(`http://127.0.0.1:${harness.port}/v2/playback/actions`, {
    method: 'POST',
    headers: { ...authHeaders(harness.config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-volume', volume: 0.42 })
  })
  assert.equal(action.status, 202)

  const intent = await fetch(`http://127.0.0.1:${harness.port}/v2/intents`, {
    method: 'POST',
    headers: { ...authHeaders(harness.config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enqueue', targetRef: 'track-ref', position: 'next' })
  })
  assert.equal(intent.status, 202)
  assert.deepEqual(harness.companionCommands, [
    { type: 'playback-action', action: { action: 'set-volume', volume: 0.42 } },
    { type: 'enqueue-paths', trackPaths: ['/music/test.flac'], position: 'next' }
  ])
})

test('v2 gates curated writes and answers mutation CORS preflight', async (t) => {
  const harness = await createHarness({ libraryWriteEnabled: true })
  t.after(async () => harness.service.stop())

  const preflight = await fetch(`http://127.0.0.1:${harness.port}/v2/tracks/track-ref/favorite`, {
    method: 'OPTIONS',
    headers: {
      Origin: CORS_TEST_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, PUT, PATCH, DELETE, OPTIONS')

  const favorite = await fetch(`http://127.0.0.1:${harness.port}/v2/tracks/track-ref/favorite`, {
    method: 'PUT',
    headers: { ...authHeaders(harness.config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: true })
  })
  assert.equal(favorite.status, 200)
  assert.deepEqual(await favorite.json(), { ref: 'track-ref', favorite: true })
})

test('v2 rejects deleted targets, malformed mutations, oversized bodies, and unavailable renderer commands', async (t) => {
  const harness = await createHarness({ librarySearchEnabled: true, libraryWriteEnabled: true })
  t.after(async () => harness.service.stop())
  const jsonHeaders = { ...authHeaders(harness.config.token), 'Content-Type': 'application/json' }

  const deletedTarget = await fetch(`http://127.0.0.1:${harness.port}/v2/intents`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ action: 'play', targetRef: 'deleted-ref' })
  })
  assert.equal(deletedTarget.status, 404)
  assert.equal((await deletedTarget.json() as { error: { code: string } }).error.code, 'target_not_found')

  const invalidTypes = await fetch(`http://127.0.0.1:${harness.port}/v2/search?q=test&types=track,path`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(invalidTypes.status, 400)
  assert.equal((await invalidTypes.json() as { error: { code: string } }).error.code, 'invalid_types')

  const oversizedBatch = await fetch(`http://127.0.0.1:${harness.port}/v2/playlists/playlist-ref/items`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ trackRefs: Array.from({ length: 101 }, () => 'track-ref') })
  })
  assert.equal(oversizedBatch.status, 400)
  assert.equal((await oversizedBatch.json() as { error: { code: string } }).error.code, 'invalid_track_references')

  const oversizedBody = await fetch(`http://127.0.0.1:${harness.port}/v2/playlists`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: 'x'.repeat(70_000) })
  })
  assert.equal(oversizedBody.status, 413)
  assert.equal((await oversizedBody.json() as { error: { code: string } }).error.code, 'body_too_large')

  const noPlaylistDelete = await fetch(`http://127.0.0.1:${harness.port}/v2/playlists/playlist-ref`, {
    method: 'DELETE',
    headers: authHeaders(harness.config.token)
  })
  assert.equal(noPlaylistDelete.status, 404)

  harness.setRendererAvailable(false)
  const rendererUnavailable = await fetch(`http://127.0.0.1:${harness.port}/v2/playback/actions`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(rendererUnavailable.status, 503)
  assert.equal((await rendererUnavailable.json() as { error: { code: string } }).error.code, 'renderer_unavailable')
})

test('v2 enforces event topic validation and the eight-stream ceiling', async (t) => {
  const harness = await createHarness({ librarySearchEnabled: true })
  t.after(async () => harness.service.stop())

  const invalidTopics = await fetch(`http://127.0.0.1:${harness.port}/v2/events?topics=playback,secrets`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(invalidTopics.status, 400)
  assert.equal((await invalidTopics.json() as { error: { code: string } }).error.code, 'invalid_topics')

  const controllers = Array.from({ length: 8 }, () => new AbortController())
  t.after(() => controllers.forEach((controller) => controller.abort()))
  const streams = await Promise.all(controllers.map((controller) => fetch(
    `http://127.0.0.1:${harness.port}/v2/events?topics=playback&positionIntervalMs=250`,
    { headers: authHeaders(harness.config.token), signal: controller.signal }
  )))
  assert.equal(streams.every((response) => response.status === 200), true)

  const ninth = await fetch(`http://127.0.0.1:${harness.port}/v2/events`, {
    headers: authHeaders(harness.config.token)
  })
  assert.equal(ninth.status, 503)
  assert.equal((await ninth.json() as { error: { code: string } }).error.code, 'event_stream_limit')
})

test('v2 applies a per-credential request rate limit', async (t) => {
  const harness = await createHarness()
  t.after(async () => harness.service.stop())

  const responses = await Promise.all(Array.from({ length: 121 }, () => fetch(
    `http://127.0.0.1:${harness.port}/v2/capabilities`,
    { headers: authHeaders(harness.config.token) }
  )))
  const statuses = responses.map((response) => response.status)
  assert.equal(statuses.filter((status) => status === 200).length, 120)
  assert.equal(statuses.filter((status) => status === 429).length, 1)
  const limited = responses.find((response) => response.status === 429)
  assert.equal((await limited?.json() as { error: { code: string } }).error.code, 'rate_limit_exceeded')
})
