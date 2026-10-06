import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderStateSync, type ProviderStateClient } from './providerStateSync.ts'
import { resolveProviderChoice } from '../../shared/sync/providerState.ts'
import type { ProviderSyncRef, ProviderSyncTrack, ProviderSyncField, ProviderSyncValue, ProviderUserState } from '../../types/providerSync.ts'

const ref: ProviderSyncRef = { provider: 'subsonic', sourceId: 1 }
const path = 'subsonic://1/track/a'
const copy = <T>(value: T): T => structuredClone(value)
function fixture() {
  let fingerprint: string | null = 'account-1'
  let setting: { fingerprint: string; enabled: number } | null = null
  const tracks: ProviderSyncTrack[] = [{ id: 'a', path, title: 'Song', artist: 'Artist', favorite: false, rating: null }]
  const remote = new Map<string, ProviderUserState>([['a', { favorite: false, rating: null }]])
  const baseline = new Map<string, ProviderSyncValue>()
  const writes: { id: string; field: ProviderSyncField; value: ProviderSyncValue }[] = []
  let reads = 0
  const client: ProviderStateClient = {
    read: async ids => { reads++; return new Map([...remote].filter(([id]) => !ids || ids.includes(id)).map(([id, value]) => [id, copy(value)])) },
    write: async (id, field, value) => {
      writes.push({ id, field, value })
      const state = remote.get(id)!
      if (field === 'favorite') state.favorite = value as boolean
      else state.rating = value as number | null
    }
  }
  const service = new ProviderStateSync({
    sources: () => [ref], fingerprint: () => fingerprint, setting: () => setting,
    setSetting: async (_ref, fp, enabled) => {
      if (!enabled || setting?.fingerprint !== fp) baseline.clear()
      setting = { fingerprint: fp, enabled: Number(enabled) }
    },
    tracks: () => copy(tracks), track: (_ref, path) => copy(tracks.find(t => t.path === path)),
    baselines: () => new Map(baseline), saveBaseline: (_ref, path, field, value) => baseline.set(JSON.stringify([path, field]), value),
    applyLocal: async (path, field, value) => {
      const track = tracks.find(t => t.path === path)!
      if (field === 'favorite') track.favorite = value as boolean
      else track.rating = value as number | null
    },
    persist: async () => {}, changed: () => {}, client: async () => client
  })
  const enable = async () => {
    const review = await service.review(ref)
    await service.apply(review.token, Object.fromEntries(review.differences.map(row => [row.key, 'server'])))
  }
  return { service, client, tracks, remote, baseline, writes, enable, reads: () => reads,
    fingerprint: (value: string | null) => { fingerprint = value } }
}

test('default off makes no background requests; preview never changes values or enables a server', async () => {
  const f = fixture()
  await f.service.refresh(ref)
  assert.equal(f.reads(), 0)
  f.tracks[0].rating = 4.5
  f.remote.get('a')!.favorite = true
  const review = await f.service.review(ref)
  assert.equal(review.differences.length, 2)
  assert.equal(f.tracks[0].favorite, false)
  assert.equal(f.tracks[0].rating, 4.5)
  assert.equal(f.service.enabled(ref), false)
  assert.deepEqual(f.writes, [])
  await assert.rejects(f.service.apply(review.token, Object.fromEntries(review.differences.map(r => [r.key, 'local']))), /whole stars/)
  assert.deepEqual(f.writes, []) // Every choice was validated before the first write.
})

test('bulk-compatible whole-star choices preserve 0.5 until explicit confirmation and clearing is distinct', async () => {
  const f = fixture()
  f.tracks[0].rating = 0.5
  const review = await f.service.review(ref)
  assert.equal(resolveProviderChoice(review.differences[0], 'down'), 1)
  assert.equal(resolveProviderChoice(review.differences[0], 'clear'), null)
  await f.service.apply(review.token, { [review.differences[0].key]: 'up' })
  assert.equal(f.service.enabled(ref), true)
  assert.equal(f.tracks[0].rating, 1)
  assert.equal(f.remote.get('a')!.rating, 1)
  assert.equal(f.baseline.get(JSON.stringify([path, 'rating'])), 1)
})

