import assert from 'node:assert/strict'
import test from 'node:test'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer.ts'
import {
  LASTFM_OFFICIAL_API_BASE_URL,
  LASTFM_OFFICIAL_PROFILE_ID,
  normalizeLastFmApiBaseUrl,
  parseLastFmApiBaseUrl,
  type LastFmPendingScrobble,
  type LastFmProfileConfig,
  type LastFmServiceConfig
} from '../../types/lastFm.ts'
import { LastFmService } from './lastFm.ts'

type SignedCaller = {
  callSignedMethod: (
    method: string,
    inputParams?: Record<string, string | number>,
    sessionKey?: string,
    profile?: LastFmProfileConfig
  ) => Promise<{ ok: boolean }>
}

type ProtocolCaller = {
  submitNowPlaying: (
    playback: Record<string, unknown>,
    profile: LastFmProfileConfig
  ) => Promise<{ ok: boolean; kind?: string; message?: string }>
  submitScrobbleBatch: (
    batch: LastFmPendingScrobble[],
    profile: LastFmProfileConfig
  ) => Promise<{ ok: boolean; kind?: string; message?: string }>
}

type QueueFlushHarness = {
  flushQueue: () => Promise<void>
  submitScrobbleBatch: (
    batch: LastFmPendingScrobble[],
    profile: LastFmProfileConfig
  ) => Promise<{ ok: boolean; kind?: string; message?: string }>
}

interface CapturedRequest {
  url: string
  method: string | undefined
  headers?: HeadersInit
  body: string
}

function createPendingScrobble(overrides: Partial<LastFmPendingScrobble> = {}): LastFmPendingScrobble {
  return {
    id: 'pending-1',
    trackPath: '/music/track.flac',
    track: 'Pending Track',
    artist: 'Pending Artist',
    album: 'Pending Album',
    albumArtist: null,
    durationSeconds: 180,
    timestamp: 1_700_000_000,
    queuedAt: 1_700_000_100,
    retryCount: 0,
    nextRetryAt: 1_700_000_100,
    ...overrides
  }
}

function createPlaybackSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trackKey: '/music/track.flac',
    trackPath: '/music/track.flac',
    track: 'Now Track',
    artist: 'Now Artist',
    album: 'Now Album',
    albumArtist: null,
    durationSeconds: 180,
    startedAtUnix: 1_700_000_000,
    playedSeconds: 12,
    nowPlayingSent: false,
    nowPlayingRetryCount: 0,
    nextNowPlayingAttemptAt: 0,
    scrobbleQueued: false,
    lastObservedAtMs: 0,
    lastObservedPlaybackState: 'playing',
    ...overrides
  }
}

function createMiniPlayerSnapshot(overrides: Partial<MiniPlayerSnapshot> = {}): MiniPlayerSnapshot {
  return {
    playbackState: 'playing',
    currentTime: 0,
    duration: 180,
    queueLength: 1,
    shuffle: false,
    repeat: 'none',
    outputDeviceLabel: null,
    timeDisplayMode: 'remaining',
    visualizerLineColor: '#ffffff',
    currentTrack: {
      id: 'track-1',
      path: '/music/track.flac',
      title: 'Queued Track',
      artist: 'Queued Artist',
      album: 'Queued Album',
      isFavorite: false
    },
    ...overrides
  }
}

function createOfficialProfile(overrides: Partial<LastFmProfileConfig> = {}): LastFmProfileConfig {
  return {
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    protocol: 'lastfm2',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
    enabled: Boolean(overrides.sessionKey),
    sessionKey: null,
    username: null,
    pendingScrobbles: [],
    ...overrides
  }
}

function createCustomProfile(overrides: Partial<LastFmProfileConfig> = {}): LastFmProfileConfig {
  return {
    id: 'custom-test',
    kind: 'custom',
    protocol: 'lastfm2',
    name: 'Custom endpoint',
    apiBaseUrl: 'http://localhost:9078/2.0/',
    enabled: Boolean(overrides.sessionKey),
    sessionKey: null,
    username: null,
    pendingScrobbles: [],
    ...overrides
  }
}

function createConfig(overrides: Partial<LastFmServiceConfig> = {}): LastFmServiceConfig {
  return {
    enabled: false,
    activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
    profiles: [createOfficialProfile()],
    ...overrides
  }
}

function cloneConfig(config: LastFmServiceConfig): LastFmServiceConfig {
  return {
    enabled: config.enabled,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      pendingScrobbles: profile.pendingScrobbles.map((item) => ({ ...item }))
    }))
  }
}

