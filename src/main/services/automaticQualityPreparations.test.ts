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

for (const failure of ['http-415', 'decoder', 'network'] as const) {
  test(`automatic preparation handles ${failure} without releasing current audio and pins a successful fallback`, async () => {
    const requests: unknown[] = []
    const current = lease(), opus = lease(), mp3 = lease()
    opus.quality = { requested: 128, mode: 'automatic', requestedCodec: 'opus', delivered: null }
    mp3.quality = { ...opus.quality, requestedCodec: 'mp3', compatibility: 'mp3' }
    if (failure === 'http-415') opus.progress = () => ({ complete: false, loadedBytes: 0, totalBytes: null, failureKind: 'unsupported-format' })
    const preparations = new AutomaticQualityPreparations({ acquire: async (_path, _signal, quality) => {
      requests.push(quality)
      return quality === previous ? current : typeof quality === 'object' && quality.compatibility === 'mp3' ? mp3 : opus
    }, prime: async candidate => {
      assert.equal(current.released, false)
      if (candidate === opus) throw new Error(failure === 'decoder' ? 'Decoder (codec opus) not found for input stream #0:0' : 'Could not read input')
    } })
    if (failure === 'network') {
      await assert.rejects(preparations.prepare(1, 'a', 'subsonic://1/a', request, 10, previous))
      assert.deepEqual(requests, [previous, request])
    } else {
      const fallback = { ...request, compatibility: 'mp3' }
      assert.deepEqual(await preparations.prepare(1, 'a', 'subsonic://1/a', request, 10, previous), { complete: false, request: fallback })
      assert.deepEqual(requests, [previous, request, fallback])
      assert.equal(opus.released, true)
      assert.equal(current.released, false)
      assert.equal(mp3.released, false)
    }
    preparations.releaseOwner(1)
    assert.equal(current.released, true)
    assert.equal(opus.released, true)
  })
}
