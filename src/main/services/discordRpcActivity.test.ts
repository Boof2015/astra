import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiscordActivityFromPresence, normalizeDiscordActivityDetails } from './discordRpcActivity.ts'

test('pads one-character titles with a zero-width space', () => {
  assert.equal(normalizeDiscordActivityDetails('X', 128), 'X\u200B')
})

test('trims one-character titles before padding them', () => {
  assert.equal(normalizeDiscordActivityDetails(' X ', 128), 'X\u200B')
})

test('keeps titles with at least two characters unchanged', () => {
  assert.equal(normalizeDiscordActivityDetails('AB', 128), 'AB')
})

test('returns null for blank titles', () => {
  assert.equal(normalizeDiscordActivityDetails('', 128), null)
  assert.equal(normalizeDiscordActivityDetails('   ', 128), null)
})

test("truncates long titles to Discord's max length after normalization", () => {
  const longTitle = 'A'.repeat(129)
  const normalized = normalizeDiscordActivityDetails(longTitle, 128)

  assert.equal(normalized, `${'A'.repeat(127)}\u2026`)
  assert.equal(normalized?.length, 128)
})

test('builds a Spotify-like listening activity while playing', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    currentTimeSeconds: 12,
    durationSeconds: 180,
    track: {
      title: '0',
      artist: 'Ado',
      format: 'flac',
      sampleRate: 48000,
      bitDepth: 24
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    nowSeconds: 1000
  })

  assert.deepEqual(activity, {
    name: 'Astra',
    type: 2,
    details: '0\u200B',
    state: 'Ado',
    status_display_type: 2,
    instance: false,
    timestamps: {
      start: 988,
      end: 1168
    },
    assets: {
      large_image: 'https://example.com/cover.jpg',
      large_text: 'FLAC • 24-bit • 48kHz'
    }
  })
})

test('adds the small image badge when a key is provided alongside cover art', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    currentTimeSeconds: 12,
    durationSeconds: 180,
    track: {
      title: 'Bambi',
      artist: 'Dazbee'
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    smallImageKey: 'astra-logo',
    smallImageText: 'Astra',
    nowSeconds: 1000
  })

  assert.deepEqual(activity?.assets, {
    large_image: 'https://example.com/cover.jpg',
    small_image: 'astra-logo',
    small_text: 'Astra'
  })
})

test('ignores the small image key without a large image', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    currentTimeSeconds: 12,
    durationSeconds: 180,
    track: {
      title: 'Bambi',
      artist: 'Dazbee'
    }
  }, {
    smallImageKey: 'astra-logo',
    smallImageText: 'Astra',
    nowSeconds: 1000
  })

  assert.equal(activity?.assets, undefined)
})

test('links title, artist, album art, and badge for YouTube Music', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    currentTimeSeconds: 12,
    durationSeconds: 180,
    track: {
      title: 'Air',
      artist: 'Dzeko & Torres',
      album: 'Air EP'
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    smallImageKey: 'astra-logo',
    smallImageText: 'Astra',
    smallImageLinkUrl: 'https://github.com/Boof2015/astra',
    linkDestination: 'ytmusic',
    nowSeconds: 1000
  })

  assert.equal(activity?.details_url, 'https://music.youtube.com/search?q=Air%20Dzeko%20%26%20Torres')
  assert.equal(activity?.state_url, 'https://music.youtube.com/search?q=Dzeko%20%26%20Torres')
  assert.equal(activity?.assets?.large_url, 'https://music.youtube.com/search?q=Air%20EP%20Dzeko%20%26%20Torres')
  assert.equal(activity?.assets?.small_url, 'https://github.com/Boof2015/astra')
})

test('links to Last.fm pages and prefers the album artist for album links', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    currentTimeSeconds: 12,
    durationSeconds: 180,
    track: {
      title: 'Air',
      artist: 'Dzeko & Torres, Delaney',
      albumArtist: 'Dzeko & Torres',
      album: 'Air EP'
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    linkDestination: 'lastfm',
    nowSeconds: 1000
  })

  assert.equal(activity?.details_url, 'https://www.last.fm/music/Dzeko%20%26%20Torres%2C%20Delaney/_/Air')
  assert.equal(activity?.state_url, 'https://www.last.fm/music/Dzeko%20%26%20Torres%2C%20Delaney')
  assert.equal(activity?.assets?.large_url, 'https://www.last.fm/music/Dzeko%20%26%20Torres/Air%20EP')
})

