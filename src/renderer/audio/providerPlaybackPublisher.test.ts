import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderPlaybackPublisher } from './providerPlaybackPublisher.ts'
import type { ProviderPlaybackSnapshot } from '../../types/providerPlayback.ts'

test('only actual playback starts reporting; buffering retains position and live seeks publish immediately', () => {
  const reports: ProviderPlaybackSnapshot[] = []
  let now = 0
  const publisher = new ProviderPlaybackPublisher(r => reports.push(r), () => now)
  publisher.start('one', 'subsonic://7/track/a', 90)
  publisher.observe('loading', 0, 90)
  publisher.observe('paused', 0, 90)
  assert.equal(reports.length, 0)
  publisher.observe('playing', 12, 90)
  now = 100; publisher.observe('playing', 12.1, 90)
  assert.equal(reports.length, 1)
  publisher.observe('loading', 0, 90)
  assert.equal(reports.at(-1)?.position, 12)
  publisher.observe('playing', 12, 90)
  publisher.observe('playing', 70, 90)
  assert.equal(reports.at(-1)?.position, 70)
  publisher.observe('paused', 70, 90)
  assert.equal(reports.at(-1)?.state, 'paused')
  publisher.observe('stopped', 0, 90) // transient native command; finalization owns stop
  publisher.finish()
  assert.equal(reports.at(-1)?.position, 70)
  assert.equal(reports.at(-1)?.state, 'stopped')
})

test('gapless repeats finalize their own duration and use new identities; local tracks emit nothing', () => {
  const reports: ProviderPlaybackSnapshot[] = []
  const publisher = new ProviderPlaybackPublisher(r => reports.push(r))
  publisher.start('one', 'jellyfin://7/track/a', 60)
  publisher.observe('playing', 59, 60)
  publisher.finish(true)
  publisher.start('two', 'jellyfin://7/track/a', 60)
  publisher.observe('playing', 0, 60)
  publisher.start('local', '/local.flac', 90)
  publisher.observe('playing', 0, 90)
  assert.deepEqual(reports.map(r => [r.sessionId, r.state, r.position]), [
    ['one', 'playing', 59], ['one', 'stopped', 60], ['two', 'playing', 0], ['two', 'stopped', 0]
  ])
})

test('reporting bridge failure cannot interrupt a playback transition', () => {
  const publisher = new ProviderPlaybackPublisher(() => { throw new Error('renderer closing') })
  publisher.start('one', 'subsonic://7/track/a', 60)
  assert.doesNotThrow(() => { publisher.observe('playing', 0, 60); publisher.finish() })
})
