import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LISTENING_STATS_TRANSFER_VERSION,
  createStatsTransferTrackDictionary,
  decodeListeningCountsPayload,
  decodeListeningHistoryPayload,
  encodeListeningCountsPayload,
  encodeListeningHistoryPayload,
  mergeMaxTimestamp,
  mergeMinTimestamp,
  mergePlayCount,
  shouldReplaceRating,
  sumOriginPlayCounts,
  type ListeningCountsPayload,
  type ListeningHistoryPayload
} from './statsTransfer.ts'

function buildCountsPayload(): ListeningCountsPayload {
  return {
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [
      ['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist'],
      ['hash-b', 'fold-b', 'B', 'Artist', 'Album', 'Album Artist']
    ],
    origins: ['install-one', 'install-two'],
    plays: [[0, 0, 12, 1700], [0, 1, 4, 1800], [1, 0, 3, null]],
    ratings: [[0, 4.5, 1650]],
    favorites: [[1, 1600]]
  }
}

function buildHistoryPayload(): ListeningHistoryPayload {
  return {
    v: LISTENING_STATS_TRANSFER_VERSION,
    historyStartedAt: 1000,
    sessionsTotal: 2,
    truncated: false,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    sessions: [
      [0, 'session-1', 'local', 240, 1000, 1240, 240, 1015],
      [0, 'session-2', 'local', 240, 2000, null, 30, null]
    ],
    segments: [
      [0, 'segment-1', 1000, 1240, 1240, 240],
      [1, 'segment-1', 2000, 2030, null, 30]
    ]
  }
}

test('listening counts payload survives an encode/decode round trip', () => {
  const payload = buildCountsPayload()
  const decoded = decodeListeningCountsPayload(encodeListeningCountsPayload(payload))
  assert.equal(decoded.ok, true)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload, payload)
})

test('listening history payload survives an encode/decode round trip', () => {
  const payload = buildHistoryPayload()
  const decoded = decodeListeningHistoryPayload(encodeListeningHistoryPayload(payload))
  assert.equal(decoded.ok, true)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload, payload)
})

test('decoding rejects structurally invalid input', () => {
  for (const input of [undefined, null, 42, '', '   ', 'not json', '[]', '"a string"']) {
    const decoded = decodeListeningCountsPayload(input)
    assert.equal(decoded.ok, false, `expected rejection for ${JSON.stringify(input)}`)
  }

  const wrongVersion = decodeListeningCountsPayload(JSON.stringify({ v: 99, tracks: [] }))
  assert.equal(wrongVersion.ok, false)
  assert.ok(!wrongVersion.ok)
  assert.match(wrongVersion.error, /unsupported/i)

  const missingTracks = decodeListeningCountsPayload(
    JSON.stringify({ v: LISTENING_STATS_TRANSFER_VERSION, plays: [] })
  )
  assert.equal(missingTracks.ok, false)
})

test('decoding drops malformed rows instead of throwing', () => {
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    origins: ['install-one'],
    plays: [
      [0, 0, 5, 1700],
      [9, 0, 5, 1700],           // out-of-range track index
      [-1, 0, 5, 1700],          // negative track index
      [0.5, 0, 5, 1700],         // non-integer track index
      ['0', 0, 5, 1700],         // non-numeric track index
      [0, 4, 5, 1700],           // out-of-range origin index
      [0, 0, -3, 1700],          // negative play count
      'not an array'
    ],
    ratings: [[0, 4, 1650], [0, 2, 1600]],   // duplicate index: first wins
    favorites: [[0, 1600], [4, 1600]]
  })

  const decoded = decodeListeningCountsPayload(encoded)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload.plays, [[0, 0, 5, 1700]])
  assert.deepEqual(decoded.payload.ratings, [[0, 4, 1650]])
  assert.deepEqual(decoded.payload.favorites, [[0, 1600]])
})

test('decoding drops sessions and segments with unusable keys or scalars', () => {
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    sessions: [
      [0, 'ok', 'local', 100, 500, 600, 100, 550],
      [0, '   ', 'local', 100, 500, 600, 100, 550],       // blank session key
      [0, 'negative', 'local', 100, 500, 600, -5, null],  // negative listened seconds
      [0, 'bad-start', 'local', 100, 'nope', 600, 10, null]
    ],
    segments: [
      [0, 'seg', 500, 600, 600, 100],
      [0, '', 500, 600, 600, 100],                        // blank segment key
      [0, 'bad', 500, 600, 600, -1],                      // negative listened seconds
      [7, 'orphan', 500, 600, 600, 10]                    // out-of-range session index
    ]
  })

  const decoded = decodeListeningHistoryPayload(encoded)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload.sessions.map((session) => session[1]), ['ok'])
  assert.deepEqual(decoded.payload.segments, [[0, 'seg', 500, 600, 600, 100]])
})

