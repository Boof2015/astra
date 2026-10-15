import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderSyncRef } from '../../types/providerSync.ts'
import { useProviderSyncStore } from './providerSyncStore.ts'

/** Library 3 has differences to choose; library 4 has none (it turns on without a window). */
function stub(differing: number[]) {
  const calls: string[] = []
  ;(globalThis as any).window = { electronAPI: { providerSync: {
    status: async () => [],
    review: async (ref: ProviderSyncRef) => {
      calls.push(`review ${ref.sourceId}`)
      return { ref, token: `t${ref.sourceId}`, enabling: true, matchedTracks: 1, missingTracks: 0,
        differences: differing.includes(ref.sourceId) ? [{ key: 'k' }] : [] }
    },
    apply: async (token: string) => { calls.push(`apply ${token}`) },
    disable: async (ref: ProviderSyncRef) => { calls.push(`disable ${ref.sourceId}`) }
  } } }
  useProviderSyncStore.setState({ statuses: [], review: null, working: false, error: null, queue: [], queueStep: null })
  return calls
}
const plex = (sourceId: number): ProviderSyncRef => ({ provider: 'plex', sourceId })

test('turning sync on for a server’s libraries compares them one at a time, saying which step it is', async () => {
  const calls = stub([3, 5])
  await useProviderSyncStore.getState().openReviews([plex(3), plex(4), plex(5)])
  assert.equal(useProviderSyncStore.getState().review?.ref.sourceId, 3)
  assert.deepEqual(useProviderSyncStore.getState().queueStep, { index: 1, total: 3 })
  // Confirming the first opens the next; one with nothing to choose turns on by itself and moves on.
  await useProviderSyncStore.getState().apply({})
  assert.deepEqual(calls, ['review 3', 'apply t3', 'review 4', 'apply t4', 'review 5'])
  assert.equal(useProviderSyncStore.getState().review?.ref.sourceId, 5)
  assert.deepEqual(useProviderSyncStore.getState().queueStep, { index: 3, total: 3 })
  await useProviderSyncStore.getState().apply({})
  assert.equal(useProviderSyncStore.getState().review, null)
  assert.equal(useProviderSyncStore.getState().queueStep, null)
})

test('cancelling a comparison leaves the rest off, and a single review never continues an old queue', async () => {
  const calls = stub([3, 4])
  await useProviderSyncStore.getState().openReviews([plex(3), plex(4)])
  useProviderSyncStore.getState().closeReview()
  assert.deepEqual(useProviderSyncStore.getState().queue, [])
  assert.equal(useProviderSyncStore.getState().queueStep, null)
  assert.deepEqual(calls, ['review 3'])

  await useProviderSyncStore.getState().openReviews([plex(3), plex(4)])
  useProviderSyncStore.getState().closeReview()
  await useProviderSyncStore.getState().openReview(plex(4))
  await useProviderSyncStore.getState().apply({})
  assert.deepEqual(calls.slice(-2), ['review 4', 'apply t4'], 'nothing else opens after it')
  assert.equal(useProviderSyncStore.getState().review, null)
})

test('comparing again after an apply failed keeps the libraries still to come', async () => {
  const calls = stub([3, 4])
  let failOnce = true
  const api = (globalThis as any).window.electronAPI.providerSync
  const apply = api.apply
  api.apply = async (token: string) => {
    if (failOnce) { failOnce = false; throw new Error('This review expired. Refresh the comparison.') }
    return apply(token)
  }
  await useProviderSyncStore.getState().openReviews([plex(3), plex(4)])
  await useProviderSyncStore.getState().apply({})
  assert.match(useProviderSyncStore.getState().error ?? '', /expired/)
  await useProviderSyncStore.getState().refreshReview()
  assert.equal(useProviderSyncStore.getState().review?.ref.sourceId, 3)
  assert.deepEqual(useProviderSyncStore.getState().queueStep, { index: 1, total: 2 }, 'still 1 of 2')
  await useProviderSyncStore.getState().apply({})
  assert.equal(useProviderSyncStore.getState().review?.ref.sourceId, 4, 'the next library follows')
  assert.deepEqual(calls, ['review 3', 'review 3', 'apply t3', 'review 4'])
})
