import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addressHost, cleanIpcError, defaultServerName, detectionOrder, subsonicProductName,
  CACHE_SLIDER_MAX, CACHE_STOPS, CacheLimitEdits, cacheSliderValue, deriveServerState, formatAgo, hostOf, nearestCacheStop,
  lastSyncedText, libraryCountsText, plural, progressFraction, progressText, qualityCopy, qualityFollowUps, qualityFromChoice, qualityLabel, qualityMode,
  SerialQueue, serverProblem, stepCacheStop, syncSucceeded
} from './serverModel.ts'

test('server state: off wins, then syncing, failed, connected, checking', () => {
  const progress = { activity: 'Loading tracks...', current: 1, total: 2 }
  assert.equal(deriveServerState(false, 'error', progress), 'off')
  assert.equal(deriveServerState(true, 'ok', progress), 'syncing')
  assert.equal(deriveServerState(true, 'syncing', null), 'syncing')
  assert.equal(deriveServerState(true, 'error', null), 'failed')
  assert.equal(deriveServerState(true, 'ok', null), 'connected')
  assert.equal(deriveServerState(true, 'unknown', null), 'checking')
  assert.equal(deriveServerState(true, undefined, null), 'checking')
})

test('progress reads as text plus a fraction; phases without a total sweep instead', () => {
  assert.equal(progressText({ activity: 'Loading tracks...', current: 1240, total: 8412 }), 'Loading tracks 1,240 / 8,412')
  assert.equal(progressText({ activity: 'Loading music…', current: null, total: 300 }), 'Loading music 0 / 300')
  assert.equal(progressText({ activity: 'Connecting to server...', current: null, total: null }), 'Connecting to server…')
  assert.equal(progressText({ activity: 'Loading artwork…', current: 0, total: 0 }), 'Loading artwork…')
  assert.equal(progressFraction({ activity: '', current: 50, total: 200 }), 0.25)
  assert.equal(progressFraction({ activity: '', current: 9, total: 4 }), 1)
  assert.equal(progressFraction({ activity: '', current: 0, total: 0 }), null)
  assert.equal(progressFraction({ activity: '', current: null, total: null }), null)
})

test('host and relative time', () => {
  assert.equal(hostOf('http://den.local:8096/jellyfin'), 'den.local:8096')
  assert.equal(hostOf('not a url'), 'not a url')
  const now = Date.UTC(2026, 9, 14, 12)
  assert.equal(formatAgo(now - 20_000, now), 'just now')
  assert.equal(formatAgo(now - 4 * 60_000, now), '4 min ago')
  assert.equal(formatAgo(now - 90 * 60_000, now), '1 h ago')
  assert.equal(formatAgo(now - 30 * 3_600_000, now), '1 day ago')
  assert.equal(formatAgo(now - 72 * 3_600_000, now), '3 days ago')
})

test('quality choices cover all eight stored values and read back the same way', () => {
  const all = ['automatic', 'automatic-original', 'original', 64, 128, 192, 256, 320] as const
  for (const quality of all) {
    const mode = qualityMode(quality)
    const resolved = qualityFromChoice(mode, quality === 'automatic-original' ? 'original' : 'balanced',
      typeof quality === 'number' ? quality : 192)
    assert.equal(resolved, quality)
  }
  assert.equal(qualityLabel('automatic-original'), 'Automatic, prefer original')
  assert.equal(qualityLabel(256), 'Fixed, 256 kbps')
})

