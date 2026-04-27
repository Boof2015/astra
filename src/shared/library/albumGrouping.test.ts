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
    base_artwork_hash: overrides.base_artwork_hash ?? null
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