test('decoding treats a non-finite scalar as a dropped row, not NaN data', () => {
  // JSON has no NaN/Infinity literal, so a hand-edited file expresses them as null or a
  // string. Either way the row must not survive with a poisoned number.
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    origins: ['install-one'],
    plays: [[0, 0, null, 1700], [0, 0, 'many', 1700]]
  })
  const decoded = decodeListeningCountsPayload(encoded)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload.plays, [])
})

test('decoding merges duplicate session keys the way the SQL upsert would', () => {
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    sessions: [
      [0, 'dupe', 'local', 200, 1000, 1100, 60, 1050],
      [0, 'dupe', 'local', 240, 900, 1300, 90, 1020]
    ],
    segments: [
      [0, 'seg', 1000, 1100, 1100, 60],
      [1, 'seg', 900, 1300, 1300, 90]
    ]
  })

  const decoded = decodeListeningHistoryPayload(encoded)
  assert.ok(decoded.ok)
  // duration MAX, started_at MIN, ended_at MAX, listened MAX, qualified_at MIN
  assert.deepEqual(decoded.payload.sessions, [[0, 'dupe', 'local', 240, 900, 1300, 90, 1020]])
  // Both segments collapse onto the surviving session and merge on (sessionIndex, segmentKey).
  assert.deepEqual(decoded.payload.segments, [[0, 'seg', 900, 1300, 1300, 90]])
})

test('segment session indices remap after duplicate sessions collapse', () => {
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    sessions: [
      [0, 'first', 'local', 100, 100, 200, 100, null],
      [0, 'first', 'local', 100, 100, 200, 100, null],  // collapses into index 0
      [0, 'second', 'local', 100, 300, 400, 100, null]  // was index 2, becomes index 1
    ],
    segments: [[2, 'seg', 300, 400, 400, 100]]
  })

  const decoded = decodeListeningHistoryPayload(encoded)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload.sessions.map((session) => session[1]), ['first', 'second'])
  assert.equal(decoded.payload.segments[0][0], 1)
})

test('the track dictionary interns identical identities to one index', () => {
  const dictionary = createStatsTransferTrackDictionary()
  const identity = {
    pathHash: 'abc123', pathFoldHash: 'def456',
    title: 'A', artist: 'Artist', album: 'Album', albumArtist: 'AA'
  }

  assert.equal(dictionary.indexOf(identity), 0)
  assert.equal(dictionary.indexOf({ ...identity }), 0)
  assert.equal(dictionary.indexOf({ ...identity, title: 'B' }), 1)
  assert.equal(dictionary.size(), 2)
  assert.deepEqual(dictionary.tuples()[0], ['abc123', 'def456', 'A', 'Artist', 'Album', 'AA'])
})

test('exported track tuples never carry a readable path', () => {
  // A settings file may be shared; an absolute path would disclose the account name and
  // library layout to whoever receives it.
  const dictionary = createStatsTransferTrackDictionary()
  dictionary.indexOf({
    pathHash: 'abc123', pathFoldHash: 'def456',
    title: 'A', artist: 'Artist', album: 'Album', albumArtist: 'AA'
  })
  const serialized = JSON.stringify(dictionary.tuples())
  assert.equal(serialized.includes('/'), false)
  assert.equal(serialized.includes('\\\\'), false)
})

test('the track dictionary does not conflate identities across field boundaries', () => {
  const dictionary = createStatsTransferTrackDictionary()
  const first = dictionary.indexOf({ pathHash: 'a', pathFoldHash: '', title: 'b', artist: '', album: '', albumArtist: '' })
  const second = dictionary.indexOf({ pathHash: 'a', pathFoldHash: '', title: '', artist: 'b', album: '', albumArtist: '' })
  assert.notEqual(first, second)
})

test('decoding drops a repeated (track, origin) pair so a total cannot inflate', () => {
  const encoded = JSON.stringify({
    v: LISTENING_STATS_TRANSFER_VERSION,
    tracks: [['hash-a', 'fold-a', 'A', 'Artist', 'Album', 'Album Artist']],
    origins: ['install-one', 'install-two'],
    plays: [
      [0, 0, 10, 1700],
      [0, 0, 40, 1900],   // same origin again: must not add a second contribution
      [0, 1, 7, 1800]     // a different origin is a legitimate separate row
    ]
  })

  const decoded = decodeListeningCountsPayload(encoded)
  assert.ok(decoded.ok)
  assert.deepEqual(decoded.payload.plays, [[0, 0, 10, 1700], [0, 1, 7, 1800]])
})

