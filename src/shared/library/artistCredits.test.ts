import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildArtistIdentityIndex,
  buildArtistCreditTokens,
  buildArtistNameTokens,
  canonicalizeArtistDisplay,
  deserializeArtistNames,
  formatArtistNames,
  normalizeArtistKey,
  normalizeArtistNames,
  resolveArtistCredit,
  resolveTrackArtistNames,
  serializeArtistNames
} from './artistCredits.ts'

test('normalizes and deduplicates parsed artist names', () => {
  assert.deepEqual(
    normalizeArtistNames([' Paul McCartney ', 'Michael   Jackson', 'paul mccartney', '', null]),
    ['Paul McCartney', 'Michael Jackson']
  )
})

test('formats parsed artist names with stable display separators', () => {
  assert.equal(formatArtistNames(['Paul McCartney', 'Michael Jackson']), 'Paul McCartney & Michael Jackson')
  assert.equal(formatArtistNames(['A', 'B', 'C']), 'A, B & C')
})

test('serializes and deserializes stored artist credits', () => {
  const stored = serializeArtistNames(['A', 'B'])
  assert.equal(stored, '["A","B"]')
  assert.deepEqual(deserializeArtistNames(stored), ['A', 'B'])
  assert.deepEqual(deserializeArtistNames('not json'), [])
})

test('builds link tokens without splitting artist names that contain separators', () => {
  assert.deepEqual(
    buildArtistNameTokens(['Earth, Wind & Fire', 'The Emotions']),
    [
      { artist: 'Earth, Wind & Fire', separator: ' & ' },
      { artist: 'The Emotions', separator: null }
    ]
  )
})

test('preserves raw credit separators for resolved link targets', () => {
  assert.deepEqual(
    buildArtistCreditTokens('Becky Hill, Chase & Status', ['Becky Hill', 'Chase & Status']),
    [
      { artist: 'Becky Hill', separator: ', ' },
      { artist: 'Chase & Status', separator: null }
    ]
  )
})

test('normalizes unicode identity representation without changing display semantics', () => {
  assert.equal(normalizeArtistKey('  L’Impératrice\u200b  '), "l'impératrice")
  assert.equal(canonicalizeArtistDisplay('V/A'), 'Various Artists')
})

test('resolves real-library comma and ampersand examples from factual evidence', () => {
  const tracks = [
    { artist: 'BIZ', album_artist: 'BIZ' },
    { artist: 'Zera', album_artist: null },
    { artist: 'Becky Hill', album_artist: 'Becky Hill' },
    { artist: 'BIZ, Zera', album_artist: 'BIZ, Zera' },
    { artist: 'd4vd, Arcane, League of Legends', album_artist: null },
    { artist: 'Becky Hill, Chase & Status', album_artist: null },
    { artist: 'Royal & the Serpent', album_artist: null }
  ]
  const index = buildArtistIdentityIndex(tracks)

  assert.deepEqual(resolveArtistCredit('BIZ, Zera', index), ['BIZ', 'Zera'])
  assert.deepEqual(
    resolveArtistCredit('d4vd, Arcane, League of Legends', index),
    ['d4vd', 'Arcane', 'League of Legends']
  )
  assert.deepEqual(
    resolveArtistCredit('Becky Hill, Chase & Status', index),
    ['Becky Hill', 'Chase & Status']
  )
  assert.deepEqual(resolveArtistCredit('Royal & the Serpent', index), ['Royal & the Serpent'])
})

test('structured credits win and fallback inferences never train the index', () => {
  const structured = {
    artist: 'Earth, Wind & Fire & The Emotions',
    artist_names: ['Earth, Wind & Fire', 'The Emotions'],
    album_artist: null
  }
  const index = buildArtistIdentityIndex([
    structured,
    { artist: 'Porter Robinson', album_artist: null },
    { artist: 'Madeon', album_artist: null },
    { artist: 'Porter Robinson & Madeon', album_artist: null }
  ])

  assert.deepEqual(resolveTrackArtistNames(structured, index), ['Earth, Wind & Fire', 'The Emotions'])
  assert.deepEqual(resolveArtistCredit('Porter Robinson & Madeon', index), ['Porter Robinson', 'Madeon'])
  assert.equal(index.factualKeys.has('chase'), false)
})

