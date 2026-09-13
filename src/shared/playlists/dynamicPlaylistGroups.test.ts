import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeDynamicPlaylistRules, serializeDynamicPlaylistRules, createDefaultDynamicPlaylistRules,
  type DynamicPlaylistGroup, type DynamicPlaylistCondition
} from './dynamicPlaylist.ts'
import { dynamicPlaylistNodeId, editDynamicPlaylistNode } from './dynamicPlaylistDraft.ts'
import { dynamicPlaylistSyncNeedsUpdate } from './dynamicPlaylistSync.ts'

const artist: DynamicPlaylistCondition = { kind: 'text', field: 'artist', operator: 'is', value: 'Artist A' }
const favorite: DynamicPlaylistCondition = { kind: 'exact', field: 'favorite', operator: 'is', value: true }
const group = (children: DynamicPlaylistGroup['children'], match: DynamicPlaylistGroup['match'] = 'all'): DynamicPlaylistGroup => ({ kind: 'group', match, children })
const rules = (filter: DynamicPlaylistGroup) => ({ ...createDefaultDynamicPlaylistRules(), filter })

test('legacy AND rules normalize to an ALL group and keep legacy storage', () => {
  const legacy = { version: 1 as const, conditions: [artist, favorite], sort: { field: 'title' as const, direction: 'asc' as const }, limit: 12 }
  const normalized = normalizeDynamicPlaylistRules(legacy)
  assert.deepEqual(normalized.filter, group([artist, favorite]))
  assert.deepEqual(JSON.parse(serializeDynamicPlaylistRules(normalized)), legacy)
  assert.deepEqual(normalizeDynamicPlaylistRules(JSON.parse(serializeDynamicPlaylistRules(normalized))), normalized)
})

test('nested groups and root ANY retain grouping through serialization', () => {
  for (const filter of [group([favorite, group([artist, { ...artist, value: 'Artist B' }], 'any')]), group([favorite, artist], 'any')]) {
    const value = rules(filter)
    assert.equal(JSON.parse(serializeDynamicPlaylistRules(value)).version, 2)
    assert.deepEqual(normalizeDynamicPlaylistRules(JSON.parse(serializeDynamicPlaylistRules(value))), value)
  }
})

test('invalid group structure and leaves are never ignored', () => {
  for (const filter of [null, [], artist, { kind: 'group', match: 'xor', children: [artist] }, { kind: 'group', match: 'all' }, group([group([])]), group([{ ...artist, field: 'unsupported' } as never]), group([null as never])]) {
    assert.throws(() => normalizeDynamicPlaylistRules({ ...createDefaultDynamicPlaylistRules(), filter }))
  }
  assert.throws(() => normalizeDynamicPlaylistRules({ version: 1, conditions: [group([artist])] }))
  assert.throws(() => normalizeDynamicPlaylistRules({ version: 1, conditions: 'invalid' }))
  assert.deepEqual(normalizeDynamicPlaylistRules(rules(group([]))).filter.children, [])
  assert.deepEqual(normalizeDynamicPlaylistRules(rules(group([], 'any'))).filter.children, [])
})

test('group depth and total node limits have exact boundaries', () => {
  let filter = group([artist])
  for (let depth = 1; depth < 8; depth++) filter = group([filter])
  assert.doesNotThrow(() => normalizeDynamicPlaylistRules(rules(filter)))
  assert.throws(() => normalizeDynamicPlaylistRules(rules(group([filter]))), /8 group levels/)
  assert.doesNotThrow(() => normalizeDynamicPlaylistRules(rules(group(Array.from({ length: 255 }, () => artist)))))
  assert.throws(() => normalizeDynamicPlaylistRules(rules(group(Array.from({ length: 256 }, () => artist)))), /256 filter nodes/)
})

test('an open editor target keeps its identity when siblings are removed or changed', () => {
  const a = { ...artist }
  const b = { ...artist, value: 'Artist B' }
  const nested = group([a, b], 'any')
  let root = group([favorite, nested])
  const target = dynamicPlaylistNodeId(b)
  const nestedId = dynamicPlaylistNodeId(nested)
  root = editDynamicPlaylistNode(root, dynamicPlaylistNodeId(a), () => null)
  root = editDynamicPlaylistNode(root, target, (node) => ({ ...node, value: 'Artist C' } as DynamicPlaylistCondition))
  const updated = root.children[1] as DynamicPlaylistGroup
  assert.equal(dynamicPlaylistNodeId(updated), nestedId)
  assert.equal(dynamicPlaylistNodeId(updated.children[0]), target)
  assert.equal((updated.children[0] as typeof artist).value, 'Artist C')
  root = editDynamicPlaylistNode(root, nestedId, () => null)
  assert.equal(editDynamicPlaylistNode(root, target, () => artist), root)
})

test('sync only requires an update when grouped rules meet an older peer', () => {
  const flat = { kind: 'dynamic', dynamicRules: serializeDynamicPlaylistRules(rules(group([artist]))) }
  const grouped = { kind: 'dynamic', dynamicRules: serializeDynamicPlaylistRules(rules(group([group([artist], 'any')]))) }
  assert.equal(dynamicPlaylistSyncNeedsUpdate(undefined, [flat]), false)
  assert.equal(dynamicPlaylistSyncNeedsUpdate(1, [grouped]), true)
  assert.equal(dynamicPlaylistSyncNeedsUpdate(undefined, [grouped]), true)
  assert.equal(dynamicPlaylistSyncNeedsUpdate(2, [flat, grouped]), false)
})

test('sync preflight blocks native writes and includes playlists without sync identities', async () => {
  const { prepareDynamicPlaylistSyncState } = await import('./dynamicPlaylistSync.ts')
  const grouped = { kind: 'dynamic', dynamicRules: serializeDynamicPlaylistRules(rules(group([artist], 'any'))) }
  let preparations = 0
  let localReads = 0
  const readLocal = async () => { localReads++; return [grouped] }
  const prepare = async () => { preparations++; return { baseline: 'unchanged' } }
  await assert.rejects(prepareDynamicPlaylistSyncState(undefined, [], readLocal, prepare), /Update the desktop/)
  assert.equal(preparations, 0)
  assert.equal(localReads, 1)
  assert.deepEqual(await prepareDynamicPlaylistSyncState(2, [], readLocal, prepare), { baseline: 'unchanged' })
  assert.equal(localReads, 1)
  assert.equal(preparations, 1)
  await prepareDynamicPlaylistSyncState(1, [], async () => [], prepare)
  assert.equal(preparations, 2)
})