function createService(configOverrides: Partial<LastFmServiceConfig> = {}) {
  const persisted: LastFmServiceConfig[] = []
  const service = new LastFmService({
    config: createConfig(configOverrides),
    apiKey: 'test-api-key',
    sharedSecret: 'test-shared-secret',
    openExternal: async () => {},
    onConfigChange: (config) => {
      persisted.push(cloneConfig(config))
    }
  })

  return { service, persisted }
}

async function captureSignedRequest(profile: LastFmProfileConfig): Promise<CapturedRequest> {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    })
  }) as typeof fetch

  try {
    const { service } = createService({
      enabled: true,
      activeProfileId: profile.id,
      profiles: [createOfficialProfile(), profile]
    })
    const result = await (service as unknown as SignedCaller).callSignedMethod(
      'track.scrobble',
      {
        track: 'Request Track',
        artist: 'Request Artist',
        timestamp: 1_700_000_000
      },
      'session-key',
      profile
    )

    assert.equal(result.ok, true)
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    return request
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('Last.fm API base URL normalization defaults blank values to official Last.fm', () => {
  assert.equal(normalizeLastFmApiBaseUrl(null), LASTFM_OFFICIAL_API_BASE_URL)
  assert.equal(normalizeLastFmApiBaseUrl(''), LASTFM_OFFICIAL_API_BASE_URL)
  assert.equal(normalizeLastFmApiBaseUrl('https://ws.audioscrobbler.com/2.0'), LASTFM_OFFICIAL_API_BASE_URL)
  assert.equal(
    parseLastFmApiBaseUrl('http://localhost:9078/2.0/?ignored=1#fragment'),
    'http://localhost:9078/2.0/'
  )
  assert.equal(parseLastFmApiBaseUrl('ftp://localhost/2.0/'), null)
})

test('Last.fm service migrates legacy configs into the official profile', () => {
  const legacyConfig = {
    enabled: true,
    sessionKey: 'legacy-session',
    username: 'legacy-user',
    pendingScrobbles: []
  } as unknown as LastFmServiceConfig

  const service = new LastFmService({
    config: legacyConfig,
    apiKey: 'test-api-key',
    sharedSecret: 'test-shared-secret',
    openExternal: async () => {}
  })

  const status = service.getStatus()
  assert.equal(status.activeProfileId, LASTFM_OFFICIAL_PROFILE_ID)
  assert.equal(status.apiBaseUrl, LASTFM_OFFICIAL_API_BASE_URL)
  assert.equal(status.usingCustomEndpoint, false)
  assert.equal(status.connected, true)
  assert.equal(status.enabled, true)
  assert.equal(status.profiles.length, 1)
  assert.equal(status.profiles[0].protocol, 'lastfm2')
  assert.equal(status.profiles[0].connected, true)
  assert.equal(status.profiles[0].enabled, true)
})

test('creating a custom profile enables it without leaking official pending scrobbles', async (t) => {
  const officialPending = createPendingScrobble()
  const { service, persisted } = createService({
    enabled: true,
    activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user',
        pendingScrobbles: [officialPending]
      })
    ]
  })
  t.after(() => service.stop())

  const status = await service.createCustomProfile({
    name: 'Multi-Scrobbler',
    apiBaseUrl: 'http://localhost:9078/2.0/',
    username: 'custom-user',
    sessionKey: 'custom-session'
  })

  assert.equal(status.usingCustomEndpoint, true)
  assert.equal(status.connected, true)
  assert.equal(status.enabled, true)
  assert.equal(status.username, 'custom-user')
  assert.equal(status.pendingScrobbles, 1)

  const persistedConfig = persisted.at(-1)
  assert.ok(persistedConfig)
  assert.equal(persistedConfig.profiles.length, 2)
  assert.equal(persistedConfig.profiles[0].pendingScrobbles.length, 1)
  assert.equal(persistedConfig.profiles[1].enabled, true)
  assert.equal(persistedConfig.profiles[1].sessionKey, 'custom-session')
  assert.deepEqual(persistedConfig.profiles[1].pendingScrobbles, [])
})