test('protects the longest exact factual identity before parsing punctuation', () => {
  const index = buildArtistIdentityIndex([
    { artist: 'Earth, Wind & Fire', artist_names: ['Earth, Wind & Fire'], album_artist: null },
    { artist: 'The Emotions', album_artist: null }
  ])

  assert.deepEqual(
    resolveArtistCredit('Earth, Wind & Fire & The Emotions', index),
    ['Earth, Wind & Fire', 'The Emotions']
  )
})

test('generic aliases share an identity without rewriting source display spelling', () => {
  const track = { artist: 'V/A', artist_names: ['V/A'], album_artist: null }
  const index = buildArtistIdentityIndex([track])
  assert.deepEqual(resolveTrackArtistNames(track, index), ['V/A'])
  assert.equal(normalizeArtistKey('V/A'), normalizeArtistKey('Various Artists'))
})

test('preserves a strongly dominant repeated compound observation', () => {
  const tracks = Array.from({ length: 12 }, () => ({ artist: 'Earth, Wind & Fire', album_artist: null }))
  const index = buildArtistIdentityIndex(tracks)
  assert.deepEqual(resolveArtistCredit('Earth, Wind & Fire', index), ['Earth, Wind & Fire'])
})

test('learns an ampersand list convention only within a strongly corroborated release', () => {
  const collaborationAlbum = 'Monstercat x Hospital Records'
  const tracks = [
    { artist: 'Bensley', album: 'Fade Out', album_artist: 'Bensley' },
    { artist: 'Protostar', album: 'Galaxies', album_artist: 'Protostar' },
    { artist: 'P Money x Whiney x hayve', album: collaborationAlbum, album_artist: null },
    { artist: 'hayve & DRIIA', album: collaborationAlbum, album_artist: 'Hospital & Monstercat' },
    { artist: 'Waeys, Bensley & Hoax', album: collaborationAlbum, album_artist: null },
    { artist: 'Anaïs & hayve', album: collaborationAlbum, album_artist: null },
    { artist: 'Bensley, BOP & Degs', album: collaborationAlbum, album_artist: null },
    { artist: 'Protostar, Subten & PVC', album: collaborationAlbum, album_artist: null },
    { artist: 'DNMO & SOLAH', album: collaborationAlbum, album_artist: null },
    { artist: 'BOP, Subwave & imallryt', album: collaborationAlbum, album_artist: null },
    {
      artist: 'Royal & the Serpent',
      album: 'Arcane League of Legends: Season 2',
      album_artist: 'Arcane, League of Legends'
    },
    { artist: 'Becky Hill, Chase & Status', album: 'Disconnect', album_artist: null }
  ]
  const index = buildArtistIdentityIndex(tracks)

  assert.equal(index.ampersandListAlbumKeys.has(collaborationAlbum.toLocaleLowerCase()), true)
  assert.deepEqual(resolveTrackArtistNames(tracks[2], index), ['P Money', 'Whiney', 'hayve'])
  assert.deepEqual(resolveTrackArtistNames(tracks[3], index), ['hayve', 'DRIIA'])
  assert.deepEqual(resolveTrackArtistNames(tracks[3], index, true), ['Hospital & Monstercat'])
  assert.deepEqual(resolveTrackArtistNames(tracks[4], index), ['Waeys', 'Bensley', 'Hoax'])
  assert.deepEqual(resolveTrackArtistNames(tracks[5], index), ['Anaïs', 'hayve'])
  assert.deepEqual(resolveTrackArtistNames(tracks[6], index), ['Bensley', 'BOP', 'Degs'])
  assert.deepEqual(resolveTrackArtistNames(tracks[7], index), ['Protostar', 'Subten', 'PVC'])
  assert.deepEqual(resolveTrackArtistNames(tracks[8], index), ['DNMO', 'SOLAH'])
  assert.deepEqual(resolveTrackArtistNames(tracks[9], index), ['BOP', 'Subwave', 'imallryt'])
  assert.deepEqual(resolveTrackArtistNames(tracks[10], index), ['Royal & the Serpent'])
  assert.deepEqual(resolveTrackArtistNames(tracks[11], index), ['Becky Hill', 'Chase & Status'])
})

