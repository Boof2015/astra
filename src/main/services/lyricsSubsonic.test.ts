import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSubsonicLyrics, SubsonicLyricsResolver } from './lyricsSubsonic.ts'
import { SubsonicRequestError } from './subsonic.ts'
import { createLyricsPayload } from './lyricsParsing.ts'

const connection = { baseUrl: 'https://music.example', username: 'listener', password: 'secret' }
const plain = [{ synced: false, lang: 'jpn', line: [{ value: '夜空' }, { value: '' }, { value: '星の歌' }] }]

test('server lyrics preserve Unicode and blank lines and choose the first usable synchronized entry', () => {
  const result = parseSubsonicLyrics([
    null, {}, { synced: true, line: [] }, ...plain,
    { synced: true, offset: 100, line: [{ start: 50, value: '夜空' }, { start: 1500, value: '' }, { start: 2250, value: '星の歌' }] },
    { synced: true, line: [{ start: 1000, value: 'another language' }] }
  ])!
  assert.equal(result.source, 'server')
  assert.equal(result.provider, null)
  assert.equal(result.plainLyrics, '夜空\n\n星の歌')
  assert.deepEqual(result.syncedLines, [
    { timestampMs: 0, text: '夜空' }, { timestampMs: 1400, text: '', kind: 'silence' }, { timestampMs: 2150, text: '星の歌' }
  ])
  assert.equal(result.syncedLyrics, '[00:00.000]夜空\n[00:01.400]\n[00:02.150]星の歌')
  const cached = createLyricsPayload('server', null, 'lrc', result.plainLyrics, result.syncedLyrics, result.syncedLines)!
  assert.deepEqual(cached.syncedLines, result.syncedLines, 'cache reconstruction must not change timing or silence')
  assert.equal(parseSubsonicLyrics([{ synced: true, offset: -250, line: [{ start: 1000, value: 'Later' }] }])?.syncedLines[0].timestampMs, 1250)
  const literal = parseSubsonicLyrics([{ synced: true, line: [{ start: 1000, value: '[00:59.000] literal\nsecond line' }] }])!
  assert.deepEqual(createLyricsPayload('server', null, 'lrc', literal.plainLyrics, literal.syncedLyrics, literal.syncedLines)?.syncedLines, literal.syncedLines)
})

test('server lyrics retain plain order and degrade unusable timing to readable text', () => {
  const result = parseSubsonicLyrics([...plain, { synced: false, line: [{ value: 'second' }] }])!
  assert.equal(result.format, 'plain')
  assert.equal(result.plainLyrics, '夜空\n\n星の歌')
  assert.equal(result.syncedLyrics, null)
  for (const start of [undefined, -1, NaN, Infinity, '1200']) {
    const malformed = parseSubsonicLyrics([{ synced: true, line: [null, { value: 'Keep this', start }, { value: 'and this', start: 2000 }] }])!
    assert.equal(malformed.format, 'plain')
    assert.equal(malformed.plainLyrics, 'Keep this\nand this')
  }
  for (const raw of [null, {}, [], [null], [{ synced: false, line: [{ value: ' ' }] }], [{ line: [{ value: 'missing flag' }] }]]) {
    assert.equal(parseSubsonicLyrics(raw), null)
  }
})

test('server misses expire, refresh bypasses them, and identical song IDs on different servers are independent', async () => {
  let now = 0
  const calls: string[] = []
  const resolver = new SubsonicLyricsResolver({
    source: id => ({ binding: `server-${id}`, enabled: true }),
    credentials: id => ({ ...connection, username: String(id) }), now: () => now,
    request: async (config, id) => { calls.push(`${config.username}:${id}`); return [] }
  })
  const one = resolver.resolve('subsonic://1/track/same%2Fid')!
  const two = resolver.resolve('subsonic://2/track/same%2Fid')!
  await one.lookup({})
  await one.lookup({})
  await two.lookup({})
  assert.deepEqual(calls, ['1:same/id', '2:same/id'])
  await one.lookup({ forceRefresh: true })
  now += 300_001
  await one.lookup({})
  assert.equal(calls.length, 4)
  assert.equal(resolver.resolve('/music/local.flac'), null)
  assert.equal(resolver.resolve('jellyfin://1/track/same'), null)
})

test('unsupported endpoints are remembered per server but transient errors and malformed responses are retried', async () => {
  for (const outcome of [404, 501, 500, 401, 'timeout', 'malformed'] as const) {
    let calls = 0
    let now = 0
    const resolver = new SubsonicLyricsResolver({
      source: () => ({ binding: 'one', enabled: true }), credentials: () => connection, now: () => now,
      request: async () => {
        calls++
        if (outcome === 'malformed') return {}
        if (outcome === 'timeout') throw new DOMException('Timed out', 'AbortError')
        throw new SubsonicRequestError('Request failed', { httpStatus: outcome })
      }
    })
    await resolver.resolve('subsonic://1/track/a')!.lookup({})
    await resolver.resolve('subsonic://1/track/b')!.lookup({})
    assert.equal(calls, outcome === 404 || outcome === 501 ? 1 : 2)
    await resolver.resolve('subsonic://1/track/a')!.lookup({ forceRefresh: true })
    const before = calls
    now += 300_001
    await resolver.resolve('subsonic://1/track/a')!.lookup({})
    assert.equal(calls, before + 1)
  }
})

test('concurrent server lookups share a request and changed, disabled, or removed connections discard its result', async () => {
  for (const change of ['credentials', 'disabled', 'removed', 'invalidate', 'none']) {
    let source: { binding: string; enabled: boolean } | null = { binding: 'old', enabled: true }
    let finish!: (value: unknown) => void
    let signal: AbortSignal | undefined
    let calls = 0
    const resolver = new SubsonicLyricsResolver({
      source: () => source, credentials: () => connection,
      request: async (_config, _id, options) => {
        calls++
        signal = options?.signal
        return new Promise(resolve => { finish = resolve })
      }
    })
    const context = resolver.resolve('subsonic://1/track/a')!
    const first = context.lookup({})
    const second = context.lookup({ forceRefresh: true })
    assert.equal(calls, 1)
    if (change === 'credentials') source = { binding: 'new', enabled: true }
    if (change === 'disabled') source!.enabled = false
    if (change === 'removed') source = null
    if (change === 'invalidate') {
      resolver.invalidate(1)
      assert.equal(signal?.aborted, true)
    }
    finish(plain)
    const results = await Promise.all([first, second])
    if (change === 'none') assert.equal(results[0]?.plainLyrics, '夜空\n\n星の歌')
    else assert.deepEqual(results, [null, null])
    assert.equal(context.isCurrent(), change === 'none')
    if (change === 'disabled' || change === 'removed') assert.equal(resolver.resolve('subsonic://1/track/a'), null)
  }
})

test('connection changes clear remembered misses and unsupported responses', async () => {
  let binding = 'old'
  let calls = 0
  const resolver = new SubsonicLyricsResolver({
    source: () => ({ binding, enabled: true }), credentials: () => connection,
    request: async () => { calls++; return [] }
  })
  await resolver.resolve('subsonic://1/track/a')!.lookup({})
  binding = 'new'
  await resolver.resolve('subsonic://1/track/a')!.lookup({})
  assert.equal(calls, 2)
})
