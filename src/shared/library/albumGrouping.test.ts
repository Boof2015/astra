import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAlbumIdentityKeyByTrackId,
  groupTracksByAlbumIdentity,
  type AlbumIdentityTrackLike
} from './albumGrouping.ts'

interface TestTrack extends AlbumIdentityTrackLike {
  id: string
}

function createTrack(overrides: Partial<TestTrack> & Pick<TestTrack, 'id' | 'album' | 'artist'>): TestTrack {
  return {
    id: overrides.id,
    album: overrides.album,
    artist: overrides.artist,
    artist_names: overrides.artist_names ?? null,
    album_artist: overrides.album_artist ?? null,
    album_artist_names: overrides.album_artist_names ?? null,
    artwork_hash: overrides.artwork_hash ?? null,
    base_artwork_hash: overrides.base_artwork_hash ?? null,
    year: overrides.year ?? null,
    track_number: overrides.track_number ?? null,
    track_total: overrides.track_total ?? null,
    disc_number: overrides.disc_number ?? null,
    disc_total: overrides.disc_total ?? null
  }
}

function groupTracks(tracks: TestTrack[]) {
  return groupTracksByAlbumIdentity(tracks, (track) => track.id)
}

test('groups missing-albumartist tracks by primary artist even when artwork differs', () => {
  const tracks = [
    createTrack({ id: '1', album: 'teen week', artist: 'Jane Remover', base_artwork_hash: 'cover-a' }),
    createTrack({ id: '2', album: 'teen week', artist: 'Jane Remover feat. Venturing', base_artwork_hash: 'cover-b' }),
  ]

  const groups = groupTracks(tracks)

  assert.equal(groups.size, 1)
  const [group] = Array.from(groups.values())
  assert.equal(group.groupingMode, 'track-artist')
  assert.equal(group.displayArtist, 'Jane Remover')
  assert.deepEqual(group.tracks.map((track) => track.id), ['1', '2'])
})

test('uses parsed multi-value artist credits for primary artist grouping', () => {
  const tracks = [
    createTrack({
      id: '1',
      album: 'duets',
      artist: 'Earth, Wind & Fire & The Emotions',
      artist_names: ['Earth, Wind & Fire', 'The Emotions'],
      base_artwork_hash: 'cover-a'
    }),
    createTrack({
      id: '2',
      album: 'duets',
      artist: 'Earth, Wind & Fire & The Emotions',
      artist_names: ['Earth, Wind & Fire', 'The Emotions'],
      base_artwork_hash: 'cover-b'
    }),
  ]

  const groups = groupTracks(tracks)

  assert.equal(groups.size, 1)
  const [group] = Array.from(groups.values())
  assert.equal(group.displayArtist, 'Earth, Wind & Fire')
  assert.deepEqual(group.tracks.map((track) => track.id), ['1', '2'])
})

test('collapses shared-cover multi-artist albums into a single compilation group when albumartist is missing', () => {
  const tracks = [
    createTrack({ id: '1', album: 'split release', artist: 'Artist A', base_artwork_hash: 'shared-cover' }),
    createTrack({ id: '2', album: 'split release', artist: 'Artist B', base_artwork_hash: 'shared-cover' }),
  ]

  const groups = groupTracks(tracks)

  assert.equal(groups.size, 1)
  const [group] = Array.from(groups.values())
  assert.equal(group.groupingMode, 'shared-artwork-compilation')
  assert.equal(group.displayArtist, 'Various Artists')
  assert.deepEqual(group.tracks.map((track) => track.id), ['1', '2'])
})

test('keeps missing-albumartist multi-artist albums separate when artwork differs', () => {
  const tracks = [
    createTrack({ id: '1', album: 'split release', artist: 'Artist A', base_artwork_hash: 'cover-a' }),
    createTrack({ id: '2', album: 'split release', artist: 'Artist B', base_artwork_hash: 'cover-b' }),
  ]

  const groups = groupTracks(tracks)

  assert.equal(groups.size, 2)
  const groupedArtists = Array.from(groups.values()).map((group) => group.displayArtist).sort()
  assert.deepEqual(groupedArtists, ['Artist A', 'Artist B'])
  assert.ok(Array.from(groups.values()).every((group) => group.groupingMode === 'track-artist'))
})