test('omits link fields when the destination is off or metadata is missing', () => {
  const offActivity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: { title: 'Air', artist: 'Dzeko & Torres' }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    linkDestination: 'off',
    nowSeconds: 1000
  })
  assert.equal(offActivity?.details_url, undefined)
  assert.equal(offActivity?.state_url, undefined)
  assert.equal(offActivity?.assets?.large_url, undefined)

  // Last.fm track pages need an artist; no artist means no links at all.
  const noArtistActivity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: { title: 'Air' }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    linkDestination: 'lastfm',
    nowSeconds: 1000
  })
  assert.equal(noArtistActivity?.details_url, undefined)
  assert.equal(noArtistActivity?.state_url, undefined)
})

test('drops links that exceed the Discord URL length limit', () => {
  const longTitle = 'A'.repeat(300)
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: { title: longTitle, artist: 'Ado' }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    linkDestination: 'ytmusic',
    nowSeconds: 1000
  })
  assert.equal(activity?.details_url, undefined)
  assert.equal(activity?.state_url, 'https://music.youtube.com/search?q=Ado')
})

test('keeps paused tracks as listening activity without moving timestamps', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'paused',
    currentTimeSeconds: 61,
    durationSeconds: 180,
    track: {
      title: '0',
      artist: 'Ado',
      format: 'flac',
      sampleRate: 48000,
      bitDepth: 24
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    nowSeconds: 1000
  })

  assert.equal(activity?.type, 2)
  assert.equal(activity?.details, '0\u200B')
  assert.equal(activity?.state, 'Paused • Ado')
  assert.equal(activity?.status_display_type, 2)
  assert.equal(activity?.timestamps, undefined)
  assert.deepEqual(activity?.assets, {
    large_image: 'https://example.com/cover.jpg',
    large_text: 'FLAC • 24-bit • 48kHz'
  })
})

test('keeps loading tracks as listening activity without timestamps', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'loading',
    track: {
      title: '0',
      artist: 'Ado'
    }
  })

  assert.equal(activity?.type, 2)
  assert.equal(activity?.details, '0\u200B')
  assert.equal(activity?.state, 'Loading • Ado')
  assert.equal(activity?.timestamps, undefined)
})

test('keeps quality metadata out of the activity state line', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: 'Song',
      artist: 'Artist',
      codec: 'flac',
      sampleRate: 96000,
      bitDepth: 24
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    nowSeconds: 1000
  })

  assert.equal(activity?.state, 'Artist')
  assert.equal(activity?.assets?.large_text, 'FLAC • 24-bit • 96kHz')
})

test('can use the artist as the compact status field', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: 'Charles',
      artist: 'Ado'
    }
  }, {
    compactStatusMode: 'artist'
  })

  assert.equal(activity?.details, 'Charles')
  assert.equal(activity?.state, 'Ado')
  assert.equal(activity?.status_display_type, 1)
})

test('falls back to song title compact status when artist is missing', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: 'Charles'
    }
  }, {
    compactStatusMode: 'artist'
  })

  assert.equal(activity?.details, 'Charles')
  assert.equal(activity?.state, undefined)
  assert.equal(activity?.status_display_type, 2)
})

test('can use album as the profile info line', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: 'Charles',
      artist: 'Ado',
      album: 'Fall Apart',
      codec: 'flac',
      sampleRate: 44100,
      bitDepth: 16
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    expandedInfoMode: 'album'
  })

  assert.equal(activity?.assets?.large_text, 'Fall Apart')
})

test('omits the profile info line in album mode when album is blank', () => {
  const activity = buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: 'Charles',
      artist: 'Ado',
      album: '   ',
      codec: 'flac',
      sampleRate: 44100,
      bitDepth: 16
    }
  }, {
    largeImageUrl: 'https://example.com/cover.jpg',
    expandedInfoMode: 'album'
  })

  assert.deepEqual(activity?.assets, {
    large_image: 'https://example.com/cover.jpg'
  })
})

test('clears presence for stopped playback and blank titles', () => {
  assert.equal(buildDiscordActivityFromPresence({
    playbackState: 'stopped',
    track: {
      title: 'Song'
    }
  }), null)

  assert.equal(buildDiscordActivityFromPresence({
    playbackState: 'playing',
    track: {
      title: '   '
    }
  }), null)
})
