import assert from 'node:assert/strict'
import test from 'node:test'
import { runAtmosMetadataRefreshOnce, supportsAtmosMetadataRefresh } from './atmosMetadataRefresh.ts'

test('Atmos refresh accepts Linux release-tag versions while rejecting old and unknown builds', () => {
  for (const version of ['6.1.1', '6.1.1-tessus', 'n6.1.2-9-g4571c80b40-20241023', '7.0.2', 'n7.0.2']) {
    assert.equal(supportsAtmosMetadataRefresh(`ffprobe version ${version} Copyright`), true, version)
  }
  for (const version of ['4.4-tessus', '6.0', 'n6.0.1-9-g123456', 'N-unknown']) {
    assert.equal(supportsAtmosMetadataRefresh(`ffprobe version ${version} Copyright`), false, version)
  }
})

test('refresh persists completion before notifying the UI and runs only once', async () => {
  let complete = false
  const events: string[] = []
  const result = { scanned: 3, updated: 2, errors: 1 }
  const deps = {
    isComplete: () => complete,
    refresh: async () => { events.push('probe'); return result },
    markComplete: async () => { events.push('complete'); complete = true },
    notify: (actual: typeof result) => { assert.equal(actual, result); events.push('notify') }
  }
  assert.equal(await runAtmosMetadataRefreshOnce(deps), result)
  assert.equal(await runAtmosMetadataRefreshOnce(deps), null)
  assert.deepEqual(events, ['probe', 'complete', 'notify'])
})

test('missing binary, failed refresh, and interruption leave completion pending', async () => {
  for (const failure of ['unavailable', 'failed', 'aborted']) {
    const controller = new AbortController()
    const deps = {
      isComplete: () => false,
      refresh: async () => {
        if (failure === 'failed') throw new Error('probe failed')
        if (failure === 'aborted') controller.abort()
        return failure === 'unavailable' ? null : { scanned: 1, updated: 1, errors: 0 }
      },
      markComplete: async () => { assert.fail('must remain pending') },
      notify: () => { assert.fail('must not invalidate') },
      signal: controller.signal
    }
    if (failure === 'unavailable') assert.equal(await runAtmosMetadataRefreshOnce(deps), null)
    else await assert.rejects(runAtmosMetadataRefreshOnce(deps))
  }
})

test('an empty completed pass does not invalidate the UI', async () => {
  let complete = false
  await runAtmosMetadataRefreshOnce({
    isComplete: () => false,
    refresh: async () => ({ scanned: 0, updated: 0, errors: 0 }),
    markComplete: async () => { complete = true },
    notify: () => assert.fail('nothing changed')
  })
  assert.equal(complete, true)
})