test('enabling profiles preserves each profile queue', async (t) => {
  const customProfile = createCustomProfile({
    enabled: false,
    sessionKey: 'custom-session',
    username: 'custom-user',
    pendingScrobbles: [createPendingScrobble({ id: 'custom-pending' })]
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: LASTFM_OFFICIAL_PROFILE_ID,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user',
        pendingScrobbles: [createPendingScrobble({ id: 'official-pending' })]
      }),
      customProfile
    ]
  })
  t.after(() => service.stop())

  const status = await service.setProfileEnabled(customProfile.id, true)
  assert.equal(status.activeProfileId, customProfile.id)
  assert.equal(status.pendingScrobbles, 2)
  assert.equal(status.profiles.find((profile) => profile.id === LASTFM_OFFICIAL_PROFILE_ID)?.pendingScrobbles, 1)
  assert.equal(status.profiles.find((profile) => profile.id === customProfile.id)?.pendingScrobbles, 1)
  assert.equal(status.profiles.find((profile) => profile.id === customProfile.id)?.enabled, true)
})

test('playback sends now-playing updates to every enabled profile', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const customProfile = createCustomProfile({
    sessionKey: 'custom-session',
    username: 'custom-user'
  })
  const { service } = createService({
    enabled: true,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user'
      }),
      customProfile
    ]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch

  service.publishSnapshot(createMiniPlayerSnapshot({ currentTime: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [LASTFM_OFFICIAL_API_BASE_URL, customProfile.apiBaseUrl].sort()
  )
  assert.ok(requests.every((request) => new URLSearchParams(request.body).get('method') === 'track.updateNowPlaying'))
})

test('playback queues scrobbles for every enabled profile', async (t) => {
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  let nowMs = 1_700_000_000_000
  Date.now = () => nowMs
  globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch

  const customProfile = createCustomProfile({
    sessionKey: 'custom-session',
    username: 'custom-user'
  })
  const { service, persisted } = createService({
    enabled: true,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user'
      }),
      customProfile
    ]
  })
  t.after(() => {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    service.stop()
  })

  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  service.stop()

  const persistedConfig = persisted.at(-1)
  assert.ok(persistedConfig)
  assert.equal(persistedConfig.profiles.find((profile) => profile.id === LASTFM_OFFICIAL_PROFILE_ID)?.pendingScrobbles.length, 1)
  assert.equal(persistedConfig.profiles.find((profile) => profile.id === customProfile.id)?.pendingScrobbles.length, 1)
})

test('disabled profiles and global disabled state skip playback scrobble queues', async (t) => {
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  let nowMs = 1_700_000_000_000
  Date.now = () => nowMs
  globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch

  const disabledProfile = createCustomProfile({
    enabled: false,
    sessionKey: 'custom-session',
    username: 'custom-user'
  })
  const { service, persisted } = createService({
    enabled: true,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user'
      }),
      disabledProfile
    ]
  })
  t.after(() => {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    service.stop()
  })

  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  service.stop()

  const persistedConfig = persisted.at(-1)
  assert.ok(persistedConfig)
  assert.equal(persistedConfig.profiles.find((profile) => profile.id === LASTFM_OFFICIAL_PROFILE_ID)?.pendingScrobbles.length, 1)
  assert.equal(persistedConfig.profiles.find((profile) => profile.id === disabledProfile.id)?.pendingScrobbles.length, 0)

  const disabledMaster = createService({
    enabled: false,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user'
      })
    ]
  })
  disabledMaster.service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  disabledMaster.service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  nowMs += 60_000
  disabledMaster.service.publishSnapshot(createMiniPlayerSnapshot({ duration: 60 }))
  disabledMaster.service.stop()
  assert.equal(disabledMaster.persisted.length, 0)
})

test('queue flushing isolates success and retry state per profile', async (t) => {
  const officialPending = createPendingScrobble({ id: 'official-pending' })
  const customPending = createPendingScrobble({ id: 'custom-pending' })
  const customProfile = createCustomProfile({
    sessionKey: 'custom-session',
    username: 'custom-user',
    pendingScrobbles: [customPending]
  })
  const { service, persisted } = createService({
    enabled: true,
    profiles: [
      createOfficialProfile({
        sessionKey: 'official-session',
        username: 'official-user',
        pendingScrobbles: [officialPending]
      }),
      customProfile
    ]
  })
  t.after(() => service.stop())

  const harness = service as unknown as QueueFlushHarness
  harness.submitScrobbleBatch = async (_batch, profile) => {
    if (profile.id === customProfile.id) {
      return { ok: false, kind: 'transient', message: 'Custom endpoint busy.' }
    }
    return { ok: true }
  }

  await harness.flushQueue()

  const persistedConfig = persisted.at(-1)
  assert.ok(persistedConfig)
  const officialProfile = persistedConfig.profiles.find((profile) => profile.id === LASTFM_OFFICIAL_PROFILE_ID)
  const retriedProfile = persistedConfig.profiles.find((profile) => profile.id === customProfile.id)
  assert.equal(officialProfile?.pendingScrobbles.length, 0)
  assert.equal(retriedProfile?.pendingScrobbles.length, 1)
  assert.equal(retriedProfile?.pendingScrobbles[0]?.retryCount, 1)

  const status = service.getStatus()
  assert.equal(status.profiles.find((profile) => profile.id === customProfile.id)?.lastError, 'Custom endpoint busy.')
})

