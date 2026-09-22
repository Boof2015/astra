import assert from 'node:assert/strict'
import test from 'node:test'
import { groupTracksByAlbumIdentity, type AlbumIdentityTrackLike } from './albumGrouping.ts'
import { resolveAlbumFixtureTracks } from './__fixtures__/resolveAlbums.ts'
import { resolveMultiDiscAlbumFixtureTracks } from './__fixtures__/resolveMultiDiscAlbums.ts'

interface TestTrack extends AlbumIdentityTrackLike { id: string }

function track(id: string, overrides: Partial<TestTrack> = {}): TestTrack {
  return { id, album: 'Release', artist: 'Owner', album_artist: 'Owner', ...overrides }
}

const group = (tracks: TestTrack[]) => groupTracksByAlbumIdentity(tracks, (item) => item.id)
const memberships = (tracks: TestTrack[]) => Array.from(group(tracks).values())
  .map((release) => release.tracks.map((item) => item.id).sort())
  .sort((a, b) => a.join('|').localeCompare(b.join('|')))

function assertStablePartition(tracks: TestTrack[]): void {
  const identityMap = (groups: ReturnType<typeof group>) => Array.from(groups)
    .map(([key, release]) => [key, release.tracks.map((item) => item.id).sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  const expected = identityMap(group(tracks))
  let seed = 1741
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shuffled = [...tracks]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const target = seed % (index + 1)
      const current = shuffled[index]
      shuffled[index] = shuffled[target]
      shuffled[target] = current
    }
    const actual = group(shuffled)
    assert.deepEqual(identityMap(actual), expected)
    assert.deepEqual(Array.from(actual.values()).flatMap((release) => release.tracks.map((item) => item.id)).sort(),
      tracks.map((item) => item.id).sort())
    assert.equal(new Set(Array.from(actual.values()).map((release) => release.identityKey)).size, actual.size)
  }
}

test('keeps all 42 tester tracks in two intended albums without changing metadata', () => {
  const before = structuredClone(resolveAlbumFixtureTracks)
  const groups = group(resolveAlbumFixtureTracks)
  assert.equal(groups.size, 2)
  assert.equal(groups.get('album:carti leaks::aa:playboi carti')?.tracks.length, 18)
  assert.equal(groups.get('album:scarlet 2 claude::aa:doja cat')?.tracks.length, 24)
  assert.deepEqual(resolveAlbumFixtureTracks, before)
  assertStablePartition(resolveAlbumFixtureTracks)
})

test('additional tester albums reunite J. Cole, Black Eyed Peas, and David Gray discs', () => {
  const before = structuredClone(resolveMultiDiscAlbumFixtureTracks)
  const groups = group(resolveMultiDiscAlbumFixtureTracks)
  const expectations = [
    { key: 'album:2014 forest hills drive::aa:j. cole', year: 2024, discs: [13, 8] },
    { key: 'album:the e•n•d::aa:black eyed peas', year: 2009, discs: [15, 10] },
    { key: 'album:foundling::aa:david gray', year: 2010, discs: [11, 9] }
  ]
  assert.equal(resolveMultiDiscAlbumFixtureTracks.length, 66)
  assert.equal(groups.size, 3)
  for (const expected of expectations) {
    const release = groups.get(expected.key)
    assert.ok(release, expected.key)
    assert.equal(release.groupingMode, 'explicit-album-artist')
    assert.equal(release.tracks.length, expected.discs.reduce((sum, count) => sum + count, 0))
    assert.ok(release.tracks.every((item) => item.year === expected.year && item.disc_total === 2))
    for (const [index, count] of expected.discs.entries()) {
      const discTracks: TestTrack[] = release.tracks.filter((item) => item.disc_number === index + 1)
      assert.deepEqual(discTracks.map((item) => item.track_number).sort((a, b) => (a ?? 0) - (b ?? 0)),
        Array.from({ length: count }, (_, number) => number + 1))
      assert.ok(discTracks.every((item) => item.track_total === count))
    }
  }
  assert.deepEqual(resolveMultiDiscAlbumFixtureTracks, before)
  assertStablePartition(resolveMultiDiscAlbumFixtureTracks)
})

test('all 108 supplied tracks keep five stable album identities when combined', () => {
  const tracks = [...resolveAlbumFixtureTracks, ...resolveMultiDiscAlbumFixtureTracks]
  assert.equal(tracks.length, 108)
  assert.equal(group(tracks).size, 5)
  assertStablePartition(tracks)
})

