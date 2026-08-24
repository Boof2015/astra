import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFolderTree,
  getRelativeDescendantFsPath,
  isSameOrDescendantFsPath
} from './folderTree'

interface TestTrack {
  id: string
  path: string
}

function track(id: string, path: string): TestTrack {
  return { id, path }
}

test('buildFolderTree includes tracks beneath a POSIX filesystem root', () => {
  const tree = buildFolderTree(
    [{ path: '/' }],
    [
      track('direct', '/loose.flac'),
      track('nested', '/Music/Artist/song.flac')
    ],
    'linux'
  )

  assert.equal(tree.length, 1)
  assert.equal(tree[0].fullPath, '/')
  assert.equal(tree[0].totalTrackCount, 2)
  assert.deepEqual(tree[0].tracks.map((item) => item.id), ['direct'])
  assert.equal(tree[0].children.get('Music')?.children.get('Artist')?.tracks[0]?.id, 'nested')
})

test('buildFolderTree includes tracks beneath a Windows drive root', () => {
  const tree = buildFolderTree(
    [{ path: 'D:\\' }],
    [track('song', 'd:\\Music\\Artist\\song.flac')],
    'win32'
  )

  assert.equal(tree.length, 1)
  assert.equal(tree[0].fullPath, 'D:\\')
  assert.equal(tree[0].children.get('Music')?.fullPath, 'D:\\Music')
  assert.equal(tree[0].children.get('Music')?.children.get('Artist')?.tracks[0]?.id, 'song')
})

test('folder matching handles UNC roots, trailing separators, and mixed separators', () => {
  const uncRoot = '\\\\NAS\\Music\\'
  const uncTrack = '\\\\nas\\music\\Artist\\song.flac'

  assert.equal(getRelativeDescendantFsPath(uncTrack, uncRoot, 'win32'), 'Artist/song.flac')

  const tree = buildFolderTree(
    [{ path: 'C:\\Music\\' }],
    [track('song', 'c:/music/Artist/song.flac')],
    'win32'
  )

  assert.equal(tree.length, 1)
  assert.equal(tree[0].children.get('Artist')?.fullPath, 'C:\\Music\\Artist')
  assert.equal(tree[0].children.get('Artist')?.tracks[0]?.id, 'song')
})

test('folder matching follows platform case and Unicode behavior', () => {
  assert.equal(isSameOrDescendantFsPath('/Music/song.flac', '/music', 'win32'), true)
  assert.equal(isSameOrDescendantFsPath('/Music/song.flac', '/music', 'darwin'), true)
  assert.equal(isSameOrDescendantFsPath('/Music/song.flac', '/music', 'linux'), false)
  assert.equal(
    isSameOrDescendantFsPath('/Volumes/Mu\u0301sica/song.flac', '/volumes/Música', 'darwin'),
    true
  )
})

test('folder matching enforces path-segment boundaries', () => {
  assert.equal(isSameOrDescendantFsPath('/music/song.flac', '/music', 'linux'), true)
  assert.equal(isSameOrDescendantFsPath('/musicology/song.flac', '/music', 'linux'), false)
  assert.equal(isSameOrDescendantFsPath('/music', '/music', 'linux'), true)
})

test('buildFolderTree assigns tracks to the longest matching root', () => {
  const tree = buildFolderTree(
    [{ path: '/music' }, { path: '/music/Artist' }],
    [
      track('root-track', '/music/root.flac'),
      track('specific-track', '/music/Artist/song.flac')
    ],
    'linux'
  )

  assert.equal(tree.length, 2)
  assert.deepEqual(tree[0].tracks.map((item) => item.id), ['root-track'])
  assert.deepEqual(tree[1].tracks.map((item) => item.id), ['specific-track'])
  assert.equal(tree[0].totalTrackCount, 1)
  assert.equal(tree[1].totalTrackCount, 1)
})

test('buildFolderTree preserves empty-tree behavior when no tracks match', () => {
  assert.deepEqual(buildFolderTree([{ path: '/music' }], [], 'linux'), [])
  assert.deepEqual(
    buildFolderTree([{ path: '/music' }], [track('outside', '/other/song.flac')], 'linux'),
    []
  )
})

test('root and trailing-separator mappings work for hidden-folder filtering', () => {
  assert.equal(isSameOrDescendantFsPath('/Music/song.flac', '/', 'linux'), true)
  assert.equal(isSameOrDescendantFsPath('/mnt/music/song.flac', '/mnt/music/', 'linux'), true)
  assert.equal(isSameOrDescendantFsPath('D:\\Music\\song.flac', 'd:\\', 'win32'), true)
})
