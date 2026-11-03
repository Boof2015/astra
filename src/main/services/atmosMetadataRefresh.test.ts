import assert from 'node:assert/strict'
import test from 'node:test'
import { runAtmosMetadataRefreshOnce } from './atmosMetadataRefresh.ts'

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
