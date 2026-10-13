import assert from 'node:assert/strict'
import test from 'node:test'
import { RemotePlaylists, planRemotePlaylistEdit, type RemotePlaylistClient } from './remotePlaylists.ts'
import type { RemotePlaylistLocal, RemotePlaylistSnapshot } from '../../types/remotePlaylists.ts'

const ref = { provider: 'subsonic' as const, sourceId: 1 }
const path = (id: string) => `subsonic://1/track/${id}`
const clone = <T>(value: T): T => structuredClone(value)
function fixture() {
  let enabled = false, fingerprint: string | null = 'one'
  let local: RemotePlaylistLocal | null = { id: 'mix', localId: 1, ref, name: 'Mix', writable: true,
    tracks: ['a', 'b', 'a'].map((id, index) => ({ path: path(id), entryId: index + 1 })) }
  let remote: RemotePlaylistSnapshot | null = clone(local)
  let reads = 0, writes = 0, nextEntry = 10
  const client: RemotePlaylistClient = {
    list: async () => { reads++; return remote ? [clone(remote)] : [] },
    read: async () => { reads++; return clone(remote) },
    write: async (_before, after) => { writes++; remote = clone(after) }
  }
  const service = new RemotePlaylists({ sources: () => [ref], fingerprint: () => fingerprint,
    enabled: () => enabled, setEnabled: async (_ref, value) => { enabled = value },
    local: () => clone(local), client: async () => client, changed: () => {},
    apply: async (_ref, snapshots, prune) => {
      if (snapshots.length) local = { ...clone(snapshots[0]), localId: 1, ref,
        tracks: snapshots[0].tracks.map(t => ({ ...t, entryId: t.entryId ?? nextEntry++ })) }
      else if (prune) local = null
    },
    remove: async () => { local = null }
  })
  return { service, client, local: () => clone(local), remote: () => clone(remote), reads: () => reads, writes: () => writes,
    change: (update: (value: RemotePlaylistSnapshot) => void) => update(remote!), fingerprint: (value: string | null) => { fingerprint = value } }
}

test('playlist sync defaults off; enable imports and disable never deletes server playlists', async () => {
  const f = fixture()
  await f.service.refresh(ref)
  assert.equal(f.reads(), 0)
  await assert.rejects(f.service.edit(1, { kind: 'rename', name: 'No' }), /sync is off/)
  assert.equal(f.writes(), 0)
  await f.service.setEnabled(ref, true)
  assert.equal(f.reads(), 1)
  await f.service.setEnabled(ref, false)
  await f.service.refresh(ref)
  assert.equal(f.reads(), 1)
  assert.equal(f.remote()!.name, 'Mix')
  assert.equal(f.local()!.name, 'Mix')
})

test('rename, insert, reorder, individual duplicate removal and delete write through and verify', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  await f.service.edit(1, { kind: 'rename', name: 'New mix' })
  assert.equal(f.remote()!.name, 'New mix'); assert.equal(f.local()!.name, 'New mix')
  await f.service.edit(1, { kind: 'insert', paths: [path('c'), path('b')], position: 1 })
  assert.deepEqual(f.remote()!.tracks.map(t => t.path), ['a', 'c', 'b', 'a'].map(path))
  const ids = f.local()!.tracks.map(t => t.entryId!)
  await f.service.edit(1, { kind: 'remove', entryId: ids[3] })
  assert.deepEqual(f.remote()!.tracks.map(t => t.path), ['a', 'c', 'b'].map(path))
  assert.equal(f.local()!.tracks[0].entryId, ids[0])
  await f.service.edit(1, { kind: 'reorder', entryIds: [ids[2], ids[0], ids[1]] })
  assert.deepEqual(f.remote()!.tracks.map(t => t.path), ['b', 'a', 'c'].map(path))
  await f.service.edit(1, { kind: 'move', entryIds: [ids[1]], position: 0 })
  assert.deepEqual(f.remote()!.tracks.map(t => t.path), ['c', 'b', 'a'].map(path))
  await f.service.edit(1, { kind: 'delete' })
  assert.equal(f.remote(), null); assert.equal(f.local(), null)
})

test('external changes refresh the mirror and reject a stale edit without overwriting the server', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  f.change(remote => { remote.tracks.push({ path: path('d') }) })
  await assert.rejects(f.service.edit(1, { kind: 'rename', name: 'Stale' }), /changed on the server/)
  assert.equal(f.writes(), 0)
  assert.equal(f.local()!.tracks.length, 4)
  await f.service.edit(1, { kind: 'rename', name: 'Fresh' })
  assert.equal(f.remote()!.name, 'Fresh')
})