test('an empty comparison enables without changing favorites or ratings; missing tracks stay untouched', async () => {
  const f = fixture()
  const missingPath = 'subsonic://1/track/missing'
  f.tracks.push({ ...f.tracks[0], id: 'missing', path: missingPath, favorite: true, rating: 4.5 })
  const before = copy(f.tracks)
  const review = await f.service.review(ref)
  assert.equal(review.differences.length, 0)
  assert.equal(review.missingTracks, 1)
  await f.service.apply(review.token, {})
  assert.equal(f.service.enabled(ref), true)
  assert.deepEqual(f.tracks, before)
  assert.deepEqual(f.writes, [])
  assert.equal(f.baseline.size, 2)
  assert.equal(f.baseline.has(JSON.stringify([missingPath, 'rating'])), false)
})

test('an empty comparison cannot bypass differences that appear before enablement', async () => {
  for (const change of ['local', 'server', 'missing']) {
    const f = fixture()
    const review = await f.service.review(ref)
    assert.equal(review.differences.length, 0)
    if (change === 'local') f.tracks[0].rating = 4.5
    else if (change === 'server') f.remote.get('a')!.rating = 3
    else f.remote.delete('a')
    const before = copy(f.tracks)
    await assert.rejects(f.service.apply(review.token, {}), /Values changed|No matching tracks/)
    assert.equal(f.service.enabled(ref), false)
    assert.deepEqual(f.tracks, before)
    assert.deepEqual(f.writes, [])
    assert.equal(f.baseline.size, 0)
  }
})

test('stale previews reject local/server changes before any write and are single use', async () => {
  for (const change of ['local', 'server']) {
    const f = fixture()
    f.remote.get('a')!.rating = 3
    const review = await f.service.review(ref)
    if (change === 'local') f.tracks[0].rating = 4
    else f.remote.get('a')!.rating = 5
    await assert.rejects(f.service.apply(review.token, { [review.differences[0].key]: 'server' }), /Values changed/)
    assert.equal(f.service.enabled(ref), false)
    assert.equal(f.writes.length, 0)
    await assert.rejects(f.service.apply(review.token, {}), /expired/)
  }
})

test('automatic incoming changes include unfavorites and clears; conflicts hold only their field', async () => {
  const f = fixture()
  f.remote.set('a', { favorite: true, rating: 3 })
  await f.enable()
  f.remote.set('a', { favorite: false, rating: null })
  await f.service.refresh(ref)
  assert.equal(f.tracks[0].favorite, false)
  assert.equal(f.tracks[0].rating, null)
  f.tracks[0].rating = 4
  f.remote.set('a', { favorite: true, rating: 2 })
  await f.service.refresh(ref)
  assert.equal(f.tracks[0].favorite, true)
  assert.equal(f.tracks[0].rating, 4)
  assert.equal(f.remote.get('a')!.rating, 2)
  assert.equal(f.service.status()[0].conflicts, 1)
  assert.equal(f.writes.length, 0)
})

test('ordinary online edits write and verify; offline failure changes neither local values nor a durable queue', async () => {
  const f = fixture()
  await f.enable()
  await f.service.edit(ref, path, 'favorite', true)
  assert.equal(f.remote.get('a')!.favorite, true)
  assert.equal(f.tracks[0].favorite, true)
  f.client.read = async () => { throw new Error('offline') }
  await assert.rejects(f.service.edit(ref, path, 'rating', 4), /offline/)
  assert.equal(f.tracks[0].rating, null)
  assert.equal(f.writes.length, 1)
})

test('an online edit colliding with another client preserves both values for review', async () => {
  const f = fixture()
  await f.enable()
  f.remote.get('a')!.rating = 2
  await f.service.edit(ref, path, 'rating', 4)
  assert.equal(f.tracks[0].rating, 4)
  assert.equal(f.remote.get('a')!.rating, 2)
  assert.equal(f.writes.length, 0)
  const review = await f.service.review(ref)
  await f.service.apply(review.token, { [review.differences[0].key]: 'local' })
  assert.equal(f.remote.get('a')!.rating, 4)
})

test('one-sided local changes sync on refresh, but a concurrent server edit is preserved for review', async () => {
  const f = fixture()
  await f.enable()
  f.tracks[0].favorite = true
  await f.service.refresh(ref)
  assert.equal(f.remote.get('a')!.favorite, true)
  assert.equal(f.baseline.get(JSON.stringify([path, 'favorite'])), true)
  f.tracks[0].rating = 4
  const read = f.client.read
  f.client.read = async ids => {
    if (ids) f.remote.get('a')!.rating = 2
    return read(ids)
  }
  await f.service.refresh(ref)
  assert.equal(f.tracks[0].rating, 4)
  assert.equal(f.remote.get('a')!.rating, 2)
  assert.equal(f.service.status()[0].conflicts, 1)
  assert.equal(f.writes.length, 1)
})