test('cache slider snaps to the agreed stops, which get finer as sizes grow', () => {
  assert.deepEqual(CACHE_STOPS.map(([gb]) => gb), [1, 2, 5, 10, 15, 20, 25, 30, 40, 50])
  for (const [gb] of CACHE_STOPS) assert.equal(nearestCacheStop(cacheSliderValue(gb)), gb)
  assert.equal(cacheSliderValue(1), 0)
  assert.equal(cacheSliderValue(50), CACHE_SLIDER_MAX)
  assert.equal(cacheSliderValue(10), 600)
  assert.equal(cacheSliderValue(15), 700)
  assert.equal(cacheSliderValue(25), 850)
  // A limit from before the stops existed sits between its neighbours and steps to them.
  assert.ok(cacheSliderValue(7) > cacheSliderValue(5) && cacheSliderValue(7) < cacheSliderValue(10))
  assert.equal(stepCacheStop(7, 1), 10)
  assert.equal(stepCacheStop(7, -1), 5)
  assert.equal(stepCacheStop(20, 1), 25)
  assert.equal(stepCacheStop(50, 1), 50)
  assert.equal(stepCacheStop(1, -1), 1)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

function cacheHarness() {
  const saves: number[] = []
  const pending: ReturnType<typeof deferred>[] = []
  let saved = 5
  const edits = new CacheLimitEdits(new SerialQueue(), gb => {
    saves.push(gb)
    const step = deferred()
    pending.push(step)
    return step.promise.then(() => { saved = gb })
  }, () => {})
  return { edits, saves, pending, saved: () => saved }
}

test('cache limit: an earlier save finishing keeps a newer edit, which saves on its own release', async () => {
  const h = cacheHarness()
  h.edits.edit(10)
  const first = h.edits.release(h.saved())
  await settle()
  h.edits.edit(15)                       // second key press, still held
  h.pending[0].resolve(); await first     // first save lands meanwhile
  assert.equal(h.edits.draft, 15, 'the newer choice stays on screen')
  const second = h.edits.release(h.saved())
  await settle(); h.pending[1].resolve(); await second
  assert.deepEqual(h.saves, [10, 15])
  assert.equal(h.edits.draft, null)
  assert.equal(h.saved(), 15)
})

test('cache limit: saves run one at a time, in order, and returning to a queued value still saves it last', async () => {
  const h = cacheHarness()
  h.edits.edit(10)
  const a = h.edits.release(h.saved())
  h.edits.edit(5)                         // back to the old limit while 10 is still saving
  const b = h.edits.release(h.saved())
  await settle()
  assert.deepEqual(h.saves, [10], 'the second save waits for the first')
  h.pending[0].resolve(); await a; await settle()
  assert.deepEqual(h.saves, [10, 5])
  h.pending[1].resolve(); await b
  assert.equal(h.saved(), 5)
  assert.equal(h.edits.draft, null)
})

test('cache limit: releasing on a value that is already queued waits for it instead of flashing the old limit', async () => {
  const h = cacheHarness()
  h.edits.edit(10)
  const a = h.edits.release(h.saved())
  h.edits.edit(15)
  h.edits.edit(10)
  const b = h.edits.release(h.saved())
  await settle()
  assert.equal(h.edits.draft, 10, 'still showing the queued value')
  h.pending[0].resolve(); await a; await b
  assert.deepEqual(h.saves, [10])
  assert.equal(h.edits.draft, null)
})

test('quality follow-ups show the saved value after a failed save, for both rows', () => {
  // The user clicked 64 kbps (or Prefer original) and the save failed: the saved value still rules.
  assert.equal(qualityFollowUps(192, { priority: 'balanced', bitrate: 64 }).bitrate, 192)
  assert.equal(qualityFollowUps('automatic', { priority: 'original', bitrate: 192 }).priority, 'balanced')
  assert.equal(qualityFollowUps('automatic-original', { priority: 'balanced', bitrate: 192 }).priority, 'original')
  // The closed row keeps the remembered choice, so switching modes back restores it.
  assert.deepEqual(qualityFollowUps('original', { priority: 'original', bitrate: 256 }), { priority: 'original', bitrate: 256 })
  assert.deepEqual(qualityFollowUps(null, { priority: 'balanced', bitrate: 320 }), { priority: 'balanced', bitrate: 320 })
})

test('quality copy discloses a lone server\'s own setting instead of presenting the default as what plays', () => {
  const nav = { key: 'subsonic:1', name: 'Home Navidrome' }
  const jf = { key: 'jellyfin:2', name: 'Den Jellyfin' }
  assert.deepEqual(qualityCopy({ global: 'original', overrides: {}, servers: [nav] }),
    { label: 'Quality', description: 'Plays the server’s file as is.', overridden: [] })
  const lone = qualityCopy({ global: 'original', overrides: { 'subsonic:1': 64 }, servers: [nav] })
  assert.equal(lone.label, 'Default quality')
  assert.equal(lone.description, 'Plays the server’s file as is. Home Navidrome uses its own setting (Fixed, 64 kbps).')
  assert.deepEqual(lone.overridden, [{ key: 'subsonic:1', name: 'Home Navidrome', quality: 64 }])
  // Overrides for servers that no longer exist don't count.
  assert.equal(qualityCopy({ global: 'automatic', overrides: { 'plex:9': 128 }, servers: [nav] }).label, 'Quality')
  assert.equal(qualityCopy({ global: 'automatic', overrides: {}, servers: [nav, jf] }).description,
    'Adapts to your connection. Each server can override it.')
  assert.equal(qualityCopy({ global: 'automatic', overrides: { 'jellyfin:2': 256 }, servers: [nav, jf] }).description,
    'Adapts to your connection. Den Jellyfin uses its own setting.')
  assert.equal(qualityCopy({ global: 'automatic', overrides: { 'jellyfin:2': 256, 'subsonic:1': 64 }, servers: [nav, jf] }).description,
    'Adapts to your connection. Home Navidrome and Den Jellyfin use their own settings.')
  assert.equal(qualityCopy({ global: 'automatic', overrides: {}, servers: [nav, jf], serverKey: 'jellyfin:2' }).description,
    'Follows your default (Automatic).')
  assert.equal(qualityCopy({ global: 'automatic', overrides: { 'jellyfin:2': 256 }, servers: [nav, jf], serverKey: 'jellyfin:2' }).description,
    'Overrides your default (Automatic). Always streams at the bitrate you pick.')
})

test('last synced reads as when, plus the 20-minute check only while the server is in use', () => {
  const now = Date.UTC(2026, 9, 14, 12)
  assert.equal(lastSyncedText({ state: 'connected', enabled: true, lastSyncAt: now - 4 * 60_000 }, now), '4 min ago · checks every 20 min')
  assert.equal(lastSyncedText({ state: 'checking', enabled: true, lastSyncAt: null }, now), 'Not yet · checks every 20 min')
  assert.equal(lastSyncedText({ state: 'syncing', enabled: true, lastSyncAt: null }, now), 'Syncing now · checks every 20 min')
  assert.equal(lastSyncedText({ state: 'off', enabled: false, lastSyncAt: now - 72 * 3_600_000 }, now), '3 days ago')
})

test('"In your library" shows the counts once a sync brought music in, and Hidden while off', () => {
  const on = { enabled: true, lastSyncAt: 1 }
  assert.equal(libraryCountsText(on, { tracks: 8412, albums: 1204 }), '8,412 tracks · 1,204 albums')
  assert.equal(libraryCountsText(on, { tracks: 1, albums: 0 }), '1 track · 0 albums')
  assert.equal(libraryCountsText(on, { tracks: 0, albums: 0 }), 'No tracks')
  assert.equal(libraryCountsText(on, { tracks: 12, albums: null }), '12 tracks')
  assert.equal(libraryCountsText(on, null), null, 'not read yet')
  assert.equal(libraryCountsText({ enabled: true, lastSyncAt: null }, { tracks: 0, albums: 0 }), null, 'before the first sync')
  assert.equal(libraryCountsText({ enabled: false, lastSyncAt: 1 }, { tracks: 12, albums: null }), 'Hidden')
  assert.equal(plural(1, 'track'), '1 track')
  assert.equal(plural(2, 'library', 'libraries'), '2 libraries')
})

test('add-server helpers: detection order, default name, host, product name, IPC errors', () => {
  assert.deepEqual(detectionOrder('http://den.local:8096'), ['jellyfin', 'subsonic'])
  assert.deepEqual(detectionOrder('https://home.example/jellyfin'), ['jellyfin', 'subsonic'])
  assert.deepEqual(detectionOrder('http://music.home.lan:4533'), ['subsonic', 'jellyfin'])
  assert.equal(defaultServerName('http://music.home.lan:4533'), 'music.home.lan')
  assert.equal(defaultServerName('den.local:8096'), 'den.local')
  assert.equal(addressHost('https://music.example.com/rest'), 'music.example.com')
  assert.equal(addressHost(''), 'that address')
  assert.equal(subsonicProductName('navidrome'), 'Navidrome')
  assert.equal(subsonicProductName(null), 'Subsonic')
  assert.equal(cleanIpcError(new Error("Error invoking remote method 'plex:connect': Error: Reconnect using the same Plex account."), 'x'),
    'Reconnect using the same Plex account.')
  assert.equal(cleanIpcError(undefined, 'Could not connect.'), 'Could not connect.')
})

test('a sync counts as working only when the source recorded ok, not when the request settled', () => {
  assert.equal(syncSucceeded('ok', 'error'), true, 'live status wins')
  assert.equal(syncSucceeded('error', 'ok'), false, 'a recorded failure after a resolved request')
  assert.equal(syncSucceeded(undefined, 'ok'), true)
  assert.equal(syncSucceeded(undefined, 'error'), false)
  assert.equal(syncSucceeded('syncing', 'ok'), false, 'still running is not success')
  assert.equal(syncSucceeded(undefined, undefined), false)
})

test('a failure’s kind decides the problem shown: offline, signed out, or a sync problem', () => {
  assert.equal(serverProblem('unreachable'), 'offline')
  assert.equal(serverProblem('auth'), 'signed-out')
  assert.equal(serverProblem('sync'), 'sync')
  assert.equal(serverProblem(null), 'sync', 'an error from before kinds existed')
  assert.equal(serverProblem(undefined), 'sync')
})