test('play counts from different installs add up while one install stays idempotent', () => {
  // Two machines each played the same track. The displayed count is the sum, and merging
  // the same origin twice takes the MAX rather than adding, so re-import changes nothing.
  const local = new Map<string, number>([['install-a', 12]])
  const imported: Array<[string, number]> = [['install-a', 12], ['install-b', 7]]

  for (const [originId, count] of imported) {
    local.set(originId, mergePlayCount(local.get(originId) ?? 0, count))
  }
  assert.equal(sumOriginPlayCounts(local.values()), 19)

  // Applying the very same payload again must not move the total.
  for (const [originId, count] of imported) {
    local.set(originId, mergePlayCount(local.get(originId) ?? 0, count))
  }
  assert.equal(sumOriginPlayCounts(local.values()), 19)

  // And a stale file reporting fewer plays than we already have cannot lower it.
  local.set('install-b', mergePlayCount(local.get('install-b') ?? 0, 3))
  assert.equal(sumOriginPlayCounts(local.values()), 19)
})

test('sumOriginPlayCounts ignores unusable contributions', () => {
  assert.equal(sumOriginPlayCounts([]), 0)
  assert.equal(sumOriginPlayCounts([3, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 4]), 7)
})

test('merge primitives mirror the SQL merge rules', () => {
  assert.equal(mergePlayCount(5, 3), 5)
  assert.equal(mergePlayCount(3, 5), 5)
  assert.equal(mergePlayCount(0, 0), 0)
  assert.equal(mergePlayCount(Number.NaN, 4), 4)

  assert.equal(mergeMaxTimestamp(null, 7), 7)
  assert.equal(mergeMaxTimestamp(7, null), 7)
  assert.equal(mergeMaxTimestamp(null, null), null)
  assert.equal(mergeMaxTimestamp(9, 7), 9)

  assert.equal(mergeMinTimestamp(null, 7), 7)
  assert.equal(mergeMinTimestamp(7, null), 7)
  assert.equal(mergeMinTimestamp(null, null), null)
  assert.equal(mergeMinTimestamp(9, 7), 7)

  assert.equal(shouldReplaceRating(500, 400), false)
  assert.equal(shouldReplaceRating(400, 500), true)
  assert.equal(shouldReplaceRating(500, 500), false)
})

test('encoded payloads stay on a single line', () => {
  // Regression guard: the payload is embedded inside a pretty-printed settings file, so any
  // reintroduction of indentation here would multiply the exported file size.
  const encoded = encodeListeningHistoryPayload(buildHistoryPayload())
  assert.equal(encoded.includes('\n'), false)
  assert.equal(encodeListeningCountsPayload(buildCountsPayload()).includes('\n'), false)
})

test('a heavy-user history payload encodes within the file size budget', () => {
  const dictionary = createStatsTransferTrackDictionary()
  const sessions: ListeningHistoryPayload['sessions'] = []
  const segments: ListeningHistoryPayload['segments'] = []

  const distinctTracks = 6_000
  for (let i = 0; i < distinctTracks; i += 1) {
    dictionary.indexOf({
      // 16 hex chars, matching hashTrackPathForTransfer's output width.
      pathHash: i.toString(16).padStart(16, '0'),
      pathFoldHash: (i + 1_000_000).toString(16).padStart(16, '0'),
      title: `Track Title Number ${i}`,
      artist: `Artist ${i % 400}`,
      album: `Album Name ${i % 900}`,
      albumArtist: `Artist ${i % 400}`
    })
  }

  for (let i = 0; i < 20_000; i += 1) {
    sessions.push([i % distinctTracks, `sess-${i}-9f8a7b6c`, 'local', 213.4, 1750000000000 + i * 1000, 1750000000000 + i * 1000 + 213000, 213.4, 1750000000000 + i * 1000 + 15000])
  }
  for (let i = 0; i < 30_000; i += 1) {
    segments.push([i % 20_000, `seg-${i}-1a2b3c`, 1750000000000 + i * 1000, 1750000000000 + i * 1000 + 90000, 1750000000000 + i * 1000 + 90000, 90])
  }

  const encoded = encodeListeningHistoryPayload({
    v: LISTENING_STATS_TRANSFER_VERSION,
    historyStartedAt: 1750000000000,
    sessionsTotal: 20_000,
    truncated: false,
    tracks: dictionary.tuples(),
    sessions,
    segments
  })

  const bytes = Buffer.byteLength(encoded, 'utf-8')
  assert.ok(bytes < 7 * 1024 * 1024, `expected under 7 MB, got ${(bytes / 1024 / 1024).toFixed(2)} MB`)
})