test('outgoing refresh does not overwrite local changes during verification or accept ignored writes', async () => {
  for (const change of ['local', 'ignored']) {
    const f = fixture()
    await f.enable()
    f.tracks[0].rating = 4
    const write = f.client.write
    f.client.write = async (...args) => {
      if (change === 'ignored') return
      await write(...args)
      f.tracks[0].rating = 5
    }
    if (change === 'ignored') await assert.rejects(f.service.refresh(ref), /did not retain/)
    else await f.service.refresh(ref)
    assert.equal(f.tracks[0].rating, change === 'local' ? 5 : 4)
    assert.equal(f.baseline.get(JSON.stringify([path, 'rating'])), null)
  }
})

test('a local mutation during the server read is preserved, including when the server has a conflicting edit', async () => {
  for (const serverRating of [null, 2]) {
    const f = fixture()
    await f.enable()
    f.remote.get('a')!.rating = serverRating
    const read = f.client.read
    f.client.read = async ids => {
      const result = await read(ids)
      f.tracks[0].rating = 5
      return result
    }
    await assert.rejects(f.service.edit(ref, path, 'rating', 4), /Astra values changed/)
    assert.equal(f.tracks[0].rating, 5)
    assert.equal(f.remote.get('a')!.rating, serverRating)
    assert.equal(f.writes.length, 0)
  }
})

test('ignored server writes do not change Astra; local changes during write verification survive', async () => {
  const f = fixture()
  await f.enable()
  const write = f.client.write
  f.client.write = async () => {}
  await assert.rejects(f.service.edit(ref, path, 'rating', 4), /did not retain/)
  assert.equal(f.tracks[0].rating, null)
  assert.equal(f.baseline.get(JSON.stringify([path, 'rating'])), null)
  f.client.write = async (...args) => {
    await write(...args)
    f.tracks[0].rating = 5
  }
  await assert.rejects(f.service.edit(ref, path, 'rating', 4), /Astra values changed/)
  assert.equal(f.tracks[0].rating, 5)
  assert.equal(f.remote.get('a')!.rating, 4)
  assert.equal(f.baseline.get(JSON.stringify([path, 'rating'])), null)
})

test('turning off during a slow read blocks incoming changes and preserves local state', async () => {
  const f = fixture()
  await f.enable()
  let release!: () => void
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  f.client.read = async () => { began(); await new Promise<void>(resolve => { release = resolve }); return new Map([['a', { favorite: true, rating: 5 }]]) }
  const refresh = f.service.refresh(ref)
  await started
  await f.service.disable(ref)
  release()
  await assert.rejects(refresh)
  assert.equal(f.service.enabled(ref), false)
  assert.equal(f.tracks[0].favorite, false)
  assert.equal(f.tracks[0].rating, null)
  assert.equal(f.baseline.size, 0)
})

test('account changes invalidate enabled state and reviews; missing server tracks are never treated as cleared values', async () => {
  const f = fixture()
  await f.enable()
  f.tracks[0].favorite = true
  f.remote.delete('a')
  await f.service.refresh(ref)
  assert.equal(f.tracks[0].favorite, true)
  await assert.rejects(f.service.review(ref), /No matching tracks/)
  f.remote.set('a', { favorite: true, rating: null })
  const review = await f.service.review(ref)
  f.fingerprint('different-account')
  assert.equal(f.service.enabled(ref), false)
  await assert.rejects(f.service.apply(review.token, {}), /settings changed/)
})

test('disable/re-enable compares current values again; no edits replay on a background refresh while off', async () => {
  const f = fixture()
  await f.enable()
  await f.service.disable(ref)
  f.tracks[0].favorite = true
  f.remote.get('a')!.rating = 4
  const reads = f.reads()
  await f.service.refresh(ref)
  assert.equal(f.reads(), reads)
  const review = await f.service.review(ref)
  assert.equal(review.enabling, true)
  assert.equal(review.differences.length, 2)
  assert.equal(f.writes.length, 0)
})