test('real releases tolerate absent covers, absent owners, incomplete tracklists, and missing totals', () => {
  const variants = [
    resolveAlbumFixtureTracks.map((item) => ({ ...item, base_artwork_hash: null })),
    resolveAlbumFixtureTracks.map((item) => ({ ...item, album_artist: null, album_artist_names: null })),
    resolveAlbumFixtureTracks.filter((item) => [1, 7, 10, 13].includes(item.track_number ?? 0)),
    resolveAlbumFixtureTracks.map((item) => ({ ...item, track_total: null }))
  ]
  for (const tracks of variants) {
    assert.equal(group(tracks).size, 2)
    assertStablePartition(tracks)
  }
})

test('different totals on known discs are compatible even for compilations without owners', () => {
  const tracks = [
    track('disc-1', { year: 2024, disc_number: 1, disc_total: 2, track_number: 1, track_total: 14 }),
    track('disc-2', { year: 2024, disc_number: 2, disc_total: 2, track_number: 1, track_total: 10 })
  ]
  assert.equal(group(tracks).size, 1)
  const compilation = tracks.map((item, index) => ({
    ...item, album_artist: null, artist: `Artist ${index}`, base_artwork_hash: 'cover'
  }))
  assert.equal(group(compilation).size, 1)
  assert.equal(Array.from(group(compilation).values())[0].groupingMode, 'shared-artwork-compilation')
})

test('missing disc numbers do not excuse conflicting totals', () => {
  const tracks = [
    track('known', { disc_number: 2, disc_total: 2, track_number: 1, track_total: 10 }),
    track('unknown', { disc_total: 2, track_number: 2, track_total: 14 })
  ]
  assert.equal(group(tracks).size, 2)
  assertStablePartition(tracks)
})

test('owner and artwork cannot override same-disc totals or release-wide disc totals', () => {
  for (const conflict of [{ track_total: 12 }, { disc_total: 2 }]) {
    const tracks = [
      track('old', { year: 2000, disc_number: 1, disc_total: 1, track_number: 1, track_total: 10, base_artwork_hash: 'cover' }),
      track('new', { year: 2020, disc_number: 1, disc_total: 1, track_number: 2, track_total: 10, base_artwork_hash: 'cover', ...conflict })
    ]
    assert.equal(group(tracks).size, 2)
  }
})

test('an explicit owner and partial numbering override dates without covers or totals', () => {
  assert.equal(group([
    track('old', { year: 2000, track_number: 2 }),
    track('new', { year: 2020, track_number: 8 })
  ]).size, 1)
})

test('year overrides require numbered evidence from both dated sides', () => {
  const tracks = [
    track('old', { year: 2000, track_number: 1, base_artwork_hash: 'cover' }),
    track('new', { year: 2020, base_artwork_hash: 'cover' }),
    track('undated', { track_number: 2, base_artwork_hash: 'cover' })
  ]
  assert.deepEqual(memberships(tracks), [['new'], ['old'], ['undated']])
  assertStablePartition(tracks)
})

test('invalid or ambiguous numbering cannot justify overriding dates', () => {
  for (const invalid of [
    { track_number: 0 }, { track_number: -1 }, { track_number: 11, track_total: 10 },
    { disc_number: 0 }, { disc_number: 3, disc_total: 2 }, { disc_number: null, disc_total: 2 }
  ]) {
    assert.equal(group([
      track('old', { year: 2000, track_number: 1, disc_number: 1 }),
      track('new', { year: 2020, track_number: 2, disc_number: 1, ...invalid })
    ]).size, 2, JSON.stringify(invalid))
  }
})

test('missing owners need matching source covers to override years', () => {
  const tracks = [
    track('old', { album_artist: null, year: 2000, track_number: 1, base_artwork_hash: 'cover' }),
    track('new', { album_artist: null, year: 2020, track_number: 2, base_artwork_hash: 'cover' })
  ]
  assert.equal(group(tracks).size, 1)
  for (const cover of [null, 'different']) {
    const changed = tracks.map((item, index) => ({ ...item, artwork_hash: 'display-cover',
      base_artwork_hash: index === 1 ? cover : item.base_artwork_hash }))
    assert.equal(group(changed).size, 2)
  }
  const compilation = tracks.map((item, index) => ({ ...item, artist: `Artist ${index}` }))
  assert.equal(Array.from(group(compilation).values())[0].groupingMode, 'shared-artwork-compilation')
  assert.equal(group(compilation.map((item) => ({ ...item, album: 'Unknown Album' }))).size, 2)
})

test('missing owners attach across years only with numbering and shared source artwork', () => {
  const tracks = [
    track('owner', { year: 2000, track_number: 1, base_artwork_hash: 'cover' }),
    track('guest', { album_artist: null, artist: 'Guest', year: 2020, track_number: 2, base_artwork_hash: 'cover' })
  ]
  assert.equal(group(tracks).size, 1)
  assert.equal(Array.from(group(tracks).values())[0].groupingMode, 'explicit-album-artist')
  assert.equal(group(tracks.map((item) => ({ ...item, base_artwork_hash: null }))).size, 2)
})

