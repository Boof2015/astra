import assert from 'node:assert/strict'
import test from 'node:test'
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

interface CapturedRequest {
  url: string
  method: string | undefined
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

function createOfficialProfile(overrides: Partial<LastFmProfileConfig> = {}): LastFmProfileConfig {
  return {
    id: LASTFM_OFFICIAL_PROFILE_ID,
    kind: 'official',
    name: 'Official Last.fm',
    apiBaseUrl: LASTFM_OFFICIAL_API_BASE_URL,
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
    name: 'Custom endpoint',
    apiBaseUrl: 'http://localhost:9078/2.0/',
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
  assert.equal(status.profiles[0].connected, true)
})

test('creating a custom profile selects it without leaking official pending scrobbles', async (t) => {
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
  assert.equal(status.pendingScrobbles, 0)

  const persistedConfig = persisted.at(-1)
  assert.ok(persistedConfig)
  assert.equal(persistedConfig.profiles.length, 2)
  assert.equal(persistedConfig.profiles[0].pendingScrobbles.length, 1)
  assert.equal(persistedConfig.profiles[1].sessionKey, 'custom-session')
  assert.deepEqual(persistedConfig.profiles[1].pendingScrobbles, [])
})

test('switching active profiles preserves each profile queue', async (t) => {
  const customProfile = createCustomProfile({
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

  const status = await service.setActiveProfile(customProfile.id)
  assert.equal(status.activeProfileId, customProfile.id)
  assert.equal(status.pendingScrobbles, 1)
  assert.equal(status.profiles.find((profile) => profile.id === LASTFM_OFFICIAL_PROFILE_ID)?.pendingScrobbles, 1)
  assert.equal(status.profiles.find((profile) => profile.id === customProfile.id)?.pendingScrobbles, 1)
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