test('uses factual anchors and one-hop repeated co-credits without blindly splitting ampersands', () => {
  const tracks = [
    { artist: 'MOTTO MUSIC', album: 'Angle.', album_artist: 'MOTTO MUSIC' },
    { artist: 'MOTTO MUSIC & 雄之助', album: 'Sweets.', album_artist: 'MOTTO MUSIC' },
    { artist: 'WaMi & 雄之助', album: 'Glass heel', album_artist: 'WaMi & 雄之助' },
    { artist: 'lapix', album: 'Genexx Nova', album_artist: 'lapix' },
    { artist: 'lapix & 水槽', album: 'Backstage', album_artist: 'lapix & 水槽' },
    { artist: 't+pazolite & ぷにぷに電機', album: 'FAKE CIRCUS', album_artist: 'T+pazolite' },
    { artist: 'Royal & the Serpent', album: 'Arcane Season 2', album_artist: null },
    { artist: 'Becky Hill, Chase & Status', album: 'Disconnect', album_artist: null }
  ]
  const index = buildArtistIdentityIndex(tracks)

  assert.deepEqual(resolveTrackArtistNames(tracks[1], index), ['MOTTO MUSIC', '雄之助'])
  assert.deepEqual(resolveTrackArtistNames(tracks[2], index), ['WaMi', '雄之助'])
  assert.deepEqual(resolveTrackArtistNames(tracks[4], index), ['lapix', '水槽'])
  assert.deepEqual(resolveTrackArtistNames(tracks[5], index), ['t+pazolite', 'ぷにぷに電機'])
  assert.deepEqual(resolveTrackArtistNames(tracks[6], index), ['Royal & the Serpent'])
  assert.deepEqual(resolveTrackArtistNames(tracks[7], index), ['Becky Hill', 'Chase & Status'])
  assert.equal(index.factualKeys.has(normalizeArtistKey('雄之助')), false)
  assert.equal(index.factualKeys.has(normalizeArtistKey('WaMi')), false)
})

test('does not let repetition protect a punctuation compound with a factual component', () => {
  const tracks = [
    ...Array.from({ length: 12 }, () => ({
      artist: 'Arcane, League of Legends',
      album: 'Arcane Soundtrack',
      album_artist: 'Arcane, League of Legends'
    })),
    { artist: 'League of Legends', album: 'Soul Fighter', album_artist: 'League of Legends' }
  ]
  const index = buildArtistIdentityIndex(tracks)

  assert.deepEqual(resolveTrackArtistNames(tracks[0], index), ['Arcane', 'League of Legends'])
  assert.deepEqual(resolveTrackArtistNames(tracks[0], index, true), ['Arcane', 'League of Legends'])
})

test('does not amplify repeated scalar album-owner boilerplate into compound identity evidence', () => {
  const albumOwner = 'Sān-Z, HOYO-MiX'
  const tracks = [
    ...Array.from({ length: 3 }, (_, index) => ({
      artist: albumOwner,
      album: `Release ${index + 1}`,
      album_artist: albumOwner
    })),
    ...['Alaina Cross', 'Ymir', 'Gin Wigmore', 'Astra Yao', 'han.irl<3', '雷雨心', '狐妖Mikan'].map(
      (guest, index) => ({
        artist: `${albumOwner}, ${guest}`,
        album: `Guest Release ${index + 1}`,
        album_artist: albumOwner
      })
    )
  ]
  const index = buildArtistIdentityIndex(tracks)

  assert.equal(index.rawCreditCounts.get(normalizeArtistKey(albumOwner)), 3)
  assert.deepEqual(resolveTrackArtistNames(tracks[0], index), ['Sān-Z', 'HOYO-MiX'])
  assert.deepEqual(resolveTrackArtistNames(tracks[0], index, true), ['Sān-Z', 'HOYO-MiX'])
})
