import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteSourceCounts } from '../../types/subsonic.ts'
import { serverCounts, useServerCountsStore } from './serverCountsStore.ts'

/** Each counts() call waits until the test answers it, by position. */
function stubCounts() {
  const pending: { resolve(rows: RemoteSourceCounts[]): void; reject(error: Error): void }[] = []
  ;(globalThis as any).window = { electronAPI: { servers: { counts: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }) } } }
  return pending
}
const rows = (tracks: number): RemoteSourceCounts[] => [{ provider: 'subsonic', sourceId: 1, tracks, albums: 1, serverAlbums: 1 }]

test('server counts are keyed by server, read as zero once loaded, and stay stable for selectors', async () => {
  useServerCountsStore.setState({ counts: {}, loaded: false })
  const pending = stubCounts()
  assert.equal(serverCounts(useServerCountsStore.getState(), 'subsonic:1'), null, 'not read yet')
  const refresh = useServerCountsStore.getState().refresh()
  pending[0].resolve([{ provider: 'subsonic', sourceId: 1, tracks: 8412, albums: 1204, serverAlbums: 1204 }, { provider: 'plex', sourceId: 3, tracks: 20, albums: null, serverAlbums: null }])
  await refresh
  const state = useServerCountsStore.getState()
  assert.deepEqual(serverCounts(state, 'subsonic:1'), { tracks: 8412, albums: 1204, serverAlbums: 1204 })
  assert.deepEqual(serverCounts(state, 'plex:3'), { tracks: 20, albums: null, serverAlbums: null })
  assert.deepEqual(serverCounts(state, 'jellyfin:2'), { tracks: 0, albums: 0, serverAlbums: 0 }, 'no tracks in the library')
  // A selector must return the same value for the same state, or React re-renders forever.
  assert.equal(serverCounts(state, 'jellyfin:2'), serverCounts(state, 'jellyfin:2'))
  assert.equal(serverCounts(state, 'subsonic:1'), serverCounts(state, 'subsonic:1'))
})

test('a slow older read never replaces a newer one, and a failed read keeps what was there', async () => {
  useServerCountsStore.setState({ counts: {}, loaded: false })
  const pending = stubCounts()
  const older = useServerCountsStore.getState().refresh()
  const newer = useServerCountsStore.getState().refresh()
  pending[1].resolve(rows(5))
  await newer
  pending[0].resolve(rows(1))
  await older
  assert.equal(serverCounts(useServerCountsStore.getState(), 'subsonic:1')?.tracks, 5)

  const failing = useServerCountsStore.getState().refresh()
  pending[2].reject(new Error('IPC failed'))
  await failing
  assert.equal(serverCounts(useServerCountsStore.getState(), 'subsonic:1')?.tracks, 5)
})

test('each read resolves with its own result, even one a newer read replaced; a failed read with null', async () => {
  useServerCountsStore.setState({ counts: {}, loaded: false })
  const pending = stubCounts()
  // The caller's read comes back first, while a newer one is still out: the store doesn't
  // take it, but the caller still gets what it read.
  const mine = useServerCountsStore.getState().refresh()
  const newer = useServerCountsStore.getState().refresh()
  pending[0].resolve(rows(640))
  assert.deepEqual(await mine, { 'subsonic:1': { tracks: 640, albums: 1, serverAlbums: 1 } })
  assert.equal(useServerCountsStore.getState().loaded, false, 'the store waits for the newest read')
  pending[1].resolve(rows(640))
  await newer
  assert.equal(serverCounts(useServerCountsStore.getState(), 'subsonic:1')?.tracks, 640)

  const failing = useServerCountsStore.getState().refresh()
  pending[2].reject(new Error('IPC failed'))
  assert.equal(await failing, null)
})
