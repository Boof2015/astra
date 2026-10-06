import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRemoteCacheLimitGb } from './remoteAudioCache.ts'

test('remote cache limits keep the agreed default and supported range', () => {
  assert.equal(normalizeRemoteCacheLimitGb(null), 5)
  assert.equal(normalizeRemoteCacheLimitGb('bad'), 5)
  assert.equal(normalizeRemoteCacheLimitGb(0), 5)
  assert.equal(normalizeRemoteCacheLimitGb(1), 1)
  assert.equal(normalizeRemoteCacheLimitGb(50), 50)
  assert.equal(normalizeRemoteCacheLimitGb(100), 50)
})