test('all proposed missing-owner attachments must be coherent together', () => {
  const tracks = [
    track('owner', { year: 2000, track_number: 1, base_artwork_hash: 'cover' }),
    track('guest-a', { album_artist: null, year: 2020, track_number: 2, base_artwork_hash: 'cover' }),
    track('guest-b', { album_artist: null, year: 2020, track_number: 2, base_artwork_hash: 'cover' })
  ]
  assert.deepEqual(memberships(tracks), [['guest-a', 'guest-b'], ['owner']])
  assertStablePartition(tracks)
})

test('original and reissue stay separate despite identical covers and owners; duplicate formats still group', () => {
  const tracks = [2000, 2020].flatMap((year) => [1, 2, 3].map((number) => track(`${year}-${number}`, {
    year, track_number: number, track_total: 3, base_artwork_hash: 'cover'
  })))
  assert.deepEqual(memberships(tracks), [
    ['2000-1', '2000-2', '2000-3'], ['2020-1', '2020-2', '2020-3']
  ])
  assertStablePartition(tracks)
  const duplicate = { ...tracks[0], id: 'duplicate-format' }
  assert.equal(group([...tracks, duplicate]).size, 2)
  assert.equal(group([...tracks.slice(0, 3), duplicate]).size, 1)
})

test('a numbered middle-year fragment cannot arbitrarily bridge competing releases', () => {
  const tracks = [
    track('old', { year: 2000, track_number: 1 }),
    track('middle', { year: 2010, track_number: 2 }),
    track('new', { year: 2020, track_number: 1 })
  ]
  assert.deepEqual(memberships(tracks), [['middle'], ['new'], ['old']])
  assertStablePartition(tracks)
})

test('undated tracks that fit two editions stay separate from both', () => {
  const tracks = [
    track('old', { year: 2000, track_number: 1, track_total: 2 }),
    track('new', { year: 2020, track_number: 1, track_total: 2 }),
    track('undated', { track_number: 2, track_total: 2 })
  ]
  assert.deepEqual(memberships(tracks), [['new'], ['old'], ['undated']])
  assertStablePartition(tracks)
})

test('unqualified tracks consider incompatible undated releases before assignment', () => {
  assert.deepEqual(memberships([
    track('dated', { year: 2000, track_total: 10 }),
    track('undated-release', { track_total: 14 }),
    track('wildcard')
  ]), [['dated'], ['undated-release'], ['wildcard']])
})

test('an ambiguous second disc cannot be claimed by whichever first-disc edition sorts first', () => {
  const tracks = [
    track('bonus', { year: 2024, disc_number: 2, disc_total: 2, track_number: 1, track_total: 5 }),
    track('short', { year: 2024, disc_number: 1, disc_total: 2, track_number: 1, track_total: 10 }),
    track('long', { year: 2024, disc_number: 1, disc_total: 2, track_number: 1, track_total: 14 })
  ]
  assert.deepEqual(memberships(tracks), [['bonus'], ['long'], ['short']])
  assertStablePartition(tracks)
  const renamed = tracks.map((item, index) => ({ ...item, id: `${3 - index}-${item.id}` }))
  assert.ok(Array.from(group(renamed).values()).every((release) => release.tracks.length === 1))
})

test('release qualifiers describe all discs in stable order', () => {
  const tracks = [2000, 2020].flatMap((year) => [2, 1].map((disc) => track(`${year}-${disc}`, {
    year, disc_number: disc, disc_total: 2, track_number: 1, track_total: disc === 1 ? 14 : 10
  })))
  const keys = Array.from(group(tracks).keys())
  assert.equal(keys.length, 2)
  assert.ok(keys.every((key) => key.endsWith(':d2:t1=14;2=10')))
  assertStablePartition(tracks)
})

test('mixed ambiguous metadata preserves every track and stable identities', () => {
  const tracks = Array.from({ length: 80 }, (_, index) => track(String(index), {
    artist: `Artist ${index % 3}`,
    album_artist: index % 4 === 0 ? null : `Owner ${index % 2}`,
    year: index % 5 === 0 ? null : 2000 + (index % 3) * 10,
    disc_number: index % 7 === 0 ? null : 1 + (index % 2),
    track_number: index % 6 === 0 ? null : 1 + (index % 4),
    track_total: index % 3 === 0 ? null : 4 + (index % 2),
    base_artwork_hash: index % 7 === 0 ? null : 'cover'
  }))
  assertStablePartition(tracks)
})