test('signed requests use the active profile endpoint without changing the Last.fm form payload', async () => {
  const officialProfile = createOfficialProfile({
    sessionKey: 'session-key',
    username: 'request-user'
  })
  const customProfile = createCustomProfile({
    sessionKey: 'session-key',
    username: 'request-user'
  })

  const officialRequest = await captureSignedRequest(officialProfile)
  const customRequest = await captureSignedRequest(customProfile)

  assert.equal(officialRequest.url, LASTFM_OFFICIAL_API_BASE_URL)
  assert.equal(customRequest.url, 'http://localhost:9078/2.0/')
  assert.equal(officialRequest.method, 'POST')
  assert.equal(customRequest.method, 'POST')
  assert.equal(customRequest.body, officialRequest.body)
})

test('custom Last.fm 2.0 scrobbles submit without official app credentials', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const customProfile = createCustomProfile({
    sessionKey: 'custom-session',
    username: 'custom-user'
  })
  const service = new LastFmService({
    config: createConfig({
      enabled: true,
      activeProfileId: customProfile.id,
      profiles: [createOfficialProfile(), customProfile]
    }),
    apiKey: '',
    sharedSecret: '',
    openExternal: async () => {}
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch

  const result = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    customProfile
  )

  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, customProfile.apiBaseUrl)
  assert.equal(requests[0].method, 'POST')
  const body = new URLSearchParams(requests[0].body)
  assert.equal(body.get('method'), 'track.scrobble')
  assert.equal(body.get('sk'), 'custom-session')
  assert.equal(body.get('track[0]'), 'Pending Track')
})

test('AudioScrobbler now-playing performs a standard auth handshake and posts legacy form fields', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const profile = createCustomProfile({
    protocol: 'audioscrobbler',
    apiBaseUrl: 'http://maloja.local/apis/audioscrobbler_legacy',
    username: 'legacy-user',
    sessionKey: 'legacy-key'
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: profile.id,
    profiles: [createOfficialProfile(), profile]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })

    if (requests.length === 1) {
      return new Response([
        'OK',
        'legacy-session',
        'http://maloja.local/np',
        'http://maloja.local/sub'
      ].join('\n'), { status: 200 })
    }
    return new Response('OK\n', { status: 200 })
  }) as typeof fetch

  const result = await (service as unknown as ProtocolCaller).submitNowPlaying(
    createPlaybackSession(),
    profile
  )

  assert.equal(result.ok, true)
  assert.equal(requests.length, 2)
  const handshake = new URL(requests[0].url)
  assert.equal(handshake.origin + handshake.pathname, 'http://maloja.local/apis/audioscrobbler_legacy')
  assert.equal(handshake.searchParams.get('hs'), 'true')
  assert.equal(handshake.searchParams.get('p'), '1.2.1')
  assert.equal(handshake.searchParams.get('u'), 'legacy-user')
  assert.ok(handshake.searchParams.get('a'))

  assert.equal(requests[1].url, 'http://maloja.local/np')
  assert.equal(requests[1].method, 'POST')
  const body = new URLSearchParams(requests[1].body)
  assert.equal(body.get('s'), 'legacy-session')
  assert.equal(body.get('a'), 'Now Artist')
  assert.equal(body.get('t'), 'Now Track')
  assert.equal(body.get('b'), 'Now Album')
  assert.equal(body.get('l'), '180')
})

