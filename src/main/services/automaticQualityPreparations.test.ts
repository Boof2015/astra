import assert from 'node:assert/strict'
import test from 'node:test'
import { AutomaticQualityPreparations } from './automaticQualityPreparations.ts'
import type { RemoteAudioLease } from './remoteAudioCache.ts'

const request = { mode: 'automatic' as const, target: 128 as const }
const previous = { mode: 'automatic' as const, target: 'original' as const }
function lease(): RemoteAudioLease & { released: boolean } {
  const value = { url: 'http://internal-secret', released: false,
    progress: () => ({ complete: false, loadedBytes: 1000, totalBytes: null }), finished: async () => {},
    release: () => { value.released = true } }
  return value
}

test('preparation keeps both encoded representations leased until the playback handoff settles', async () => {
  const leases: ReturnType<typeof lease>[] = []
  const requests: unknown[] = []
  const preparations = new AutomaticQualityPreparations({ acquire: async (_path, _signal, quality) => {
    requests.push(quality); const value = lease(); leases.push(value); return value
  }, prime: async (_lease, position) => { assert.equal(position, 125) } })
  assert.deepEqual(await preparations.prepare(1, 'one', 'subsonic://1/a', request, 125, previous), { complete: false })
  assert.deepEqual(requests, [previous, request])
  assert.ok(leases.every(value => !value.released))
  preparations.release(2, 'one')
  assert.ok(leases.every(value => !value.released), 'other windows cannot release the preparation')
  preparations.release(1, 'one')
  assert.ok(leases.every(value => value.released))
})

test('cancelled late acquisition releases its lease without replacing a newer preparation', async () => {
  let resolve!: (lease: RemoteAudioLease) => void
  const pending = new Promise<RemoteAudioLease>(done => { resolve = done })
  let calls = 0
  const later = lease(), newer = lease()
  const preparations = new AutomaticQualityPreparations({ acquire: async () => ++calls === 1 ? pending : newer,
    prime: async () => {} })
  const old = preparations.prepare(1, 'old', 'subsonic://1/a', request, 4)
  const rejected = assert.rejects(old, /cancelled/)
  await preparations.prepare(1, 'new', 'subsonic://1/b', request, 0)
  resolve(later)
  await rejected
  assert.equal(later.released, true)
  assert.equal(newer.released, false)
  preparations.releaseOwner(1)
  assert.equal(newer.released, true)
})

test('failed candidates release their holds and do not expose internal decoder URLs', async () => {
  const current = lease()
  const preparations = new AutomaticQualityPreparations({ acquire: async () => current,
    prime: async () => { throw new Error('ffmpeg failed at http://internal-secret') } })
  await assert.rejects(preparations.prepare(1, 'a', 'jellyfin://1/a', request, 10), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /internal-secret/)
    return true
  })
  assert.equal(current.released, true)
  await assert.rejects(preparations.prepare(1, 'a', '/local.flac', 'original', -1), /Invalid/)
})