test('respects explicit albumartist even when per-track artwork differs', () => {
  const tracks = [
    createTrack({
      id: '1',
      album: 'mixtape',
      artist: 'Artist A',
      album_artist: 'Curator',
      base_artwork_hash: 'cover-a'
    }),
    createTrack({
      id: '2',
      album: 'mixtape',
      artist: 'Artist B',
      album_artist: 'Curator',
      base_artwork_hash: 'cover-b'
    }),
  ]

  const groups = groupTracks(tracks)

  assert.equal(groups.size, 1)
  const [group] = Array.from(groups.values())
  assert.equal(group.groupingMode, 'explicit-album-artist')
  assert.equal(group.displayArtist, 'Curator')
  assert.deepEqual(group.tracks.map((track) => track.id), ['1', '2'])
})

test('produces per-track canonical identity keys that match the grouped album identities', () => {
  const tracks = [
    createTrack({ id: '1', album: 'teen week', artist: 'Jane Remover', base_artwork_hash: 'cover-a' }),
    createTrack({ id: '2', album: 'teen week', artist: 'Jane Remover feat. Venturing', base_artwork_hash: 'cover-b' }),
    createTrack({ id: '3', album: 'split release', artist: 'Artist A', base_artwork_hash: 'shared-cover' }),
    createTrack({ id: '4', album: 'split release', artist: 'Artist B', base_artwork_hash: 'shared-cover' }),
    createTrack({ id: '5', album: 'mixtape', artist: 'Artist C', album_artist: 'Curator', base_artwork_hash: 'cover-c' }),
  ]

  const groups = groupTracks(tracks)
  const keysByTrackId = buildAlbumIdentityKeyByTrackId(tracks, (track) => track.id)
  const expectedKeysByTrackId = new Map<string, string>()

  for (const [identityKey, group] of groups.entries()) {
    for (const track of group.tracks) {
      expectedKeysByTrackId.set(track.id, identityKey)
    }
  }

  assert.deepEqual(
    Object.fromEntries(Array.from(keysByTrackId.entries()).sort(([a], [b]) => a.localeCompare(b))),
    Object.fromEntries(Array.from(expectedKeysByTrackId.entries()).sort(([a], [b]) => a.localeCompare(b)))
  )
})

test('ignores missing covers when all available compilation artwork matches', () => {
  const tracks = [
    createTrack({ id: '1', album: 'Compilation', artist: 'Artist A', base_artwork_hash: 'cover' }),
    createTrack({ id: '2', album: 'Compilation', artist: 'Artist B', base_artwork_hash: 'cover' }),
    createTrack({ id: '3', album: 'Compilation', artist: 'Artist C', base_artwork_hash: null })
  ]
  const [group] = groupTracks(tracks).values()
  assert.equal(group.groupingMode, 'shared-artwork-compilation')
  assert.deepEqual(group.tracks.map((track) => track.id), ['1', '2', '3'])
})

test('uses dominant artwork only with corroborating release metadata', () => {
  const tracks = Array.from({ length: 5 }, (_, index) => createTrack({
    id: String(index + 1),
    album: 'Compilation',
    artist: `Artist ${index + 1}`,
    base_artwork_hash: index < 4 ? 'cover' : 'minority',
    year: 2025
  }))
  const [group] = groupTracks(tracks).values()
  assert.equal(group.groupingMode, 'shared-artwork-compilation')
})

test('does not treat a partially missing year as an exact common year for dominant artwork', () => {
  const tracks = Array.from({ length: 5 }, (_, index) => createTrack({
    id: String(index + 1),
    album: 'Compilation',
    artist: `Artist ${index + 1}`,
    base_artwork_hash: index < 4 ? 'cover' : 'minority',
    year: index === 4 ? null : 2025
  }))
  assert.equal(groupTracks(tracks).size, 5)
})

test('infers a complete coherently numbered compilation with distinct artwork', () => {
  const tracks = Array.from({ length: 4 }, (_, index) => createTrack({
    id: String(index + 1),
    album: 'Compilation',
    artist: `Artist ${index + 1}`,
    base_artwork_hash: `cover-${index + 1}`,
    year: 2025,
    track_number: index + 1,
    track_total: 4,
    disc_number: 1,
    disc_total: 1
  }))
  const [group] = groupTracks(tracks).values()
  assert.equal(group.groupingMode, 'metadata-compilation')
})

