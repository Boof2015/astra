import assert from 'node:assert/strict'
import test from 'node:test'
import type { QuickLaunchLockedFilter, QuickLaunchTrackRecord } from '../types/quickLaunch'
import {
  buildQuickLaunchPlayRequest,
  filterQuickLaunchAlbumOptions,
  findQuickLaunchTokenFragment,
  rankQuickLaunchFilterOptions,
  rankQuickLaunchTrackOccurrences,
  removeQuickLaunchTokenFragment,
  replaceQuickLaunchTokenFragment,
  trackMatchesArtistFilter,
  trackMatchesQuickLaunchFilters,
  upsertQuickLaunchFilter,
  type QuickLaunchFilterOption,
  type QuickLaunchTrackOccurrence
} from './quickLaunchSearch'

function track(overrides: Partial<QuickLaunchTrackRecord> = {}): QuickLaunchTrackRecord {
  return {
    id: 1,
    path: '/music/one.flac',
    album_identity_key: 'album-one',
    title: 'Hidden Place',
    artist: 'Björk feat. Ensemble',
    artist_names: ['Björk', 'Ensemble'],
    album: 'Vespertine',
    album_artist: 'Björk',
    album_artist_names: ['Björk'],
    duration: 240,
    track_number: 1,
    disc_number: 1,
    year: 2001,
    genre: 'Electronic',
    genres: ['Electronic', 'Art Pop'],
    artwork_hash: null,
    format: 'flac',
    sample_rate: 44100,
    bit_depth: 16,
    bitrate: null,
    channels: 2,
    replaygain_track_gain_db: null,
    replaygain_album_gain_db: null,
    source_type: 'local',
    source_id: null,
    source_track_id: null,
    source_path: null,
    is_available: 1,
    availability_reason: null,
    ...overrides
  }
}

function occurrence(value: QuickLaunchTrackRecord, index: number, key = `${index}`): QuickLaunchTrackOccurrence {
  return { occurrenceKey: key, track: value, sourceIndex: index }
}

function albumSuggestionsFixture() {
  const options: QuickLaunchFilterOption[] = [
    { id: 'album-one', label: 'Vespertine', subtitle: 'Björk · 2001', value: 'album-one' },
    { id: 'album-two', label: 'Together', subtitle: 'Ensemble · 2002', value: 'album-two' },
    { id: 'album-three', label: 'Together', subtitle: 'Radiohead · 2003', value: 'album-three' },
    { id: 'album-four', label: 'Together', subtitle: 'Ensemble · 2004', value: 'album-four' }
  ]
  const tracks = [
    track({ artist: 'Björk', artist_names: ['Björk'] }),
    track({
      album_identity_key: 'album-four', album: 'Together', year: 2004,
      artist: 'Ensemble', artist_names: ['Ensemble'], album_artist: 'Ensemble', album_artist_names: ['Ensemble']
    }),
    track({
      album_identity_key: 'album-three', album: 'Together', year: 2003,
      artist: 'Radiohead', artist_names: ['Radiohead'], album_artist: 'Radiohead', album_artist_names: ['Radiohead']
    }),
    track({
      album_identity_key: 'album-two', album: 'Together', year: 2002,
      artist: 'Ensemble', artist_names: ['Ensemble'], album_artist: 'Ensemble', album_artist_names: ['Ensemble']
    }),
    track({ id: 2, path: '/music/two.flac', track_number: 2 })
  ]
  return { options, tracks }
}

test('artist filters follow strict and canonical browse semantics', () => {
  const value = track()
  assert.equal(trackMatchesArtistFilter(value, 'Ensemble', 'strict'), false)
  assert.equal(trackMatchesArtistFilter(value, 'Ensemble', 'canonical'), true)
  assert.equal(trackMatchesArtistFilter(value, 'bjork', 'strict'), true)
})

test('album suggestions include later featured appearances and preserve release identities and option order', () => {
  const { options, tracks } = albumSuggestionsFixture()
  const eligible = filterQuickLaunchAlbumOptions(options, tracks, 'Ensemble', 'canonical')
  assert.deepEqual(eligible, [options[0], options[1], options[3]])
  assert.equal(eligible[0], options[0])

  // The first track on Vespertine has no Ensemble credit; the later track qualifies the release.
  assert.deepEqual(
    filterQuickLaunchAlbumOptions(options, tracks.slice(0, -1), 'Ensemble', 'canonical'),
    [options[1], options[3]]
  )
})

test('album suggestions follow strict mode and normalize artist names', () => {
  const { options, tracks } = albumSuggestionsFixture()
  assert.deepEqual(
    filterQuickLaunchAlbumOptions(options, tracks, ' ensemble ', 'strict'),
    [options[1], options[3]]
  )
  for (const mode of ['canonical', 'strict'] as const) {
    assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, ' BJORK ', mode), [options[0]])
  }
})

test('album suggestions recognize structured album artist credits and strict track artist fallback', () => {
  const { options } = albumSuggestionsFixture()
  const collaboration = track({
    artist: 'Soloist', artist_names: ['Soloist'],
    album_artist: 'Björk & Ensemble', album_artist_names: ['Björk', 'Ensemble']
  })
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, [collaboration], 'Ensemble', 'canonical'), [options[0]])
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, [collaboration], 'Ensemble', 'strict'), [])

  const noAlbumArtist = track({ artist: 'Ensemble', artist_names: [], album_artist: null, album_artist_names: [] })
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, [noAlbumArtist], 'Ensemble', 'strict'), [options[0]])
})