test('AudioScrobbler scrobble batches use legacy submission fields', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const profile = createCustomProfile({
    protocol: 'audioscrobbler',
    apiBaseUrl: 'http://maloja.local/apis/audioscrobbler_legacy',
    username: 'legacy-user',
    sessionKey: 'legacy-key'
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: profile.id,
    profiles: [createOfficialProfile(), profile]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })

    if (requests.length === 1) {
      return new Response([
        'OK',
        'legacy-session',
        'http://maloja.local/np',
        'http://maloja.local/sub'
      ].join('\n'), { status: 200 })
    }
    return new Response('OK\n', { status: 200 })
  }) as typeof fetch

  const result = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    profile
  )

  assert.equal(result.ok, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url, 'http://maloja.local/sub')
  const body = new URLSearchParams(requests[1].body)
  assert.equal(body.get('s'), 'legacy-session')
  assert.equal(body.get('a[0]'), 'Pending Artist')
  assert.equal(body.get('t[0]'), 'Pending Track')
  assert.equal(body.get('i[0]'), '1700000000')
  assert.equal(body.get('o[0]'), 'P')
  assert.equal(body.get('r[0]'), '')
  assert.equal(body.get('l[0]'), '180')
  assert.equal(body.get('b[0]'), 'Pending Album')
})

test('AudioScrobbler BADSESSION clears the cached handshake and retries with a new handshake later', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const profile = createCustomProfile({
    protocol: 'audioscrobbler',
    apiBaseUrl: 'http://maloja.local/apis/audioscrobbler_legacy',
    username: 'legacy-user',
    sessionKey: 'legacy-key'
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: profile.id,
    profiles: [createOfficialProfile(), profile]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  let postCount = 0
  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })

    if (init?.method === 'GET') {
      return new Response([
        'OK',
        `legacy-session-${requests.length}`,
        'http://maloja.local/np',
        'http://maloja.local/sub'
      ].join('\n'), { status: 200 })
    }

    postCount += 1
    return new Response(postCount === 1 ? 'BADSESSION\n' : 'OK\n', { status: 200 })
  }) as typeof fetch

  const firstResult = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    profile
  )
  const secondResult = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    profile
  )

  assert.equal(firstResult.ok, false)
  assert.equal(firstResult.kind, 'transient')
  assert.equal(secondResult.ok, true)
  assert.equal(requests.filter((request) => request.method === 'GET').length, 2)
})

test('AudioScrobbler handshake failures classify rejected credentials and transient server failures', async (t) => {
  const originalFetch = globalThis.fetch
  const profile = createCustomProfile({
    protocol: 'audioscrobbler',
    apiBaseUrl: 'http://maloja.local/apis/audioscrobbler_legacy',
    username: 'legacy-user',
    sessionKey: 'legacy-key'
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: profile.id,
    profiles: [createOfficialProfile(), profile]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (): Promise<Response> => new Response('BADAUTH\n', { status: 200 })) as typeof fetch
  const badAuthResult = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    profile
  )
  assert.equal(badAuthResult.ok, false)
  assert.equal(badAuthResult.kind, 'session-invalid')

  globalThis.fetch = (async (): Promise<Response> => new Response('FAILED server busy\n', { status: 200 })) as typeof fetch
  const failedResult = await (service as unknown as ProtocolCaller).submitScrobbleBatch(
    [createPendingScrobble()],
    profile
  )
  assert.equal(failedResult.ok, false)
  assert.equal(failedResult.kind, 'transient')
  assert.match(failedResult.message ?? '', /server busy/)
})