test('partitions repeated same-artist album titles across conflicting years', () => {
  const groups = groupTracks([
    createTrack({ id: 'old', album: 'Greatest Hits', artist: 'Artist', year: 2004, track_total: 18 }),
    createTrack({ id: 'new', album: 'Greatest Hits', artist: 'Artist', year: 2017, track_total: 12 })
  ])
  assert.equal(groups.size, 2)
  assert.equal(new Set(groups.keys()).size, 2)
  assert.ok(Array.from(groups.keys()).every((key) => !key.includes('cover-')))
})

test('partitions releases when non-null totals conflict', () => {
  const groups = groupTracks([
    createTrack({ id: 'short', album: 'Deluxe', artist: 'Artist', track_number: 1, track_total: 10 }),
    createTrack({ id: 'long', album: 'Deluxe', artist: 'Artist', track_number: 1, track_total: 14 })
  ])
  assert.equal(groups.size, 2)
})

test('duplicate positions prevent numbering-only compilation inference', () => {
  const tracks = Array.from({ length: 4 }, (_, index) => createTrack({
    id: String(index + 1),
    album: 'Compilation',
    artist: `Artist ${index + 1}`,
    base_artwork_hash: `cover-${index + 1}`,
    year: 2025,
    track_number: index === 3 ? 3 : index + 1,
    track_total: 4,
    disc_number: 1,
    disc_total: 1
  }))
  assert.equal(groupTracks(tracks).size, 4)
})

test('attaches one missing album artist track only to its unambiguous compatible owner', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: 'Album', artist: 'Owner', album_artist: 'Owner', year: 2025 }),
    createTrack({ id: '2', album: 'Album', artist: 'Owner feat. Guest', year: 2025 })
  ])
  assert.equal(groups.size, 1)
  const [group] = groups.values()
  assert.equal(group.groupingMode, 'explicit-album-artist')
  assert.deepEqual(group.tracks.map((track) => track.id).sort(), ['1', '2'])
})

test('uses any resolved credit identity for explicit-owner attachment', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: 'Album', artist: 'Owner', album_artist: 'Owner' }),
    createTrack({
      id: '2',
      album: 'Album',
      artist: 'Guest feat. Owner',
      artist_names: ['Guest', 'Owner']
    })
  ])
  assert.equal(groups.size, 1)
  assert.deepEqual(Array.from(groups.values())[0].tracks.map((track) => track.id).sort(), ['1', '2'])
})

test('leaves missing-owner tracks separate when multiple explicit targets are plausible', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: 'Album', artist: 'Owner A', album_artist: 'Owner A', base_artwork_hash: 'cover' }),
    createTrack({ id: '2', album: 'Album', artist: 'Owner B', album_artist: 'Owner B', base_artwork_hash: 'cover' }),
    createTrack({ id: '3', album: 'Album', artist: 'Guest', base_artwork_hash: 'cover' })
  ])
  assert.equal(groups.size, 3)
  assert.equal(Array.from(groups.values()).find((group) => group.tracks.some((track) => track.id === '3'))?.groupingMode, 'track-artist')
})

test('never infers a cross-artist compilation for Unknown Album', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: '', artist: 'Artist A', base_artwork_hash: 'cover' }),
    createTrack({ id: '2', album: 'Unknown Album', artist: 'Artist B', base_artwork_hash: 'cover' })
  ])
  assert.equal(groups.size, 2)
})

test('canonicalizes generic album artist aliases', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: 'Compilation', artist: 'A', album_artist: 'V/A' }),
    createTrack({ id: '2', album: 'Compilation', artist: 'B', album_artist: 'Various Artists' })
  ])
  assert.equal(groups.size, 1)
  assert.equal(Array.from(groups.values())[0].displayArtist, 'Various Artists')
})

test('canonicalizes generic aliases when they are track-level identities', () => {
  const groups = groupTracks([
    createTrack({ id: '1', album: 'Loose Compilation', artist: 'V/A' }),
    createTrack({ id: '2', album: 'Loose Compilation', artist: 'Various Artists' })
  ])
  assert.equal(groups.size, 1)
})
