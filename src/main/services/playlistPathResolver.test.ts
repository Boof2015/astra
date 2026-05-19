import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'
import {
  normalizePlaylistPathForLookup,
  resolveImportedPlaylistEntryPaths
} from './playlistPathResolver.ts'

test('playlist path resolver decodes VLC Windows file URI variants', () => {
  const importFilePath = 'C:\\Users\\Alice\\Music\\Playlists\\vlc.m3u'
  const expected = 'C:\\Users\\Alice\\Music\\\u25b6 Music\\01 Tia Na S\u00e9.m4a'
  const uriVariants = [
    'file:///C:/Users/Alice/Music/%E2%96%B6%20Music/01%20Tia%20Na%20S%C3%A9.m4a',
    'file:/C:/Users/Alice/Music/%E2%96%B6%20Music/01%20Tia%20Na%20S%C3%A9.m4a',
    'file://localhost/C:/Users/Alice/Music/%E2%96%B6%20Music/01%20Tia%20Na%20S%C3%A9.m4a'
  ]

  for (const uri of uriVariants) {
    const resolved = resolveImportedPlaylistEntryPaths(uri, importFilePath, { platform: 'win32' })
    assert.deepEqual(resolved?.map((entry) => entry.normalizedPath), [expected])
    assert.equal(resolved?.[0].caseInsensitivePath, expected.toLocaleLowerCase())
  }
})

test('playlist path resolver keeps ampersands in VLC file URI paths', () => {
  const importFilePath = 'C:\\Users\\Alice\\Music\\Playlists\\vlc.m3u'
  const expected = 'C:\\Users\\Alice\\Music\\\u25b6 Music\\03 Venez on va danser (feat. Didi B & Terely).m4a'
  const resolved = resolveImportedPlaylistEntryPaths(
    'file:///C:/Users/Alice/Music/%E2%96%B6%20Music/03%20Venez%20on%20va%20danser%20(feat.%20Didi%20B%20&%20Terely).m4a',
    importFilePath,
    { platform: 'win32' }
  )

  assert.deepEqual(resolved?.map((entry) => entry.normalizedPath), [expected])
})

test('playlist path resolver keeps Windows file URI candidates available on POSIX', () => {
  const resolved = resolveImportedPlaylistEntryPaths(
    'file:///C:/Users/Alice/Music/%E2%96%B6%20Music/01%20Tia%20Na%20S%C3%A9.m4a',
    '/tmp/vlc.m3u',
    { platform: 'posix' }
  )

  assert.deepEqual(resolved?.map((entry) => entry.normalizedPath), [
    '/C:/Users/Alice/Music/\u25b6 Music/01 Tia Na S\u00e9.m4a',
    'C:/Users/Alice/Music/\u25b6 Music/01 Tia Na S\u00e9.m4a'
  ])
})

test('playlist path resolver preserves encoded local path fallback behavior', () => {
  const resolved = resolveImportedPlaylistEntryPaths(
    '..\\Music\\Encoded%20Name.wav',
    'C:\\Users\\Alice\\Playlists\\encoded.m3u',
    { platform: 'win32' }
  )

  assert.deepEqual(resolved?.map((entry) => entry.normalizedPath), [
    win32.normalize('C:\\Users\\Alice\\Music\\Encoded%20Name.wav'),
    win32.normalize('C:\\Users\\Alice\\Music\\Encoded Name.wav')
  ])
})

test('playlist path resolver rejects unsupported non-file URI schemes', () => {
  assert.equal(
    resolveImportedPlaylistEntryPaths('spotify:track:123', 'C:\\Users\\Alice\\Playlists\\vlc.m3u', { platform: 'win32' }),
    null
  )
})

test('playlist path lookup normalization can simulate Windows paths', () => {
  assert.equal(
    normalizePlaylistPathForLookup('C:/Users/Alice/Music/../Music/Track.m4a', { platform: 'win32' }),
    win32.normalize('C:\\Users\\Alice\\Music\\Track.m4a')
  )
})