test('ListenBrainz native submissions use token auth and omit timestamps for playing-now', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: CapturedRequest[] = []
  const profile = createCustomProfile({
    protocol: 'listenbrainz',
    apiBaseUrl: 'http://maloja.local/apis/listenbrainz',
    username: null,
    sessionKey: 'listenbrainz-token'
  })
  const { service } = createService({
    enabled: true,
    activeProfileId: profile.id,
    profiles: [createOfficialProfile(), profile]
  })
  t.after(() => {
    service.stop()
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args
    requests.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
    })
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch

  const caller = service as unknown as ProtocolCaller
  const nowPlayingResult = await caller.submitNowPlaying(createPlaybackSession({
    artist: 'Jamule & Chilla',
    artistNames: ['Jamule', 'Chilla']
  }), profile)
  const scrobbleResult = await caller.submitScrobbleBatch([
    createPendingScrobble({
      artist: 'Jamule & Chilla',
      artistNames: ['Jamule', 'Chilla']
    })
  ], profile)

  assert.equal(nowPlayingResult.ok, true)
  assert.equal(scrobbleResult.ok, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'http://maloja.local/apis/listenbrainz/1/submit-listens')
  assert.equal(requests[0].method, 'POST')
  assert.deepEqual(requests[0].headers, {
    Authorization: 'Token listenbrainz-token',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Astra-LastFM/0.1.0 (https://github.com/Boof2015/astra)'
  })

  const nowPlayingBody = JSON.parse(requests[0].body) as Record<string, unknown>
  assert.equal(nowPlayingBody.listen_type, 'playing_now')
  const nowPlayingPayload = nowPlayingBody.payload as Array<Record<string, unknown>>
  assert.equal('listened_at' in nowPlayingPayload[0], false)
  assert.deepEqual(nowPlayingPayload[0].track_metadata, {
    artist_name: 'Jamule & Chilla',
    track_name: 'Now Track',
    additional_info: {
      media_player: 'Astra',
      submission_client: 'Astra',
      artist_names: ['Jamule', 'Chilla'],
      duration: 180,
      duration_played: 12
    },
    release_name: 'Now Album'
  })

  const scrobbleBody = JSON.parse(requests[1].body) as Record<string, unknown>
  assert.equal(scrobbleBody.listen_type, 'single')
  const scrobblePayload = scrobbleBody.payload as Array<Record<string, unknown>>
  assert.equal(scrobblePayload[0].listened_at, 1_700_000_000)
  assert.deepEqual((scrobblePayload[0].track_metadata as Record<string, unknown>).additional_info, {
    media_player: 'Astra',
    submission_client: 'Astra',
    artist_names: ['Jamule', 'Chilla'],
    duration: 180
  })
})

test('ListenBrainz profile creation normalizes full submit-listens endpoint URLs', async (t) => {
  const { service } = createService()
  t.after(() => service.stop())

  const status = await service.createCustomProfile({
    protocol: 'listenbrainz',
    name: 'Maloja ListenBrainz',
    apiBaseUrl: 'http://maloja.local/apis/listenbrainz/1/submit-listens',
    sessionKey: 'listenbrainz-token'
  })

  assert.equal(status.connected, true)
  assert.equal(status.activeProfile.protocol, 'listenbrainz')
  assert.equal(status.activeProfile.apiBaseUrl, 'http://maloja.local/apis/listenbrainz')
})

test('missing Last.fm app credentials only block the official Last.fm profile', () => {
  const officialService = new LastFmService({
    config: createConfig({
      enabled: true,
      profiles: [
        createOfficialProfile({
          sessionKey: 'official-session',
          username: 'official-user'
        })
      ]
    }),
    apiKey: '',
    sharedSecret: '',
    openExternal: async () => {}
  })
  const customLastFmProfile = createCustomProfile({
    id: 'custom-lastfm2',
    username: 'custom-user',
    sessionKey: 'custom-session'
  })
  const audioProfile = createCustomProfile({
    id: 'custom-audioscrobbler',
    protocol: 'audioscrobbler',
    apiBaseUrl: 'http://maloja.local/apis/audioscrobbler_legacy',
    username: 'legacy-user',
    sessionKey: 'legacy-key'
  })
  const customService = new LastFmService({
    config: createConfig({
      enabled: true,
      activeProfileId: customLastFmProfile.id,
      profiles: [createOfficialProfile(), customLastFmProfile, audioProfile]
    }),
    apiKey: '',
    sharedSecret: '',
    openExternal: async () => {}
  })

  try {
    const officialStatus = officialService.getStatus()
    assert.equal(officialStatus.connected, true)
    assert.equal(officialStatus.enabled, true)
    assert.equal(officialStatus.profiles[0].enabled, false)
    assert.equal(officialStatus.activeProfileRequiresApiCredentials, true)
    assert.equal(officialStatus.profiles[0].requiresApiCredentials, true)

    const customStatus = customService.getStatus()
    assert.equal(customStatus.connected, true)
    assert.equal(customStatus.enabled, true)
    assert.equal(customStatus.activeProfile.id, customLastFmProfile.id)
    assert.equal(customStatus.profiles.find((profile) => profile.id === customLastFmProfile.id)?.enabled, true)
    assert.equal(customStatus.profiles.find((profile) => profile.id === customLastFmProfile.id)?.requiresApiCredentials, false)
    assert.equal(customStatus.profiles.find((profile) => profile.id === audioProfile.id)?.enabled, true)
    assert.equal(customStatus.profiles.find((profile) => profile.id === audioProfile.id)?.requiresApiCredentials, false)
    assert.equal(customStatus.activeProfileRequiresApiCredentials, false)
  } finally {
    officialService.stop()
    customService.stop()
  }
})