test('swapping identical songs preserves occurrence identity without a redundant server write', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  const ids = f.local()!.tracks.map(track => track.entryId!)
  const reorderedIds = [ids[2], ids[1], ids[0]]
  const first = f.service.edit(1, { kind: 'reorder', entryIds: reorderedIds })
  const stale = f.service.edit(1, { kind: 'remove', entryId: ids[0] })
  await first
  await assert.rejects(stale, /changed/)
  assert.equal(f.writes(), 0)
  assert.deepEqual(f.local()!.tracks.map(track => track.entryId), reorderedIds)
  await f.service.edit(1, { kind: 'remove', entryId: ids[0] })
  assert.deepEqual(f.remote()!.tracks.map(track => track.path), ['a', 'b'].map(path))
  assert.deepEqual(f.local()!.tracks.map(track => track.entryId), reorderedIds.slice(0, 2))
})

test('permission changes and offline failures do not produce an editable local fork', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  f.change(remote => { remote.writable = false })
  await assert.rejects(f.service.edit(1, { kind: 'rename', name: 'Denied' }), /read-only/)
  assert.equal(f.local()!.writable, false); assert.equal(f.writes(), 0)
  const offline = fixture()
  await offline.service.setEnabled(ref, true)
  offline.client.read = async () => { throw new Error('offline') }
  await assert.rejects(offline.service.edit(1, { kind: 'rename', name: 'Lost' }), /offline/)
  assert.equal(offline.local()!.name, 'Mix'); assert.equal(offline.writes(), 0)
})

test('playlist deletion permission is independent of editing and is checked again before writing', async () => {
  const f = fixture()
  f.change(remote => { remote.deletable = false })
  await f.service.setEnabled(ref, true)
  assert.throws(() => f.service.edit(1, { kind: 'delete' }), /permission/)
  await f.service.edit(1, { kind: 'rename', name: 'Can edit' })
  assert.equal(f.writes(), 1)
  f.change(remote => { remote.writable = false; remote.deletable = true })
  await f.service.refresh(ref)
  f.change(remote => { remote.deletable = false })
  await assert.rejects(f.service.edit(1, { kind: 'delete' }), /permission/)
  assert.equal(f.writes(), 1)
  f.change(remote => { remote.deletable = true })
  await f.service.refresh(ref)
  await f.service.edit(1, { kind: 'delete' })
  assert.equal(f.remote(), null)
})

test('ignored writes are not acknowledged, and ambiguous writes are never retried', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  let attempts = 0
  f.client.write = async () => { attempts++ }
  await assert.rejects(f.service.edit(1, { kind: 'delete' }), /did not delete/)
  assert.equal(f.local()!.name, 'Mix')
  f.client.write = async () => { attempts++; throw new Error('connection lost after request') }
  await assert.rejects(f.service.edit(1, { kind: 'rename', name: 'Lost' }), /connection lost/)
  assert.equal(attempts, 2)
  assert.equal(f.local()!.name, 'Mix')
})

test('disabling or changing credentials during a refresh blocks its stale result', async () => {
  for (const mode of ['disable', 'account']) {
    const f = fixture()
    await f.service.setEnabled(ref, true)
    let release!: () => void, began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    f.client.list = async () => { began(); await new Promise<void>(resolve => { release = resolve }); return [{ ...f.remote()!, name: 'Late' }] }
    const pending = f.service.refresh(ref)
    await started
    if (mode === 'disable') await f.service.setEnabled(ref, false)
    else f.fingerprint('another account')
    release()
    await assert.rejects(pending)
    assert.equal(f.local()!.name, 'Mix')
  }
})

test('queued edits use the content the user saw; invalid occurrence ids cannot mutate a playlist', async () => {
  const f = fixture()
  await f.service.setEnabled(ref, true)
  const first = f.service.edit(1, { kind: 'rename', name: 'First' })
  const second = f.service.edit(1, { kind: 'rename', name: 'Second' })
  await first
  await assert.rejects(second, /changed/)
  assert.equal(f.remote()!.name, 'First'); assert.equal(f.writes(), 1)
  for (const entryIds of [[999], [1, 1, 3], [1]]) assert.throws(() => planRemotePlaylistEdit(f.local()!, { kind: 'reorder', entryIds }), /changed/)
})