test('changing or removing the artist recomputes album suggestions without altering the full list', () => {
  const { options, tracks } = albumSuggestionsFixture()
  const original = structuredClone(options)
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, null, 'canonical'), original)
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, 'Björk', 'canonical'), [options[0]])
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, 'Radiohead', 'canonical'), [options[2]])
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, null, 'canonical'), original)
  assert.deepEqual(options, original)
})

test('album suggestions never fall back to unrelated releases when the artist has no matches', () => {
  const { options, tracks } = albumSuggestionsFixture()
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, tracks, 'Missing Artist', 'canonical'), [])
  assert.deepEqual(filterQuickLaunchAlbumOptions(options, [], 'Björk', 'canonical'), [])
})

test('album text ranking only searches the artist-scoped options', () => {
  const { options, tracks } = albumSuggestionsFixture()
  const eligible = filterQuickLaunchAlbumOptions(options, tracks, 'Ensemble', 'canonical')
  assert.deepEqual(rankQuickLaunchFilterOptions(eligible, ''), eligible)
  assert.deepEqual(rankQuickLaunchFilterOptions(eligible, 'Together'), [options[1], options[3]])
  assert.deepEqual(rankQuickLaunchFilterOptions(eligible, 'Vespertine'), [options[0]])
  assert.deepEqual(rankQuickLaunchFilterOptions(eligible, 'Radiohead'), [])
  assert.deepEqual(rankQuickLaunchFilterOptions(eligible, 'zzzzzzzzzz'), [])
})

test('distinct filters combine with AND and Unknown year is exact', () => {
  const filters: QuickLaunchLockedFilter[] = [
    { kind: 'album', id: 'album:album-one', label: 'Vespertine', value: 'album-one' },
    { kind: 'genre', id: 'genre:electronic', label: 'Electronic', value: 'electronic' },
    { kind: 'year', id: 'year:2001', label: '2001', value: 2001 }
  ]
  assert.equal(trackMatchesQuickLaunchFilters(track(), filters, 'canonical'), true)
  assert.equal(trackMatchesQuickLaunchFilters(track({ year: null }), filters, 'canonical'), false)
  assert.equal(trackMatchesQuickLaunchFilters(
    track({ year: null }),
    [{ kind: 'year', id: 'year:unknown', label: 'Unknown', value: null }],
    'canonical'
  ), true)
})

test('locking another value replaces only the matching filter type', () => {
  const initial: QuickLaunchLockedFilter[] = [
    { kind: 'artist', id: 'artist:first', label: 'First', value: 'First' },
    { kind: 'year', id: 'year:2001', label: '2001', value: 2001 }
  ]
  const next = upsertQuickLaunchFilter(initial, { kind: 'artist', id: 'artist:second', label: 'Second', value: 'Second' })
  assert.deepEqual(next.map((filter) => filter.id), ['year:2001', 'artist:second'])
})

test('playlist occurrences preserve entry order and duplicates', () => {
  const duplicate = track()
  const rows = [occurrence(duplicate, 0, 'entry-1'), occurrence(duplicate, 1, 'entry-2')]
  const ranked = rankQuickLaunchTrackOccurrences(
    rows,
    '',
    [{ kind: 'playlist', id: 'playlist:4', label: 'Mix', value: 4 }],
    'canonical'
  )
  assert.deepEqual(ranked.map((row) => row.occurrenceKey), ['entry-1', 'entry-2'])
  assert.deepEqual(buildQuickLaunchPlayRequest(ranked, 'entry-2'), {
    paths: ['/music/one.flac', '/music/one.flac'],
    startIndex: 1
  })
})

test('album scopes use disc and track order without free text', () => {
  const rows = [
    occurrence(track({ path: '/three', disc_number: 2, track_number: 1 }), 0),
    occurrence(track({ path: '/two', disc_number: 1, track_number: 2 }), 1),
    occurrence(track({ path: '/one', disc_number: 1, track_number: 1 }), 2)
  ]
  const ranked = rankQuickLaunchTrackOccurrences(
    rows,
    '',
    [{ kind: 'album', id: 'album:album-one', label: 'Vespertine', value: 'album-one' }],
    'canonical'
  )
  assert.deepEqual(ranked.map((row) => row.track.path), ['/one', '/two', '/three'])
})

test('global track terms are AND-based across different identity fields', () => {
  const rows = [occurrence(track(), 0)]
  assert.equal(rankQuickLaunchTrackOccurrences(rows, 'hidden bjork', [], 'canonical').length, 1)
  assert.equal(rankQuickLaunchTrackOccurrences(rows, 'hidden radiohead', [], 'canonical').length, 0)
})

test('token triggers are recognized only at boundaries and preserve their start', () => {
  assert.deepEqual(findQuickLaunchTokenFragment('hidden @art'), { trigger: '@', fragment: 'art', start: 7 })
  assert.deepEqual(findQuickLaunchTokenFragment('mix /que'), { trigger: '/', fragment: 'que', start: 4 })
  assert.deepEqual(findQuickLaunchTokenFragment('hidden @art live'), { trigger: '@', fragment: 'art', start: 7 })
  assert.equal(findQuickLaunchTokenFragment('email@example.com'), null)
  assert.equal(replaceQuickLaunchTokenFragment('hidden @art live', 7, '@artist'), 'hidden @artist live')
  assert.equal(removeQuickLaunchTokenFragment('hidden @artist live', 7), 'hidden live')
})
